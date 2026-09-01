# Securing a small tool that touches things you don't own

Notes on the reasoning, written up as source material for a longer piece. The worked example is a
utility that instruments a game, but none of it is specific to that: the same shape turns up in any
personal tool that wraps software someone else wrote — a scraper, a log tailer, a dev-environment
helper, a script that drives an app you didn't build.

`../docs/SECURITY.md` is this project's own policy: what it does, what its invariants are, what risk it has
accepted. This file is the reasoning behind it.

---

## 1. Small tools accumulate serious capabilities quietly

Nobody sets out to write a privileged program. You set out to read a log file. Then:

- it needs a mod installer, so it **executes a third-party binary**
- the installer must be found, so it **searches a directory it does not control**
- the hook must run in-process, so it **injects code into a running application**
- the hook emits output, so it **captures a stream and writes it to disk**
- the output should be browsable, so it **runs an HTTP server over that data**
- and then you **publish the repository**, logs included

Each step is individually reasonable and locally small. Together they are: arbitrary code execution,
an injection point, a data-capture pipeline, a network service, and a publication channel — in a
weekend project nobody is going to threat-model.

The useful move is to state the bar explicitly and early, because it is higher than the one you drift
toward on your own:

> **This tool must not compromise the machine it runs on.**

Not "has no known vulnerabilities". The stronger phrasing is what makes you go looking, because it
implies you have not finished looking yet.

---

## 2. Capture is indiscriminate; publication is a separate act

A capture pipeline records what the source emits, not what you were interested in. It cannot know the
difference — that is the whole point of capturing.

In this project the source printed, on line 7 of every session, the user's account id for the platform
the software was bought from, plus their home-directory path 56 times per file. None of it was
gameplay data. All of it was committed, and the repository was one command away from public.

Two lessons, and the second is the one that carries further:

**Read your own capture output before you publish it.** Not the parsed, structured part you built the
tool for — the noise you have been ignoring for a week. That is where identifiers live, because it is
where you were not looking.

**Redact at the point of capture, not as a cleanup pass.** Cleaning existing files fixes those files.
The next run recreates the problem. Scrubbing is a one-off; redaction in the write path is a property
of the system. The distinction is the difference between remembering and not having to.

And be honest about the limits of the fix: redaction is pattern-based, so it strips the identifiers
you have already seen. It is a mitigation, not a guarantee, and the doc should say so rather than imply
coverage it does not have.

## 3. Making something public is retroactive

Flipping a repository to public does not publish the current state. It publishes **every state you
ever committed**. A secret removed in a later commit is still there, one `git log -p` away.

So the visibility change is a moment that deserves its own checklist, separate from any individual
commit:

```sh
git log -p --all | grep -nE "<the patterns you care about>"
```

If something turns up, the fix is a history rewrite before the flip, not a new commit after it.

The related trap: **the risk calculus of a decision changes when the context changes.** Committing raw
capture logs to a private repository is a reasonable convenience. The identical decision becomes a
disclosure the moment the repository is public — without anyone touching the logs, and without any new
commit to review.

---

## 4. Convenience lookups are trust decisions

The tool needed an installer binary that it does not ship. So it looked for one:

1. an explicit path from an environment variable
2. **any file matching `setup-*` in the application's directory**
3. the binary's name on `$PATH`

Step 2 is a real hole, and it is worth being precise about why. That directory is not controlled by
this project, is writable by anything running as the user, and is routinely filled with executables
downloaded from community sites. Matching a filename pattern and running the result is a plausible way
to get owned by a mechanism you built for your own convenience.

What makes it easy to miss is that on a *modded* install the lookup always succeeds, silently, and the
dependency never announces itself. The hole and the convenience are the same feature.

Three general points:

**A lookup chain is a trust gradient, and code tends to flatten it.** An explicit env var, a
pattern-matched directory scan, and `$PATH` are wildly different levels of assurance, but the code
treated all three identically — it returned a string. Preserving *which branch matched* and showing it
to the user is most of the fix.

**Show provenance, not just the path.** `matched setup-* in the game directory (not verified)` and
`$BG2EE_WEIDU` are both a filename on screen, and they mean completely different things.

**Confirm before executing anything you didn't ship** — and put the confirmation where it cannot be
routed around. See §8.

## 5. Data you did not author is input, even when nobody is attacking you

Everything this tool stores originates in the application's own text — names, messages, labels — which
any installed extension can rewrite. That makes every stored value third-party input.

The framing that helps: **you do not need to believe extension authors are malicious.** You need only
observe that they have no reason to sanitise strings that were only ever going to be read by a human
inside an application window. Nobody is attacking you; the data is simply not written to your
assumptions.

Naming the boundary explicitly is what makes the consequences visible. Draw the path:

```
third-party strings → application UI → capture → parser → database ─┬→ HTTP API → browser
                                                                    └→ terminal reports
```

Nothing on that path is authored by you. Once it is written down like that, the next question asks
itself.

## 6. Sinks fail differently, and you will forget one

"Escaping" is not one thing. Ask, for each place a stored value ends up, *how does this sink fail?*

| sink | failure |
|---|---|
| HTML text node | script injection |
| HTML attribute | injection via quote-breaking — a narrower escape that only covers `& < >` is not enough |
| Terminal / stdout | ANSI escape sequences are **interpreted**, not displayed |
| SQL | injection — and note identifiers cannot be parameterised, only allowlisted |
| Filesystem path | traversal |
| Shell command | command injection |

The terminal is the one that gets missed, and it got missed here. Escaping had been thought about
carefully for the browser — quotes included, attributes considered — while a diagnostic command printed
the same untrusted strings straight to stdout, unexamined. The defence had been attached to the sink
that was salient, not to the data.

Worth listing the sinks you *don't* have yet, too. "Export to a file named after the actor" is one
refactor away from path traversal, and writing that down costs nothing.

## 7. Normalise at a choke point, not at each sink

Having found two sinks, the tempting fix is to defend both. The better fix is to notice you will add a
third and forget.

So normalise once, where the data enters your model — strip control characters, drop markup, canonicalise
whitespace — and let every sink inherit it. Per-sink escaping still matters where the sink has its own
grammar (HTML does), but the general-purpose hazards belong at the boundary.

This is the same principle as redacting in the write path rather than cleaning files afterwards, and it
applies broadly: **put the defence where new code inherits it by default, not where new code must remember
to add it.**

---

## 8. Documenting an invariant does not keep it true

A security document is a snapshot of intentions. Six months later the code has moved and the document
has not, and the gap is invisible because documents do not fail.

So make the invariants executable. Most of them are mechanically checkable with very little code:

- no third-party dependencies → scan imports
- least privilege → parse the task/permission definitions and flag blanket grants
- server bound to loopback → assert the literal, and assert the absence of `0.0.0.0`
- no unparameterised SQL identifiers → find interpolations in SQL strings, require each to be a known
  allowlisted expression
- untrusted text escaped → find data-derived interpolations that skip the escape helper
- redaction wired into the write path → assert the call exists and precedes the write
- published artifacts clean → grep committed data for the patterns you care about
- confirmation precedes execution → assert the ordering

Three things learned writing them:

**Verify that a check can fail.** Break the invariant deliberately, confirm exactly the right finding
appears, restore. A check that cannot go red reads as coverage while providing none — it is worse than
no check, because it stops you looking.

**Blunt checks train you to ignore them.** The first run produced two false positives — a safe SQL
expression that was not on the allowlist, and a legitimate `--force-install` flag matching a
"can-you-skip-confirmation" pattern. Two noisy findings in a set of eight is enough to start skimming.
Tighten them, or you have built an alarm people mute.

**Record exceptions in the checker, with a reason.** One command legitimately needs a broad permission
because the thing it invokes is discovered at runtime. That belongs in an explicit exceptions map, in
code, with the justification next to it — so it is a deliberate, visible entry rather than a check
quietly weakened for everyone.

## 9. Put the guard where it cannot be routed around

The natural place to run checks is the task runner. It is also the place that is trivially bypassed —
by anyone invoking the underlying script directly, which is exactly what you do when debugging.

The riskiest command here now runs the audit **inside itself**, before it copies or executes anything,
and refuses if any invariant is broken. Not because a future contributor is careless, but because the
person most likely to bypass the task runner is you, at the moment you are least attentive.

## 10. Be honest about what a control actually achieves

A confirmation prompt that prints a checksum and asks *is this the binary you expect?* mostly receives
`y`. The prompt is still worth having — it creates a decision point, and it makes provenance visible —
but a document that presents it as verification is lying slightly.

Write down what the control does *not* do. The same applies to distinguishing **latent** from **live**:
an unescaped interpolation that no attacker-controlled value currently reaches is worth fixing and
worth labelling as latent. Reporting it as exploitable is as much a failure of accuracy as missing it.

## 11. Accepted risk is a decision — write it down where it will be re-read

Some risks you accept: a local API with no authentication, a dependency trusted once approved, a
mitigation known to be incomplete. Those are legitimate for a single-user tool, but only as decisions.

Two properties make them safe to accept:

**They are listed as accepted**, so the next audit does not re-litigate them and does not mistake them
for oversights.

**They are stated with the conditions that make them acceptable** — "bound to loopback",
"single-user", "not exposed". Because when a condition changes, the acceptance expires, and a bare
"we decided this was fine" gives no way to notice.

---

## 12. Tactics: how to make a checklist actually stick

A checklist in a document is the weakest possible form of a control. It works exactly as long as
someone remembers it exists. The useful question for each item is not "is this written down?" but
**"what is the strongest tier I can move this to?"**

| tier | mechanism | fails when |
|---|---|---|
| 1. Impossible | architecture — a choke point that makes the mistake unrepresentable | you design a way around it |
| 2. Automatic | an executable check that fails the build | someone disables it |
| 3. Procedural | a written procedure with explicit triggers | nobody opens it |
| 4. Remembered | a bullet in a document | immediately |

Most items can be moved up at least one tier, and it is usually less work than expected.

### Tier 1 — delete the item by making it structural

The strongest tactic is to make a checklist item unnecessary. Two from this project:

- *"Remember to redact before publishing"* became **redaction in the write path**. The item is gone;
  the system can no longer produce unredacted output.
- *"Remember to escape at every sink"* became **normalisation at the parse boundary**. New sinks
  inherit the defence instead of needing to be added to a list.

Whenever an item starts with *remember to*, ask what would have to be true for it to be deletable.

### Tier 2 — an executable audit

Most security invariants are **structural properties of the source**, which means they are checkable
by reading files and matching patterns. No AST, no framework, no dependency:

| invariant | how you check it |
|---|---|
| no third-party dependencies | scan import statements against an allowlist |
| least privilege | parse the task/permission definitions, flag blanket grants |
| service bound to loopback | assert the literal is present *and* the wildcard is absent |
| no unparameterised SQL identifiers | find interpolations inside SQL strings, require each to be a known-safe expression |
| untrusted text escaped | find data-derived interpolations that skip the escape helper |
| defence wired into the write path | assert the call exists *and* precedes the write |
| published artifacts clean | grep the committed data for the patterns you care about |
| confirmation precedes execution | compare the index of each in the source |

That is roughly 200 lines of ordinary script for a project this size. Two techniques carry beyond the
specifics: **assert absence as well as presence** — a bind check that only looks for `127.0.0.1`
happily passes a file that also binds `0.0.0.0` — and **assert ordering**, because a confirmation that
exists but runs *after* the thing it guards is decoration.

Four rules for the checks themselves:

1. **Prove each one can fail.** Break the invariant deliberately, confirm the exact finding appears,
   restore. A check that cannot go red reads as coverage while providing none — worse than nothing,
   because it stops you looking.
2. **Fix false positives immediately.** Two noisy findings out of eight is enough to start skimming
   the output, and a suite you skim is a suite you have already lost.
3. **Exceptions live in code, with a reason.** A legitimate exception belongs in an explicit
   exceptions map next to its justification — not as a check quietly relaxed for everyone.
4. **Bind the audit to the risky action, not the task runner.** Per §9, the command with the blast
   radius should run the audit itself and refuse, because the task runner is trivially bypassed by
   whoever is debugging.

### Tier 3 — a procedure for the judgement half

What is left cannot be automated: *is this new capability appropriate at all? does this new capture
path leak something no pattern is looking for?* That needs a written procedure, and three properties
decide whether it gets used or archived.

**Triggers stated up front.** Not "review periodically" but a list of events: before publishing, after
adding an external command, after adding a capture path, after changing permissions, after touching
injected code. The trigger list is what causes the document to be opened at all.

**Question-shaped, not assertion-shaped.** "Which sink is this, and how does that sink fail?" makes an
auditor think. "Escape your output" does not. A table of *failure modes* beats a list of rules,
because the reader has to find their own case in it.

**Accepted risks listed explicitly as do-not-report.** Otherwise every audit rediscovers the same
deliberate trade-offs and real findings get lost among them.

Say plainly what the automated half does *not* cover, too. "Passing is necessary, not sufficient"
belongs at the top of the procedure, or green checks become a reason to stop looking.

### Put both where the work happens

Neither survives in a wiki. The audit is a task sitting alongside the test command; the procedure
lives in the repository and is linked from the contributor doc a newcomer — or a future you — actually
opens. Discoverability is part of the control.

---

## Checklist

For the next small tool that touches something you don't own. Ask §12's question of each: **which tier
can this one reach?**

- [ ] State the bar. "Must not compromise the machine it runs on" is different from "no known bugs".
- [ ] List what the tool actually does: what it executes, injects, captures, serves, publishes.
- [ ] Read the noise in your own capture output before publishing any of it.
- [ ] Redact in the write path, not as a cleanup pass.
- [ ] Treat the visibility flip as its own event — check history, not just the working tree.
- [ ] For every discovered binary: preserve which lookup matched, show provenance, confirm.
- [ ] Draw the path third-party data takes through your system, and name the boundary.
- [ ] Enumerate sinks — including the terminal — and how each one fails.
- [ ] Normalise at a choke point so new sinks inherit the defence.
- [ ] Make the invariants executable, and prove each check can fail.
- [ ] Put the guard inside the risky command, not around it.
- [ ] Record accepted risks with the conditions that make them acceptable.
