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
import { nextSort } from "../web/common.js";

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
