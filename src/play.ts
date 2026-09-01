/**
 * Launch the game, capture its stdout, and store every tap event live.
 *
 * One process does launch + capture + parse + insert, so there is no separate
 * pipeline step. The raw session log is always written first and in full: it is
 * the source of truth, and `import.ts` can rebuild the database from it.
 */
import { GAME_BINARY, LOGS_DIR, TAP_MARKER } from "./config.ts";
import { EventLinker, parseLine, parseRoster, SideResolver } from "./parse.ts";
import { makeInserter, makeSideUpdater, openDb } from "./db.ts";

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  await Deno.mkdir(LOGS_DIR, { recursive: true });

  const session = `session-${stamp()}.log`;
  const logPath = `${LOGS_DIR}/${session}`;
  const logFile = await Deno.open(logPath, { create: true, append: true, write: true });
  const encoder = new TextEncoder();

  const db = openDb();
  const insert = makeInserter(db);
  const updateSide = makeSideUpdater(db);
  const linker = new EventLinker();
  const sides = new SideResolver();

  // Live capture writes rows before it can know whose side anyone is on. When a
  // name is later settled, rewrite the rows already stored for it.
  const applied = new Map<string, string>();
  const backfillSides = () => {
    for (const [name, side] of sides.resolve()) {
      const isSummon = sides.isSummon(name);
      const settled = `${side}${isSummon ? "+summon" : ""}`;
      if (applied.get(name) !== settled) {
        applied.set(name, settled);
        updateSide(session, name, side, isSummon);
      }
    }
  };

  const counts = new Map<string, number>();
  let lines = 0;
  let events = 0;
  let luaErrors = 0;

  const handle = (line: string) => {
    lines++;
    logFile.writeSync(encoder.encode(line + "\n"));

    if (line.includes("LUA ERROR:")) {
      luaErrors++;
      console.error(`  lua error: ${line.trim()}`);
      return;
    }

    const roster = parseRoster(line);
    if (roster !== null) {
      sides.addRoster(roster);
      backfillSides();
      return;
    }

    const event = parseLine(line);
    if (!event) return;
    const linked = linker.apply(event);
    sides.observe(linked);
    insert(session, sides.label(linked));
    backfillSides();
    events++;
    counts.set(linked.kind, (counts.get(linked.kind) ?? 0) + 1);
    if (events % 50 === 0) console.log(`  ${events} events`);
  };

  const finish = () => {
    try {
      logFile.close();
    } catch { /* already closed */ }
    try {
      db.close();
    } catch { /* already closed */ }

    console.log(`\nsession  ${logPath}`);
    console.log(`lines    ${lines}`);
    console.log(`events   ${events}`);
    if (luaErrors > 0) console.log(`LUA ERRORS ${luaErrors}  <- the tap is broken, check ui.menu`);
    if (events === 0) {
      console.log(
        `\nNo ${TAP_MARKER} lines captured. Either the mod is not installed, or\n` +
          `Infinity_Log does not reach stdout on this build - see docs/FINDINGS.md.`,
      );
    } else {
      const breakdown = [...counts].sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`).join(", ");
      console.log(`kinds    ${breakdown}`);
      console.log(`\nView it:  deno task serve`);
    }
  };

  console.log(`game     ${GAME_BINARY}`);
  console.log(`session  ${logPath}`);
  console.log(`\nCapturing. Quit the game to finish.\n`);

  // `script` allocates a pty. Without one, the game's stdout is a pipe and libc
  // block-buffers it at 4 KB, so events would arrive in bursts and live viewing
  // would lag badly. Deno has no built-in pty, hence the system binary.
  const child = new Deno.Command("script", {
    args: ["-q", "/dev/null", GAME_BINARY],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();

  const onInterrupt = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
  };
  Deno.addSignalListener("SIGINT", onInterrupt);

  let buffer = "";
  for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) handle(buffer);

  await child.status;
  Deno.removeSignalListener("SIGINT", onInterrupt);
  finish();
}

if (import.meta.main) await main();
