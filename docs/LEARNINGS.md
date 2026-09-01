# Learnings

Transferable lessons from building this. `FINDINGS.md` records *what this project established* about
the engine; this file records *what to do differently next time*, with the evidence that produced it.

These are specific to this project's stack — the Infinity Engine's Lua UI, WeiDU, Deno, the browser,
and how the debugging actually went.

For the general method behind the data model — how an unstructured stream of prose was turned into a
queryable dataset, and how relationships were deduced from the order of events — see
[EVENT-STREAM-STRUCTURING.md](EVENT-STREAM-STRUCTURING.md).

---

## Infinity Engine / Enhanced Edition UI

### 1. Engine accessors are not safe to call while `ui.menu` is loading

`Infinity_GetGameTicks()`, `Infinity_GetCurrentScreenName()` and friends dereference the current game
object. The top-level chunks in `ui.menu` run during UI construction, **before any game exists**, so
calling one there segfaults the process about a second into startup.

**`pcall` does not protect you.** It catches Lua errors, not C++ crashes. Wrapping the call in `pcall`
and assuming it is now safe is exactly the mistake that cost the most time here.

> Only touch engine state from code paths that can only run once a game is loaded. In this project
> that means `A7LOG_drain`, which is reached only when `combatLog` already has rows. Load-time code
> emits constants only.

### 2. A UI-load crash looks identical to "the feature silently did nothing"

The broken tap produced: clean exit, **no crash report**, no error on stdout, no `LUA ERROR:` line —
just the game quitting after 51 lines of startup logging. That is indistinguishable from "the mod
isn't installed" or "the transport doesn't work", and it sent the investigation in the wrong direction
twice (first blaming the pty, then the shell sandbox).

Two things cut through it:

- **Run the binary directly in the foreground and read the raw exit code.** Through `script` and
  through the background-job wrapper the failure reported exit 0. Run directly, it reported **139** —
  128 + 11, SIGSEGV. The signal was there the whole time; the wrappers hid it.
- **Bisect against a control.** Uninstall the mod, launch the identical way, see if the symptom
  disappears. That single comparison localised the fault to our patch in one step, after two wrong
  hypotheses.

### 3. `Infinity_Log` output is wrapped, not verbatim

What the tap emits is not what lands on stdout. The engine prefixes it:

```
2026-08-31 00:11:26.976 BaldursGateIIEnhancedEdition[88424:110912244] INFO: LUA: A7LOG<TAB>0<TAB>...
```

A parser that anchors with `startsWith("A7LOG\t")` matches nothing. **Locate your marker inside the
line rather than anchoring at its start**, and require the prefix to look like the engine's log prefix
so the marker appearing inside game text can't be mistaken for real output.

This was a gift as well as a trap: that leading timestamp is real wall-clock time, which became a
column the design would not otherwise have had.

### 4. Load Lua as a resource, don't splice it into `ui.menu`

`Infinity_DoFile("a7log")` loads `override/a7log.lua` — the same mechanism the stock UI uses for its
translation files (`Infinity_DoFile("L_en_us")`). Confirmed working with a loose `.lua` in `override`.

This keeps the WeiDU patch to three tiny single-line insertions instead of pushing a whole Lua blob
through a regex replacement (where `%`, `\` and backreference syntax all become hazards), and it means
iterating on the tap is one file copy instead of a reinstall.

### 5. `text lua "…"` is the per-frame hook

UI.MENU evaluates every rendered element's `text lua` expression on each frame. It is the only
per-frame callback available without EEex. Return `""` and nothing draws. Patch more than one host if
the element you chose can be hidden.

### 6. Patching shared files: verify anchor uniqueness, then fail loudly

`override/ui.menu` is shared state that other mods rewrite. Before patching:

- **Count occurrences of every anchor first.** Of the three used here, one appeared twice
  (`leftSidebarBackground`) and a first-choice anchor (`toolbarTop = toolbarTop - h`) also appeared
  twice and had to be discarded. Multi-line regex anchors were abandoned entirely in favour of
  verified-unique single-line ones.
- **Make the patch fail loudly if an anchor is missing.** `COUNT_REGEXP_INSTANCES` + `PATCH_FAIL`. A
  patch that silently matches nothing installs "successfully" and looks correct right up until you go
  looking for data that was never captured.

### 7. WeiDU wants `AUTHOR` before `VERSION`

WeiDU 24900 rejects a tp2 with `VERSION` before `AUTHOR` (`Parse error (state 68) at VERSION`).
`AUTHOR` is mandatory — use the project name, not a person.

---

## Lua

### 8. When wrapping a variadic stdlib function, forward `...` — never name positionals

```lua
-- Broken: turns table.remove(t) into table.remove(t, nil), which errors in 5.2
table.remove = function(t, pos, ...) return _remove(t, pos, ...) end

-- Correct: arity is preserved for every caller
table.remove = function(t, ...) return _remove(t, ...) end
```

Naming an intermediate parameter materialises it as `nil` when the caller omitted it, changing the
call the wrapped function sees. This breaks every single-argument call site in code you don't own.

### 9. Overriding a global is a legitimate hook when the engine evaluates chunks

The engine trims the log by executing the string `table.remove(combatLog, %d)`. Because a Lua chunk
resolves globals at *run* time, replacing the global is visible to the engine — which is what turns a
shifting array index into a stable monotonic id. Appends go through the C API (`lua_rawseti`), which
bypasses metatables, so `__newindex` would **not** have worked. Know which side of that line your
target is on before designing the hook.

---

## Deno

### 10. `node:sqlite` is the low-friction choice

`DatabaseSync` from `node:sqlite` runs with **no flags, no dependencies, no downloads** (Deno ≥ 2.2).
`jsr:@db/sqlite` needs `--allow-ffi` plus a prebuilt native library fetch. Verified before committing
to it with a CREATE / INSERT / `GROUP BY … ORDER BY sum()` round-trip.

### 11. `CREATE TABLE IF NOT EXISTS` is not a migration

Adding a column to the schema silently does nothing to a database that already exists; the next insert
fails with `table events has no column named …`. Read `PRAGMA table_info(...)` and `ALTER TABLE ADD
COLUMN` anything missing, with column names from a literal list.

### 12. No pty in Deno — and macOS `script` leaves artifacts

Deno has no pty support. Without one, a child's stdout is a pipe and libc block-buffers at 4 KB, so
output arrives in bursts. `Deno.Command("script", ["-q", "/dev/null", binary])` gets a pty and streams
correctly, but the transcript carries a leading `^D\b\b` and `\r\n` line endings. Strip both.

### 13. Watch for apostrophes when interpolating paths into `deno eval`

`Baldur's Gate` inside a single-quoted shell string inside JS source terminates the string and
produces a confusing `SyntaxError` far from the cause. Pass paths through an environment variable or
`Deno.args` instead of interpolating them into the code.

---

## Browser

### 14. Top-level `await` in a classic `<script>` kills the entire block, silently

```html
<script>          <!-- every line below is dead -->
  ...
  await load();   <!-- SyntaxError: the whole block never parses -->
</script>
```

There is no partial execution and nothing obvious on the page: the static HTML renders normally, so it
looks like a data problem, not a script problem. The page had a full set of controls and an empty
table, which pointed the investigation straight at the database and the API — both of which were fine.

`<script type="module">` permits top-level await. Confirm mechanically rather than by eye:
`new Function(code)` throws for a classic script that uses top-level await.

### 15. HTTP 200 is not evidence that a page works

This was verified before shipping with `curl -o /dev/null -w "%{http_code}"` → `200`, which proves the
server can read a file off disk and nothing more. The page was inert the whole time. **Verify the
surface the user actually touches**: for a page, that means loading it in a browser, or at minimum
checking that its script parses under the semantics the browser will apply.

The same class of mistake as #16, one layer up.

## Method

### 16. Verify the risky assumption against the real system, early

The whole design rested on "`Infinity_Log` reaches stdout", which was inferred from a `LUA: %s` format
string in the binary and the stock UI's use of the function. It turned out to be true — but the run
that confirmed it also surfaced the log prefix (schema change), the load-time segfault (fatal), and the
`table.remove` arity bug (fatal). None of the three was reachable by reading code.

The corollary is worth stating plainly: **the parts of this that are still unverified are the parts
nobody has run.** No combat has been captured yet, so monotonic ids under trimming and the HUD
rendering with injected labels remain untested. That is recorded in `FINDINGS.md` rather than smoothed
over.

### 17. Derive facts from the artifact, not from memory

Nearly every load-bearing fact here came from inspecting the actual install rather than recalling how
the engine works: `strings` on the binary for the Lua API surface and the `combatLog` literals,
`grep` on `ui.menu` for the anchors and their counts, `PRAGMA table_info` for the schema. Where that
was not possible — the exact English wording of combat feedback — the honest move was to ship
provisional rules with an `other` bucket and a `deno task patterns` workflow, rather than guessing and
mislabelling data.
