/**
 * API tests, run with `deno task test`.
 *
 * Builds a throwaway database via BG2EE_DB so the tests never touch the real
 * one, then drives `handle()` directly — no port is bound, because serve.ts
 * guards `Deno.serve` behind `import.meta.main`.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";

// Must be set before serve.ts is imported: it opens the database at module load.
const tmp = await Deno.makeTempDir();
Deno.env.set("BG2EE_DB", join(tmp, "test.db"));

const { makeInserter, openDb } = await import("./db.ts");
const { EventLinker, parseLine, SideResolver } = await import("./parse.ts");
const { handle } = await import("./serve.ts");

/**
 * Insert lines as a named session, through the real parse + link path.
 *
 * With a roster given, sides are resolved the way `import.ts` does it — in two
 * passes, because who is on which side is only knowable once the whole session
 * has been seen. Needed for anything testing `actor_side`, whose value is the
 * one thing in a row that does not also appear in `raw`.
 */
function seed(session: string, lines: string[], startId = 1, roster: string[] = []) {
  const db = openDb();
  const insert = makeInserter(db);
  const linker = new EventLinker();
  const sides = new SideResolver();
  sides.addRoster(roster);

  const events = lines.map((text, i) => {
    const id = startId + i;
    const e = parseLine(
      `2026-01-01 00:00:00.000 B[1:2] INFO: LUA: A7LOG\t${id}\t${id * 60}\t${id * 1000}\tDay 1\tWORLD\t${text}`,
    );
    if (e === null) return null;
    const linked = linker.apply(e);
    sides.observe(linked);
    return linked;
  }).filter((e) => e !== null);

  for (const e of events) insert(session, roster.length > 0 ? sides.label(e) : e);
  db.close();
}

const get = async (path: string) =>
  await (await handle(new Request(`http://127.0.0.1/${path}`))).json();

// Two sessions. The older one is deliberately the interesting one, so a fold
// that reached into it would be obvious.
seed("session-20260101-000000.log", [
  "Ancient Enemy: Casts Mirror Image : Ancient Enemy",
  "Ancient Enemy: Mirror Imaged",
]);
seed("session-20260202-000000.log", [
  "Recent Foe: Casts Stoneskin : Recent Foe",
  "Recent Foe: Stoneskin",
  "Recent Foe: Attacks Jaheira",
]);

/**
 * A session with resolved sides, for the sort and search cases.
 *
 * Deliberately named older than both of the above so it is never "the newest
 * session" and cannot disturb the range tests, which pick that implicitly. It
 * is only ever queried by name.
 */
const SIDED = "session-20251231-000000.log";
seed(SIDED, [
  "Wyvern: Takes 9 piercing damage from Jaheira",
  "Wyvern: Takes 7 slashing damage from Jaheira",
  "Jaheira: Takes 4 piercing damage from Wyvern",
  // No actor at all, so no side: this is the row that must sort last, not first.
  "Your journal has been updated.",
], 1, ["Jaheira"]);

Deno.test("with no session given, the newest is used", async () => {
  const d = await get("api/combatants?window=400");
  assertEquals(d.session, "session-20260202-000000.log");
});

Deno.test("the range never spills into an older session", async () => {
  // The bug this replaced: `ORDER BY session DESC, id DESC` with a window larger
  // than the newest session quietly pulled in rows from the one before it,
  // mixing creatures from separate playthroughs onto one screen.
  const d = await get("api/combatants?from=0&to=99999");
  const names = [...d.opponents, ...d.party, ...d.neutral].map((c: { name: string }) => c.name);
  assertEquals(names.includes("Ancient Enemy"), false);
  assertEquals(d.folded, 3);
});

Deno.test("an explicit session is honored over the newest", async () => {
  const d = await get("api/combatants?session=session-20260101-000000.log");
  assertEquals(d.session, "session-20260101-000000.log");
  const names = [...d.opponents, ...d.party, ...d.neutral].map((c: { name: string }) => c.name);
  assertEquals(names.includes("Ancient Enemy"), true);
  assertEquals(names.includes("Recent Foe"), false);
});

Deno.test("maxBack reports how far back the session reaches", async () => {
  const d = await get("api/combatants");
  // Ids 1-3, so you can go 2 events back from the newest.
  assertEquals(d.maxBack, 2);
  assertEquals(d.bounds, { min: 1, max: 3 });
  assertEquals(d.sessionTotal, 3);
});

Deno.test("the range is ages, not ids: 0 is the newest event", async () => {
  // This is the whole point of the relative form. The client cannot send an id
  // on first load, because it would need `max`, which only arrives in the
  // response. `0` needs no such knowledge and stays "now" as a session grows.
  const d = await get("api/combatants?from=0&to=0");
  assertEquals([d.from, d.to], [0, 0]);
  assertEquals([d.fromId, d.toId], [3, 3], "age 0 is the highest id");
  assertEquals(d.folded, 1);
});

Deno.test("a larger age reaches further back", async () => {
  const d = await get("api/combatants?from=0&to=2");
  assertEquals([d.fromId, d.toId], [1, 3]);
  assertEquals(d.folded, 3);
});

Deno.test("an interior window excludes both ends", async () => {
  // 1-1 back is the middle row only.
  const d = await get("api/combatants?from=1&to=1");
  assertEquals([d.fromId, d.toId], [2, 2]);
  assertEquals(d.folded, 1);
});

Deno.test("with no range given, the default is the most recent events", async () => {
  const d = await get("api/combatants");
  assertEquals(d.from, 0, "starts at now");
  assertEquals(d.to, 2, "400-event default, clamped to this short session");
  assertEquals(d.toId, 3, "reaches the newest event");
  assertEquals(d.folded, 3);
});

/** All combatants regardless of side — these fixtures carry no side data. */
const everyone = (d: { opponents: unknown[]; party: unknown[]; neutral: unknown[] }) =>
  [...d.opponents, ...d.party, ...d.neutral] as Array<
    { name: string; observations: Array<{ name: string }> }
  >;

Deno.test("an explicit range folds exactly that slice", async () => {
  // Ids 1-2 are the cast and the landed effect; id 3 is an attack. Age 0 is id 3.
  const narrow = await get("api/combatants?from=0&to=0");
  assertEquals(narrow.folded, 1);
  // Only the attack in range, so nothing was observed.
  assertEquals(everyone(narrow).flatMap((c) => c.observations).length, 0);

  const wide = await get("api/combatants?from=1&to=2");
  assertEquals([wide.fromId, wide.toId, wide.folded], [1, 2, 2]);
  assertEquals(
    everyone(wide).find((c) => c.name === "Recent Foe")!.observations[0].name,
    "Stoneskin",
  );
});

Deno.test("one end of the range may be left open", async () => {
  // Only `to` given: `from` falls back to 0, the newest event.
  assertEquals(await get("api/combatants?to=1").then((d) => [d.from, d.to]), [0, 1]);
  // Only `from` given: `to` falls back to the default span, clamped.
  assertEquals(await get("api/combatants?from=1").then((d) => [d.from, d.to]), [1, 2]);
});

Deno.test("ages are clamped to the session, and echoed back", async () => {
  // Echoing matters: the UI shows what was used, so a clamp is visible rather
  // than leaving the inputs disagreeing with the data on screen.
  const d = await get("api/combatants?from=0&to=99999");
  assertEquals([d.from, d.to], [0, 2], "clamped to maxBack");
  assertEquals([d.fromId, d.toId], [1, 3]);
});

Deno.test("a reversed range is read as a typo, not an empty result", async () => {
  const d = await get("api/combatants?from=2&to=0");
  assertEquals([d.from, d.to, d.folded], [0, 2, 3]);
});

Deno.test("bad or negative ages fall back to the default", async () => {
  // A negative age is meaningless - you cannot go forward of the newest event.
  for (const bad of ["abc", "1.5", "", "-5"]) {
    const d = await get(`api/combatants?from=${bad}&to=${bad}`);
    assertEquals([d.from, d.to], [0, 2], `from=to=${bad}`);
  }
});

Deno.test("events limit and offset are bounded the same way", async () => {
  assertEquals((await get("api/events?limit=99999")).limit, 5000);
  assertEquals((await get("api/events?limit=-5")).limit, 500);
  // Offset legitimately may be zero, unlike limit and window.
  assertEquals((await get("api/events?offset=0")).offset, 0);
  assertEquals((await get("api/events?offset=-5")).offset, 0);
});

Deno.test("an unknown group-by column is refused, not interpolated", async () => {
  const res = await handle(new Request("http://127.0.0.1/api/groups?by=raw;DROP+TABLE"));
  assertEquals(res.status, 400);
});

Deno.test("sortable columns are allowlisted", async () => {
  // An unrecognized sort key is dropped rather than reaching the SQL.
  const d = await get("api/events?sort=evil;DROP:desc&limit=1");
  assertEquals(d.orderBy, "session DESC, id DESC");
});

Deno.test("unknown routes 404", async () => {
  assertEquals((await handle(new Request("http://127.0.0.1/nope"))).status, 404);
});

Deno.test("each view has its own route, with the right content type", async () => {
  for (const [path, type] of [
    ["/", "text/html"],
    ["/events", "text/html"],
    ["/combatants", "text/html"],
    ["/app.css", "text/css"],
    ["/common.js", "text/javascript"],
  ]) {
    const res = await handle(new Request(`http://127.0.0.1${path}`));
    assertEquals(res.status, 200, path);
    assertEquals(res.headers.get("content-type")?.startsWith(type), true, path);
    await res.body?.cancel();
  }
});

Deno.test("the two pages serve different documents", async () => {
  const events = await (await handle(new Request("http://127.0.0.1/events"))).text();
  const combatants = await (await handle(new Request("http://127.0.0.1/combatants"))).text();
  assertEquals(events.includes("<title>BG2EE game log — events</title>"), true);
  assertEquals(combatants.includes("<title>BG2EE game log — combatants</title>"), true);
  // Each marks its own tab current, so the highlight is right on a cold load.
  assertEquals(events.includes(`data-path="/events" href="/events" aria-current`), true);
  assertEquals(combatants.includes(`data-path="/combatants" href="/combatants" aria-current`), true);
});

Deno.test("static routes cannot be walked out of web/", async () => {
  // Two layers, and it is worth knowing which does what. `new URL()` normalizes
  // `..` away before routing, so the pathname that reaches the lookup is already
  // collapsed; the explicit route map then means it either matches a literal key
  // or 404s. A path never reaches the filesystem either way.
  for (const path of [
    "/../src/config.ts",
    "/..%2Fsrc%2Fconfig.ts",
    "/app.css/../../src/db.ts",
    "/events.html", // the real filename is not a route; only "/events" is
    "/web/app.css",
    "/./../deno.json",
  ]) {
    const res = await handle(new Request(`http://127.0.0.1${path}`));
    assertEquals(res.status, 404, path);
    await res.body?.cancel();
  }
});

Deno.test("normalization can only ever land on another allowed route", async () => {
  // "/common.js/../app.css" collapses to "/app.css", which is allowed and should
  // serve. That is normalization working, not an escape — the point of the map
  // is that the destination is always one of its keys.
  const res = await handle(new Request("http://127.0.0.1/common.js/../app.css"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type")?.startsWith("text/css"), true);
  await res.body?.cancel();
});

Deno.test("pages are served no-store so an edit shows on reload", async () => {
  const res = await handle(new Request("http://127.0.0.1/events"));
  assertEquals(res.headers.get("cache-control"), "no-store");
  await res.body?.cancel();
});

// --- sorting and searching the side columns -------------------------------
//
// Both reported from use: the side column "doesn't sort nor does the search
// work on it".

Deno.test("free-text search covers the side columns", async () => {
  // `actor_side` is the one column whose value is not also inside `raw`, so it
  // was invisible to a search over raw/actor/target - and there is no filter
  // dropdown for it either, leaving the value on screen with no way to select
  // it. Searching for it found nothing at all.
  const d = await get(`api/events?session=${SIDED}&q=opponent`);
  assertEquals(d.total, 3, "the wyvern's three rows");
  for (const row of d.rows) {
    assertEquals(
      row.actor_side === "opponent" || row.target_side === "opponent",
      true,
      row.raw,
    );
  }
});

Deno.test("search still matches the raw text and the derived columns", async () => {
  // Widening must not have cost the original behavior.
  assertEquals((await get(`api/events?session=${SIDED}&q=piercing`)).total, 2);
  assertEquals((await get(`api/events?session=${SIDED}&q=Jaheira`)).total, 3);
  assertEquals((await get(`api/events?session=${SIDED}&q=journal`)).total, 1);
});

Deno.test("sorting a sparse column never leads with empty rows", async () => {
  // The bug behind "doesn't sort". SQLite orders NULL first, and most columns
  // here are sparse, so ascending by side filled the first page with blanks —
  // which reads as sorting being broken rather than as the empties coming
  // first. They are dropped outright now, but the ordering still has to be a
  // real ordering rather than merely non-null first.
  const asc = await get(`api/events?session=${SIDED}&sort=actor_side:asc`);
  assertEquals(asc.rows[0].actor_side, "opponent");

  const desc = await get(`api/events?session=${SIDED}&sort=actor_side:desc`);
  assertEquals(desc.rows[0].actor_side, "party");

  // With the empties kept, they must still come last in both directions — which
  // is why orderClause emits its own IS NULL terms even though the primary
  // column is normally filtered.
  for (const dir of ["asc", "desc"]) {
    const kept = await get(`api/events?session=${SIDED}&sort=actor_side:${dir}&hideEmpty=0`);
    assertEquals(kept.rows[0].actor_side !== null, true, dir);
    assertEquals(kept.rows[kept.rows.length - 1].actor_side, null, dir);
  }
});

Deno.test("the sort-key cap counts columns, not SQL terms", async () => {
  // Each key now contributes two terms - "col IS NULL" then "col DIR" - so a
  // cap on terms would silently halve how many columns a user can chain.
  const d = await get(
    "api/events?sort=kind:asc,actor:asc,target:asc,amount:asc,roll:asc&limit=1",
  );
  const columns = d.orderBy.split(", ").filter((t: string) => t.endsWith(" IS NULL"));
  assertEquals(columns.length, 4, d.orderBy);
  assertEquals(d.orderBy.includes("roll"), false, "the fifth key is dropped");
  // Reverse capture order always closes the chain, so paging cannot repeat
  // rows and each group reads newest-first.
  assertEquals(d.orderBy.endsWith("session DESC, id DESC"), true, d.orderBy);
});

Deno.test("sorting by a column drops the rows with nothing in it", async () => {
  // Sorting by a column is how you examine it, and most columns here are
  // sparse, so the empties were just a block of blank cells at one end.
  // The SIDED session has three rows with a side and one journal line with no
  // actor at all.
  const d = await get(`api/events?session=${SIDED}&sort=actor_side:asc`);
  assertEquals(d.total, 3);
  assertEquals(d.hiddenEmpty, 1);
  assertEquals(d.emptyColumn, "actor_side");
  for (const row of d.rows) assertEquals(row.actor_side !== null, true, row.raw);
});

Deno.test("the dropped count is reported, not silently applied", async () => {
  // A total that shrinks when you click a header reads as missing data unless
  // something says otherwise, so the number has to come back with the rows.
  const plain = await get(`api/events?session=${SIDED}`);
  const sorted = await get(`api/events?session=${SIDED}&sort=actor_side:asc`);
  assertEquals(plain.total, sorted.total + sorted.hiddenEmpty);
  assertEquals(plain.hiddenEmpty, 0, "nothing is dropped without a sort");
  assertEquals(plain.emptyColumn, null);
});

Deno.test("hideEmpty=0 keeps the empty rows", async () => {
  const d = await get(`api/events?session=${SIDED}&sort=actor_side:asc&hideEmpty=0`);
  assertEquals(d.total, 4);
  assertEquals(d.hiddenEmpty, 0);
  assertEquals(d.emptyColumn, null);
  // Still ordered with the empties last, which is why orderClause keeps its
  // own IS NULL terms even though the primary column is normally filtered.
  assertEquals(d.rows[d.rows.length - 1].actor_side, null);
});

Deno.test("only the primary sort column is filtered", async () => {
  // Filtering every key in the chain compounds fast: side then spell would
  // quietly reduce the table to spell-attributed damage rows.
  const d = await get(`api/events?session=${SIDED}&sort=actor_side:asc,spell:asc`);
  assertEquals(d.emptyColumn, "actor_side");
  assertEquals(d.total, 3, "not narrowed further by the spell key");
  assertEquals(d.rows.some((r: { spell: string | null }) => r.spell === null), true);
});

Deno.test("sorting by a column that is never empty drops nothing", async () => {
  const d = await get(`api/events?session=${SIDED}&sort=id:desc`);
  assertEquals(d.total, 4);
  assertEquals(d.hiddenEmpty, 0);
});

Deno.test("a rejected sort key does not filter anything", async () => {
  // No valid primary key means no column to filter on, so the row set must be
  // untouched rather than falling back to some default column.
  const d = await get(`api/events?session=${SIDED}&sort=evil;DROP:desc`);
  assertEquals(d.total, 4);
  assertEquals(d.emptyColumn, null);
  assertEquals(d.orderBy, "session DESC, id DESC");
});

Deno.test("events default to newest first", async () => {
  // Opening the table on the start of the session is the wrong end: after a
  // fight what you want is what just happened.
  const d = await get(`api/events?session=${SIDED}`);
  assertEquals(d.rows.map((r: { id: number }) => r.id), [4, 3, 2, 1]);
  assertEquals(d.orderBy, "session DESC, id DESC");
});

Deno.test("reverse time is the final tiebreak under any sort", async () => {
  // "Always" reverse-chronological: within each group of whatever is sorted
  // above it, the latest rows come first.
  //
  // In this session ids 1-2 are Jaheira hitting the wyvern (actor party) and id
  // 3 is the wyvern hitting back (actor opponent).
  const d = await get(`api/events?session=${SIDED}&sort=actor_side:asc`);
  assertEquals(
    d.rows.map((r: { id: number; actor_side: string }) => `${r.actor_side}:${r.id}`),
    ["opponent:3", "party:2", "party:1"],
    "opponent group first, and newest first inside the party group",
  );
});

Deno.test("an explicit ascending sort on id still wins", async () => {
  // The default must be a default, not an override: the trailing DESC term
  // comes after the chosen key, so SQLite honours the explicit one.
  const d = await get(`api/events?session=${SIDED}&sort=id:asc`);
  assertEquals(d.rows.map((r: { id: number }) => r.id), [1, 2, 3, 4]);
});

Deno.test("capture-gap markers are counted, not left among the events", async () => {
  // `resync` is the one kind that is not game output - it is this project's own
  // marker for the engine replacing combatLog and losing whatever was pending.
  // It carries no actor, target or derived column, so as a table row it reads
  // as a broken event. It is hidden in the view; the count has to survive that,
  // because a data-loss warning that merely disappears is worse than one that
  // looks out of place.
  seed("session-20251230-000000.log", [
    "Wyvern: Takes 9 piercing damage from Jaheira",
    "capture resynced: combatLog was replaced",
    "Wyvern: Takes 7 slashing damage from Jaheira",
  ]);

  const all = await get("api/events?session=session-20251230-000000.log");
  assertEquals(all.gaps, 1);
  assertEquals(all.total, 3);

  // With the kind excluded the way "battle only" does, the row goes but the
  // count stays.
  const battle = await get(
    "api/events?session=session-20251230-000000.log&exclude=resync",
  );
  assertEquals(battle.total, 2, "the marker is not among the rows");
  assertEquals(battle.rows.some((r: { kind: string }) => r.kind === "resync"), false);
  assertEquals(battle.gaps, 1, "but it is still reported");
});

Deno.test("a session with no gaps reports none", async () => {
  const d = await get(`api/events?session=${SIDED}`);
  assertEquals(d.gaps, 0);
});

Deno.test("kind counts describe the rows actually on offer", async () => {
  // A facet count has to match what selecting that kind would give you. The
  // empty-row drop that sorting applies used to be missing here, so sorted by a
  // sparse column the dropdown advertised the unsorted totals while the table
  // showed a fraction of them.
  const sum = (d: { kinds: Array<{ n: number }> }) => d.kinds.reduce((s, k) => s + k.n, 0);

  const plain = await get(`api/events?session=${SIDED}`);
  assertEquals(sum(await get(`api/facets?session=${SIDED}`)), plain.total);

  // `roll` is only on save and attack rows, so sorting by it drops the rest.
  const sorted = await get(`api/events?session=${SIDED}&sort=roll:desc`);
  assertEquals(sorted.total < plain.total, true, "the drop actually bites");
  assertEquals(sum(await get(`api/facets?session=${SIDED}&sort=roll:desc`)), sorted.total);
});

Deno.test("paging deliberately does not change the kind counts", async () => {
  // The opposite property, and it is not an oversight: a count says what
  // selecting a kind will give you, and selecting one resets the offset. Counts
  // scoped to the visible page would be at most one screen and mostly zero.
  const sum = (d: { kinds: Array<{ n: number }> }) => d.kinds.reduce((s, k) => s + k.n, 0);
  const all = sum(await get(`api/facets?session=${SIDED}`));
  assertEquals(sum(await get(`api/facets?session=${SIDED}&limit=1&offset=2`)), all);
});

Deno.test("no column to filter on leaves the row set untouched", async () => {
  // Regression guard for a null reaching filters() as if it were a column name:
  // it emitted "null IS NOT NULL", which is never true, and silently zeroed
  // every facet count while the rows themselves still looked right.
  const d = await get(`api/facets?session=${SIDED}`);
  assertEquals(d.kinds.length > 0, true);
  assertEquals(d.sessions.length > 0, true);
});

Deno.test("group aggregates are scoped to the paging window", async () => {
  // The whole session first, as the baseline: Jaheira's two hits on the wyvern
  // sum to 16.
  const all = await get(`api/groups?by=actor&session=${SIDED}`);
  const of = (d: { rows: Array<{ key: string; events: number; damage: number }> }, key: string) =>
    d.rows.find((r) => r.key === key);
  assertEquals(of(all, "Jaheira")?.damage, 16);
  assertEquals(all.matched, 4);
  assertEquals(all.windowed, 4);

  // Rows are newest-first, so the first page holds the journal line and the
  // wyvern's hit back — and Jaheira's damage must drop out of the totals
  // entirely rather than surviving as a session-wide sum.
  const first = await get(`api/groups?by=actor&session=${SIDED}&limit=2`);
  assertEquals(of(first, "Jaheira"), undefined, "outside the window");
  assertEquals(of(first, "Wyvern")?.damage, 4);
  assertEquals(first.windowed, 2);

  // Paging back reaches her two rows, and only those.
  const second = await get(`api/groups?by=actor&session=${SIDED}&limit=2&offset=2`);
  assertEquals(of(second, "Jaheira")?.damage, 16);
  assertEquals(of(second, "Jaheira")?.events, 2);
  assertEquals(of(second, "Wyvern"), undefined);
  assertEquals(second.offset, 2);
});

Deno.test("a group window may be wider than the table's row cap", async () => {
  // The events table stops at 5000 because it renders a row per event. Grouping
  // returns a row per group however wide the window, so the whole-corpus case
  // has to stay reachable instead of being clamped to one page.
  const d = await get(`api/groups?by=actor&session=${SIDED}&limit=20000`);
  assertEquals(d.limit, 20000);
  assertEquals(d.windowed, d.matched, "covers everything matched");
});

Deno.test("paging past the end groups nothing and says so", async () => {
  const d = await get(`api/groups?by=actor&session=${SIDED}&offset=99`);
  assertEquals(d.rows.length, 0);
  assertEquals(d.windowed, 0);
  assertEquals(d.matched, 4, "still reports what the filters matched");
});
