/**
 * Rebuild events.db from raw session logs.
 *
 * Use this to backfill an old session, or to re-apply changed classification
 * rules without replaying the game. Inserts are keyed on (session, id), so
 * re-running is idempotent: rows are updated in place, never duplicated.
 *
 *   deno task import                 # every log in logs/
 *   deno task import logs/foo.log    # just this one
 */
import { LOGS_DIR } from "./config.ts";
import { EventLinker, type GameEvent, parseLine, parseRoster, SideResolver } from "./parse.ts";
import { makeInserter, openDb } from "./db.ts";

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

async function sessionLogs(): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(LOGS_DIR)) {
      if (entry.isFile && entry.name.endsWith(".log")) found.push(`${LOGS_DIR}/${entry.name}`);
    }
  } catch {
    return [];
  }
  return found.sort();
}

async function main() {
  const files = Deno.args.length > 0 ? Deno.args : await sessionLogs();
  if (files.length === 0) {
    console.log(`No session logs found in ${LOGS_DIR}`);
    return;
  }

  const db = openDb();
  const insert = makeInserter(db);
  let total = 0;

  for (const file of files) {
    const session = basename(file);
    const linker = new EventLinker();
    const sides = new SideResolver();
    const text = await Deno.readTextFile(file);

    // Pass 1: parse and link, gathering side evidence from the whole session.
    const events: GameEvent[] = [];
    for (const line of text.split("\n")) {
      const roster = parseRoster(line);
      if (roster !== null) {
        sides.addRoster(roster);
        continue;
      }
      const event = parseLine(line);
      if (event !== null) {
        const linked = linker.apply(event);
        sides.observe(linked);
        events.push(linked);
      }
    }

    // Pass 2: who is on which side is only knowable once it has all been seen -
    // an enemy that only shows up late still has to colour the earlier rows.
    for (const event of events) insert(session, sides.label(event));

    total += events.length;
    console.log(`${session.padEnd(32)} ${events.length} events`);
  }

  db.close();
  console.log(`\n${total} events across ${files.length} session(s)`);
}

if (import.meta.main) await main();
