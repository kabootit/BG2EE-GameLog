import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.ts";
import type { GameEvent } from "./parse.ts";
import type { DerivedSpell } from "./protections.ts";

export type Db = DatabaseSync;

/**
 * Open (creating if needed) the event database.
 *
 * WAL matters here: `play.ts` writes while a session is running and `serve.ts`
 * reads at the same time, so the viewer can be refreshed mid-session.
 */
export function openDb(path: string = DB_PATH): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // Several processes hold this open at once: a live capture writing, plus an
  // import or the viewer. WAL lets readers run alongside a writer, but writers
  // still serialize — and with no timeout the loser fails instantly with
  // "database is locked" rather than waiting. Running `deno task import` during
  // a capture killed the capture process exactly this way.
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      session    TEXT    NOT NULL,
      id         INTEGER NOT NULL,
      wall_clock TEXT,
      game_ticks INTEGER,
      clock_ms   INTEGER,
      game_time  TEXT,
      screen     TEXT,
      kind       TEXT    NOT NULL,
      actor      TEXT,
      target     TEXT,
      amount     INTEGER,
      roll       INTEGER,
      resisted   INTEGER,
      detail     TEXT,
      critical   INTEGER NOT NULL DEFAULT 0,
      spell      TEXT,
      spell_candidate TEXT,
      actor_side  TEXT,
      target_side TEXT,
      summon      TEXT,
      target_summon TEXT,
      raw        TEXT    NOT NULL,
      PRIMARY KEY (session, id)
    )
  `);
  migrate(db);
  createSpells(db);

  for (const col of ["kind", "actor", "target", "session"]) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_${col} ON events(${col})`);
  }
  return db;
}

/**
 * Spell semantics read out of the installed game files by `deno task extract`.
 *
 * A sibling of the events table rather than part of `migrate()`, which is
 * specific to events and keyed on their columns. The two are independent:
 * `import` rebuilds events from `logs/` and touches nothing here, `extract`
 * rebuilds this from the game directory and touches no events, so the order
 * they run in does not matter.
 *
 * Keyed on resref because that is what the game files key on. `name` is the
 * display string and is *not* unique — several spells print "Shielded", and two
 * different spells both print "Armor".
 */
function createSpells(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS spells (
      resref      TEXT PRIMARY KEY,
      symbol      TEXT,
      name        TEXT,
      level       INTEGER,
      type        TEXT,
      school      TEXT,
      category    TEXT,
      confidence  REAL,
      dispellable INTEGER,
      strips      TEXT,
      effect_text TEXT,
      source      TEXT NOT NULL
    )
  `);
  // Lookups are by display name (from a log line) far more often than by
  // resref, and the name column is not the primary key.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_spells_name ON spells(name)`);
}

/** Replace the spell table's contents. Extraction is always a full rebuild. */
export function makeSpellWriter(db: Db): {
  clear: () => void;
  insert: (row: SpellRow) => void;
} {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO spells
      (resref, symbol, name, level, type, school, category, confidence,
       dispellable, strips, effect_text, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return {
    clear: () => db.exec(`DELETE FROM spells`),
    insert: (r) =>
      stmt.run(
        r.resref,
        r.symbol,
        r.name,
        r.level,
        r.type,
        r.school,
        r.category,
        r.confidence,
        r.dispellable === null ? null : r.dispellable ? 1 : 0,
        r.strips,
        // A spell can print several messages; stored as JSON rather than a
        // second table, since nothing queries inside it.
        r.effectText.length === 0 ? null : JSON.stringify(r.effectText),
        r.source,
      ),
  };
}

/**
 * Read extracted spell semantics back out, shaped for `hydrate()`.
 *
 * Lives here rather than in either caller because both `serve.ts` and
 * `patterns.ts` need it and must agree. The coverage report and the view have
 * to be looking at the same set of known names — a report that measures a
 * different set than the screen shows is worse than no report, since it gets
 * trusted. That mistake has already been made once in this project.
 *
 * Returns an empty array when extraction has never run, which is a supported
 * state: lookups then fall back to the hand-written table alone.
 */
export function loadDerivedSpells(db: Db): DerivedSpell[] {
  let rows: Array<{
    name: string | null;
    effect_text: string | null;
    category: string | null;
    dispellable: number | null;
    strips: string | null;
  }>;
  try {
    rows = db.prepare(
      `SELECT name, effect_text, category, dispellable, strips
         FROM spells WHERE category IS NOT NULL AND name IS NOT NULL`,
    ).all() as typeof rows;
  } catch {
    return [];
  }

  const derived: DerivedSpell[] = [];
  for (const r of rows) {
    if (r.name === null || r.category === null) continue;
    let messages: string[] = [];
    try {
      messages = r.effect_text === null ? [] : JSON.parse(r.effect_text) as string[];
    } catch {
      messages = [];
    }
    const base: DerivedSpell = {
      name: r.name,
      category: r.category as DerivedSpell["category"],
      dispellable: r.dispellable === 1,
      ...(r.strips === null ? {} : { strips: r.strips as DerivedSpell["strips"] }),
    };
    derived.push(base);
    // A spell can print more than one message, so each is registered in its own
    // right rather than assuming one alias per spell.
    for (const effect of messages) derived.push({ ...base, effect });
  }
  return derived;
}

export interface SpellRow {
  resref: string;
  symbol: string | null;
  name: string | null;
  level: number;
  type: string;
  school: string;
  category: string | null;
  confidence: number | null;
  dispellable: boolean | null;
  strips: string | null;
  effectText: string[];
  source: string;
}

/**
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
 * database created before a column was added would keep failing on insert. Add
 * anything missing. Names come from this literal list, never from input.
 */
const COLUMNS: Array<[string, string]> = [
  ["wall_clock", "TEXT"],
  ["game_ticks", "INTEGER"],
  ["clock_ms", "INTEGER"],
  ["game_time", "TEXT"],
  ["screen", "TEXT"],
  ["kind", "TEXT"],
  ["actor", "TEXT"],
  ["target", "TEXT"],
  ["amount", "INTEGER"],
  ["roll", "INTEGER"],
  ["resisted", "INTEGER"],
  ["detail", "TEXT"],
  ["critical", "INTEGER NOT NULL DEFAULT 0"],
  ["spell", "TEXT"],
  ["spell_candidate", "TEXT"],
  ["actor_side", "TEXT"],
  ["target_side", "TEXT"],
  ["summon", "TEXT"],
  ["target_summon", "TEXT"],
  ["raw", "TEXT"],
];

function migrate(db: Db): void {
  const present = new Set(
    (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const [name, type] of COLUMNS) {
    if (!present.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`);
  }
}

/**
 * INSERT OR REPLACE keyed on (session, id), so re-importing a session log is
 * idempotent and re-running it after changing a classification rule updates
 * rows in place.
 */
export function makeInserter(db: Db): (session: string, e: GameEvent) => void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO events
      (session, id, wall_clock, game_ticks, clock_ms, game_time, screen,
       kind, actor, target, amount, roll, resisted, detail, critical, spell, spell_candidate,
       actor_side, target_side, summon, target_summon, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return (session, e) => {
    stmt.run(
      session,
      e.id,
      e.wallClock,
      e.gameTicks,
      e.clockMs,
      e.gameTime,
      e.screen,
      e.kind,
      e.actor,
      e.target,
      e.amount,
      e.roll,
      e.resisted,
      e.detail,
      e.critical ? 1 : 0,
      e.spell,
      e.spellCandidate,
      e.actorSide,
      e.targetSide,
      e.summon,
      e.targetSummon,
      e.raw,
    );
  };
}

/**
 * Sides are only knowable once enough of the session has been seen, so live
 * capture writes rows before the answer exists. This rewrites the ones already
 * stored when a name's side is later settled.
 */
export function makeSideUpdater(
  db: Db,
): (session: string, name: string, side: string, isSummon: boolean) => void {
  const byActor = db.prepare(
    `UPDATE events
        SET actor_side = ?,
            summon = CASE WHEN ? = 1 THEN actor ELSE NULL END
      WHERE session = ? AND actor = ?`,
  );
  const byTarget = db.prepare(
    `UPDATE events
        SET target_side = ?,
            target_summon = CASE WHEN ? = 1 THEN target ELSE NULL END
      WHERE session = ? AND target = ?`,
  );
  return (session, name, side, isSummon) => {
    byActor.run(side, isSummon ? 1 : 0, session, name);
    byTarget.run(side, isSummon ? 1 : 0, session, name);
  };
}
