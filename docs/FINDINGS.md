# Findings

How this works, and why it works this way. Written against **BG2:EE build 2.7.3** (macOS, Steam),
with iwdification, A7-TotLM and A7#ImprovedArcher installed.

For the transferable lessons — what to do differently next time, and the two fatal bugs that only
live testing exposed — see [GOTCHAS.md](GOTCHAS.md).

## The message window is a Lua table

The engine does not keep the combat log in opaque UI state. `override/ui.menu` declares it as a plain
global Lua table and renders it from there:

| where | what |
|---|---|
| `ui.menu:21` | `combatLog = {}` |
| `ui.menu:12377` | `text lua "combatLog[rowNumber]"` |
| `ui.menu:12384` | `table "combatLog"` — inside `menu 'WORLD_MESSAGES'` (`:12330`) |

Rows are appended from C++ via the Lua C API, so a metatable `__newindex` hook would not fire
(`lua_rawseti` bypasses metatables). Trimming, however, is done by **executing a Lua chunk** — the
literal `table.remove(combatLog, %d)` is present in the game binary. Because that chunk resolves
`table.remove` from the global environment at run time, wrapping the global function works, and that
is what turns a shifting array position into a stable monotonic row id. See `mod/gamelog/lib/a7log.lua`.

Row contents are strings that have already been resolved from `dialog.tlk`, including Infinity Engine
color markup (`^` + `0x` + 8 hex digits to open, `^-` to close — from the binary's `^%#010x%s^-`).

## Getting data out of the Lua sandbox

The engine embeds **Lua 5.2 with a restricted stdlib**. Present: `string table math coroutine package
bit32 debug pcall print dofile require`. **`io` and `os` are absent** — verified by the absence of
`luaopen_io` / `luaopen_os` and of every liolib marker string (`setvbuf`, `lines`, `seek`, `popen`,
`tmpfile`, `difftime`, `getenv`, `tmpname`) in the binary. So Lua cannot open a file.

146 `Infinity_*` functions are exposed (extracted from the binary here, and documented by
[EEex-Docs](https://github.com/Bubb13/EEex-Docs) — <https://eeex-docs.readthedocs.io/>, which is where
the ones below were identified). The ones that can move data outward:

- **`Infinity_Log(str)`** — writes to the process's stdout/stderr. Used by the stock UI
  (`bgee.lua:3153` `Infinity_Log("Initializing Quests")`, `ui.menu:830`). **This is the transport.**
- `Infinity_WriteINILine`, `Infinity_SetINIValue`, `Infinity_ChangeOption` — write into `Baldur.lua`.
  The fallback if `Infinity_Log` turns out not to reach stdout.
- `Infinity_SendChatMessage`, `Infinity_LaunchURL`, `Infinity_TakeScreenshot` — impractical here.

Useful context accessors used by the tap: `Infinity_GetGameTicks`, `Infinity_GetClockTicks`,
`Infinity_GetTimeString`, `Infinity_GetCurrentScreenName`.

The engine has no general log file. `home:/jingle.log` and `home:/network.log` belong to the XMPP
multiplayer matchmaking library, not to gameplay; `home:/framelog_*.csv` is a frame profiler. There is
no `baldur.err` or equivalent for game events.

## Why not EEex

[EEex](https://github.com/Bubb13/EEex) is the obvious tool for this and it does not apply: it is
**Windows-only** natively (macOS is listed as "via Wine, untested"), and it targets game **v2.6.6.0**
while this install is **2.7.3**.

## Injection points in ui.menu

`override/ui.menu` is a loose, editable, plaintext file (473 KB) — iwdification extracted it from the
biffs during its install (`SETUP-IWDIFICATION.DEBUG`: `Copied [ui.menu] to [override/ui.menu]`). No
biff extraction was needed — an unintended but load-bearing gift from
[IWDification](https://github.com/Gibberlings3/iwdification).

Three single-line anchors, all verified for occurrence count before use:

| anchor | count | purpose |
|---|---|---|
| `combatLog = {}` | 1 | insert `Infinity_DoFile("a7log")` to load the tap |
| `name 'messagesRect'` | 1 | per-frame tick host inside `WORLD_MESSAGES` |
| `name 'leftSidebarBackground'` | 2 | per-frame tick host in both sidebar menus |

Loading the tap as a separate `override/a7log.lua` via `Infinity_DoFile` — the same mechanism the
stock UI uses for its translation files (`Infinity_DoFile("L_en_us")` at `ui.menu:16-18`) — keeps the
WeiDU patch down to three tiny textual insertions instead of splicing a Lua blob through a regex
replacement. Iterating on the tap means replacing one file.

The tick works because UI.MENU evaluates every rendered element's `text lua` expression on each frame.
`A7LOG_tick()` returns an empty string, so nothing draws. Two hosts are patched so that collapsing the
message window does not stop capture. Both `leftSidebarBackground` labels are patched, which covers
the hidden-sidebar menu too.

## What the message window actually contains

From a real captured session (arena fight, Extra Combat Info off). Nearly every row is prefixed with
the creature it belongs to, which is where `parse.ts` gets `actor` from:

| shape | example | kind |
|---|---|---|
| `<Name>: <prose>` | `Tartle: Hello again, Alarion. The arena awaits!` | `dialogue` |
| `<Name>:  <Effect> : <Target>` | `Tyras:  Enrage : Tyras` (note the double space) | `effect` |
| `<Name>: Auto-Paused: <reason>` | `Tyras: Auto-Paused: Spell Cast` | `pause` |
| `PAUSED` / `UNPAUSED` (unattributed) | `PAUSED` | `pause` |
| `<Name>: [Stopped ]Singing <song>` | `Zeris: Singing Bard Song` | `song` |
| `<Name>: <Title Case status>` | `Gaul: Contingency Active` | `status` |
| `<Name>: Attacks <Target>` | `Vampire: Attacks Mireille` | `attack` |
| `<Name>: Attack Roll <r> + <m> = <t> : <Hit\|Miss>` | `Vidania: Attack Roll 6 + 16 = 22 : Hit` | `attack` |
| `<Victim>: Takes <n> <type> damage from <Source>` | `Vampire: Takes 13 slashing damage from Tyras` | `damage` |
| … with a bonus suffix | `Alarion: Takes 18 crushing damage from Vampire (9 damage bonus)` | `damage` |
| `<Name>: Save vs. <Type> : <roll>` | `Vampire: Save vs. Spell : 11` | `save` |
| `<Name>: Casts <Spell>` | `Rurik: Casts Summon Deva` | `spell` |
| `<Name>: Spell Failed: <reason>` | `Rurik: Spell Failed: Casting Failure` | `spell` |
| `<Name>: Critical <what>` | `Vampire: Critical Hit Averted` | `critical` |
| `<Name>: Death` | `Zeris: Death` | `death` |
| `<Name>: *<action>*` | `Vampire: *attempts to hide in shadows*` | `action` |

**A critical is its own line, separate from the damage it caused.**

```
Vampire: Attack Roll 19 + 7 = 26 : Hit
Vampire: Critical Hit
Mireille: Takes 64 crushing damage from Vampire (32 damage bonus)
```

The crit line's speaker is the attacker, which is also the damage line's `actor` after the source
swap below — so `CritLinker` in `parse.ts` attaches a crit to the next damage event from the same
actor, and sets the `critical` column on it. Crits always precede their damage, so one forward pass
serves both live capture and re-import.

`Critical Hit Averted` is excluded: it means a critical was *prevented*, and the damage following it
is ordinary. Treating it as a crit would be wrong in exactly the cases that matter.

A useful cross-check that the linking is right: on both flagged rows the `damage bonus` is exactly
half the total (64 with +32, 112 with +56) — the doubled portion of a critical.

**Nothing in a damage line says what caused it.** It names the creature and the damage type, never the
weapon or spell. The `spell` column is therefore *inferred*: `EventLinker` attaches the most recent
successful `Casts` by the same actor, within 60 rows. An area spell is not consumed on use, because
one cast produces several damage lines:

```
Gaul: Casts Abi-Dalzim's Horrid Wilting : Fire Elemental
Fire Elemental: Takes 84 magic damage from Gaul
Aerial Servant: Takes 70 magic damage from Gaul
Tyras: Takes 78 magic damage from Gaul
```

Two guards keep the inference honest, both put in on evidence from the captured data:

- **Only damage types in `SPELL_DAMAGE_TYPES` are attributed** — currently just `magic`. Physical
  types are weapon hits. `acid` is excluded because the single acid line in the data (8 acid from
  Gaul) follows a `Greater Malison` cast, and Greater Malison deals no damage at all — attributing it
  would have been wrong. Widen the set only when a session shows that type genuinely coming from a
  spell.
- **Failed casts are a separate kind (`miscast`)** so `Spell Failed: Casting Failure` can never be
  attributed as a damage source. There are three of them in the data, two from Rurik.

Result on the captured session: 12 of 12 magic damage rows attributed, no non-magic row attributed.

**The allowlist audits itself, so a missing spell type cannot stay hidden.** Every damage row also
stores `spell_candidate` — the cast that *would* have been attributed, recorded regardless of damage
type. `deno task patterns` reports the two side by side, and the ratio is the discriminator:

```
  type           rows  after cast  attributed
  magic            12          12          12     <- promoted, every row explained
  missile          11           1           0     <- 1/11, weapon damage; the one hit
  acid              1           1           0        after Entangle/Greater Malison is
  crushing         12           0           0        coincidence, not causation
```

A type where nearly every row follows a cast belongs in `SPELL_DAMAGE_TYPES`; a handful of stray rows
is just a weapon hit that happened to land after someone cast something. Promote, then
`deno task import` re-applies it to every session already captured — no replaying.

**Damage lines are written from the receiving end.** The speaker is the *victim*, and the attacker
appears in the `from …` clause — the opposite of every other line, where the speaker is the one acting.
Taking the speaker as the actor would invert every damage statistic. `parse.ts` handles this with a
named `source` capture group: any rule that defines one gets actor and target swapped, so
`GROUP BY actor SUM(amount)` means "damage dealt", which is what you actually want to ask.

Two consequences for the rules:

- **Speaker extraction first, then classify the remainder.** The name pattern excludes digits and `=`
  so engine text like `Attack Roll 18 -4 = 14 : Hit` is not read as a speaker.
- **Anchor damage and attack rules at the start of the remainder.** `Tyras: When the berserk state
  ends, the character will take 15 damage.` is a *description*, and an unanchored rule counted it as
  damage dealt. Likewise `\bdies\b` needs its leading word boundary, or it matches inside `bodies`.

Combat resolution lines have since been observed and the rules derived from them (see the table
above). What remains unobserved: experience, gold, loot, level-up and party messages — those rules are
still guesses, and `deno task patterns` will surface them when they first appear.

## Telling the party from the opposition

Nothing in a log line says which side anyone is on, so `SideResolver` works it out from evidence.

**The party roster is readable from Lua.** `characters` is an engine-populated table (declared
`characters = {}` at `ui.menu:308`, with both `characters` and `name` present in the binary — the same
arrangement as `combatLog`), and `characters[i].name` is what the inventory and record screens display.
The tap emits an `A7ROSTER` line whenever the roster changes. As with everything else in the tap, it
reads the Lua table directly and calls no `Infinity_*` accessor, because this code can run before a
game exists.

**"Auto-Paused" identifies the party side retroactively.** Auto-pause is a party-side feature, so
anyone who triggers one is on the party's side. In the captured data this named exactly the six party
members and their four summons, and never an enemy — which is what makes sessions recorded before the
roster tap existed still resolvable, with no replay.

**Everyone else is placed by who they fight.** An unknown name that trades damage or attacks with a
party-side name becomes an `opponent`, propagated until stable. Names that only ever talk stay
`neutral`.

**Party membership always beats the combat graph.** This is the guard that matters: the captured
session contains `Rurik -> Zeris 1x 8`, a real friendly-fire hit. Plain two-coloring of the damage
graph would have made Zeris an opponent. Because auto-pause had already named him party, he stays
party — and the row surfaces as `party -> party`, which is a useful thing to be able to query rather
than a bug to hide.

Resolved on the captured data:

```
  party     Alarion, Vidania, Tyras, Rurik, Mireille, Zeris
            + Fire Elemental, Aerial Servant, Deva, Skeleton Warrior   (summons)
  opponent  Vampire, Gaul
  neutral   Dennaton, Tartle                                           (arena announcers)

  damage    opponent -> party  23x 1223
            party -> opponent  24x  342
            party -> party      1x    8   (friendly fire)
```

**Sides are resolved per session, and `neutral` means "no evidence here", not "friendly".** Gaul comes
out `opponent` in the session where he fights and `neutral` in the earlier one where he only speaks and
casts Stoneskin on himself. That is an honest reading of each session in isolation; carrying a label
across sessions would be guessing, since the same name is not necessarily the same creature.

## Toolchain verification

- `deno 2.9.6`.
- **`node:sqlite`** (`DatabaseSync`) works with **no flags and no dependencies** — confirmed with a
  CREATE / INSERT / `GROUP BY … ORDER BY sum()` round-trip. Chosen over `jsr:@db/sqlite`, which needs
  `--allow-ffi` and downloads a prebuilt native library.
- **`Deno.Command("script", …)`** with `stdout: "piped"` streams a pty-wrapped child correctly.
  Artifacts to strip: macOS `script` emits a leading `^D\b\b`, and the pty makes line endings `\r\n`.
  Both are handled in `parse.ts`.

## Worklog

**Build.** Project scaffolded under `Documents/BG2EE-GameLog`; WeiDU mod (`mod/gamelog`), capture
(`play.ts`), parse/store (`parse.ts`, `db.ts`), re-import (`import.ts`), rule refinement
(`patterns.ts`), viewer (`serve.ts`, `web/viewer.html`), docs.

**Resolved — the `Infinity_Log` gate. It works.** Confirmed against the running game: the tap's
load-time line came through, and so does the stock UI's own logging (`INFO: LUA: Initializing Quests`
from `bgee.lua:3153`). The `Infinity_WriteINILine` fallback is not needed.

**The output is not emitted verbatim.** `Infinity_Log` reaches stdout wrapped in the platform log
prefix:

```
2026-08-31 00:11:26.976 BaldursGateIIEnhancedEdition[88424:110912244] INFO: LUA: A7LOG<TAB>0<TAB>...
```

So `parse.ts` locates the `A7LOG` marker rather than anchoring at the start of the line, and requires
any prefix to contain `LUA:` so the marker appearing inside game text cannot be mistaken for a tap
line. The leading timestamp is harvested as the event's real wall-clock time — a column that would not
have existed if the prefix had not turned up.

**Two bugs the live test caught, both fatal, both fixed:**

1. **Engine accessors segfault at UI-load time.** The load-time probe originally called
   `Infinity_GetGameTicks()` / `Infinity_GetCurrentScreenName()`. That chunk runs while `ui.menu` is
   being loaded, before any game exists, so those dereference a null game pointer and kill the process
   (exit 139, SIGSEGV) about one second into startup — before the UI Lua runs, which is why nothing
   was logged. `pcall` does **not** help: it catches Lua errors, not C++ crashes. The probe now emits
   a constant string and touches no engine state. Accessors are still used in `A7LOG_drain`, which
   only runs once `combatLog` has rows, i.e. once a game is loaded.
2. **The `table.remove` wrapper broke arity.** Written as `function(t, pos, ...)`, it turned every
   single-argument `table.remove(t)` call anywhere in the UI into `table.remove(t, nil)`, which errors
   in Lua 5.2. It now forwards varargs untouched: `function(t, ...)`.

Bisecting these was worth the trouble: with the broken tap the game exited cleanly and silently at
51 lines of stdout with no crash report and no error message, which looks identical to "the transport
does not work". The control — same launch, mod uninstalled — ran fine, which is what localized it.

**Verified end to end:** tap → `Infinity_Log` → stdout → pty capture → parse (prefix stripped,
wall-clock harvested) → SQLite, read concurrently by `serve.ts` while the game was still running (WAL
works). `deno task install-mod --uninstall` restores `override/ui.menu` exactly and removes
`override/a7log.lua`. No `LUA ERROR` lines in the session.

**Confirmed over a full play session (537 events in one session, 706 total).**

- **Ids are gapless.** `min(id)..max(id)` is `0..536` with 537 rows and nothing missing, across a
  session long enough to scroll the log well past its cap. The `table.remove` trim counter does what
  it was designed to do.
- **The HUD is unaffected** — the session ran normally with the injected labels, no `LUA ERROR` lines.
- **Classification against real combat**: 706 events, 3 remaining as `other` — and those three are the
  tap's own `gamelog tap loaded` marker, which has no speaker and is correctly unclassified. The
  earlier round left 240 unmatched.

**Open — classification rules.** The rules in `src/parse.ts` are provisional and deliberately
conservative: the feedback wording is version- and mod-dependent, and no verified corpus of BG2:EE
message strings was available at build time (the templates are assembled from `dialog.tlk` with token
substitution such as `<CRITICALROLL>`, `<EXPERIENCEAMOUNT>`, `<RESISTED>`, `<THAC0>`, rather than
stored as complete sentences). Unmatched lines are preserved verbatim as `kind='other'`. Refine from a
real session with `deno task patterns`, then `deno task import`.
