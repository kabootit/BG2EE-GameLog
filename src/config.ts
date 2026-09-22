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

/**
 * Loose game resources. Mods install here and the engine reads it before the
 * biffs, so this directory is where the *actual* installed semantics live — on
 * this install, 881 of the 1,124 standard spells are overridden.
 */
export const OVERRIDE_DIR = `${GAME_DIR}/override`;

export const UI_MENU = `${OVERRIDE_DIR}/ui.menu`;

/** Biffed resources, indexed by chitin.key. Read only when override/ misses. */
export const CHITIN_KEY = `${GAME_DIR}/chitin.key`;
export const DATA_DIR = `${GAME_DIR}/data`;

/**
 * Which localization to read strings from. The combat log prints whatever this
 * language's dialog.tlk contains, so it has to match the running game.
 */
export const GAME_LANG = Deno.env.get("BG2EE_LANG") ?? "en_US";

export const DIALOG_TLK = Deno.env.get("BG2EE_TLK") ??
  `${GAME_DIR}/lang/${GAME_LANG}/dialog.tlk`;

export const USER_DIR = Deno.env.get("BG2EE_USER_DIR") ??
  `${home()}/Documents/Baldur's Gate II - Enhanced Edition`;

export const BALDUR_LUA = `${USER_DIR}/Baldur.lua`;

export const SERVE_PORT = Number(Deno.env.get("BG2EE_PORT") ?? "8787");

/**
 * Explicit path to a WeiDU binary. WeiDU is a real external dependency — the tap
 * is packaged as a WeiDU mod — and it is not vendored here. See findWeidu() in
 * install_mod.ts for the full lookup order.
 */
export const WEIDU = Deno.env.get("BG2EE_WEIDU") ?? "";

/** Prefix the in-game tap puts on every line it emits. */
export const TAP_MARKER = "A7LOG";

/** Prefix for the tap's party-roster lines. State, not an event - never stored as a row. */
export const ROSTER_MARKER = "A7ROSTER";

/**
 * Prefix for the tap's party saving-throw targets. State, like the roster.
 *
 * The combat log prints a save's result but never whether it succeeded. These
 * are the numbers it has to beat, read live from `characters[id]` so they
 * include level and any temporary modifier.
 */
export const STATS_MARKER = "A7STATS";

/**
 * Prefix for the tap's own diagnostics. Never an event, never state.
 *
 * Exists because the roster tap silently emitted nothing for the whole life of
 * the project: `characters` is keyed by pointer-like integers, not 0..9, so the
 * scan found no one and returned. A channel for the tap to say what it is
 * actually looking at is worth the one line.
 */
export const PROBE_MARKER = "A7PROBE";
