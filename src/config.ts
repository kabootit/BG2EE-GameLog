/**
 * Paths and settings. Every path is derived from $HOME or from this module's own
 * location, so no home directory is hardcoded. Each one can be overridden by env var.
 */

function home(): string {
  const h = Deno.env.get("HOME");
  if (!h) throw new Error("HOME is not set");
  return h;
}

/** file:// URL -> filesystem path, without pulling in a dependency for one function. */
export function toPath(url: URL): string {
  return decodeURIComponent(url.pathname);
}

/** Project root, with trailing slash. */
export const ROOT = toPath(new URL("../", import.meta.url));

export const LOGS_DIR = `${ROOT}logs`;
export const WEB_DIR = `${ROOT}web`;
export const MOD_DIR = `${ROOT}mod`;
export const DB_PATH = Deno.env.get("BG2EE_DB") ?? `${ROOT}events.db`;

export const GAME_DIR = Deno.env.get("BG2EE_GAME_DIR") ??
  `${home()}/Library/Application Support/Steam/steamapps/common/Baldur's Gate II Enhanced Edition`;

export const GAME_BINARY = Deno.env.get("BG2EE_BINARY") ??
  `${GAME_DIR}/BaldursGateIIEnhancedEdition.app/Contents/MacOS/BaldursGateIIEnhancedEdition`;

export const UI_MENU = `${GAME_DIR}/override/ui.menu`;

export const USER_DIR = Deno.env.get("BG2EE_USER_DIR") ??
  `${home()}/Documents/Baldur's Gate II - Enhanced Edition`;

export const BALDUR_LUA = `${USER_DIR}/Baldur.lua`;

export const SERVE_PORT = Number(Deno.env.get("BG2EE_PORT") ?? "8787");

/** Prefix the in-game tap puts on every line it emits. */
export const TAP_MARKER = "A7LOG";

/** Prefix for the tap's party-roster lines. State, not an event - never stored as a row. */
export const ROSTER_MARKER = "A7ROSTER";
