/**
 * Tests for the capture path.
 *
 * The full path cannot run here — it needs a pty and the game — so these cover
 * the parts that can be isolated: redaction, and the line splitting that
 * replaced a hand-rolled chunk buffer.
 */
import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { TextLineStream } from "jsr:@std/streams@1/text-line-stream";
import { redact, stamp } from "./play.ts";

/** Feed byte chunks through the same pipeline play.ts uses. */
async function linesFrom(chunks: string[]): Promise<string[]> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const out: string[] = [];
  const lines = source.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
  for await (const line of lines) out.push(line);
  return out;
}

Deno.test("a line split across two reads is reassembled", () => {
  // The case the manual buffer existed for, and the one that only appears under
  // load: the game writes faster than a single read returns.
  return linesFrom(["A7LOG\t1\tfir", "st\nA7LOG\t2\tsecond\n"]).then((lines) => {
    assertEquals(lines, ["A7LOG\t1\tfirst", "A7LOG\t2\tsecond"]);
  });
});

Deno.test("a trailing line with no newline is still emitted", async () => {
  // The game's last output before exit often has no terminating newline.
  assertEquals(await linesFrom(["one\ntwo"]), ["one", "two"]);
});

Deno.test("many lines in one chunk all come through", async () => {
  assertEquals(await linesFrom(["a\nb\nc\n"]), ["a", "b", "c"]);
});

Deno.test("empty input yields no lines", async () => {
  assertEquals(await linesFrom([]), []);
  assertEquals(await linesFrom([""]), []);
});

Deno.test("session stamp is fixed width and zero padded", () => {
  // Single-digit months, days and hours must pad, or filenames stop sorting
  // chronologically - which is how `deno task import` orders sessions.
  assertEquals(stamp(Temporal.PlainDateTime.from("2026-01-02T03:04:05")), "20260102-030405");
  assertEquals(stamp(Temporal.PlainDateTime.from("2026-12-31T23:59:59")), "20261231-235959");
});

Deno.test("session stamp drops sub-second precision", () => {
  // Temporal keeps nanoseconds; a filename must not.
  assertEquals(stamp(Temporal.PlainDateTime.from("2026-09-14T18:41:05.797510986")), "20260914-184105");
});

Deno.test("session stamp is filename safe and sorts chronologically", () => {
  const stamps = [
    "2026-09-14T18:41:05",
    "2026-09-14T09:41:05",
    "2026-01-14T18:41:05",
  ].map((s) => stamp(Temporal.PlainDateTime.from(s)));
  for (const s of stamps) assertMatch(s, /^\d{8}-\d{6}$/);
  assertEquals([...stamps].sort(), ["20260114-184105", "20260914-094105", "20260914-184105"]);
});

Deno.test("redaction strips the account id", () => {
  const line = "SteamInternal_SetMinidumpSteamID:  Caching Steam ID:  76561198024997128 [API]";
  const out = redact(line);
  assertEquals(out.includes("76561198024997128"), false);
  assertEquals(out.includes("<steam-id>"), true);
});

Deno.test("redaction leaves the public app id alone", () => {
  // 257350 is BG2:EE's Steam AppID - public, and not an account identifier.
  assertEquals(redact("Setting breakpad minidump AppID = 257350"), "Setting breakpad minidump AppID = 257350");
});

Deno.test("redaction does not touch captured events", () => {
  const event = "INFO: LUA: A7LOG\t9\t1\t2\tt\tW\tVampire: Takes 13 slashing damage from Tyras";
  assertEquals(redact(event), event);
});
