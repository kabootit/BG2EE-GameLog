/**
 * Tests for the browser-side helpers in `web/`.
 *
 * Those files run in a page rather than in Deno, so most of what they do needs
 * a DOM and cannot be tested here. The pure parts can be, and are: the sort
 * chain in particular, because two separate sorting bugs were reported from use
 * while it sat inside an event handler where nothing could reach it.
 *
 * `esc()` is covered indirectly by the `html-escaping` invariant in lint.ts,
 * which checks that every page imports it and that it still escapes all five
 * characters.
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  cellHidden,
  columnIsEmpty,
  groupScope,
  nextSort,
  sortRows,
  stripSpeaker,
} from "../web/common.js";

const MAX = 4;
/** Compact form, so the expected chain reads like the header row does. */
const keys = (sort: Array<{ key: string; dir: string }>) =>
  sort.map((s) => `${s.key}:${s.dir}`);

Deno.test("clicking an unsorted column sorts by it ascending", () => {
  assertEquals(keys(nextSort([], "kind", MAX)), ["kind:asc"]);
});

Deno.test("clicking the primary column reverses it, then clears it", () => {
  const asc = nextSort([], "kind", MAX);
  const desc = nextSort(asc, "kind", MAX);
  assertEquals(keys(desc), ["kind:desc"]);
  assertEquals(keys(nextSort(desc, "kind", MAX)), []);
});

Deno.test("a new column becomes primary, not least significant", () => {
  // The reported bug, exactly: reverse-sort on id, then sort on side. Appending
  // the new key put it behind `id`, which is unique, so no two rows ever tied on
  // it and the side ordering was never consulted. The click looked dead.
  let sort = nextSort([], "id", MAX); // id:asc
  sort = nextSort(sort, "id", MAX); // id:desc
  assertEquals(keys(sort), ["id:desc"]);

  sort = nextSort(sort, "actor_side", MAX);
  assertEquals(keys(sort), ["actor_side:asc", "id:desc"], "side leads, id follows");
});

Deno.test("a buried column is promoted rather than toggled in place", () => {
  // Otherwise the same dead click returns by another route: get side behind id,
  // click side, and toggling its direction changes nothing visible.
  const sort = nextSort(nextSort([], "actor_side", MAX), "id", MAX);
  assertEquals(keys(sort), ["id:asc", "actor_side:asc"]);

  const promoted = nextSort(sort, "actor_side", MAX);
  assertEquals(keys(promoted), ["actor_side:asc", "id:asc"]);
  assertEquals(promoted[0].dir, "asc", "direction is kept; promotion is the change");
});

Deno.test("the chain is capped and drops its oldest key", () => {
  let sort: Array<{ key: string; dir: string }> = [];
  for (const key of ["a", "b", "c", "d"]) sort = nextSort(sort, key, MAX);
  assertEquals(keys(sort), ["d:asc", "c:asc", "b:asc", "a:asc"]);

  // A fifth key evicts "a", the least significant, not the one just clicked.
  assertEquals(keys(nextSort(sort, "e", MAX)), ["e:asc", "d:asc", "c:asc", "b:asc"]);
});

Deno.test("the input chain is never mutated", () => {
  // The page holds this in `state.sort` and re-renders from it, so an in-place
  // edit would leave the header marks describing a chain that no longer exists.
  const before = nextSort([], "kind", MAX);
  const snapshot = keys(before);
  nextSort(before, "actor", MAX);
  nextSort(before, "kind", MAX);
  assertEquals(keys(before), snapshot);
});

// --- the text column ------------------------------------------------------

/** Row shapes as the API returns them; only the name columns matter here. */
const row = (o: Partial<Record<string, string | null>> = {}) => ({
  actor: null,
  target: null,
  summon: null,
  target_summon: null,
  ...o,
});

Deno.test("the speaker prefix is dropped when it is the actor", () => {
  // The reported duplication: an actor cell reading Jaheira next to text
  // reading "Jaheira: Save vs. Death : 11".
  assertEquals(
    stripSpeaker("Jaheira: Save vs. Death : 11", row({ actor: "Jaheira" })),
    "Save vs. Death : 11",
  );
});

Deno.test("on a damage line the speaker is the target, and still goes", () => {
  // The reason this checks every name on the row rather than just the actor.
  // "Vampire: Takes 13 slashing damage from Tyras" has actor Tyras and target
  // Vampire - the victim speaks - so an actor-only rule would leave it in place.
  assertEquals(
    stripSpeaker("Vampire: Takes 13 slashing damage from Tyras", row({
      actor: "Tyras",
      target: "Vampire",
    })),
    "Takes 13 slashing damage from Tyras",
  );
});

Deno.test("a summon's name counts, since it shows in its own column", () => {
  // The actor cell is blanked for a summon and the name appears under `summon`,
  // so it is still visible on the row and still redundant in the text.
  assertEquals(
    stripSpeaker("Fire Elemental: Poison", row({ summon: "Fire Elemental" })),
    "Poison",
  );
});

Deno.test("a name not on the row is left alone", () => {
  // The safety property: nothing is ever hidden that is not visible elsewhere
  // on the same row. A mismatch means the text is the only place it appears.
  assertEquals(
    stripSpeaker("Cernd: Save vs. Spell : 10", row({ actor: "Jan" })),
    "Cernd: Save vs. Spell : 10",
  );
});

Deno.test("engine narration keeps its colon", () => {
  // "The Party Has Gained Experience: 175" reads like a speaker prefix and is
  // not one. Two things stop it: the name is no row's actor, and it is longer
  // than a creature name can be.
  for (const text of [
    "The Party Has Gained Experience: 175",
    "PAUSED",
    "Jan: What? Is there a griffon about?",
  ]) {
    assertEquals(stripSpeaker(text, row()), text, text);
  }
});

Deno.test("a column being sorted on always shows its value", () => {
  // The reported "gap". `target` blanks itself for a summon because the name is
  // shown in the neighbouring summon column - but 2,528 rows carry the same
  // name in both, so sorting by target ordered on a value those cells refused
  // to display. The result was a run of blanks in the middle of an otherwise
  // alphabetical column, which reads as the sort having broken.
  const target = { key: "target", hideWhen: (r: { target_summon: string | null }) =>
    r.target_summon !== null };
  const summonRow = { target: "Aerial Servant", target_summon: "Aerial Servant" };

  assertEquals(cellHidden(target, summonRow, false), true, "blanked when not sorted");
  assertEquals(cellHidden(target, summonRow, true), false, "shown when sorted by it");
});

Deno.test("a column with no hideWhen is never blanked", () => {
  assertEquals(cellHidden({ key: "detail" }, { target_summon: "x" }, false), false);
});

Deno.test("a non-summon row keeps its value either way", () => {
  const target = { key: "target", hideWhen: (r: { target_summon: string | null }) =>
    r.target_summon !== null };
  const plainRow = { target: "Wyvern", target_summon: null };
  assertEquals(cellHidden(target, plainRow, false), false);
  assertEquals(cellHidden(target, plainRow, true), false);
});

/**
 * Group-by rows, shaped like what `/api/groups` returns: a text key plus
 * aggregates, several of them sparse.
 */
const groups = () => [
  { value: "Cernd", events: 120, damage: 340, worst_save: -1 },
  { value: "Anomen", events: 80, damage: 340, worst_save: 7 },
  { value: "Jaheira", events: 200, damage: null, worst_save: null },
  { value: "jan", events: 9, damage: 12, worst_save: null },
];
const values = (rows: Array<{ value: string }>) => rows.map((r) => r.value);

Deno.test("group rows sort by a numeric column in both directions", () => {
  assertEquals(values(sortRows(groups(), [{ key: "events", dir: "asc" }])), [
    "jan",
    "Anomen",
    "Cernd",
    "Jaheira",
  ]);
  assertEquals(values(sortRows(groups(), [{ key: "events", dir: "desc" }])), [
    "Jaheira",
    "Cernd",
    "Anomen",
    "jan",
  ]);
});

Deno.test("empty cells sort last in both directions", () => {
  // Matching the `col IS NULL, col DIR` the server emits for the events table.
  // Descending on a sparse column would otherwise open with a screen of blanks,
  // which is the same complaint the `target` gap was.
  for (const dir of ["asc", "desc"]) {
    const sorted = values(sortRows(groups(), [{ key: "worst_save", dir }]));
    assertEquals(sorted.slice(2).sort(), ["Jaheira", "jan"], dir);
  }
  // Negative rolls are real game output and must not read as missing.
  assertEquals(values(sortRows(groups(), [{ key: "worst_save", dir: "asc" }]))[0], "Cernd");
});

Deno.test("ties fall through to the next key, then to the server's order", () => {
  const rows = groups();
  // Cernd and Anomen both did 340 damage; Cernd came first from the server.
  assertEquals(values(sortRows(rows, [{ key: "damage", dir: "desc" }])).slice(0, 2), [
    "Cernd",
    "Anomen",
  ]);
  assertEquals(
    values(sortRows(rows, [{ key: "damage", dir: "desc" }, { key: "events", dir: "asc" }]))
      .slice(0, 2),
    ["Anomen", "Cernd"],
  );
});

Deno.test("text sorts case-insensitively and numbers inside text sort numerically", () => {
  // Creature names arrive in whatever case the game uses, and `jan` next to
  // `Jaheira` should not jump to the end of the alphabet.
  assertEquals(values(sortRows(groups(), [{ key: "value", dir: "asc" }])), [
    "Anomen",
    "Cernd",
    "Jaheira",
    "jan",
  ]);
  const rounds = [{ value: "round 10" }, { value: "round 2" }];
  assertEquals(values(sortRows(rounds, [{ key: "value", dir: "asc" }])), [
    "round 2",
    "round 10",
  ]);
});

Deno.test("an empty chain leaves the server's order alone", () => {
  const rows = groups();
  assertEquals(sortRows(rows, []), rows);
});

// --- what the group aggregates cover ---------------------------------------

Deno.test("a window covering everything matched says so, with no range", () => {
  // The common case, and the one that must not read as a slice: "all 69,722
  // matched events" rather than "events 1-69,722 of 69,722".
  assertEquals(
    groupScope({ matched: 69722, windowed: 69722, offset: 0 }),
    "all 69,722 matched events",
  );
  // A window larger than the match still covers all of it.
  assertEquals(
    groupScope({ matched: 12, windowed: 500, offset: 0 }),
    "all 12 matched events",
  );
});

Deno.test("a partial window names its range and the total it came from", () => {
  // Numbers from 500 events look identical to numbers from 70,000, so the
  // scope has to be on screen next to them.
  assertEquals(
    groupScope({ matched: 69722, windowed: 500, offset: 0 }),
    "events 1–500 of 69,722 matched",
  );
  assertEquals(
    groupScope({ matched: 69722, windowed: 500, offset: 1000 }),
    "events 1,001–1,500 of 69,722 matched",
  );
});

Deno.test("an offset past the end is not reported as a range", () => {
  // Paging beyond the data would otherwise print "events 70,001-70,000".
  assertEquals(
    groupScope({ matched: 69722, windowed: 0, offset: 70000 }),
    "nothing in this window, of 69,722 matched",
  );
});

Deno.test("no matching events says nothing about windows", () => {
  assertEquals(groupScope({ matched: 0, windowed: 0, offset: 0 }), "no matching events");
});

// --- dropping columns that would draw nothing -------------------------------

Deno.test("a column with no value on any row is empty", () => {
  // The reported problem: with no kind selected every column is on screen, and
  // "made?", "resisted" and "spell" are blank for whole pages while each still
  // holds its header's width. The text column was left about 70px.
  const rows = [{ spell: null }, { spell: null }, { spell: "" }];
  assertEquals(columnIsEmpty({ key: "spell" }, rows, []), true);
  assertEquals(columnIsEmpty({ key: "spell" }, [...rows, { spell: "Fireball" }], []), false);
});

Deno.test("a flag column of zeroes is empty, since only the true case is drawn", () => {
  const crit = { key: "critical", flag: true };
  assertEquals(columnIsEmpty(crit, [{ critical: 0 }, { critical: 0 }], []), true);
  assertEquals(columnIsEmpty(crit, [{ critical: 0 }, { critical: 1 }], []), false);
});

Deno.test("a verdict column of unknowns is empty, but a failure is not", () => {
  // saved is tri-state and null is the common case: every enemy save. A page of
  // nulls draws nothing, while a 0 draws FAILED and must keep the column.
  const saved = { key: "saved", verdict: true };
  assertEquals(columnIsEmpty(saved, [{ saved: null }, { saved: null }], []), true);
  assertEquals(columnIsEmpty(saved, [{ saved: null }, { saved: 0 }], []), false);
  assertEquals(columnIsEmpty(saved, [{ saved: 1 }], []), false);
});

Deno.test("a column blanked on every row counts as empty", () => {
  // actor blanks itself on a summon row because the name shows under summon. A
  // page of nothing but summon rows draws an empty actor column, so it is width
  // spent on nothing even though the field is populated.
  const actor = {
    key: "actor",
    hideWhen: (r: { summon: string | null }) => r.summon !== null,
  };
  const summonRows = [
    { actor: "Cernd", summon: "Fire Elemental" },
    { actor: "Cernd", summon: "Aerial Servant" },
  ];
  assertEquals(columnIsEmpty(actor, summonRows, []), true);

  // ...unless it is being sorted on, which un-blanks it: see cellHidden().
  assertEquals(columnIsEmpty(actor, summonRows, [{ key: "actor", dir: "asc" }]), false);
});

Deno.test("no rows at all leaves every column looking empty", () => {
  // Which is why ALWAYS_SHOWN exists on the page: an empty page must not also
  // lose its headers.
  assertEquals(columnIsEmpty({ key: "spell" }, [], []), true);
});
