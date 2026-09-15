/**
 * Local viewer for the captured events.
 *
 * Read-only: `play.ts` is the only writer. The database is opened in WAL mode,
 * so this can run while a session is being captured and a refresh will pick up
 * new rows.
 */
import { join } from "jsr:@std/path@1";
import { DB_PATH, SERVE_PORT, WEB_DIR } from "./config.ts";
import { openDb } from "./db.ts";
import { type EventRow, foldCombatants } from "./combatants.ts";

/** Column names can never be bound as parameters, so they are allowlisted. */
const SORTABLE = new Set([
  "id",
  "session",
  "wall_clock",
  "game_ticks",
  "clock_ms",
  "game_time",
  "screen",
  "kind",
  "actor",
  "target",
  "amount",
  "roll",
  "resisted",
  "detail",
  "critical",
  "spell",
  "actor_side",
  "target_side",
  "summon",
  "target_summon",
  "raw",
]);
const GROUPABLE = new Set([
  "kind",
  "actor",
  "target",
  "detail",
  "critical",
  "spell",
  "actor_side",
  "target_side",
  "summon",
  "target_summon",
  "screen",
  "session",
]);

type Param = string | number | null;

/**
 * Read a bounded integer from the query string.
 *
 * Anything not a positive integer falls back to the default, then the result is
 * clamped. Written once because the inline version was inconsistent: `|| dflt`
 * caught `0` and `"abc"` but not `-5`, which is truthy and so clamped to the
 * minimum instead of falling back.
 */
function intParam(url: URL, name: string, dflt: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  const n = raw === null ? dflt : Number(raw);
  const valid = Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : dflt;
  return Math.min(Math.max(valid, min), max);
}

const db = openDb();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function query<T>(sql: string, params: Param[] = []): T[] {
  return db.prepare(sql).all(...params).map((row) => ({ ...row })) as T[];
}

/**
 * Build the shared WHERE clause. Values are always bound, never interpolated.
 *
 * `omit` drops one filter. Facet counts use it to exclude their own dimension:
 * the kind counts must respect the selected session, but must not be narrowed by
 * the selected kind, or picking a kind would leave that kind as the only option.
 */
function filters(url: URL, omit?: string): { sql: string; params: Param[] } {
  const clauses: string[] = [];
  const params: Param[] = [];

  const eq = (param: string, column: string) => {
    if (param === omit) return;
    const value = url.searchParams.get(param);
    if (value) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  };
  eq("session", "session");
  eq("kind", "kind");
  eq("actor", "actor");
  eq("target", "target");
  eq("detail", "detail");
  eq("spell", "spell");
  eq("actor_side", "actor_side");
  eq("target_side", "target_side");
  eq("summon", "summon");
  eq("target_summon", "target_summon");

  // Kinds hidden by the viewer's "battle only" toggle. Unlike the `kind`
  // selection this is a scope, not a choice, so it applies to the kinds facet
  // too: the dropdown lists only what the current scope contains.
  const exclude = url.searchParams.get("exclude");
  if (exclude !== null) {
    const kinds = exclude.split(",").map((k) => k.trim()).filter(Boolean);
    if (kinds.length > 0) {
      clauses.push(`kind NOT IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }
  }

  const q = url.searchParams.get("q");
  if (q) {
    clauses.push("(raw LIKE ? OR actor LIKE ? OR target LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function handleEvents(url: URL): Response {
  const { sql: where, params } = filters(url);

  const orderBy = orderClause(url);

  const limit = intParam(url, "limit", 500, 1, 5000);
  // Offset is the one that may legitimately be zero, so it is defaulted to 0 and
  // allowed down to 0 rather than going through the positive-integer rule.
  const rawOffset = Number(url.searchParams.get("offset") ?? "0");
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const [{ n: total }] = query<{ n: number }>(
    `SELECT count(*) AS n FROM events ${where}`,
    params,
  );
  const rows = query(
    `SELECT * FROM events ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return json({ total, limit, offset, orderBy, rows });
}

/** How many sort keys a request may specify. */
const MAX_SORT_KEYS = 4;

/**
 * Build ORDER BY from `sort=col:dir,col:dir,...`, most significant first.
 *
 * Column names cannot be bound as parameters, so every one is checked against
 * SORTABLE and anything unrecognized is dropped rather than interpolated.
 */
function orderClause(url: URL): string {
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const part of (url.searchParams.get("sort") ?? "").split(",")) {
    const [rawColumn, rawDir] = part.split(":");
    const column = rawColumn?.trim() ?? "";
    if (!SORTABLE.has(column) || seen.has(column)) continue;
    seen.add(column);
    terms.push(`${column} ${(rawDir ?? "asc").trim().toLowerCase() === "desc" ? "DESC" : "ASC"}`);
    if (terms.length === MAX_SORT_KEYS) break;
  }

  // Capture order is the natural reading order and the only fully stable one -
  // always last, so paging cannot repeat or skip rows that tie on every key.
  terms.push("session ASC", "id ASC");
  return terms.join(", ");
}

function handleGroups(url: URL): Response {
  const by = url.searchParams.get("by") ?? "actor";
  if (!GROUPABLE.has(by)) return json({ error: `cannot group by "${by}"` }, 400);

  const { sql: where, params } = filters(url);
  const rows = query(
    `SELECT COALESCE(${by}, '(none)') AS key,
            count(*)                                                  AS events,
            COALESCE(sum(CASE WHEN kind = 'damage' THEN amount END), 0) AS damage,
            COALESCE(sum(resisted), 0)                                  AS resisted,
            COALESCE(sum(CASE WHEN kind = 'xp'     THEN amount END), 0) AS xp,
            sum(critical)                                               AS crits,
            COALESCE(sum(CASE WHEN critical = 1 THEN amount END), 0)    AS crit_damage
     FROM events ${where}
     GROUP BY key
     ORDER BY events DESC`,
    params,
  );
  return json({ by, rows });
}

function handleFacets(url: URL): Response {
  const bySession = filters(url, "session");
  const byKind = filters(url, "kind");
  return json({
    // Unfiltered, so the header can show a grand total that does not shift as
    // filters change - the status line reports the filtered count.
    total: query<{ n: number }>(`SELECT count(*) AS n FROM events`)[0].n,
    sessions: query(
      `SELECT session AS key, count(*) AS n FROM events ${bySession.sql}
       GROUP BY session ORDER BY session DESC`,
      bySession.params,
    ),
    kinds: query(
      `SELECT kind AS key, count(*) AS n FROM events ${byKind.sql}
       GROUP BY kind ORDER BY n DESC`,
      byKind.params,
    ),
  });
}

/** How many events wide the default range is when none is asked for. */
const COMBATANT_WINDOW = 400;
/** Most rows one fold will read, however wide a range is requested. */
const COMBATANT_SPAN_MAX = 5000;

/**
 * Per-creature state folded from recent events.
 *
 * Always scoped to exactly one session, and windowed within it:
 *
 * - **One session**, because folding across sessions would put creatures from
 *   separate playthroughs on the same screen. With no session chosen this
 *   resolves to the newest rather than spilling over the boundary, which the
 *   earlier `ORDER BY session DESC, id DESC` silently did whenever the newest
 *   session held fewer rows than the window.
 * - **Windowed**, because a session spans hours of unrelated encounters and the
 *   question is "what is on the thing I am fighting now".
 *
 * The fold needs ascending order, so the newest N are selected and reversed.
 */
function handleCombatants(url: URL): Response {
  const requested = url.searchParams.get("session");
  const session = requested ?? newestSession();

  if (session === null) {
    return json({
      session: null,
      bounds: null,
      maxBack: 0,
      from: 0,
      to: 0,
      fromId: 0,
      toId: 0,
      folded: 0,
      sessionTotal: 0,
      opponents: [],
      party: [],
      neutral: [],
    });
  }

  // Event ids are per-session and contiguous, so a range over them is a
  // meaningful slice of the session's timeline.
  const [bounds] = query<{ min: number; max: number; n: number }>(
    `SELECT min(id) AS min, max(id) AS max, count(*) AS n FROM events WHERE session = ?`,
    [session],
  );

  const { from, to, fromId, toId } = resolveRange(url, bounds.min, bounds.max);

  const rows = query<EventRow>(
    `SELECT id, kind, actor, target, detail, raw, game_ticks, clock_ms,
            actor_side, target_side, summon, target_summon
       FROM events WHERE session = ? AND id BETWEEN ? AND ?
      ORDER BY id`,
    [session, fromId, toId],
  );

  const { combatants, latestId, latestClockMs } = foldCombatants(rows);

  // Opponents first: they are the reason to look. Dead creatures are kept but
  // flagged, so the client can decide rather than losing the information.
  const bySide = (side: string) => combatants.filter((c) => c.side === side);
  return json({
    // Echoed so the client can name what it is showing rather than implying the
    // view is global.
    session,
    // How far back the session goes, so the client can bound its inputs without
    // knowing anything about the absolute id space.
    maxBack: bounds.max - bounds.min,
    bounds: { min: bounds.min, max: bounds.max },
    // The offsets actually used, which may differ from those asked for since the
    // range is clamped. Echoing them lets the UI show the truth.
    from,
    to,
    // The absolute ids behind those offsets, for cross-referencing the events
    // table — which is keyed on id, not on age.
    fromId,
    toId,
    folded: rows.length,
    sessionTotal: bounds.n,
    latestId,
    latestClockMs,
    opponents: bySide("opponent"),
    party: bySide("party"),
    neutral: combatants.filter((c) => c.side !== "opponent" && c.side !== "party"),
  });
}

/**
 * Work out which slice of a session to fold.
 *
 * `from` and `to` are **ages, not ids**: how many events back from the newest.
 * `0` is the newest event, `400` is four hundred events earlier. So the default
 * `0`–`400` is "the most recent 400 events", and it means the same thing in
 * every session regardless of how long it ran or where its ids start.
 *
 * Relative rather than absolute because the client cannot send an id on first
 * load — it would need `max`, which only arrives in the response. Ages need no
 * such knowledge, and `0` stays "now" as a session grows underneath a live
 * capture.
 *
 * Clamped rather than rejected, and the result is echoed back: a range typed
 * into an input is half-finished most of the time, so silently correcting it and
 * reporting what was used beats a 400 mid-keystroke.
 */
function resolveRange(
  url: URL,
  min: number,
  max: number,
): { from: number; to: number; fromId: number; toId: number } {
  const asked = (name: string): number | null => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };

  const maxBack = max - min;
  const clampAge = (n: number) => Math.min(Math.max(n, 0), maxBack);

  // `from` is the near end (closer to now), `to` the far end. A reversed pair is
  // a typo, not an empty result.
  let near = clampAge(asked("from") ?? 0);
  let far = clampAge(asked("to") ?? COMBATANT_WINDOW);
  if (near > far) [near, far] = [far, near];

  // Trim the far end when the span is too wide: the newer events matter more.
  if (far - near + 1 > COMBATANT_SPAN_MAX) far = near + COMBATANT_SPAN_MAX - 1;

  return { from: near, to: far, fromId: max - far, toId: max - near };
}

/** Newest session by name — filenames are timestamped, so name order is time order. */
function newestSession(): string | null {
  const rows = query<{ session: string }>(
    `SELECT session FROM events ORDER BY session DESC LIMIT 1`,
  );
  return rows.length === 0 ? null : rows[0].session;
}

/**
 * Servable files, by route.
 *
 * An explicit map rather than resolving a path under `web/`: a request path must
 * never reach the filesystem, or `/../../etc/passwd` becomes a question of how
 * good the sanitizing is. Adding a page means adding a line here.
 */
const PAGES: Record<string, { file: string; type: string }> = {
  "/": { file: "events.html", type: "text/html; charset=utf-8" },
  "/events": { file: "events.html", type: "text/html; charset=utf-8" },
  "/combatants": { file: "combatants.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/common.js": { file: "common.js", type: "text/javascript; charset=utf-8" },
};

export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const page = PAGES[url.pathname];
  if (page !== undefined) {
    return new Response(await Deno.readTextFile(join(WEB_DIR, page.file)), {
      headers: {
        "content-type": page.type,
        // The pages are read from disk per request so an edit shows on reload;
        // say so, or the browser caches a stale view.
        "cache-control": "no-store",
      },
    });
  }

  try {
    switch (url.pathname) {
      case "/api/events":
        return handleEvents(url);
      case "/api/groups":
        return handleGroups(url);
      case "/api/facets":
        return handleFacets(url);
      case "/api/combatants":
        return handleCombatants(url);
      case "/favicon.ico":
        return new Response(null, { status: 204 });
      default:
        return new Response("not found", { status: 404 });
    }
  } catch (error) {
    console.error(error);
    return json({ error: String(error) }, 500);
  }
}

// Guarded like every other entry point, so tests can import `handle` without
// binding a port.
if (import.meta.main) {
  console.log(`db    ${DB_PATH}`);
  console.log(`open  http://127.0.0.1:${SERVE_PORT}/`);
  Deno.serve({ port: SERVE_PORT, hostname: "127.0.0.1" }, handle);
}
