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
import { basename, join } from "jsr:@std/path@1";
import { LOGS_DIR } from "./config.ts";
import {
  EventLinker,
  type GameEvent,
  parseLine,
  parseRoster,
  parseStats,
  PartyStats,
  SideResolver,
} from "./parse.ts";
import { makeInserter, openDb } from "./db.ts";

async function sessionLogs(): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(LOGS_DIR)) {
      if (entry.isFile && entry.name.endsWith(".log")) found.push(join(LOGS_DIR, entry.name));
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
    const stats = new PartyStats();
    const text = await Deno.readTextFile(file);

    // Pass 1: parse and link, gathering side evidence from the whole session.
    const events: GameEvent[] = [];
    let lastId = 0;
    for (const line of text.split("\n")) {
      const roster = parseRoster(line);
      if (roster !== null) {
        sides.addRoster(roster);
        continue;
      }
      // Saving-throw targets carry no event id of their own, so they are pinned
      // to the last row seen. That keeps the timeline ordered against the saves
      // it has to judge.
      const saves = parseStats(line);
      if (saves !== null) {
        stats.observe(lastId, saves);
        continue;
      }
      const event = parseLine(line);
      if (event !== null) {
        const linked = linker.apply(event);
        sides.observe(linked);
        events.push(linked);
        lastId = linked.id;
      }
    }

    // Pass 2: who is on which side is only knowable once it has all been seen -
    // an enemy that only shows up late still has to color the earlier rows. The
    // same is true of a save verdict, which needs the targets in force at the
    // time and those may be emitted after the roll.
    for (const event of events) {
      insert(session, { ...sides.label(event), saved: stats.verdict(event) });
    }

    total += events.length;
    console.log(`${session.padEnd(32)} ${events.length} events`);
  }

  db.close();
  console.log(`\n${total} events across ${files.length} session(s)`);
}

if (import.meta.main) await main();
