# BG2EE-GameLog

Exports Baldur's Gate II: Enhanced Edition's in-game message window to a queryable SQLite database
with a local web viewer — so the combat log can be sorted, searched and grouped instead of just
scrolled, and so you can see what protections an enemy actually has up.

![The events view: a table of damage rows showing side, actor, summon, target, damage type, amount
and the spell responsible, sorted by actor](resources/events.png)

<p align="center">
  <em>
    Only the rightmost column is what the game wrote. Everything else is<br>
    reconstructed — much of it from the order of events rather than their<br>
    wording, since a cause and its effect arrive as separate lines with<br>
    nothing linking them. <a href="learnings/EVENT-STREAM-STRUCTURING.md">How that works</a>.
  </em>
</p>

## Acknowledgements

The engine specifics used here — the `combatLog` Lua table, the `table.remove` chunk the engine uses to
trim it, the platform log prefix wrapped around `Infinity_Log` output — were verified first-hand
against the game binary and `ui.menu`. Knowing where to look came from other people's work:

- **[EEex-Docs](https://github.com/Bubb13/EEex-Docs)** · [rendered](https://eeex-docs.readthedocs.io/)
  — the reference for the engine's `Infinity_*` Lua API. `Infinity_Log`, `Infinity_DoFile` and
  `Infinity_WriteINILine` are documented there; finding them is what made a stdout transport possible
  at all, and what identified the fallback if it hadn't been.
- **[EEex](https://github.com/Bubb13/EEex)** — the executable extender that would be the right tool for
  this job if it ran here. Ruled out on platform and game version, but knowing what it can do framed
  what was worth attempting without it.
- **[WeiDU](https://github.com/WeiDUorg/weidu)** — the framework the tap is packaged with. Its backup
  and uninstall behavior is what makes patching a shared `ui.menu` safe to iterate on.
- **[IWDification](https://github.com/Gibberlings3/iwdification)** — unintentionally load-bearing: its
  install extracts `ui.menu` from the biffs into `override/`, which is the reason the file was already
  loose and editable, with no extraction step needed here.

## How it works

The engine keeps the message window in a plain Lua table (`combatLog`) that the scriptable UI renders
from. A small WeiDU mod patches `override/ui.menu` to mirror every new row to stdout via
`Infinity_Log`. The game is launched under a pty so that output can be captured, parsed into
structured events, and stored.

```
ui.menu tap ──Infinity_Log──▶ stdout ──▶ play.ts ──▶ events.db ──▶ serve.ts ──▶ viewer
   (Lua)                                (capture + parse)   (SQLite)     │      events
                                              │                          └──▶ combatants
                                       logs/session-*.log                     (folded state)
                                       (source of truth)
```

No EEex, no binary patching. Tested on BG2:EE 2.7.3, macOS.

## Requirements

- Baldur's Gate II: Enhanced Edition
- [Deno](https://deno.com) — verified on **2.9.6**. Uses the built-in `node:sqlite`, the `Temporal`
  global, and a few `@std` modules that Deno fetches on first run (pinned in `deno.lock`). No npm, no
  third-party packages. `node:sqlite` needs 2.2+; `Temporal` unflagged is more recent, so 2.9 is the
  safe floor rather than a tested minimum.
- **[WeiDU](https://github.com/WeiDUorg/weidu/releases)** — the tap is packaged as a WeiDU mod, so a
  WeiDU binary must be available. `deno task install-mod` looks in this order:

  1. `$BG2EE_WEIDU`, if set
  2. any `setup-*` executable in the game directory — every installed mod ships one, so a
     **modded install needs no action here**
  3. `weidu` on `$PATH`

  On a clean, unmodded install there is nothing to borrow: download the release for your platform and
  either put it on `$PATH` or point `$BG2EE_WEIDU` at it.

  Step 2 matches on **filename alone**, in a directory this project does not control — so
  `install-mod` prints the path, how it was found, and the SHA-256 of whatever it is about to run, and
  waits for confirmation. Check that checksum against the release you expect
  ([source](https://github.com/WeiDUorg/weidu) ·
  [releases](https://github.com/WeiDUorg/weidu/releases)) before saying yes. There is no flag to skip
  the prompt. `install-mod` also audits the project's own security invariants first (the same checks
  as `deno task lint`) and refuses to run if any are broken.

## Game settings

The tap captures whatever the message window shows, so the game's own feedback settings decide how
much there is to capture. They live in `Baldur.lua` in the game's user directory — on macOS,
`~/Documents/Baldur's Gate II - Enhanced Edition/Baldur.lua`:

| setting | value | effect |
|---|---|---|
| `Extra Combat Info` | `1` | per-swing combat detail |
| `Extra Feedback` | `1` | additional feedback messages |
| `GUI Feedback Level` | `5` | maximum |
| `Effect Text Level` | `63` | maximum |

**These are not exposed in the in-game options — the file is the only way to set them.** And it must be
edited **while the game is closed**: BG2:EE holds the settings in memory and rewrites `Baldur.lua` from
that on exit, so an edit made while the game is running is overwritten the moment you quit, and the
next launch reads the old value back.

```sh
# quit the game first, then:
$EDITOR "$HOME/Documents/Baldur's Gate II - Enhanced Edition/Baldur.lua"
```

Once set, they persist: the game reads them at launch and writes the same values back on exit.

These adjust volume, not capture: with `Extra Combat Info` at `0` the log still contained attack rolls
and damage lines, just fewer of them. Nothing the game does not print can be captured.

`Debug Mode = 1` under `Program Options` enables the Ctrl+Space console, useful for inspecting Lua
state. It was set throughout development; nothing in the capture path is known to require it.

## Quick start

```sh
deno task install-mod   # patch ui.menu (re-run after installing any other UI mod)
deno task play          # launch the game and capture a session
deno task serve         # viewer on http://127.0.0.1:8787/
```

Then, after playing:

```sh
deno task import        # re-derive events.db from logs/ (idempotent)
deno task patterns      # show unclassified lines, damage types, protection coverage
deno task test          # run the test suite
deno task lint          # lint, type-check, test, and audit the security invariants
```

`deno task install-mod --uninstall` restores the original `ui.menu`.

`deno task lint` is the one to run before committing: it lints, type-checks, runs the tests, and
audits the security invariants in `docs/SECURITY.md`. The test suite covers the parsing and folding
logic, and most of its cases are real lines from `logs/` that the classifier once got wrong.

## What gets captured

Every row keeps the game's original text in `raw`. Everything else is derived from it:

| field | meaning |
|---|---|
| `kind` | one of ~20: `damage`, `attack`, `spell`, `cast_start`, `immune`, `save`, `death`, `effect`, `status`, `xp`, `dialogue`, `pause`, `resync`, … |
| `actor` / `target` | who did it, and to whom |
| `amount` | damage or experience — things worth summing |
| `roll` | a die result or attack-roll total, kept apart from `amount` so a miss cannot read as damage |
| `resisted` | damage prevented by resistance |
| `detail` | sub-type: damage type, save type, spell name, Hit/Miss |
| `critical` | set on the damage row a critical produced |
| `spell` | the spell a damage row is attributed to |
| `actor_side` / `target_side` | `party`, `opponent` or `neutral` |
| `summon` / `target_summon` | set when that participant was summoned rather than a party member |

**Several are inferred, not stated.** The log never says which spell caused a hit, whose side anyone
is on, or that a critical and the damage after it are the same event — those are reconstructed from
the order events arrive in. `learnings/EVENT-STREAM-STRUCTURING.md` covers how, and what the inference
deliberately refuses to guess.

## Combatants view

Two views, each its own page and URL — so they are bookmarkable and the back button works:

| route | what it shows |
|---|---|
| `/events` | the event table: sort, filter, group |
| `/combatants` | per-creature state folded from recent events |

The selected session carries across the tab links, so `/combatants?session=…` is a valid bookmark.

Reading a BG2 fight otherwise means recognizing swirls and color flashes to guess what an enemy has
cast. The **combatants** view folds recent events into per-creature state instead — one card per
creature, opponents first:

![The combatants view: cards for ten opponents and six party members. Each lists observed effects
tagged DISABLE or PROTECTION with how long ago they were seen, a "casting…" line for spells still in
flight, and a hint on how to counter them. Dead creatures are
dimmed](resources/combatants.png)

A lot of that fight is legible at a glance. `Fiendish Harpy` is **mid-cast** — `casting Harpy Wail…` —
with the previous one seen 19s ago and a note that Chaotic Commands prevents it. `Jan` is carrying
three disables and a Mirror Image, `Jaheira` is shapeshifting, and creatures with nothing on them say
so rather than being hidden. Every age is a *relative* one, because the range is set to `400`–`1000`
back: this is a fight from earlier in the session, not the one in progress.

**That shot also contains a bug, which is worth leaving in.** Look at `Anomen`: below his Magic
Resistance sit `Spell Protections Removed` and `Spellstrike`, both with **no category tag**. Showing
them untagged was the graceful-degradation rule working as intended — an unrecognized name is
displayed rather than dropped. But *what* they are was being read backwards. Both report state having
been **stripped**, and the card presented them as two more things Anomen had picked up.

They are entries in `src/protections.ts` now, classed as removals, so the same fight renders as Anomen
keeping his Magic Resistance — innate, and nothing in the Spell Thrust family removes it — while his
actual spell protections come off. The screenshot predates that fix.

Each entry carries **how it was learned** — hover the age to see which:

| source | meaning | strength |
|---|---|---|
| `probe` | your attack failed *because* of it — so it is up **right now** | strongest |
| `effect` | the game printed the effect on that creature | it landed |
| `cast` | a spell was aimed at them | intent only |

**Scope it by how far back to look.** The two inputs are offsets from the newest event, not log ids:
`0` is now, `400` is four hundred events earlier. So the default `0`–`400` means "the most recent 400
events", and means the same thing in every session however long it ran. Raise both numbers to walk
back to an earlier fight; **latest** snaps the near end back to `0`, keeping the span you were using.

Relative rather than absolute for two concrete reasons: the page cannot send an id on first load,
since that needs the session's maximum — which only arrives in the response; and `0` keeps meaning
"now" as a session grows underneath a live capture, where a fixed id would drift out of date.

A range is clamped rather than rejected, and the values actually used are echoed back — so a
half-typed or reversed range corrects itself instead of erroring mid-keystroke, and the inputs never
disagree with the data on screen. The status line also gives the absolute ids behind the offsets, for
cross-referencing the events table, which is keyed on id.

Three deliberate limits, all stated in the UI rather than hidden:

- **It reports observations with an age; it never claims a protection is still active.** Nothing in
  the game announces an effect *ending* — verified against 61k captured events — and durations scale
  with caster level, which the log never reveals. Only death, a dispel and a vanished summon clear
  state observably. Older entries dim; they are not deleted.
- **Identical creature names are merged.** Two Lesser Clay Golems are one card, because the engine
  exposes no per-creature identity (`docs/FINDINGS.md`).
- **Party state is inferred here too**, even though the engine holds it exactly. `characters[id]` has
  real `statusEffects`, saves and resistances — but only for the party, with no way to ask about
  anyone else.

What each effect *means* — protection vs disable vs buff, what a given removal spell strips, how to
get past it — comes from `src/protections.ts`, which is domain knowledge rather than log-derived and
says so. Unknown names are still shown, just uncategorized.

**Keeping it current is `deno task patterns`.** It folds every session through the same function the
view uses and reports what came back uncategorized, so the report and the screen cannot disagree:

```
Protection coverage: 169/234 observations the combatants view would show are categorized
  32 distinct names have no entry in src/protections.ts (20 of them declined, 12 still to judge)
```

Two halves to that, and both matter. Names with semantics go in `TABLE`. Names judged and rejected —
`Magic Missile` is damage, `Searching for traps` is an action — go in `DECLINED`, which is what keeps
the queue finite. Without it every run re-lists the same hundred spells that will never be added, and
a two-occurrence name that *is* a protection stays buried under them.

`DECLINED` changes the report, not the view: a declined name still shows on its card, untagged, the
same as any name the table has never seen. Deciding a name is not a protection is not a reason to
stop showing that the creature did it — `Bombardier Beetle` still reads `Releases Acidic Vapor`. What
the cards suppress is a separate list, `NOT_STATE` in `src/combatants.ts`.

Removal spells need care: they do not all strip the same things, so they carry an explicit `strips`
class rather than sharing one flag. Dispel Magic takes Mirror Image and leaves Spell Turning, Spell
Thrust does the reverse, and Breach removes Protection From Magical Weapons that neither of them can.

## Layout

```
src/           capture, parse, store, serve — plus *_test.ts, run by `deno task test`
web/           one page per view, no CDN or external requests:
                 events.html · combatants.html · app.css · common.js
mod/gamelog/   the WeiDU mod and the in-game Lua tap
logs/          raw captured sessions — the source of truth, never rewritten
learnings/     general write-ups, stack-agnostic
docs/          project-specific documentation
skills/        the security audit procedure
resources/     screenshots
```

The pieces worth knowing about: `parse.ts` turns a tap line into a structured event and holds the
classification rules; `combatants.ts` is a pure fold from events to per-creature state;
`protections.ts` is the one file whose contents are *not* derived from captured data.

## Docs

**`learnings/`** — general write-ups. The reasoning rather than the specifics; nothing in them
depends on this game, this engine, or this stack.

| file | what it covers |
|---|---|
| `EVENT-STREAM-STRUCTURING.md` | turning an unstructured event stream into structured data |
| `LOCAL-TOOL-SECURITY.md` | securing a small tool that touches software you don't own |

**`docs/`** — this project specifically.

| file | what it covers |
|---|---|
| `FINDINGS.md` | how the engine works and why this approach was possible |
| `GOTCHAS.md` | traps specific to this stack (Infinity Engine, Lua, Deno, browser) |
| `SECURITY.md` | this project's own policy — surface, invariants, accepted risk |
| `PLAN.md` | the original design |
| `../skills/security.md` | the audit procedure — the judgment half `deno task lint` cannot check |

## Caveats

- `override/ui.menu` is shared state. Any mod that rewrites it removes the tap — reinstall afterwards.
- **Only what the game displays is captured.** Enemy HP, AC and saving throws are never printed, so
  they are not knowable. See [Game settings](#game-settings) for turning the volume up.
- Classification rules target `en_US` and are still incomplete; `deno task patterns` reports what is
  unmatched, and `deno task import` re-applies new rules to sessions already recorded.
- **If the tap loses its place it says so.** Loading a save can swap the engine's log table out from
  under the capture; when that happens the tap emits a `resync` row warning that preceding rows may be
  missing. Its own kind, so the default filter cannot hide it.
- **The raw logs are the source of truth, not the database.** Anything that goes wrong downstream is
  recoverable with `deno task import`; a failed insert never ends a capture.
