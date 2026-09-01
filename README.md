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
    nothing linking them. <a href="docs/EVENT-STREAM-STRUCTURING.md">How that works</a>.
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
  and uninstall behaviour is what makes patching a shared `ui.menu` safe to iterate on.
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
```

`deno task install-mod --uninstall` restores the original `ui.menu`.

## What gets captured

Each row carries the raw text plus derived fields: `kind`, `actor`, `target`, `amount`, `detail`,
`critical`, `spell`, `actor_side` / `target_side` (party / opponent / neutral) and `summon`.

Some of these are inferred rather than stated — the log never says which spell caused a hit, or whose
side anyone is on. See `docs/EVENT-STREAM-STRUCTURING.md` for how, and what the inference deliberately
refuses to guess.

## Layout

```
src/          capture, parse, store, serve
web/          self-contained viewer
mod/gamelog/  the WeiDU mod and the in-game Lua tap
logs/         raw captured sessions - the source of truth
docs/         see below
```

## Docs

| file | what it covers |
|---|---|
| `docs/EVENT-STREAM-STRUCTURING.md` | the general method: turning an unstructured event stream into structured data |
| `docs/FINDINGS.md` | how the engine works and why this approach was possible |
| `docs/LEARNINGS.md` | stack-specific gotchas (Infinity Engine, Lua, Deno, browser) |
| `docs/PLAN.md` | the original design |

## Caveats

- `override/ui.menu` is shared state. Any mod that rewrites it removes the tap — reinstall afterwards.
- Only what the game displays is captured. Turn on **Extra Combat Info** and **Extra Feedback** in the
  game's Feedback options for a much richer stream.
- Classification rules target `en_US` and are still incomplete; `deno task patterns` reports what is
  unmatched, and `deno task import` re-applies new rules to sessions already recorded.
