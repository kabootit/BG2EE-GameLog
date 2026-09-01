# BG2EE-GameLog

Exports Baldur's Gate II: Enhanced Edition's in-game message window (the combat log) to a queryable
SQLite database with a local web viewer, so the event stream can be sorted, searched and grouped.

## Toolchain

**Use Deno for everything** — tooling, scripts, servers, one-off tasks. All entry points go through
`deno task`. Prefer the standard library and built-in modules (`node:sqlite`, `Deno.serve`,
`Deno.Command`) over third-party packages. This project currently has **zero dependencies**; keep it
that way unless there is a concrete reason not to.

**Do not use Python. Do not write shell scripts (`.sh`).** Calling a system binary from
`Deno.Command` is fine — `src/play.ts` invokes `script` because Deno has no pty support and without a
pty the game's stdout block-buffers at 4 KB — but the orchestration lives in TypeScript.

## Conventions

- **This project must not compromise the machine it runs on.** It executes an external binary, patches
  a game install, injects code into a running process, captures everything that process prints, and
  serves it over HTTP. Read `docs/SECURITY.md` before touching any of those paths, and keep the
  invariants listed there — no dependencies, bind loopback, bind SQL values and allowlist identifiers,
  escape HTML, redact at capture, ask before executing anything not shipped here. `deno task lint`
  enforces the mechanical half; `skills/security.md` is the procedure for the half that needs
  judgement. Run it before publishing anything or adding a capture path, command, or permission.

- **Never `git push` without explicit confirmation.** Hard rule. Applies to anything that leaves the
  machine — pushing, creating or changing remotes, publishing. Commit locally, report what is staged,
  then ask. Local operations (staging, committing, branching) need no permission.
- **Show the commit message before committing.** Every time. Propose it, wait for approval or a
  rewording, then commit. Applies to `--amend` too, since that rewrites a message.
- **Commit at logical boundaries, not per edit.** One commit per completed change, however many file
  edits that took. While something is still being iterated on — a paragraph being reworded, a rule
  being tuned — `--amend` the in-progress commit instead of stacking new ones. Six commits that all
  say some version of "adjust the caption" are one change, and should read as one.
- **No personal information** in any file, document, or commit message: no email addresses, no real
  names. Derive filesystem paths from `Deno.env.get("HOME")` (see `src/config.ts`); never hardcode a
  home directory.
- **`logs/` is committed and the repo is public.** The engine's startup output contains the Steam
  account id and absolute home-directory paths, so `redact()` in `src/play.ts` strips both as each
  session is written. If you add another capture path, redact there too — cleaning it up afterwards
  only works if someone remembers.
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
src/db.ts           schema, WAL, prepared upserts
src/config.ts       all paths and settings
src/install_mod.ts  copy the WeiDU mod into the game dir and run WeiDU
web/viewer.html     self-contained viewer (no CDN, no external requests)
mod/gamelog/        the WeiDU mod: gamelog.tp2 + lib/a7log.lua (the in-game tap)
docs/               project-specific: PLAN.md (design), FINDINGS.md (how it works, worklog),
                    LEARNINGS.md (stack-specific gotchas - read before touching ui.menu or the
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
| `deno task lint` | lint, type-check, and audit the security invariants (see `skills/security.md`) |

## Things that will bite you

`docs/LEARNINGS.md` has the full set with evidence. The ones that cost real time:

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
