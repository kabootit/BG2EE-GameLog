/**
 * Copy the WeiDU mod into the game directory and install it.
 *
 *   deno task install-mod              # install
 *   deno task install-mod --uninstall  # remove, restoring the original ui.menu
 *
 * REQUIRES WEIDU. The tap is packaged as a WeiDU mod, so a WeiDU binary must be
 * available; it is not vendored here. On an already-modded install one is simply
 * borrowed from the game directory, which is why this dependency is easy to miss
 * — on a clean install there is nothing to borrow. See findWeidu() for the
 * lookup order and https://github.com/WeiDUorg/weidu/releases for downloads.
 */
import { GAME_DIR, MOD_DIR, WEIDU } from "./config.ts";

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
async function findWeidu(): Promise<string> {
  if (WEIDU !== "") {
    if (await exists(WEIDU)) return WEIDU;
    throw new Error(`BG2EE_WEIDU is set to "${WEIDU}", which does not exist.`);
  }

  for await (const entry of Deno.readDir(GAME_DIR)) {
    if (!entry.isFile) continue;
    if (!entry.name.startsWith("setup-")) continue;
    if (entry.name.includes(".")) continue; // skip .command / .DEBUG
    if (entry.name === SETUP) continue;
    const info = await Deno.stat(`${GAME_DIR}/${entry.name}`);
    if (info.mode !== null && (info.mode & 0o111) !== 0) return `${GAME_DIR}/${entry.name}`;
  }

  const fromPath = await onPath("weidu");
  if (fromPath !== null) return fromPath;

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

async function main() {
  const uninstall = Deno.args.includes("--uninstall");

  if (!await exists(`${GAME_DIR}/chitin.key`)) {
    throw new Error(`Not a game directory: ${GAME_DIR}`);
  }

  await copyTree(`${MOD_DIR}/${MOD_NAME}`, `${GAME_DIR}/${MOD_NAME}`);
  console.log(`mod      ${GAME_DIR}/${MOD_NAME}`);

  const setupPath = `${GAME_DIR}/${SETUP}`;
  if (!await exists(setupPath)) {
    const weidu = await findWeidu();
    await Deno.copyFile(weidu, setupPath);
    await Deno.chmod(setupPath, 0o755);
    console.log(`weidu    copied from ${weidu.split("/").pop()}`);
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
