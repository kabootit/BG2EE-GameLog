# BG2EE-GameLog

Exports Baldur's Gate II: Enhanced Edition's in-game message window (the combat log) to a queryable
SQLite database with a local web viewer, so the event stream can be sorted, searched and grouped.

## Toolchain

**Use Deno for everything** — tooling, scripts, servers, one-off tasks. All entry points go through
`deno task`.

**Imports are limited to Deno built-ins (`node:sqlite`, `Deno.*`) and the Deno standard library
(`jsr:@std/*`), with a pinned major version.** No npm, no other jsr scope, no raw URLs. Prefer `@std`
over hand-rolling: it replaced a manual line buffer, a recursive hex encoder, and a date formatter
here. But check the semantics match before swapping — `@std/fs` `copy()` removes the destination
first, which would have destroyed WeiDU's uninstall backup, so `copyTree()` in `install_mod.ts` stays
hand-written with a comment saying why.

**For dates and times use `Temporal`, not `Date` and not `@std/datetime`.** It is a global in Deno
2.9.6 with no unstable flag and no lib config needed, and its types are built in. `Temporal` makes the
local-vs-instant distinction explicit where `Date` leaves it ambiguous: `Temporal.Now
.plainDateTimeISO()` is unambiguously a local wall clock, which is what a session filename wants.
`Temporal.PlainDateTime.from()` also parses the engine's space-separated log timestamps
(`2026-01-01 00:00:00.000`) without reformatting, so nothing stored needs converting.

**Do not use Python, perl, awk, sed, or shell scripts — for anything, including throwaway work.**
Calling a system binary from `Deno.Command` is fine (`src/play.ts` invokes `script` because Deno has
no pty support, and without a pty the game's stdout block-buffers at 4 KB), but the orchestration
lives in TypeScript.

This governs *how the work is done*, not just what ships:

- **Read or search a file** → the Read and Grep tools, not `cat` / `sed` / `grep` pipelines.
- **Edit a file** → the Edit and Write tools. Never `perl -i`, never a heredoc.
- **Check behavior** → a test in `src/*_test.ts` run by `deno task test`, not a one-off `deno eval`
  whose output is eyeballed once and thrown away.
- **Shell** → invoking `deno`, plus genuine process inspection (`pgrep`, `lsof`). Nothing else.

Not a style preference. Every shell detour in this project has cost something real: an apostrophe in
`Baldur's Gate` breaking quoting mid-command, a zsh glob failure silently skipping a setup step so a
test proved nothing, zsh not word-splitting a file list so a substitution never ran at all. The tools
do not have those failure modes.

## Conventions

- **This project must not compromise the machine it runs on.** It executes an external binary, patches
  a game install, injects code into a running process, captures everything that process prints, and
  serves it over HTTP. Read `docs/SECURITY.md` before touching any of those paths, and keep the
  invariants listed there — no dependencies, bind loopback, bind SQL values and allowlist identifiers,
  escape HTML, redact at capture, ask before executing anything not shipped here. `deno task lint`
  enforces the mechanical half; `skills/security.md` is the procedure for the half that needs
  judgment. Run it before publishing anything or adding a capture path, command, or permission.

- **Never `git push` without explicit confirmation.** Hard rule. Applies to anything that leaves the
  machine — pushing, creating or changing remotes, publishing. Commit locally, report what is staged,
  then ask. Local operations (staging, committing, branching) need no permission.

  **Ask immediately before the push, every time — an earlier instruction does not carry.** "Commit and
  push" is a request for the whole job, not advance authorization for the push half: make the commits,
  then stop and ask.
- **Show the commit message before committing.** Every time, and for every commit — a batch of
  messages approved once is not a substitute for reading each one before its commit lands. Propose it,
  wait for approval or a rewording, then commit. Applies to `--amend` too, since that rewrites a
  message.
- **Commit at logical boundaries, not per edit.** One commit per completed change, however many file
  edits that took. While something is still being iterated on — a paragraph being reworded, a rule
  being tuned — `--amend` the in-progress commit instead of stacking new ones. Six commits that all
  say some version of "adjust the caption" are one change, and should read as one.
- **No personal information** in any file, document, or commit message: no email addresses, no real
  names. Derive filesystem paths from `Deno.env.get("HOME")` (see `src/config.ts`); never hardcode a
  home directory.
- **`logs/` is gitignored, but keep redacting anyway.** The engine's startup output contains the
  Steam account id and absolute home-directory paths, so `redact()` in `src/play.ts` strips both as
  each session is written. If you add another capture path, redact there too. The repo is public and
  a few early sessions are still tracked as sample data, so redaction cannot be treated as optional
  just because new captures stay local — cleaning it up afterwards only works if someone remembers.
- **No AI attribution** anywhere: no `Co-Authored-By` trailers, no "generated with" footers, no
  tool-credit lines in code, docs, or commits.
- Every path in `src/config.ts` can be overridden by an environment variable.

## Layout

```
src/play.ts         launch the game, capture stdout, parse and insert live
src/import.ts       rebuild events.db from raw session logs (idempotent)
src/patterns.ts     report unclassified lines, to refine the rules in parse.ts
src/serve.ts        read-only HTTP API + viewer
src/parse.ts        tap line -> structured event; classification rules live here
src/protections.ts  effect semantics - DOMAIN KNOWLEDGE, not log-derived; keep that distinction
src/combatants.ts   pure fold: events -> per-creature observed state, with age and source
src/*_test.ts       `deno task test`. Add real-data cases here, not throwaway `deno eval`
src/db.ts           schema, WAL, prepared upserts
src/config.ts       all paths and settings
src/install_mod.ts  copy the WeiDU mod into the game dir and run WeiDU
web/                one page per view: events.html, combatants.html, plus shared
                    app.css and common.js. Routes are an explicit map in serve.ts -
                    a request path never reaches the filesystem. No CDN, no
                    external requests. Every page must import esc() from
                    /common.js; `deno task lint` checks all of web/, not one file
mod/gamelog/        the WeiDU mod: gamelog.tp2 + lib/a7log.lua (the in-game tap)
docs/               project-specific: PLAN.md (design), FINDINGS.md (how it works, worklog),
                    GOTCHAS.md (traps specific to this stack - read before touching ui.menu or the
                    tap), SECURITY.md (this project's policy and accepted risk)
learnings/          general write-ups, source material for longer pieces:
                    EVENT-STREAM-STRUCTURING.md, LOCAL-TOOL-SECURITY.md.
                    KEEP THESE STACK-AGNOSTIC - no engine, WeiDU, Lua or Deno specifics.
                    Project detail belongs in docs/, not here.
skills/             security.md - the audit procedure
logs/               raw captured sessions; the source of truth, never rewritten
```

## Tasks

| task | what it does |
|---|---|
| `deno task install-mod` | copy `mod/gamelog` into the game dir and install it with WeiDU |
| `deno task play` | launch the game and capture a session |
| `deno task serve` | viewer on `http://127.0.0.1:8787/` |
| `deno task import` | re-import raw logs after changing classification rules |
| `deno task patterns` | show the most frequent unclassified lines |
| `deno task check` | type-check |
| `deno task test` | run the test suite |
| `deno task lint` | lint, type-check, test, and audit the security invariants (see `skills/security.md`) |

## Things that will bite you

`docs/GOTCHAS.md` has the full set with evidence. The ones that cost real time:

- **Never call engine accessors (`Infinity_GetGameTicks`, `Infinity_GetCurrentScreenName`, …) from
  code that runs while `ui.menu` is loading.** No game exists yet, so they segfault the process — and
  `pcall` will not save you, because that is a C++ crash, not a Lua error. The symptom is a clean
  silent exit that looks exactly like "the tap did nothing".
- **When wrapping a variadic function, forward `...`; never name an intermediate positional.**
  `function(t, pos, ...)` turns `table.remove(t)` into `table.remove(t, nil)` and breaks every
  single-argument caller.
- **`Infinity_Log` output arrives wrapped** in `<timestamp> <proc>[pid:tid] INFO: LUA: `, so the parser
  locates the marker rather than anchoring at the start of the line.


- **`override/ui.menu` is shared state.** The tap is installed by patching it. Any mod that rewrites
  `ui.menu` (iwdification and most UI mods do) silently removes the tap. Reinstall this component
  after any change to the game's mod set — `deno task install-mod`.
- **The classification rules in `src/parse.ts` are provisional.** The engine builds feedback text from
  `dialog.tlk` with token substitution; the exact wording varies by game version and is rewritten by
  mods. Unmatched lines are kept verbatim as `kind='other'` rather than mislabeled — use
  `deno task patterns` on a real session to find what to add, then `deno task import` to re-classify
  without replaying.
- **`SPELL_DAMAGE_TYPES` in `src/parse.ts` will need widening as new spell schools appear.** The
  damage lines never name their cause, so the `spell` column is inferred from a preceding cast, and
  only for damage types on that list (currently just `magic`) — attributing a weapon hit to a spell is
  worse than leaving it blank. You do not have to remember to check: every damage row also records
  `spell_candidate`, and `deno task patterns` prints rows / after-cast / attributed per damage type.
  A type where nearly every row follows a cast should be promoted; then `deno task import`.
- **`actor_side` / `target_side` are inferred per session, and `neutral` means "no evidence".** A
  creature that only talks in one session and fights in the next is `neutral` in the first and
  `opponent` in the second. Labels are deliberately not carried across sessions — the same name is not
  necessarily the same creature.
- **Only what the game displays is captured.** This taps the message window, not engine internals.
  Turning up the in-game Feedback options (Extra Combat Info, Extra Feedback) produces a much richer
  stream.
- **`play.ts` is the only writer.** `serve.ts` opens the database read-only in effect; WAL is what
  lets the viewer refresh while a session is being captured.
