/**
 * Copy the WeiDU mod into the game directory and install it.
 *
 *   deno task install-mod              # install
 *   deno task install-mod --uninstall  # remove, restoring the original ui.menu
 *
 * WeiDU itself is not vendored here: the game directory already contains WeiDU
 * binaries from the other installed mods, and one of those is reused.
 */
import { GAME_DIR, MOD_DIR } from "./config.ts";

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

/** Any `setup-*` executable already in the game directory is a WeiDU binary. */
async function findWeidu(): Promise<string> {
  for await (const entry of Deno.readDir(GAME_DIR)) {
    if (!entry.isFile) continue;
    if (!entry.name.startsWith("setup-")) continue;
    if (entry.name.includes(".")) continue; // skip .command / .DEBUG
    if (entry.name === SETUP) continue;
    const info = await Deno.stat(`${GAME_DIR}/${entry.name}`);
    if (info.mode !== null && (info.mode & 0o111) !== 0) return `${GAME_DIR}/${entry.name}`;
  }
  throw new Error(`No WeiDU binary found in ${GAME_DIR}. Install one mod there first.`);
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
