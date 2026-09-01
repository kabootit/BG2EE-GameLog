/**
 * Copy the WeiDU mod into the game directory and install it.
 *
 *   deno task install-mod              # install
 *   deno task install-mod --uninstall  # remove, restoring the original ui.menu
 *
 * REQUIRES WEIDU. The tap is packaged as a WeiDU mod, so a WeiDU binary must be
 * available; it is not vendored here. On an already-modded install one is simply
 * borrowed from the game directory, which is why this dependency is easy to miss
 * — on a clean install there is nothing to borrow.
 *
 * That borrowing is also the sharp edge: this script runs an executable it found
 * by pattern-matching filenames in a directory it does not control. Anything
 * named `setup-*` there would do. So nothing is executed until the exact path,
 * how it was found, and its SHA-256 have been shown and confirmed.
 *
 *   source:   https://github.com/WeiDUorg/weidu
 *   releases: https://github.com/WeiDUorg/weidu/releases
 */
import { GAME_DIR, MOD_DIR, WEIDU } from "./config.ts";
import { audit, CHECKS, reportFindings } from "./lint.ts";

const MOD_NAME = "gamelog";
const SETUP = `setup-${MOD_NAME}`;

async function copyTree(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = `${from}/${entry.name}`;
    const dst = `${to}/${entry.name}`;
    if (entry.isDirectory) await copyTree(src, dst);
    else if (entry.isFile) await Deno.copyFile(src, dst);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function onPath(command: string): Promise<string | null> {
  try {
    const { code, stdout } = await new Deno.Command("which", {
      args: [command],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (code !== 0) return null;
    const found = new TextDecoder().decode(stdout).trim();
    return found === "" ? null : found;
  } catch {
    return null;
  }
}

/**
 * Locate a WeiDU binary, in order of decreasing explicitness:
 *
 *   1. $BG2EE_WEIDU
 *   2. any `setup-*` executable in the game directory — every installed mod
 *      ships one, so a modded install needs no setup
 *   3. `weidu` on $PATH
 */
interface Found {
  path: string;
  /** How it was located — shown to the user, since it is the provenance. */
  source: string;
}

async function findWeidu(): Promise<Found> {
  if (WEIDU !== "") {
    if (await exists(WEIDU)) return { path: WEIDU, source: "$BG2EE_WEIDU" };
    throw new Error(`BG2EE_WEIDU is set to "${WEIDU}", which does not exist.`);
  }

  for await (const entry of Deno.readDir(GAME_DIR)) {
    if (!entry.isFile) continue;
    if (!entry.name.startsWith("setup-")) continue;
    if (entry.name.includes(".")) continue; // skip .command / .DEBUG
    if (entry.name === SETUP) continue;
    const info = await Deno.stat(`${GAME_DIR}/${entry.name}`);
    if (info.mode !== null && (info.mode & 0o111) !== 0) {
      return {
        path: `${GAME_DIR}/${entry.name}`,
        source: `matched setup-* in the game directory (not verified)`,
      };
    }
  }

  const fromPath = await onPath("weidu");
  if (fromPath !== null) return { path: fromPath, source: "weidu on $PATH" };

  throw new Error(
    [
      "WeiDU not found. The tap is packaged as a WeiDU mod, so a WeiDU binary is required.",
      "",
      "Looked in:",
      "  1. $BG2EE_WEIDU                              (not set)",
      `  2. ${GAME_DIR}  (no setup-* executable)`,
      "  3. weidu on $PATH                            (not found)",
      "",
      "Download one for your platform from https://github.com/WeiDUorg/weidu/releases,",
      "then either put it on $PATH or set BG2EE_WEIDU to its full path.",
    ].join("\n"),
  );
}

async function sha256(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(path));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Show exactly what is about to be executed, and get a yes.
 *
 * This script locates WeiDU by pattern-matching filenames in the game directory,
 * which is not a trusted source — any executable named `setup-*` would be picked
 * up and run. The checksum is printed so it can be compared against the official
 * release before anything happens. There is deliberately no flag to skip this.
 */
async function confirmBinary(path: string, source: string): Promise<void> {
  const { size } = await Deno.stat(path);

  console.log(`\nAbout to execute an external binary:\n`);
  console.log(`  path     ${path}`);
  console.log(`  found    ${source}`);
  console.log(`  size     ${size.toLocaleString()} bytes`);
  console.log(`  sha256   ${await sha256(path)}\n`);
  console.log(`  WeiDU is the Infinity Engine mod installer. Verify before running:`);
  console.log(`    source    https://github.com/WeiDUorg/weidu`);
  console.log(`    releases  https://github.com/WeiDUorg/weidu/releases\n`);

  if (!confirm("  Execute this binary?")) throw new Error("Aborted — nothing was run.");
  console.log("");
}

async function main() {
  const uninstall = Deno.args.includes("--uninstall");

  // This is the command that executes an external binary and modifies a game
  // installation, so it verifies the invariants itself rather than trusting that
  // `deno task lint` was run. Living in main() rather than the task definition
  // means running the script directly cannot bypass it.
  const findings = await audit();
  if (reportFindings(findings, false)) {
    throw new Error(
      "Refusing to install: security invariants are broken. Fix them, or run\n" +
        "`deno task lint` for the full report. See docs/SECURITY.md.",
    );
  }
  console.log(`security ${CHECKS.length} invariants verified`);

  if (!await exists(`${GAME_DIR}/chitin.key`)) {
    throw new Error(`Not a game directory: ${GAME_DIR}`);
  }

  await copyTree(`${MOD_DIR}/${MOD_NAME}`, `${GAME_DIR}/${MOD_NAME}`);
  console.log(`mod      ${GAME_DIR}/${MOD_NAME}`);

  // Confirm whatever will actually run — including a setup-gamelog left behind
  // by an earlier install, which is itself a copied binary.
  const setupPath = `${GAME_DIR}/${SETUP}`;
  if (await exists(setupPath)) {
    await confirmBinary(setupPath, `left in the game directory by a previous install`);
  } else {
    const weidu = await findWeidu();
    await confirmBinary(weidu.path, weidu.source);
    await Deno.copyFile(weidu.path, setupPath);
    await Deno.chmod(setupPath, 0o755);
    console.log(`weidu    copied from ${weidu.path}`);
  }

  const args = uninstall
    ? ["--uninstall", "--language", "0", "--no-exit-pause"]
    : ["--force-install", "0", "--language", "0", "--no-exit-pause"];

  const { code } = await new Deno.Command(setupPath, {
    args,
    cwd: GAME_DIR,
    stdout: "inherit",
    stderr: "inherit",
  }).output();

  if (code !== 0) throw new Error(`WeiDU exited with code ${code}`);
  console.log(uninstall ? "\nuninstalled" : "\ninstalled");
}

if (import.meta.main) await main();
