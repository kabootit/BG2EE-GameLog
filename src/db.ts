import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.ts";
import type { GameEvent } from "./parse.ts";
import type { Category, DerivedSpell } from "./protections.ts";

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
      saved       INTEGER,
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
      -- Display names of creatures this spell summons, JSON. Populated only for
      -- spells that name a .CRE directly; most go through an EFF file, which
      -- extract.ts cannot follow yet.
      summons     TEXT,
      source      TEXT NOT NULL
    )
  `);
  migrateSpells(db);
  // Lookups are by display name (from a log line) far more often than by
  // resref, and the name column is not the primary key.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_spells_name ON spells(name)`);
}

/**
 * Columns added to `spells` after it first shipped.
 *
 * Same trap as the events table, and it bit the same way: `CREATE TABLE IF NOT
 * EXISTS` does nothing to a table that already exists, so a database created
 * before `summons` was added kept failing on insert with "table spells has no
 * column named summons". Dropping and recreating would also work here, since
 * extraction rebuilds the contents wholesale, but a migration means an existing
 * database keeps working without anyone having to know to delete it.
 *
 * Names come from this literal list, never from input.
 */
const SPELL_COLUMNS: Array<[string, string]> = [
  ["summons", "TEXT"],
];

function migrateSpells(db: Db): void {
  const present = new Set(
    (db.prepare("PRAGMA table_info(spells)").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const [name, type] of SPELL_COLUMNS) {
    if (!present.has(name)) db.exec(`ALTER TABLE spells ADD COLUMN ${name} ${type}`);
  }
}

/** Replace the spell table's contents. Extraction is always a full rebuild. */
export function makeSpellWriter(db: Db): {
  clear: () => void;
  insert: (row: SpellRow) => void;
} {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO spells
      (resref, symbol, name, level, type, school, category, confidence,
       dispellable, strips, effect_text, summons, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        r.summons.length === 0 ? null : JSON.stringify(r.summons),
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
    summons: string | null;
  }>;
  try {
    // Summoning spells are wanted even when uncategorized: what matters is
    // which creature the cast puts on the field, not whether the spell itself
    // is a protection.
    rows = db.prepare(
      `SELECT name, effect_text, category, dispellable, strips, summons
         FROM spells
        WHERE name IS NOT NULL AND (category IS NOT NULL OR summons IS NOT NULL)`,
    ).all() as typeof rows;
  } catch (e) {
    // Only "the table is not there yet" is an expected, silent outcome. This
    // catch used to swallow everything, and it hid a corrupted index for
    // several runs: the spells table had 1,936 rows, this returned none, and
    // nothing anywhere said why. Anything else gets reported.
    const message = e instanceof Error ? e.message : String(e);
    if (!/no such table/i.test(message)) {
      console.error(`spell data unavailable: ${message}`);
      console.error(`  run \`deno task extract\`; if that fails, delete events.db and`);
      console.error(`  rebuild with \`deno task import\` — it is derived from logs/.`);
    }
    return [];
  }

  const json = (raw: string | null): string[] => {
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed as string[] : [];
    } catch {
      return [];
    }
  };

  const derived: DerivedSpell[] = [];
  for (const r of rows) {
    if (r.name === null) continue;
    const messages = json(r.effect_text);
    const summons = json(r.summons);
    const base: DerivedSpell = {
      name: r.name,
      // Left absent when the files gave no semantics, so hydrate() registers
      // the summon without also making the spell name look like a condition.
      ...(r.category === null ? {} : { category: r.category as Category }),
      dispellable: r.dispellable === 1,
      ...(r.strips === null ? {} : { strips: r.strips as DerivedSpell["strips"] }),
      ...(summons.length === 0 ? {} : { summons }),
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
  summons: string[];
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
  // 1 made, 0 failed, null unknown. Only ever set for party members: the log
  // prints no target, and the tap can read one only from characters[id].
  ["saved", "INTEGER"],
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
       actor_side, target_side, summon, target_summon, saved, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      e.saved === null ? null : e.saved ? 1 : 0,
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
