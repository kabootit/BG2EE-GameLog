# BG2EE-GameLog

Exports Baldur's Gate II: Enhanced Edition's in-game message window to a queryable SQLite database
with a local web viewer — so the combat log can be sorted, searched and grouped instead of just
scrolled.

![The viewer showing damage events from one fight: side, actor, summon, target, damage type, amount
and the spell responsible, sorted by actor](resources/viewer.png)

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
   (Lua)                                (capture + parse)   (SQLite)        (localhost)
```

No EEex, no binary patching. Tested on BG2:EE 2.7.3, macOS.

## Requirements

- Baldur's Gate II: Enhanced Edition
- [Deno](https://deno.com) 2.2+ — uses the built-in `node:sqlite`, no packages to install
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
deno task patterns      # show unclassified lines and unattributed damage types
deno task lint          # lint, type-check, and audit the security invariants
```

`deno task install-mod --uninstall` restores the original `ui.menu`.

## What gets captured

Each row carries the raw text plus derived fields: `kind`, `actor`, `target`, `amount`, `detail`,
`critical`, `spell`, `actor_side` / `target_side` (party / opponent / neutral) and `summon`.

Some of these are inferred rather than stated — the log never says which spell caused a hit, or whose
side anyone is on. See `learnings/EVENT-STREAM-STRUCTURING.md` for how, and what the inference
deliberately refuses to guess.

## Layout

```
src/          capture, parse, store, serve
web/          self-contained viewer
mod/gamelog/  the WeiDU mod and the in-game Lua tap
logs/         raw captured sessions - the source of truth
learnings/    general write-ups, stack-agnostic
docs/         project-specific documentation
skills/       the security audit procedure
```

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
| `../skills/security.md` | the audit procedure — the judgement half `deno task lint` cannot check |

## Caveats

- `override/ui.menu` is shared state. Any mod that rewrites it removes the tap — reinstall afterwards.
- Only what the game displays is captured. Turn on **Extra Combat Info** and **Extra Feedback** in the
  game's Feedback options for a much richer stream.
- Classification rules target `en_US` and are still incomplete; `deno task patterns` reports what is
  unmatched, and `deno task import` re-applies new rules to sessions already recorded.
