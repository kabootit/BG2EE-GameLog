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
const { EventLinker, parseLine } = await import("./parse.ts");
const { handle } = await import("./serve.ts");

/** Insert lines as a named session, through the real parse + link path. */
function seed(session: string, lines: string[], startId = 1) {
  const db = openDb();
  const insert = makeInserter(db);
  const linker = new EventLinker();
  lines.forEach((text, i) => {
    const id = startId + i;
    const e = parseLine(
      `2026-01-01 00:00:00.000 B[1:2] INFO: LUA: A7LOG\t${id}\t${id * 60}\t${id * 1000}\tDay 1\tWORLD\t${text}`,
    );
    if (e) insert(session, linker.apply(e));
  });
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
  assertEquals(d.orderBy, "session ASC, id ASC");
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
