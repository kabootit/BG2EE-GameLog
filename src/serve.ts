/**
 * Local viewer for the captured events.
 *
 * Read-only: `play.ts` is the only writer. The database is opened in WAL mode,
 * so this can run while a session is being captured and a refresh will pick up
 * new rows.
 */
import { DB_PATH, SERVE_PORT, WEB_DIR } from "./config.ts";
import { openDb } from "./db.ts";

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

  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "500") || 500, 1), 5000);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? "0") || 0, 0);

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

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);

  try {
    switch (url.pathname) {
      case "/api/events":
        return handleEvents(url);
      case "/api/groups":
        return handleGroups(url);
      case "/api/facets":
        return handleFacets(url);
      case "/favicon.ico":
        return new Response(null, { status: 204 });
      case "/": {
        const html = await Deno.readTextFile(`${WEB_DIR}/viewer.html`);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  } catch (error) {
    console.error(error);
    return json({ error: String(error) }, 500);
  }
}

console.log(`db    ${DB_PATH}`);
console.log(`open  http://127.0.0.1:${SERVE_PORT}/`);
Deno.serve({ port: SERVE_PORT, hostname: "127.0.0.1" }, handle);
