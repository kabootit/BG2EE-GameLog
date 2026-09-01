---
name: security
description: Run a security audit of BG2EE-GameLog. Use before publishing anything, after adding a capture path, an external command, a new API parameter, or any change to deno.json permissions.
---

# Security audit

The standing rule is in `docs/SECURITY.md`: **this project must not compromise the machine it runs
on.** This is the procedure for checking that it still holds.

`deno task lint` enforces the mechanical invariants. This document covers the half that needs
judgement — whether a new capability is appropriate at all, and whether a new path leaks something no
pattern is looking for.

## When to run

- Before publishing the repo, or committing a new session log
- After adding anything to `Deno.Command`, or any new external dependency
- After adding a capture path, or changing what gets written to `logs/`
- After adding an API parameter, a sortable/groupable column, or a rendered field
- After changing permissions in `deno.json`
- After changing `mod/gamelog/lib/a7log.lua`

## Step 1 — mechanical checks

```sh
deno task lint
```

Eight checks: dependencies, permissions, bind-address, sql-injection, html-escaping, redaction,
committed-logs, binary-execution. Each maps to a section of `docs/SECURITY.md`.

Fix any failure before going further. **Passing is necessary, not sufficient** — every check is a
pattern, and patterns only catch what someone already thought of.

`install-mod` runs the same audit on itself and refuses to proceed if anything is broken, so a
regression cannot be installed even by someone who never runs this task.

When adding a check, verify it **fails** as well as passes — break the invariant on purpose, confirm
the finding appears, then restore. A check that cannot go red is worse than none, because it reads as
coverage.

## Step 2 — judgement checks

### New external commands

```sh
grep -rn "Deno.Command" src/
```

For each: is the binary shipped by this project, or discovered at runtime? Discovered means the path
came from somewhere this project does not control — a directory listing, `$PATH`, an env var, user
input. Anything discovered must print its path, its provenance and its SHA-256, and wait for a yes.
Adding a way to skip that prompt re-opens the hole for whoever scripts it.

### New capture paths

Redaction is pattern-based. It strips the identifiers we have actually seen — a SteamID and the home
directory path — and nothing else. A different engine build, platform, mod, or a newly captured stream
may print something new.

Read the non-event lines of a fresh session with your own eyes:

```sh
grep -av "A7LOG" logs/session-*.log | sort -u | less
```

Look for: account or user ids, machine or user names, absolute paths, tokens, keys, IP addresses,
email addresses. Anything found gets added to `redact()` in `src/play.ts` — **at the point of capture,
never as a cleanup pass**. Then re-scan every committed log, because the old ones will not have been
fixed by the new rule.

### New permissions

```sh
grep -n "allow-" deno.json
```

Any widened flag needs a reason or a narrowing. A blanket `--allow-run` or `--allow-net` must be listed
in `BLANKET_EXCEPTIONS` in `src/lint.ts` with the reason, which is a deliberately awkward step.

### New API parameters and columns

Ask of each: is this a *value* or an *identifier*? Values are bound with `?`. Identifiers cannot be,
so they are interpolated — and are safe only while checked against `SORTABLE` / `GROUPABLE` first.

Those sets must stay literal. Building them from `PRAGMA table_info`, or from anything else derived at
runtime, would look like a tidy refactor and would remove the check entirely.

### New sinks for stored text

**Start from the trust boundary**: every value in the database is third-party input, because game text
comes from `dialog.tlk` and any installed mod rewrites it. Mod authors have no reason to sanitize
strings that were only ever going to be read by a human inside a game window.

So the question for any new code that consumes a stored value is *which sink is this, and how does that
sink fail?*

| sink | fails as | defense |
|---|---|---|
| HTML text node | XSS | `esc()` |
| HTML attribute | XSS via quote-breaking | `esc()` — it escapes `"` and `'`, do not hand-roll a narrower version |
| Terminal / stdout | ANSI escape injection | control characters stripped at the parse boundary |
| SQL | injection | values bound, identifiers allowlisted |
| A filesystem path | traversal | never build a path from stored text |
| A shell command | command injection | never; use `Deno.Command` with an args array |

The first three are live today. The last three are listed because they are the sinks a future feature
would plausibly add — "export to a file named after the actor" is one refactor away from path
traversal.

Normalization happens **once, at the parse boundary** (`stripColor()` in `src/parse.ts`), so new sinks
inherit it. Prefer extending that over adding a defense at a new sink: the terminal sink existed
unguarded for a while precisely because only the browser had been thought about.

```sh
grep -rn "console.log\|innerHTML" src/ web/ | grep -iE "raw|actor|target|detail|spell|\br\."
```

### Anything that leaves the machine

This project makes no network requests, has no telemetry, and downloads nothing at runtime. Adding any
of those is a design decision to raise explicitly, not an implementation detail to slip in.

### Game-side code

For changes to `a7log.lua`:

- No engine accessor (`Infinity_Get*`) may be called at load time — before a game exists they
  dereference a null pointer and segfault the process, and `pcall` does not catch C++ crashes.
- Wrapping a global (`table.remove`) must forward `...` and not name intermediate positionals, or it
  changes arity for every other caller in the UI.
- The per-frame drain stays wrapped in `pcall`; it runs inside the render path.

### Before publishing

- Re-scan every committed log, not just new ones.
- Check history, not just the working tree — a secret removed in a new commit is still in the
  history and needs a rewrite:

  ```sh
  git log -p --all | grep -nE "7656[0-9]{13}|/Users/[^/ ]+" | head
  ```

## Reporting

For each finding: what it is, why it matters, a concrete failure scenario, and the fix. Separate
**confirmed** from **theoretical** — a latent issue that is not currently reachable is worth fixing but
should be labeled as latent, not reported as exploitable.

Do not pad the report. Zero findings is a valid result.

## Accepted risks — do not re-report

These are known, documented in `docs/SECURITY.md`, and deliberate:

- `install-mod` holds broad `--allow-run`, because the binary it invokes is discovered at runtime and
  cannot be named in advance. This is why it is the one command that asks first.
- The local API has no authentication. Any process on the machine can read the event data while the
  server runs. Acceptable for a single-user local tool bound to loopback.
- WeiDU is trusted completely once approved at the prompt. It is not sandboxed and writes to the game
  directory by design.
- Redaction is pattern-based and cannot be exhaustive. Mitigated by review before publishing, above.
- A bug in the Lua tap can crash the game. Blast radius is the game process; saves are never touched.
