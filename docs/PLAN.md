# Pipe BG2:EE's in-game activity log out to a queryable dataset

## Context

The in-game message window ("combat log") is a bare append-only stream: no sorting, searching,
grouping, or filtering. The goal is to get that same event stream out of the running game and into
something queryable — a SQLite DB behind a local Deno HTTP server with a sortable/filterable/
groupable viewer.

This turns out to be possible **without EEex and without any binary patching**, because of three
facts verified on this exact install (Steam BG2:EE, macOS, engine build **2.7.3**):

1. **The combat log is a plain Lua table.** `override/ui.menu:21` declares `combatLog = {}`, and the
   message window (`menu 'WORLD_MESSAGES'`, `ui.menu:12369-12388`) renders it via
   `text lua "combatLog[rowNumber]"` / `table "combatLog"`. The engine appends already-TLK-resolved
   strings to it from C++ and trims it by executing the Lua chunk `table.remove(combatLog, %d)`
   (literal present in the binary). So every line the player sees is readable from Lua.
2. **`override/ui.menu` is already a loose, editable, plaintext file** (473 KB) — iwdification
   extracted it from the biffs during its install. No biff extraction needed.
3. **`Infinity_Log(str)` exists and writes to the process's stdout/stderr.** Vanilla UI code uses it
   (`bgee.lua:3153`, `ui.menu:830`). Launching the binary from a terminal captures it.

Constraints that shape the design:

- The engine's Lua 5.2 sandbox has **no `io` and no `os` library** (verified: no `luaopen_io`/
  `luaopen_os`, none of the liolib marker strings in the binary). Available: `string table math
  coroutine package bit32 debug pcall print dofile require`. So Lua **cannot open a file** — data
  must leave via `Infinity_Log` (stdout) or `Infinity_WriteINILine` (writes into `Baldur.lua`).
- **EEex is not an option here**: Windows-only native (macOS only "via Wine, untested"), and it
  targets game v2.6.6.0 while this install is 2.7.3.
- `Debug Mode` is already `1` in `Baldur.lua`, so the in-game Lua console (Ctrl+Space) is available
  for testing snippets without restarting.

**Scope decisions (from the user):** SQLite + HTML viewer, served by Deno; the tap packaged as a
WeiDU mod; BG2:EE only; Deno for all tooling (no Python, no shell scripts); project under `Documents`.

### Verified toolchain facts

- `deno 2.9.6` at `$HOME/.cargo/bin/deno`.
- `node:sqlite` (`DatabaseSync`) works in this build **with no flags and no dependencies** —
  confirmed by running a CREATE / INSERT / `GROUP BY … ORDER BY sum()` round-trip. Preferred over
  `jsr:@db/sqlite`, which needs `--allow-ffi` and downloads a prebuilt native library.
- `Deno.Command("script", …)` with `stdout: "piped"` streams a pty-wrapped child correctly —
  confirmed. **Gotcha:** macOS `script` emits a leading `^D\b\b` artifact and uses `\r\n` line
  endings, so the reader must strip `\r` and ignore non-`A7LOG` noise.

---

## Architecture

```
 ui.menu tap  ──Infinity_Log──▶ stdout ──▶ play.ts (pty capture + parse) ──▶ events.db
      (Lua)        "A7LOG\t…"                        │                        (WAL)
                                            logs/session-*.log (raw)              │
                                                                           serve.ts (Deno.serve)
                                                                                  │
                                                                            viewer.html
```

`play.ts` is the only writer; `serve.ts` only reads. With `PRAGMA journal_mode=WAL` the viewer can be
refreshed live mid-session.

### Project root — `$HOME/Documents/BG2EE-GameLog/`

```
CLAUDE.md                 # toolchain + conventions (see Part 5)
deno.json                 # tasks + permissions, no external deps
docs/
  PLAN.md                 # this plan, kept in-project
  FINDINGS.md             # engine research + implementation worklog
src/
  play.ts                 # launch game under pty, tee raw log, parse + insert live
  import.ts               # backfill events.db from an existing session log
  serve.ts                # Deno.serve() — viewer + /api/events
  parse.ts                # A7LOG line -> structured event (shared by play/import)
  db.ts                   # node:sqlite schema, WAL, prepared upserts
  config.ts               # game paths (binary, override/ui.menu, Baldur.lua)
web/
  viewer.html             # client: search / sort / group-by, light+dark
mod/gamelog/
  gamelog.tp2             # WeiDU mod that patches override/ui.menu
  lib/tap.lua             # the injected Lua, kept separate for readability
logs/                     # session-YYYYmmdd-HHMMSS.log (raw stdout)
events.db
```

`deno.json` tasks:

| task | command |
|---|---|
| `deno task play` | `deno run --allow-run --allow-read --allow-write src/play.ts` |
| `deno task serve` | `deno run --allow-read --allow-write --allow-net src/serve.ts` |
| `deno task import` | `deno run --allow-read --allow-write src/import.ts logs/<file>` |

---

## Part 1 — The in-game tap (WeiDU mod)

### `mod/gamelog/lib/tap.lua` — injected right after `combatLog = {}`

The engine appends to `combatLog` via the C API (no metatable hook possible) and trims the front with
`table.remove`. So: wrap `table.remove` to count trims, giving a stable monotonic row index, then
poll for rows past the last one emitted.

```lua
-- gamelog tap: export combatLog rows to stdout via Infinity_Log
if not A7LOG_installed then
  A7LOG_installed = true
  A7LOG_trimmed = 0   -- rows the engine has removed off the front
  A7LOG_emitted = 0   -- absolute index of the last row exported
  local _remove = table.remove
  table.remove = function(t, pos, ...)
    if t == combatLog then A7LOG_trimmed = A7LOG_trimmed + 1 end
    return _remove(t, pos, ...)
  end
end

function A7LOG_tick()
  local total = A7LOG_trimmed + #combatLog
  if A7LOG_emitted < A7LOG_trimmed then
    A7LOG_emitted = A7LOG_trimmed          -- rows scrolled off before we saw them
  end
  while A7LOG_emitted < total do
    A7LOG_emitted = A7LOG_emitted + 1
    local row = combatLog[A7LOG_emitted - A7LOG_trimmed]
    if row then
      Infinity_Log(string.format("A7LOG\t%d\t%s\t%s\t%s\t%s",
        A7LOG_emitted,
        tostring(Infinity_GetGameTicks()),
        tostring(Infinity_GetClockTicks()),
        tostring(Infinity_GetTimeString()),
        tostring(Infinity_GetCurrentScreenName()),
        (tostring(row):gsub("[\r\n\t]", " "))))
    end
  end
  return ""
end
```

Notes:
- The `A7LOG_installed` guard matters — `ui.menu` is re-executed on UI reloads (main menu ↔ game),
  which would otherwise double-wrap `table.remove` and reset counters mid-session.
- `A7LOG_tick()` is idempotent, so calling it from more than one place per frame is safe.
- Wrap the body of `A7LOG_tick` in `pcall` at implementation time — a Lua error inside a `text lua`
  expression is noisy and could disrupt the HUD.

### Tick source

UI.MENU evaluates `text lua "…"` for every rendered element each frame. Add a zero-size hidden label
with `text lua "A7LOG_tick()"` to **both**:

- `menu 'LEFT_SIDEBAR'` (`ui.menu:4963`) — the portrait bar, effectively always on-screen in play
- `menu 'WORLD_MESSAGES'` (`ui.menu:12330`) — belt-and-braces if the sidebar is collapsed

### `mod/gamelog/gamelog.tp2`

```
BACKUP ~gamelog/backup~
VERSION ~1.0~

BEGIN ~Combat log export tap~
  REQUIRE_PREDICATE GAME_IS ~bg2ee eet~ ~BG2:EE only~
  DESIGNATED 0

  COPY_EXISTING ~ui.menu~ ~override~
    REPLACE_TEXTUALLY ~combatLog = {}~ ~combatLog = {}
<tap.lua contents>~
    // + two REPLACE_TEXTUALLY anchors inserting the hidden label into
    //   LEFT_SIDEBAR and WORLD_MESSAGES
```

Read `lib/tap.lua` at install time rather than duplicating the Lua inside the tp2. Because it goes
through WeiDU's `BACKUP`, `--uninstall` cleanly restores the current `ui.menu`.

The mod folder must be copied into the game directory to install (same as the other mods there); a
`deno task install-mod` can do that copy and shell out to the existing WeiDU binary already present
in the game dir.

**Ordering caveat:** install this *after* iwdification and any other `ui.menu` mod. Re-running those
later overwrites `override/ui.menu` and silently drops the tap — reinstall this component after any
mod change.

---

## Part 2 — Capture (`src/play.ts`)

One Deno process does launch + capture + parse + insert, so there is no separate pipeline step.

Game binary:

```
$HOME/Library/Application Support/Steam/steamapps/common/Baldur's Gate II Enhanced Edition/BaldursGateIIEnhancedEdition.app/Contents/MacOS/BaldursGateIIEnhancedEdition
```

Launching it directly works because `steam_appid.txt` sits in the game dir (Steam client must be
running).

```ts
new Deno.Command("script", {
  args: ["-q", "/dev/null", GAME_BINARY],
  stdout: "piped", stderr: "piped",
})
```

`script` is what allocates the pty. Without it, stdout is a pipe and libc block-buffers at 4 KB, so
events would arrive in bursts and live viewing would lag badly.

The reader then:
- decodes, splits on `\n`, strips trailing `\r` and the leading `^D\b\b` artifact;
- writes every raw line to `logs/session-<ts>.log` (nothing is discarded — the raw log is the
  source of truth and can always be re-imported);
- for lines starting with `A7LOG\t`, parses and inserts into `events.db`;
- surfaces any `LUA ERROR:` lines to the console immediately, since those mean the tap is broken.

## Part 3 — Parse and store (`src/parse.ts`, `src/db.ts`)

`parse.ts` splits the 6 TSV fields, strips colour codes (`^#RRGGBBAA…^-`), and classifies the message
text into structured columns:

| column | source |
|---|---|
| `id` | absolute row index from the tap (monotonic; gaps are detectable) |
| `session` | session log filename |
| `game_ticks`, `clock_ms`, `game_time` | tap fields |
| `screen` | `Infinity_GetCurrentScreenName()` |
| `kind` | regex classification: `attack`, `damage`, `death`, `xp`, `save`, `spell`, `loot`, `dialog`, `chapter`, `other` |
| `actor`, `target`, `amount` | regex capture groups per kind |
| `raw` | original text, colour codes stripped |

Classification is regex-over-English-text and will not be exhaustive on the first pass. Anything
unmatched lands in `kind='other'` with `raw` intact, so **nothing is ever lost**; patterns get added
incrementally by querying the unmatched bucket:

```sql
SELECT raw, count(*) n FROM events WHERE kind='other' GROUP BY raw ORDER BY n DESC LIMIT 40;
```

`db.ts` opens `events.db` with `DatabaseSync` from `node:sqlite`, sets `PRAGMA journal_mode=WAL`,
creates the `events` table with indexes on `(session,id)`, `kind`, `actor`, `target`, and exposes a
prepared `INSERT OR REPLACE` keyed on `(session, id)` so re-imports are idempotent.

`import.ts` reuses the same parse + insert path against an existing session log — needed for
backfilling and for iterating on regexes without replaying the game.

## Part 4 — Serve (`src/serve.ts`, `web/viewer.html`)

`Deno.serve()` on `127.0.0.1:8787`, no framework:

- `GET /` → `web/viewer.html`
- `GET /api/events?q=&kind=&actor=&sort=&dir=&limit=&offset=` → JSON rows, built as a
  **parameterised** SQL query (column names validated against an allowlist, values always bound)
- `GET /api/groups?by=actor|target|kind` → aggregates: event count, total/avg damage, hits, crits
- `GET /api/sessions` → session list for the picker

The viewer is a self-contained page (no CDN — nothing external) with a search box, sortable column
headers, a group-by selector, a session picker, and a refresh button for live use during a session.

## Part 5 — Project documentation and conventions

Written as part of the build, not afterwards.

### `CLAUDE.md` (project root)

The toolchain policy, so future sessions in this project don't drift:

- **Use Deno** for all tooling, scripts, servers, and one-off tasks. Everything runs through
  `deno task`. Prefer the standard library and built-in modules (`node:sqlite`, `Deno.serve`,
  `Deno.Command`) over third-party dependencies.
- **Do not use Python.** Do not use shell scripts (`.sh`) — invoking a system binary such as `script`
  from `Deno.Command` is fine, but the orchestration lives in TypeScript.
- **No personal information** in any file, doc, or commit message: no email addresses, no real names.
  Derive filesystem paths from `Deno.env.get("HOME")` rather than hardcoding a home directory.
- **No AI attribution** in commits or files: no `Co-Authored-By` trailers, no "generated with"
  footers, no tool-credit lines.
- Also record the project layout, the `deno task` list, and the WeiDU reinstall caveat for
  `override/ui.menu`.

### `docs/PLAN.md`

This plan, copied into the project so the design rationale lives with the code.

### `docs/FINDINGS.md`

The record of what was done and why it works — durable and easy to lose otherwise:

- the engine research: `combatLog` as a live Lua table (`ui.menu:21`, `:12369-12388`), the
  `table.remove(combatLog, %d)` trim behaviour, `Infinity_Log` as the only stdout channel, the
  missing `io`/`os` libraries, and why EEex was ruled out (Windows-only, targets 2.6.6.0 vs 2.7.3);
- toolchain verification: `node:sqlite` works flagless on Deno 2.9.6; `Deno.Command` + `script`
  streams a pty, with the `^D\b\b` / `\r\n` artifacts to strip;
- an implementation worklog appended as each part lands, including the outcome of the
  `Infinity_Log` gate in step 1 of Verification.

## Settings to enrich the stream

The tap only exports what the game chooses to display, so turn the feedback taps up first. In
`~/Documents/Baldur's Gate II - Enhanced Edition/Baldur.lua` (or the in-game Feedback options panel):

```
SetPrivateProfileString('Game Options','Extra Combat Info','1')   -- currently 0: adds to-hit rolls
SetPrivateProfileString('Game Options','Extra Feedback','1')      -- currently 0
SetPrivateProfileString('Game Options','GUI Feedback Level','5')  -- already 5 (max)
SetPrivateProfileString('Game Options','Effect Text Level','63')  -- already 63 (max)
```

---

## Verification

Staged, so a failure is localised. **Step 1 is a gate** — everything downstream assumes it passes.

1. **Does `Infinity_Log` reach stdout?** (~2 min, before writing the mod.) Run the game binary under
   `script` from a terminal, load a save, open the console with **Ctrl+Space**, run
   `Infinity_Log("A7LOG probe 123")`, quit, and grep the captured file for `A7LOG probe`.
   - *If it does not appear:* fall back to `Infinity_WriteINILine` writing into a dedicated section
     of `Baldur.lua`, with `play.ts` polling and draining that section instead of reading stdout.
     Same tap, same parser, same DB — only the transport changes. Tradeoff: pollutes the config file,
     and the engine rewrites `Baldur.lua` wholesale on exit, so the drain must run continuously.
2. **Tap emits rows.** Install the WeiDU component, `deno task play`, load a save, take a few swings
   at something. Confirm the session log has `A7LOG` lines matching the on-screen message window,
   with strictly increasing ids.
3. **Trim handling.** Fight long enough for the log to scroll (>100 lines). Confirm ids stay
   monotonic with no duplicates and no gaps — this is what the `table.remove` wrapper buys.
4. **UI intact.** No `LUA ERROR:` lines in the session log; portrait bar and message window render
   normally; the message window still scrolls and resizes.
5. **DB + server.** `deno task serve` mid-session, then confirm sort, free-text search, and group-by
   all work, that per-actor damage totals match a hand-count from the raw log for a short fight, and
   that a refresh during play picks up new rows (WAL check).
6. **Re-import is idempotent.** `deno task import` on the same session log twice → row count
   unchanged.
7. **Clean uninstall.** WeiDU `--uninstall` restores `override/ui.menu`; game still launches.
8. **Docs land.** `CLAUDE.md`, `docs/PLAN.md`, and `docs/FINDINGS.md` exist, `FINDINGS.md` records the
   step-1 gate outcome, and no file in the project contains an email address, a real name, or an AI
   attribution line.

## Known limits

- **Only what the game displays** gets captured — this is a tap on the message window, not on engine
  internals. Events the game never prints (e.g. exact enemy HP) are not recoverable this way.
- **Text parsing is language- and mod-dependent.** It targets `en_US`; strings changed by iwdification
  or other mods may need extra regexes. The `kind='other'` bucket makes this visible rather than silent.
- **Per-frame polling** on a bounded table — negligible cost, but the tap runs inside the render path,
  so the `pcall` guard is not optional.
- **`override/ui.menu` is shared state.** Any mod that rewrites it drops the tap until reinstalled.
- **`script` is a system binary**, not a shell script — it is the only practical way to get a pty on
  macOS, since Deno has no built-in pty support.
