/**
 * Local viewer for the captured events.
 *
 * Read-only: `play.ts` is the only writer. The database is opened in WAL mode,
 * so this can run while a session is being captured and a refresh will pick up
 * new rows.
 */
import { join } from "jsr:@std/path@1";
import { DB_PATH, SERVE_PORT, WEB_DIR } from "./config.ts";
import { loadDerivedSpells, openDb } from "./db.ts";
import { type EventRow, foldCombatants } from "./combatants.ts";
import { hydrate } from "./protections.ts";

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
  "saved",
  "raw",
]);
/**
 * Columns the free-text box searches, in the order the table shows them.
 *
 * A literal list for the same reason `SORTABLE` is one: it is interpolated into
 * SQL, so it must never come from input. Text only — `LIKE '%41%'` on an amount
 * matches 141 and 410 as well, which is worse than not searching it.
 */
const SEARCHABLE = [
  "kind",
  "actor_side",
  "actor",
  "target_side",
  "target",
  "summon",
  "target_summon",
  "detail",
  "spell",
  "raw",
];

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
  // Groupable, though it currently has one value. No verdict is recorded — a
  // save row is a success by construction, since the engine prints a save line
  // only when the save is made (see VERDICTS_TRUSTED in parse.ts). Kept
  // allowlisted so it works the moment a verdict means something again.
  "saved",
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

// Spell semantics read from the game files, merged *under* the hand-written
// table so a judgment already made by a person is never displaced. Done
// unconditionally rather than behind `import.meta.main`, because the API tests
// drive `handle()` directly and should exercise the same lookup path the server
// does. With no extraction run the table is empty and this is a no-op.
hydrate(loadDerivedSpells(db));

/**
 * Build the shared WHERE clause. Values are always bound, never interpolated.
 *
 * `omit` drops one filter. Facet counts use it to exclude their own dimension:
 * the kind counts must respect the selected session, but must not be narrowed by
 * the selected kind, or picking a kind would leave that kind as the only option.
 */
function filters(
  url: URL,
  omit?: string,
  // Accepts null as well as undefined on purpose: callers get this from
  // emptyFilterColumn(), which returns null for "no column". An undefined-only
  // signature meant a null slipped through the guard below and emitted
  // "null IS NOT NULL", which is never true - it silently zeroed every facet
  // count while the rows themselves looked fine.
  notNull?: string | null,
): { sql: string; params: Param[] } {
  const clauses: string[] = [];
  const params: Param[] = [];

  // Drop rows with nothing in this column. The caller passes a name taken from
  // the SORTABLE allowlist, never from input — see primarySortColumn().
  if (notNull !== undefined && notNull !== null) clauses.push(`${notNull} IS NOT NULL`);

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
    // Every text column the table can display, rather than a hand-picked three.
    // Searching "opponent" used to find nothing at all, because the side
    // columns were not covered and there is no filter dropdown for them either
    // — so the value was on screen with no way to select it. Numeric columns
    // are left out: a substring match on an amount finds 41 inside 141.
    clauses.push(`(${SEARCHABLE.map((c) => `${c} LIKE ?`).join(" OR ")})`);
    for (const _ of SEARCHABLE) params.push(`%${q}%`);
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

  // Matched the filters, before anything is dropped for being empty.
  const [{ n: matched }] = query<{ n: number }>(
    `SELECT count(*) AS n FROM events ${where}`,
    params,
  );

  // `hideEmpty=0` keeps them, for the rare case of wanting the full set while
  // still ordering by a sparse column. Defaults on, since examining a column is
  // the reason to sort by it. The facets use the same decision, so the kind
  // counts always describe the rows actually on offer.
  const sortColumn = emptyFilterColumn(url);

  // Assembled by filters() rather than concatenated here, so the clause list and
  // the WHERE keyword have one owner and an unfiltered query cannot produce a
  // dangling "AND".
  const scoped = sortColumn !== null
    ? filters(url, undefined, sortColumn)
    : { sql: where, params };

  const [{ n: total }] = sortColumn !== null
    ? query<{ n: number }>(`SELECT count(*) AS n FROM events ${scoped.sql}`, scoped.params)
    : [{ n: matched }];

  const rows = query(
    `SELECT * FROM events ${scoped.sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...scoped.params, limit, offset],
  );

  // Capture gaps in the current session scope, counted separately from the
  // rows.
  //
  // `resync` marks a point where the engine replaced `combatLog` and rows
  // pending emission were lost. It is the one kind that is not game output at
  // all - it is this project's own instrumentation - so it does not belong in
  // the event table, and it is hidden there by default. But a data-loss warning
  // that is merely hidden is worse than one that looks out of place, so the
  // count comes back here for the status line to report.
  //
  // Deliberately not run through filters(): the count means "gaps in what you
  // are looking at", which is a property of the session, not of the kind or
  // search currently narrowing the rows.
  const session = url.searchParams.get("session");
  const [{ n: gaps }] = session
    ? query<{ n: number }>(
      `SELECT count(*) AS n FROM events WHERE session = ? AND kind = 'resync'`,
      [session],
    )
    : query<{ n: number }>(`SELECT count(*) AS n FROM events WHERE kind = 'resync'`);

  return json({
    total,
    limit,
    offset,
    orderBy,
    // Named so the UI can say what it dropped rather than leaving a smaller
    // total looking like lost rows.
    hiddenEmpty: matched - total,
    emptyColumn: sortColumn,
    gaps,
    rows,
  });
}

/** How many sort keys a request may specify. */
const MAX_SORT_KEYS = 4;

/**
 * Build ORDER BY from `sort=col:dir,col:dir,...`, most significant first.
 *
 * Column names cannot be bound as parameters, so every one is checked against
 * SORTABLE and anything unrecognized is dropped rather than interpolated.
 */
/**
 * The requested sort, validated against `SORTABLE`.
 *
 * One parse shared by the ordering and by the empty-row filter, so the two
 * cannot disagree about which column is primary — and so a column name reaches
 * SQL from exactly one allowlist check.
 */
function sortKeys(url: URL): Array<{ column: string; dir: "ASC" | "DESC" }> {
  const keys: Array<{ column: string; dir: "ASC" | "DESC" }> = [];
  const seen = new Set<string>();

  for (const part of (url.searchParams.get("sort") ?? "").split(",")) {
    const [rawColumn, rawDir] = part.split(":");
    const column = rawColumn?.trim() ?? "";
    if (!SORTABLE.has(column) || seen.has(column)) continue;
    seen.add(column);
    keys.push({
      column,
      dir: (rawDir ?? "asc").trim().toLowerCase() === "desc" ? "DESC" : "ASC",
    });
    if (keys.length === MAX_SORT_KEYS) break;
  }
  return keys;
}

function orderClause(url: URL): string {
  const terms: string[] = [];
  for (const { column, dir } of sortKeys(url)) {
    // Empties last, whichever direction. Redundant while the primary column is
    // also being filtered for nulls, but secondary keys are not filtered and
    // SQLite sorts NULL first, so without this a sparse tiebreaker still leads
    // with blanks.
    terms.push(`${column} IS NULL`, `${column} ${dir}`);
  }

  // Newest first, always last in the chain.
  //
  // Two jobs at once. With no sort chosen this *is* the order, so the table
  // opens on the most recent events - which is what you want after a fight,
  // rather than the start of the session. And as the final tiebreak it means
  // rows read newest-first inside whatever grouping is above it, so sorting by
  // side shows each side's latest activity first.
  //
  // `id` is the tap's own sequence number, so it is exactly capture order and
  // the only fully stable key. Keeping it last means paging cannot repeat or
  // skip rows that tie on everything else.
  //
  // Only the events table. The folds in serve.ts and patterns.ts replay events
  // in sequence and must stay ascending, which is why they order by id
  // themselves rather than going through here.
  terms.push("session DESC", "id DESC");
  return terms.join(", ");
}

/**
 * Rows with nothing in the column being sorted by are dropped.
 *
 * Sorting by a column is how you examine it, and most columns here are sparse:
 * only damage rows carry an `amount`, only some events name a side. Keeping the
 * empty ones parks a block of blank cells at one end of every page for no
 * purpose.
 *
 * Only the *primary* key is filtered. Later keys are tiebreakers rather than
 * the thing under examination, and filtering on all of them compounds fast —
 * sorting by side then spell would quietly reduce the table to spell-attributed
 * damage rows.
 *
 * The count dropped is reported back, because a filter that silently changes
 * the row total is the kind of thing that gets mistaken for missing data.
 */
function primarySortColumn(url: URL): string | null {
  const [first] = sortKeys(url);
  return first === undefined ? null : first.column;
}

/**
 * The column whose empty rows are being dropped, or null when none are.
 *
 * Shared by the rows and the facets so the two cannot disagree about how many
 * of something there is — they did, and the dropdown was the one that lied.
 * `hideEmpty=0` opts out.
 */
function emptyFilterColumn(url: URL): string | null {
  const column = primarySortColumn(url);
  if (column === null || url.searchParams.get("hideEmpty") === "0") return null;
  return column;
}

/**
 * Largest event window the group query will summarize.
 *
 * Far above the 5000 the events table allows, and deliberately so: that cap
 * exists because the browser has to render a row per event, while a group
 * response is bounded by the number of groups instead. Summarizing the whole
 * corpus is one scan returning a few hundred rows, so the whole-set case stays
 * reachable rather than being cut off at one page.
 */
const GROUP_WINDOW_MAX = 1_000_000;

function handleGroups(url: URL): Response {
  const by = url.searchParams.get("by") ?? "actor";
  if (!GROUPABLE.has(by)) return json({ error: `cannot group by "${by}"` }, 400);

  const { sql: where, params } = filters(url);

  // What the filters match, before the window narrows it. Reported alongside the
  // rows so the page can say what the aggregates cover — a total that silently
  // described one page would read as the whole session.
  const [{ n: matched }] = query<{ n: number }>(
    `SELECT count(*) AS n FROM events ${where}`,
    params,
  );

  // The same skip/show the events table pages with, over the same newest-first
  // ordering, so grouping summarizes exactly the rows that table would show for
  // the current window.
  //
  // `sort` is not read here even though orderClause() would accept it: when
  // grouping, the header shows group columns, so any event sort chain is
  // invisible state the user cannot see or change. Letting it define the window
  // would make identical controls produce different aggregates. The canonical
  // newest-first order is what "skip" is documented against anyway.
  const limit = intParam(url, "limit", 500, 1, GROUP_WINDOW_MAX);
  const rawOffset = Number(url.searchParams.get("offset") ?? "0");
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const orderBy = orderClause(url);
  // Exact, not an estimate: the window is a contiguous slice, so what it holds
  // is whatever is left after skipping, capped by the page size.
  const windowed = Math.max(0, Math.min(limit, matched - offset));

  const rows = query(
    `SELECT COALESCE(${by}, '(none)') AS key,
            count(*)                                                  AS events,
            COALESCE(sum(CASE WHEN kind = 'damage' THEN amount END), 0) AS damage,
            COALESCE(sum(resisted), 0)                                  AS resisted,
            COALESCE(sum(CASE WHEN kind = 'xp'     THEN amount END), 0) AS xp,
            sum(critical)                                               AS crits,
            COALESCE(sum(CASE WHEN critical = 1 THEN amount END), 0)    AS crit_damage,
            -- Saving throws. The count alone is informative for an opponent:
            -- a creature only rolls one once the effect has got past magic
            -- resistance and any spell protections, so it means your spells are
            -- reaching them. The worst roll is comparative rather than absolute:
            -- the log never prints a target, so -1 is only "worse than 7".
            COALESCE(sum(CASE WHEN kind = 'save' THEN 1 END), 0)         AS saves,
            -- Only counts what is actually known: a verdict exists for party
            -- members, whose targets the tap reads live. A null saved is not a
            -- failure, so it must not be counted as one.
            COALESCE(sum(CASE WHEN saved = 0 THEN 1 END), 0)              AS failed,
            min(CASE WHEN kind = 'save' THEN roll END)                   AS worst_save
     -- Grouped over the window rather than the whole table, so the subquery
     -- applies the paging before anything is aggregated.
     FROM (SELECT * FROM events ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?)
     GROUP BY key
     ORDER BY events DESC`,
    [...params, limit, offset],
  );
  return json({ by, rows, matched, windowed, limit, offset });
}

function handleFacets(url: URL): Response {
  // Scoped the same way the rows are, including the empty-row drop that sorting
  // applies. Without that the dropdown offered counts the table could not
  // deliver: sorted by `amount`, it read "attack (611)" while only 126 rows
  // survived, because almost no attack row carries an amount.
  //
  // Paging is deliberately *not* applied. A facet count says what selecting
  // that kind will give you, and selecting one resets the offset anyway — page
  // -scoped counts would all be at most one screen and mostly zero.
  const empty = emptyFilterColumn(url);
  const bySession = filters(url, "session", empty);
  const byKind = filters(url, "kind", empty);
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
    `SELECT id, kind, actor, target, detail, roll, raw, game_ticks, clock_ms,
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
