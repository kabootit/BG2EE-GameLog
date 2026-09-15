/**
 * Launch the game, capture its stdout, and store every tap event live.
 *
 * One process does launch + capture + parse + insert, so there is no separate
 * pipeline step. The raw session log is always written first and in full: it is
 * the source of truth, and `import.ts` can rebuild the database from it.
 */
import { join } from "jsr:@std/path@1";
import { TextLineStream } from "jsr:@std/streams@1/text-line-stream";
import { GAME_BINARY, LOGS_DIR, TAP_MARKER } from "./config.ts";
import { EventLinker, parseLine, parseRoster, SideResolver } from "./parse.ts";
import { makeInserter, makeSideUpdater, openDb } from "./db.ts";

const HOME = Deno.env.get("HOME") ?? "";

/**
 * Strip identifying details from a captured line before it is written.
 *
 * The engine's startup output carries the Steam account id and absolute paths
 * under the home directory. Neither has anything to do with the captured events,
 * and `logs/` is committed to a public repo — so this happens at capture time
 * rather than being something to remember to clean up afterwards.
 */
export function redact(line: string): string {
  // Replacer function, not a string: "$HOME" in a plain replacement string would
  // be interpreted as a capture-group reference.
  const withoutHome = HOME === "" ? line : line.replaceAll(HOME, () => "$HOME");
  return withoutHome
    .replace(/\b7656\d{13}\b/g, "<steam-id>")
    .replace(/(Steam ID:\s*)\d{5,}/gi, "$1<steam-id>");
}

/**
 * Session filename stamp, local time: `20260914-184105`.
 *
 * Temporal rather than Date because `plainDateTimeISO()` is explicitly a local
 * wall clock, where `new Date()` leaves local-vs-instant implicit.
 *
 * Built from the fields directly. Temporal has no format-pattern API — only
 * `toString()`, which is ISO 8601 only, and `toLocaleString()`, which is
 * locale-dependent and so unusable for a filename. Formatting the ISO string
 * with regex would mean turning structured data into text and then taking it
 * apart again; the fields are already numbers.
 *
 * Fixed width is the requirement, not decoration: `deno task import` sorts
 * sessions by filename, so an unpadded month would break chronological order.
 *
 * Takes the time as a parameter so it can be tested.
 */
export function stamp(now: Temporal.PlainDateTime = Temporal.Now.plainDateTimeISO()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.year}${pad(now.month)}${pad(now.day)}` +
    `-${pad(now.hour)}${pad(now.minute)}${pad(now.second)}`;
}

async function main() {
  await Deno.mkdir(LOGS_DIR, { recursive: true });

  const session = `session-${stamp()}.log`;
  const logPath = join(LOGS_DIR, session);
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

  const writeLine = (text: string) => {
    try {
      logFile.writeSync(encoder.encode(text + "\n"));
    } catch { /* log already closed during shutdown */ }
  };

  /**
   * Record a capture-side event in the session log as well as on the console.
   *
   * `script` already merges the game's own stderr into the pty, so that stream is
   * never lost — but this process's own failures went only to the terminal. The
   * one time that mattered, a fatal error was visible for as long as the terminal
   * scrollback lasted and left no trace in the file.
   */
  const note = (text: string) => {
    console.error(`  ${text}`);
    writeLine(`[gamelog] ${text}`);
  };

  const counts = new Map<string, number>();
  let lines = 0;
  let events = 0;
  let luaErrors = 0;
  let storeErrors = 0;

  const handle = (captured: string) => {
    lines++;
    // Redact first, so the log on disk and everything derived from it agree.
    const line = redact(captured);
    writeLine(line);

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

    // Storage must never be able to end the capture. The raw log above is the
    // source of truth and has already been written, so a failed insert costs
    // nothing that `deno task import` cannot rebuild — whereas throwing here
    // kills the process and takes the game down with it.
    try {
      insert(session, sides.label(linked));
      backfillSides();
    } catch (error) {
      storeErrors++;
      if (storeErrors === 1) {
        note(`store failed: ${error}`);
        note(`capture continues; the raw log is intact. Re-run: deno task import`);
      }
    }

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
    if (storeErrors > 0) {
      console.log(`STORE ERRORS ${storeErrors}  <- rows missing from events.db; run: deno task import`);
    }
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
    // script's own stderr — pty setup failures and the like. The game's stderr is
    // already merged into the pty, so this is only about script itself, but it is
    // the channel that reports the launch failing.
    stderr: "piped",
  }).spawn();

  const onInterrupt = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
  };
  Deno.addSignalListener("SIGINT", onInterrupt);

  // TextLineStream replaces a hand-rolled chunk buffer. Worth the swap: the
  // manual version had to get partial-line carry-over right on every chunk
  // boundary, and a line split across two reads is exactly the case that only
  // shows up under load.
  const readStdout = async () => {
    const lines = child.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    for await (const line of lines) handle(line);
  };

  // Must be drained, not just piped: an unread pipe fills and blocks the child.
  const readStderr = async () => {
    const lines = child.stderr
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    for await (const line of lines) {
      if (line.trim() !== "") note(`stderr: ${redact(line)}`);
    }
  };

  try {
    await Promise.all([readStdout(), readStderr()]);
    await child.status;
  } catch (error) {
    // Record why the capture ended before the log is closed. Without this the
    // only account of a fatal error is the terminal it was printed to.
    note(`fatal: ${error}`);
    throw error;
  } finally {
    Deno.removeSignalListener("SIGINT", onInterrupt);
    finish();
  }
}

if (import.meta.main) await main();
