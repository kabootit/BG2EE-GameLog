/**
 * Tests for the security audit's own rules.
 *
 * A check that cannot fail reads as coverage while providing none, so the import
 * policy is tested in both directions rather than only being observed to pass.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { audit, importAllowed } from "./lint.ts";

Deno.test("Deno built-ins and relative files are allowed", () => {
  assertEquals(importAllowed("node:sqlite"), null);
  assertEquals(importAllowed("./parse.ts"), null);
  assertEquals(importAllowed("./protections.ts"), null);
});

Deno.test("the Deno standard library is allowed when pinned", () => {
  for (const spec of [
    "jsr:@std/assert@1",
    "jsr:@std/path@1",
    "jsr:@std/fs@1/exists",
    "jsr:@std/streams@1/text-line-stream",
    "jsr:@std/encoding@1/hex",
    "jsr:@std/datetime@0.225/format",
    "jsr:@std/assert@^1.0.0",
  ]) {
    assertEquals(importAllowed(spec), null, spec);
  }
});

Deno.test("an unpinned standard library import is rejected", () => {
  // Without a version this resolves to whatever is newest at install time,
  // which is the moving target the rule exists to prevent.
  for (const spec of ["jsr:@std/assert", "jsr:@std/path/join"]) {
    assert(importAllowed(spec)?.includes("pin"), spec);
  }
});

Deno.test("everything else is still rejected", () => {
  for (const spec of [
    "npm:lodash",
    "npm:express@4",
    "jsr:@oak/oak@17",
    "jsr:@db/sqlite@0.12",
    "https://deno.land/std/path/mod.ts",
    "https://example.com/evil.ts",
    "node:child_process",
    "lodash",
  ]) {
    assertEquals(typeof importAllowed(spec), "string", `${spec} should be rejected`);
  }
});

Deno.test("the project currently satisfies every invariant", async () => {
  // The audit is the thing install-mod gates on, so a regression here should
  // fail the test run rather than only surfacing at install time.
  assertEquals(await audit(), []);
});
