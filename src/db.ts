import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.ts";
import type { GameEvent } from "./parse.ts";

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

  for (const col of ["kind", "actor", "target", "session"]) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_${col} ON events(${col})`);
  }
  return db;
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
       kind, actor, target, amount, detail, critical, spell, spell_candidate,
       actor_side, target_side, summon, target_summon, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
