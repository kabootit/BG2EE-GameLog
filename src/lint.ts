/**
 * Security audit — the mechanical half.
 *
 * Every check here corresponds to an invariant in docs/SECURITY.md. Documenting
 * an invariant does not keep it true; this is what keeps it true. The judgement
 * half — is a new capability appropriate at all, does a new capture path leak
 * something — is in skills/security.md and cannot be automated.
 *
 * Run via `deno task lint`. Also invoked by install_mod.ts, which refuses to run
 * if any invariant is broken: it is the command that executes an external binary
 * and patches a game installation, so it is the one that most needs the guard.
 */
import { ROOT } from "./config.ts";

export interface Finding {
  check: string;
  detail: string;
}

type Fail = (check: string, detail: string) => void;

const read = (rel: string) => Deno.readTextFile(`${ROOT}${rel}`);

async function sources(dir: string, ext: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(`${ROOT}${dir}`)) {
    if (entry.isFile && entry.name.endsWith(ext)) names.push(`${dir}/${entry.name}`);
  }
  return names.sort();
}

/** No third-party dependencies: zero supply chain is the point. */
async function checkDependencies(fail: Fail) {
  const allowed = /^(node:sqlite|\.\/)/;
  for (const file of await sources("src", ".ts")) {
    const text = await read(file);
    for (const [, spec] of text.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
      if (!allowed.test(spec)) fail("dependencies", `${file} imports "${spec}"`);
    }
  }
  const config = JSON.parse(await read("deno.json"));
  if (config.imports && Object.keys(config.imports).length > 0) {
    fail("dependencies", "deno.json declares an import map");
  }
}

/**
 * Least permission. A task may only hold a blanket --allow-run / --allow-net if
 * it is listed here with a reason.
 */
const BLANKET_EXCEPTIONS: Record<string, string> = {
  "install-mod": "--allow-run: the WeiDU binary is discovered at runtime, so it cannot be named",
};

async function checkPermissions(fail: Fail) {
  const config = JSON.parse(await read("deno.json"));
  for (const [task, command] of Object.entries(config.tasks as Record<string, string>)) {
    if (/(^|\s)(-A|--allow-all)(\s|$)/.test(command)) {
      fail("permissions", `task "${task}" grants --allow-all`);
    }
    for (const flag of ["--allow-run", "--allow-net", "--allow-ffi"]) {
      // Blanket = the flag with no "=value" attached.
      const blanket = new RegExp(`${flag}(?![=\\w])`);
      if (blanket.test(command) && !(task in BLANKET_EXCEPTIONS)) {
        fail("permissions", `task "${task}" grants blanket ${flag}`);
      }
    }
  }
}

/** The server must never leave loopback. */
async function checkBindAddress(fail: Fail) {
  const text = await read("src/serve.ts");
  if (!text.includes(`hostname: "127.0.0.1"`)) {
    fail("bind-address", "serve.ts does not pin hostname to 127.0.0.1");
  }
  if (/0\.0\.0\.0|hostname:\s*""/.test(text)) {
    fail("bind-address", "serve.ts appears to bind a non-loopback address");
  }
}

/**
 * SQL identifiers cannot be bound as parameters, so they are interpolated — and
 * are safe only while every interpolated expression is allowlist-checked first.
 * This is the invariant most likely to be broken by adding "just one more"
 * sortable column.
 */
const SQL_SAFE_EXPRESSIONS = new Set([
  "where", // built from clauses that only ever contain ? placeholders
  'clauses.join(" AND ")', // ditto — the clause strings are literals with ?
  "orderBy", // built by orderClause(), each key checked against SORTABLE
  "by", // checked against GROUPABLE before use
  "column", // literal call-site argument inside filters()
  "bySession.sql",
  "byKind.sql",
  'kinds.map(() => "?").join(", ")', // placeholder list, not values
]);

async function checkSqlInterpolation(fail: Fail) {
  const text = await read("src/serve.ts");
  for (const [, body] of text.matchAll(/`([^`]*)`/g)) {
    if (!/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|ORDER BY|GROUP BY)\b/i.test(body)) continue;
    for (const [, expr] of body.matchAll(/\$\{([^}]+)\}/g)) {
      if (!SQL_SAFE_EXPRESSIONS.has(expr.trim())) {
        fail(
          "sql-injection",
          `serve.ts interpolates "${expr.trim()}" into SQL without an allowlist`,
        );
      }
    }
  }
  for (const name of ["SORTABLE", "GROUPABLE"]) {
    if (!new RegExp(`const ${name} = new Set\\(`).test(text)) {
      fail("sql-injection", `serve.ts no longer defines ${name} as a literal Set`);
    }
  }
}

/** Anything from the database originates in game text, which mods control. */
async function checkHtmlEscaping(fail: Fail) {
  const text = await read("web/viewer.html");
  if (!/const esc = /.test(text)) fail("html-escaping", "viewer.html defines no esc() helper");
  // Quotes included: some values land in attributes, not text nodes.
  if (!text.includes(`[&<>"']`)) {
    fail("html-escaping", `esc() no longer escapes all of & < > " '`);
  }
  for (const sink of ["insertAdjacentHTML", "outerHTML", "document.write", "eval(", "new Function("]) {
    if (text.includes(sink)) fail("html-escaping", `viewer.html uses ${sink}`);
  }
  // Data-derived interpolation: row fields and facet values must go through esc().
  for (const line of text.split("\n")) {
    for (const [, expr] of line.matchAll(/\$\{((?:r|row|value|current)[^}]*)\}/g)) {
      if (!expr.includes("esc(") && !/\.(n|length)$/.test(expr.trim())) {
        fail("html-escaping", `viewer.html interpolates "${expr.trim()}" unescaped`);
      }
    }
  }
}

/**
 * Game text is third-party input — dialog.tlk is rewritten by any installed mod,
 * so creature and spell names are attacker-authored as far as this code is
 * concerned. It is normalized once at the parse boundary rather than defended
 * against at each sink: the viewer escapes HTML, but the terminal reports print
 * stored text directly, where an ANSI escape would be interpreted.
 */
async function checkUntrustedText(fail: Fail) {
  const text = await read("src/parse.ts");
  if (!/const CONTROL = /.test(text)) {
    fail("untrusted-text", "parse.ts no longer defines a control-character filter");
  }
  if (!/\.replace\(CONTROL,/.test(text)) {
    fail("untrusted-text", "parse.ts does not strip control characters from stored text");
  }
}

/** Captured output is redacted as it is written, never cleaned up afterwards. */
async function checkRedaction(fail: Fail) {
  const text = await read("src/play.ts");
  if (!/export function redact\(/.test(text)) {
    fail("redaction", "play.ts no longer exports redact()");
  }
  if (!/const line = redact\(/.test(text)) {
    fail("redaction", "play.ts does not redact before writing the session log");
  }
}

/** Committed logs must carry no account or filesystem identifiers. */
async function checkCommittedLogs(fail: Fail) {
  for (const file of await sources("logs", ".log")) {
    const text = await read(file);
    if (/\b7656\d{13}\b/.test(text)) fail("committed-logs", `${file} contains a SteamID`);
    const home = text.match(/\/Users\/[^/\s"']+/);
    if (home) fail("committed-logs", `${file} contains a home path (${home[0]})`);
  }
}

/** Nothing this project did not ship gets executed without an explicit yes. */
async function checkBinaryConfirmation(fail: Fail) {
  const text = await read("src/install_mod.ts");
  if (!/async function confirmBinary\(/.test(text)) {
    fail("binary-execution", "install_mod.ts no longer defines confirmBinary()");
  }
  if (!/confirm\(/.test(text)) {
    fail("binary-execution", "install_mod.ts does not prompt before executing");
  }
  // Deliberately narrow: WeiDU's own --force-install must not trip this.
  if (/--yes\b|--assume-yes|--no-confirm|skipConfirm|SKIP_CONFIRM/.test(text)) {
    fail("binary-execution", "install_mod.ts appears to offer a way to skip confirmation");
  }
  const confirmAt = text.indexOf("confirmBinary(");
  const execAt = text.indexOf("new Deno.Command(setupPath");
  if (confirmAt === -1 || execAt === -1 || confirmAt > execAt) {
    fail("binary-execution", "confirmBinary() does not precede execution of the setup binary");
  }
}

export const CHECKS: Array<[string, (fail: Fail) => Promise<void>]> = [
  ["dependencies", checkDependencies],
  ["permissions", checkPermissions],
  ["bind-address", checkBindAddress],
  ["sql-injection", checkSqlInterpolation],
  ["html-escaping", checkHtmlEscaping],
  ["untrusted-text", checkUntrustedText],
  ["redaction", checkRedaction],
  ["committed-logs", checkCommittedLogs],
  ["binary-execution", checkBinaryConfirmation],
];

/** Run every check. Returns the findings; empty means all invariants hold. */
export async function audit(): Promise<Finding[]> {
  const findings: Finding[] = [];
  const fail: Fail = (check, detail) => findings.push({ check, detail });
  for (const [, run] of CHECKS) await run(fail);
  return findings;
}

/** Print findings in the shared format. Returns true if anything failed. */
export function reportFindings(findings: Finding[], verbose = true): boolean {
  const failed = new Set(findings.map((f) => f.check));
  if (verbose) {
    for (const [name] of CHECKS) console.log(`  ${failed.has(name) ? "FAIL" : "ok  "}  ${name}`);
  }
  if (findings.length === 0) return false;

  console.error(`\n${findings.length} security finding(s):\n`);
  for (const f of findings) console.error(`  [${f.check}] ${f.detail}`);
  console.error(`\nSee docs/SECURITY.md for the invariant each check enforces.`);
  return true;
}

async function main() {
  if (reportFindings(await audit())) Deno.exit(1);
  console.log(`\nAll security invariants hold. Judgement-based review: skills/security.md`);
}

if (import.meta.main) await main();
