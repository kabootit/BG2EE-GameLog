# Security

**Standing rule: this project must not compromise the machine it runs on.**

This file is the policy for *this* project. For the general reasoning behind it — what a small tool
that instruments software you don't own gets wrong, and why — see
[LOCAL-TOOL-SECURITY.md](../learnings/LOCAL-TOOL-SECURITY.md).

That is a stronger bar than "no known vulnerabilities". This is a hobby tool that runs an external
binary, patches a game installation, injects code into a running process, captures everything that
process prints, and serves it over HTTP. Every one of those is a place where carelessness would reach
the user's machine or their data. The considerations below are the ones that actually apply here, with
what is done about each and what risk remains.

---

## The trust boundary

**Every value in the database is third-party input.**

Game text comes from `dialog.tlk`, which any installed mod rewrites — creature names, spell names, the
wording of damage messages, all of it. Installing a mod means installing that mod's strings, and those
strings flow through this project unchanged:

```
dialog.tlk → message window → combatLog (Lua) → stdout → parser → SQLite ─┬→ HTTP API → browser
                                                                          └→ terminal reports
```

Nothing on that path is authored here. Treat `actor`, `target`, `detail`, `spell` and `raw` the way you
would treat a form field, and note that the danger is not hypothetical mod malice so much as the
absence of any reason for mod authors to sanitise strings that were only ever meant to be read by a
human inside a game window.

Two sinks matter, and they fail differently:

- **The browser.** `esc()` escapes `& < > " '` — quotes included, because some values land in
  attributes rather than text nodes. Hand-rolling a narrower escape for one field is the likely way
  this breaks.
- **The terminal.** `deno task patterns` and the capture summary print stored text straight to stdout,
  where an ANSI escape sequence would be *interpreted* rather than displayed.

Rather than defend at each sink, text is normalised **once at the parse boundary**: `stripColour()` in
`src/parse.ts` drops engine colour markup and every C0/C1 control character, ESC included. A new sink
then inherits the defence instead of having to remember it — which matters, because the terminal sink
was already there and unguarded when only the browser had been considered.

## The surface

### 1. It executes an external binary it did not ship

`deno task install-mod` needs WeiDU, which is not vendored. It looks in `$BG2EE_WEIDU`, then for any
`setup-*` executable **in the game directory**, then for `weidu` on `$PATH`.

The middle one is the sharp edge: the game directory is not controlled by this project, is writable by
anything running as the user, and is routinely filled with binaries downloaded from mod sites. Matching
on a filename pattern and executing the result is exactly how you get owned.

**Mitigation.** Nothing is executed until the path, how it was found, its size and its SHA-256 have
been printed and confirmed at a prompt that defaults to *no*. The provenance string is explicit about
which lookup matched, because `matched setup-* in the game directory (not verified)` should read very
differently from `$BG2EE_WEIDU`. The check also covers a `setup-gamelog` left by a previous install —
that is a copied binary too, and exempting it would have disabled the check on every run after the
first. There is deliberately **no flag to skip the prompt**.

**Residual risk.** The prompt can only prompt: a user who does not compare the checksum against the
[official release](https://github.com/WeiDUorg/weidu/releases) gains nothing from it. There is a
theoretical TOCTOU window between hashing and executing, though an attacker able to exploit it already
runs as the same user. Once approved, WeiDU is trusted completely — it is not sandboxed, and it writes
to the game directory by design.

### 2. It patches a shared file in the game installation

The tap is installed by editing `override/ui.menu`, which other mods also modify.

**Mitigation.** It is a WeiDU mod, so the original is backed up and `--uninstall` restores it exactly
(verified). Anchors are counted before patching and the install **fails loudly** if one is missing,
rather than silently matching nothing. Nothing outside the game directory is touched, and save games
are never read or written.

**Residual risk.** A bad patch can break the game — during development one crashed it at startup with
a SIGSEGV. That is a working-state problem, not a machine-integrity one, and it is reversible.

### 3. It injects code into the running game process

`a7log.lua` executes inside the engine's Lua sandbox on every rendered frame, and wraps the global
`table.remove`, which all UI code uses.

**Mitigation.** The drain is wrapped in `pcall`; the `table.remove` wrapper forwards varargs so it
cannot change arity for other callers; no engine accessor is called at load time, because doing so
dereferences a null game pointer and segfaults the process — a C++ crash `pcall` cannot catch.

**Residual risk.** Bugs here crash the game. The sandbox has no filesystem or network access, so the
blast radius is the game process.

### 4. It captures everything the game prints

Capture is indiscriminate by design — the tap cannot know which lines matter — so the session log is a
transcript of whatever the engine emitted, including things that have nothing to do with gameplay.

**This has already gone wrong once.** The first committed logs contained the account's **SteamID64** and
56 occurrences per file of the home-directory path, and the repository was about to be made public.

**Mitigation.** `redact()` in `src/play.ts` strips both **as the log is written**, not afterwards, so
new captures cannot reintroduce what was scrubbed. Cleaning up after the fact only works if somebody
remembers.

**Residual risk.** Redaction is pattern-based, not exhaustive. It covers the identifiers actually
observed; a different engine build, a different platform, or a mod could print something else.
**Review a session log before publishing it.**

### 5. It serves that data over HTTP

`deno task serve` runs a read-only API and the viewer.

**Mitigation.** It binds `127.0.0.1` explicitly, never `0.0.0.0`, and the task grants
`--allow-net=127.0.0.1` so the runtime enforces it too. The API is GET-only and never writes. No CORS
headers are sent, so a page on another origin cannot read the responses.

**Residual risk.** There is no authentication: any process or user on the machine can read the event
data while the server is running. That is a reasonable trade for a single-user local tool, but it is a
choice, not an oversight. Do not expose the port.

### 6. It renders third-party text, in a browser and in a terminal

See **The trust boundary** above: every stored value originates in mod-rewritable game text.

**Mitigation.** Control characters are stripped once at the parse boundary, so no sink inherits an
ANSI escape. In the browser, everything interpolated into HTML additionally goes through `esc()`. The
page is self-contained — no CDN, no external requests, no `eval`, no `innerHTML` written from an
unescaped value.

**Residual risk.** Escaping is per-interpolation, so a future field rendered without `esc()` reopens
it. The `html-escaping` and `untrusted-text` checks in `deno task lint` exist for exactly that.

### 7. SQL is assembled by string interpolation

Values are always bound with `?`. But column names cannot be bound, so `ORDER BY`, `GROUP BY` and the
filter columns are interpolated — and are safe **only** because each is checked against the `SORTABLE`
and `GROUPABLE` allowlists first. Unrecognised names are dropped, not passed through. The `exclude`
filter builds an `IN (?, ?, …)` with one placeholder per value.

This is the invariant most likely to be broken by a future change that adds "just one more" sortable
column without adding it to the allowlist.

---

## Enforcement

Documenting an invariant does not keep it true. `deno task lint` checks all of the above
mechanically — dependencies, permissions, bind address, SQL interpolation, HTML escaping, redaction,
committed logs, binary confirmation — and fails the build on any regression.

**`install-mod` runs the same audit itself and refuses to proceed if anything is broken.** It is the
command that executes an external binary and modifies a game installation, so it does not assume the
lint task was run. The check lives in `main()` rather than the task definition, so invoking the script
directly cannot bypass it, and it runs before anything is copied or executed.

The checks are verified to fail, not just to pass: deliberately regressing an invariant must produce
exactly the corresponding finding. A green check that cannot go red is worth nothing.

`skills/security.md` covers the judgement half — whether a new capability is appropriate, and whether
a new capture path leaks something no pattern is looking for.

## Fixed

| finding | fix |
|---|---|
| SteamID64 and home paths in committed session logs | redact at capture time in `play.ts` |
| WeiDU binary located by filename pattern and executed unverified | provenance + SHA-256 + confirmation, no bypass |
| Facet dropdown interpolated values into an attribute unescaped | shared `esc()` covering quotes (was latent — those values are project-generated, but the next value routed there might not be) |
| `deno task play` held blanket `--allow-run` | narrowed to `--allow-run=script` |
| `deno task serve` held blanket `--allow-net` | narrowed to `--allow-net=127.0.0.1` |

`install-mod` keeps broad `--allow-run` because the binary it invokes is discovered at runtime and
cannot be named in advance. That is precisely why it is the one command that asks first.

---

## Invariants to preserve

- **No third-party dependencies.** Deno built-ins only (`node:sqlite`, `Deno.serve`, `Deno.Command`).
  Zero supply chain is a security property worth more than any convenience a package would add.
- **Never execute something this project did not ship without showing provenance and asking.**
- **Bind loopback only**, and let the permission flag enforce it as well as the code.
- **Least permission in `deno.json`.** Narrow `--allow-run` / `--allow-net` to what a task actually
  needs; justify any widening in the task description.
- **SQL: bind values, allowlist identifiers.** Never interpolate a column name that has not been
  checked against a literal set.
- **HTML: escape everything that came from the database.**
- **Redact at capture, not after.**
- **Keep it reversible.** Installs back up what they replace and can be uninstalled.

## What this project does not do

No network egress. No telemetry, analytics or crash reporting. No auto-update. Nothing is downloaded
at runtime. It writes only inside its own directory and the game directory, and never touches save
games.

## Reporting

Open an issue at <https://github.com/kabootit/BG2EE-GameLog/issues>. This is a personal hobby project
with no support commitment, but anything that could affect a user's machine will be taken seriously.
