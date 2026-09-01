# Turning an event stream into something usable

Notes on the method, written up as a learning piece. The worked example is a game's
combat log, but nothing here depends on that — the same shape turns up in application logs, audit
trails, chat transcripts, telemetry, anything emitted as a sequence of human-readable events.

`../docs/LEARNINGS.md` holds the stack-specific lessons from the same project. This file is the reasoning.

---

## 1. The shape of the problem

An unstructured event stream is a sequence of lines written **for a person reading them in real time**.
Each line is self-contained prose. It makes sense on its own, in the moment, in order.

That design goal is exactly what makes it hostile to analysis:

- **No identifiers.** Two creatures with the same name are the same string.
- **No references between lines.** Nothing points at anything else.
- **No causality.** A cause and its effect are separate, independent lines.
- **No schema.** Fields exist only as prose conventions, and the conventions vary by line type.

And the request is always some version of: *let me sort, filter and group this.* Which means you need
entities and relations that were never written down.

The instinct is to treat this as a parsing problem. Parsing is the easy half. The interesting
information isn't inside the lines — it's **between** them, and it has to be reconstructed from
wording and from **order**.

---

## 2. Don't design the parser before you have the data

The first rule set here was written from an imagined format, before a single real line had been
captured. It looked reasonable. It matched almost nothing: **240 of 706 events fell through**, and two
of the rules that *did* fire were firing on the wrong things.

The imagined format and the real one:

```
Minsc - Damage Taken: 7                       <- invented
Vampire: Takes 13 slashing damage from Tyras  <- actual
```

This is a strong temptation to name, because it feels like progress: you can picture the format, so
you write the parser, and then you spend the next hour explaining away a low match rate.

Two things make it survivable:

**Capture a real sample before writing any rule.** Obvious, routinely skipped.

**If you must write rules early, make being wrong measurable.** Route unmatched input to an explicit
bucket and report on it, ranked by frequency. A bad parser plus a good report is a work queue ordered
by value. A bad parser plus silent coercion is a dataset that lies to you.

There is a sharper version of this. Later in the project a catch-all called `status` was introduced for
attributed-but-unmatched text. It immediately became a hiding place — lines that *look* classified but
aren't really — and the report had to be extended to cover it too.

> A catch-all with a respectable name is more dangerous than one called `other`, because nobody thinks
> to audit it.

---

## 3. Find the envelope, strip it, then classify

Almost every real stream repeats an envelope around a payload. Here it was a speaker prefix:

```
Alarion: I'm ready for my next fight.
Vampire: Takes 13 slashing damage from Tyras
Zeris: Singing Bard Song
```

Extracting `<Speaker>: ` **first**, then classifying only the remainder, paid off three ways:

1. It filled a field — `actor` — on ~95% of rows with no per-rule work.
2. Every rule got shorter and anchorable, because it only ever sees the payload.
3. Rules stopped competing over the name portion of the line.

The envelope pattern needs its own guard, though. `Attack Roll 18 -4 = 14 : Hit` parses very happily as
a speaker named `Attack Roll 18 -4 = 14`. Excluding digits and `=` from the name pattern fixed it.

> Separate the envelope from the payload before you try to understand the payload. Then check that the
> envelope pattern can't chew into payloads that happen to look like it.

---

## 4. Position carries meaning that vocabulary doesn't

```
Tyras: When the berserk state ends, the character will take 15 damage.
```

An unanchored "takes N damage" rule scored that as 15 damage dealt. It's a *description* — future
tense, conditional, about a rule of the game rather than an event in it.

A regex cannot see tense or mood. It can see **position**: in this stream a real damage line starts
with the verb, and a description mentions it mid-sentence. Anchoring to the start of the payload
separated them completely.

The same class of error one level down: `\bdies\b` without the *leading* word boundary matches inside
`bodies`, which turned an arena taunt — "decorate this pit with my opponents' broken bodies" — into a
death event.

> When you can't detect the semantics, look for a structural proxy. Anchoring is usually the cheapest one.

---

## 5. The core problem: deducing relationships from order

This is where the real work is, and it has more structure than it first appears.

The engine reports cause and effect as separate lines:

```
Vampire: Attack Roll 19 + 7 = 26 : Hit
Vampire: Critical Hit                             <- the cause
Mireille: Takes 64 crushing damage from Vampire   <- the effect
```

Nothing links them. Not an id, not a reference, not even adjacency — other lines interleave. Three
different links were needed in this project, and all three reduced to the same three decisions.

### 5a. What is the join key?

Something must be shared between the cause line and the effect line. Here it's the actor: the crit
line's speaker and the damage line's attacker are the same creature.

This matters more than it sounds. **With a join key you can tolerate interleaving**; without one you're
reduced to pure adjacency, which collapses the moment two things happen at once — and in a combat log,
two things are always happening at once.

If no key is available, that is itself a finding. Say so rather than shipping adjacency and hoping.

### 5b. How wide is the window?

Bound the search, or an unrelated later event will get attached to a stale cause. Measure the bound in
the data rather than guessing:

- A critical resolves within a few lines → window of 10.
- A spell's damage can lag well behind; the largest observed cast→damage gap was 51 rows → window of 60.

Two different constants, each justified by an observed distance. A single "reasonable" window would
have been wrong at one end or the other.

### 5c. Is the cause consumed?

The decision that's easiest to get wrong, and the one that changes the output most:

| relationship | cardinality | policy |
|---|---|---|
| critical → damage | exactly one | **consume** the pending crit on use |
| cast → damage | one-to-many (an area spell hits several targets) | **don't consume**; most-recent-cast wins until superseded |

Consuming a one-to-many cause loses every effect after the first. Not consuming a one-to-one cause
smears it across everything that follows.

"Most recent wins" is worth noting as a pattern in its own right: it handles supersession for free. A
second cast by the same actor simply replaces the first, with no explicit expiry logic.

### 5d. Direction: always forward

The cause always precedes the effect. That means **one forward-only pass serves both live capture and
batch re-import**, with no second implementation to keep in sync. Worth checking early: if a stream
needs backward links, that's a much more expensive design, and you want to know before you commit.

---

## 6. Establish which end each line is written from

The most dangerous assumption made in this project — made, shipped, and only caught by looking at the
output:

```
Vampire: Takes 13 slashing damage from Tyras
```

Every other line type is written from the **acting** end: the speaker is the one doing something.
Damage lines are written from the **receiving** end. The speaker is the victim, and the actor is buried
in a `from` clause.

Taking the speaker as the actor would have inverted every damage statistic in the dataset. And it would
have *looked fine* — "Vampire: 491 damage" is a plausible sentence in either reading. Nothing about the
shape of the output would have flagged it.

The fix applies broadly: a recognizer can declare that it captured a `source`, and the linker swaps actor
and target when it sees one.

> Encode the perspective in the rule that recognizes the line, not in every consumer downstream.

The check that catches this class of bug is semantic, not syntactic. Not "did it parse" but **"does
`GROUP BY actor` now mean what I'd say out loud?"** Ask that of every derived relation.

---

## 7. Exclude the near-miss that looks identical

Two lines that parse beautifully and mean the opposite of what you want:

| line | parses as | actually means |
|---|---|---|
| `Critical Hit Averted` | a critical | a critical was **prevented** |
| `Spell Failed: Casting Failure` | a spell cast | **no** spell was cast |

The first was handled by matching exactly, not by prefix. The second is the more instructive one: left
as a spell, it would have become a damage source named "Casting Failure", attributed to every hit the
caster landed for the next 60 rows.

It was fixed by giving it its **own type** rather than filtering it at each point of use.

> Make the exclusion structural. A rule that every consumer must remember to apply is a rule that one
> consumer will forget.

---

## 8. Inference needs a confidence boundary — and the boundary needs an auditor

Once you're inferring, you have to decide when *not* to.

Damage is attributed to a spell only when the damage type is on an allowlist. The evidence for keeping
that list narrow was sitting in the capture:

```
Gaul: Casts Greater Malison         <- deals no damage whatsoever
Fire Elemental: Takes 8 acid damage from Gaul
```

"Most recent cast by the same actor" would have attributed that acid damage to Greater Malison with
total confidence. Physical damage types are weapon hits and must never be attributed at all.

> A wrong attribution is worse than a blank one. A blank is visibly missing; a wrong one is invisible
> and gets aggregated.

### The auditing trick

A conservative guard has an obvious failure mode: it silently drops real signal, and the person who
wrote it is the only one who knows the list needs revisiting. Six months later nobody does.

The fix is to record **both** answers on every row:

- the **guarded** attribution — what you analyze;
- the **unguarded candidate** — what *would* have been attributed with no type check at all.

The gap between them is a review queue, and it can be reported as a decision:

```
  type           rows  after cast  attributed
  magic            12          12          12     <- promote: every row explained
  missile          11           1           0     <- coincidence: 1 in 11
  acid              1           1           0     <- coincidence
```

**The ratio is the discriminator.** A type where nearly every row follows a cause belongs on the
allowlist. A handful of stray rows is a coincidence — something that happened to occur after something
else.

Note what the report does beyond flagging candidates: it carries enough information to **reject** them.
That matters, because the tempting-but-wrong cases are indistinguishable from the real ones without the
denominator. This is the single most reusable idea in the project.

---

## 9. Some facts only exist at the level of the whole stream

Not every field can be decided when its row arrives. Which side a creature is on may not be
determinable until much later — the evidence hasn't happened yet.

That forces two execution modes over **one** body of logic:

- **Batch:** collect evidence across the entire stream, then label every row. Exact.
- **Streaming:** label with current knowledge, and when a fact later settles, **rewrite the rows already
  written**.

The temptation is to write these separately, because the batch one is so much simpler. Don't — two
copies of the evidence rules drift within days. One resolver, two drivers: the resolver accumulates
evidence and answers questions; the drivers differ only in when they ask.

Streaming backfill needs one precondition: **stable row identity**, so a late-arriving fact can be
written onto specific earlier rows.

---

## 10. When signals conflict, rank them — and record the case that forced the ranking

Classifying party versus opposition used three signals of decreasing authority:

1. **Authoritative state**, read directly from the system — the actual roster.
2. **A behavioral tell**: a particular event type only ever fires for one group. (Auto-pause is a
   party-side feature; in the captured data it named exactly the six party members and their four
   summons, and never an enemy.)
3. **A relationship graph**: anyone who trades blows with a known member of one side is on the other.

The precedence is the design, not an implementation detail — and the case that forced it was in the
data:

```
Zeris: Takes 8 missile damage from Rurik
```

Friendly fire. Two-coloring the combat graph would have placed a party member with the enemy. Because
membership evidence outranks graph evidence, he stays party.

The nice part: once the precedence is right, the anomaly stops being noise and becomes a *feature* —
"friendly fire" is now a thing you can query for, rather than a bug quietly corrupting side totals.

> Write down the concrete case that forced your precedence order. It's the regression test, and it's
> the thing you'll doubt in three months.

---

## 11. Know what you cannot know, and say so

At one point the question was: this fight had several vampires — can we tell them apart?

The answer was no, and establishing that firmly was more valuable than producing something plausible:

- Every instance prints the same display name; no suffix, no instance marker.
- The backing store holds strings only — no per-line metadata to recover.
- The system exposes no way to enumerate the entities involved.

So the options were: change the source data (rename the entities), use a lower-level hook that wasn't
available on this platform, or accept aggregation. What was *not* an option was inferring identity from
interleaving and presenting the guess as fact.

The same discipline shows up in how absence is labeled. A creature that only ever talks is marked
`neutral`, which means **"this stream contained no evidence"** — not "friendly". The same character is
`opponent` in a session where he fights and `neutral` in one where he doesn't, and carrying the label
across sessions was deliberately rejected: the same displayed name isn't necessarily the same entity.

> Distinguish "no evidence" from a negative finding, in the data model itself and not just in the docs.
> A column that conflates them will be misread by everyone including you.

---

## 12. A derived column describes one role — go and check its mirror

A column marked rows where the *actor* was a summoned creature. It looked right, and it was quietly
useless for the most interesting case.

One of the summoned creatures dealt **zero** damage and absorbed **171**. It never appeared in that
column at all, because on damage rows the summon is the victim — and victims live in a different field.

The requester noticed something was missing before the model did.

> For every role-keyed derived column, ask which rows it can *never* populate, and whether that set is
> the interesting one.

Here it was: those creatures mostly existed to soak damage, so the column was blind to their entire
purpose. The fix was the symmetric column, filled by the same predicate applied to the other role.

---

## 13. Make re-derivation free — this is what allows everything else

Every transformation is **additive**. The raw line is preserved on every row. The captured stream file
is never rewritten and is the source of truth. Each new inference adds a column rather than replacing
anything.

With an idempotent upsert keyed on `(stream, row id)`, re-deriving the entire structured dataset costs
one command and a few seconds.

That property is not a nicety, it's the **enabling constraint for the whole approach**. This project
went through roughly eight rounds of rule changes, several of which reversed earlier decisions. Every
one of them was re-applied retroactively to data captured hours earlier. If re-derivation had required
re-capturing, the rules would have been frozen at their first, worst version — the one that got 240 of
706 rows wrong.

> Cheap re-derivation is what makes it safe to be wrong early, which is what makes an iterative schema
> possible at all.

---

## 14. The meta-lesson: the schema emerged from questions, not from design

No part of this data model was designed up front. It arrived as a sequence of requests, each of which
tested the model and usually broke it:

| the question | what it forced | what it exposed |
|---|---|---|
| *what happened?* | classification rules | the invented format matched nothing |
| *who did it?* | envelope extraction | damage lines are written from the other end |
| *was it a critical?* | cause→effect linking | one-to-one needs consuming; near-misses need excluding |
| *which spell?* | one-to-many linking | inference needs a confidence boundary |
| *will we catch new spell types?* | the candidate/ratio report | conservative defaults rot silently |
| *party or opponent?* | stream-level resolution | signals must be ranked; friendly fire is the test case |
| *which of the identical enemies?* | — | some questions have no answer; establish that |
| *separate the summons* | a role-keyed column | role columns need their mirror |

Each answer was only reachable because the previous ones were cheap to revise.

The lesson isn't "don't design schemas". It's that for an unstructured stream you genuinely **cannot**
know the useful entities until you've asked real questions of real data — so the thing to get right
first isn't the schema, it's the **substrate**: immutable raw capture, stable identity, additive
transforms, free re-derivation, and a report that tells you what you're still getting wrong.

Get that right and the schema can afford to be wrong for a while. Get it wrong and the first schema
you guess is the one you're stuck with.
