/**
 * Finding a game resource by name.
 *
 * The engine resolves a resref by looking in `override/` first and falling back
 * to the biffs indexed by `chitin.key`. **That order is the whole point.** Mods
 * work by dropping patched files into `override/`, so reading the biffs first
 * would describe an unmodded game — on this install that would mean the wrong
 * data for 881 of the 1,124 standard spells, including Mirror Image, Spell
 * Turning and Protection From Magical Weapons.
 *
 * Phase 1 is override-only. `resolve()` returns null for anything biffed, and
 * the caller reports how many that was, so the gap is a number rather than a
 * silent omission. The biff fallback goes in `readBiffed()` below.
 */
import { join } from "jsr:@std/path@1";
import { CHITIN_KEY, GAME_DIR, OVERRIDE_DIR } from "./config.ts";
import {
  BIFF_ENTRY_SIZE,
  BIFF_HEADER_SIZE,
  type BiffEntry,
  type KeyEntry,
  type KeyIndex,
  readBiffEntries,
  readBiffHeader,
  readKey,
  RES_TYPE,
} from "./iebinary.ts";

/**
 * Where a resource came from.
 *
 * `override` or the archive's own path, so provenance is visible in the stored
 * data rather than being inferred later — "which of these came from a mod" is a
 * question that will be asked.
 */
export type Source = string;

export interface Resource {
  resref: string;
  bytes: Uint8Array;
  source: Source;
}

/**
 * Case-insensitive index of `override/`, built once.
 *
 * Necessary, not defensive: this install genuinely mixes cases within a single
 * mod's output — `SPWI001.spl` and `SPWI003.SPL` sit side by side. Looking up
 * either exact spelling would miss roughly half the files, and on a
 * case-insensitive filesystem the bug would hide until someone ran it on Linux.
 */
export class Override {
  private readonly byLowerName = new Map<string, string>();

  private constructor(private readonly dir: string) {}

  static async load(dir: string = OVERRIDE_DIR): Promise<Override> {
    const index = new Override(dir);
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile) index.byLowerName.set(entry.name.toLowerCase(), entry.name);
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      // No override/ at all is legitimate — an unmodded install.
    }
    return index;
  }

  /** Every resref present with this extension, lowercased, sorted. */
  list(extension: string): string[] {
    const suffix = `.${extension.toLowerCase()}`;
    const found: string[] = [];
    for (const lower of this.byLowerName.keys()) {
      if (lower.endsWith(suffix)) found.push(lower.slice(0, -suffix.length));
    }
    return found.sort();
  }

  has(resref: string, extension: string): boolean {
    return this.byLowerName.has(`${resref.toLowerCase()}.${extension.toLowerCase()}`);
  }

  async read(resref: string, extension: string): Promise<Uint8Array | null> {
    const actual = this.byLowerName.get(`${resref.toLowerCase()}.${extension.toLowerCase()}`);
    if (actual === undefined) return null;
    return await Deno.readFile(join(this.dir, actual));
  }

  get size(): number {
    return this.byLowerName.size;
  }
}

/**
 * Fill a buffer completely, or report failure.
 *
 * `read()` may return fewer bytes than asked for without being at the end, so a
 * single call is not enough. A short read here would be a truncated resource
 * that still parses — a header plus garbage — rather than an error.
 */
async function readFully(handle: Deno.FsFile, into: Uint8Array): Promise<boolean> {
  let got = 0;
  while (got < into.length) {
    const n = await handle.read(into.subarray(got));
    if (n === null) return false;
    got += n;
  }
  return true;
}

/**
 * The biffed half of the game's resources, indexed by `chitin.key`.
 *
 * Archives are opened lazily and their file tables cached. A full BG2:EE
 * install is 2 GB across 188 biffs, so reading them all up front to fetch a few
 * hundred spells would be absurd; the index in `chitin.key` is 861 KB and says
 * exactly which archive to open.
 */
export class Biffs {
  private readonly byKey = new Map<string, KeyEntry>();
  private readonly tables = new Map<number, BiffEntry[] | null>();

  private constructor(
    private readonly gameDir: string,
    private readonly index: KeyIndex,
  ) {
    for (const e of index.entries) {
      // Resref alone is not unique across types, so the type is part of the key.
      this.byKey.set(`${e.resref.toLowerCase()}.${e.type}`, e);
    }
  }

  static async load(keyPath: string = CHITIN_KEY, gameDir: string = GAME_DIR): Promise<Biffs> {
    const index = readKey(await Deno.readFile(keyPath));
    return new Biffs(gameDir, index);
  }

  get size(): number {
    return this.byKey.size;
  }

  get archiveCount(): number {
    return this.index.biffs.length;
  }

  /** Which archive holds a resref, for reporting provenance. */
  archiveOf(resref: string, extension: string): string | null {
    const entry = this.lookup(resref, extension);
    return entry === undefined ? null : this.index.biffs[entry.biff] ?? null;
  }

  private lookup(resref: string, extension: string): KeyEntry | undefined {
    const type = RES_TYPE[extension.toLowerCase()];
    if (type === undefined) return undefined;
    return this.byKey.get(`${resref.toLowerCase()}.${type}`);
  }

  has(resref: string, extension: string): boolean {
    return this.lookup(resref, extension) !== undefined;
  }

  /** Every resref of this type the index knows about, lowercased and sorted. */
  list(extension: string): string[] {
    const type = RES_TYPE[extension.toLowerCase()];
    if (type === undefined) return [];
    const found = this.index.entries
      .filter((e) => e.type === type)
      .map((e) => e.resref.toLowerCase());
    return [...new Set(found)].sort();
  }

  async read(resref: string, extension: string): Promise<Uint8Array | null> {
    const entry = this.lookup(resref, extension);
    if (entry === undefined) return null;

    const table = await this.tableFor(entry.biff);
    if (table === null) return null;

    // Matched on the locator, not by array position: entries carry their own
    // file index and are not necessarily stored in that order.
    const file = table.find((f) => f.fileIndex === entry.fileIndex);
    if (file === undefined) return null;

    const path = join(this.gameDir, this.index.biffs[entry.biff]);
    let handle: Deno.FsFile;
    try {
      handle = await Deno.open(path, { read: true });
    } catch {
      return null;
    }
    try {
      // Seek rather than slurp: some archives are hundreds of megabytes and a
      // spell is a couple of kilobytes.
      await handle.seek(file.offset, Deno.SeekMode.Start);
      const buf = new Uint8Array(file.size);
      return await readFully(handle, buf) ? buf : null;
    } finally {
      handle.close();
    }
  }

  /**
   * Read and cache one archive's file table.
   *
   * Two seeks, not one fixed-size read: the header gives the table's offset and
   * length, so the second read is sized exactly. Reading a fixed window instead
   * truncates large tables — `Spells.bif` has more entries than fit in 64 KB,
   * which made every biffed spell come back null while looking like a
   * not-found rather than a bug.
   */
  private async tableFor(biff: number): Promise<BiffEntry[] | null> {
    const cached = this.tables.get(biff);
    if (cached !== undefined) return cached;

    const name = this.index.biffs[biff];
    let table: BiffEntry[] | null = null;
    if (name !== undefined) {
      try {
        const handle = await Deno.open(join(this.gameDir, name), { read: true });
        try {
          const head = new Uint8Array(BIFF_HEADER_SIZE);
          if (await readFully(handle, head)) {
            const { fileCount, entriesAt } = readBiffHeader(head);
            const bytes = new Uint8Array(fileCount * BIFF_ENTRY_SIZE);
            await handle.seek(entriesAt, Deno.SeekMode.Start);
            if (await readFully(handle, bytes)) {
              table = readBiffEntries(bytes, fileCount);
            }
          }
        } finally {
          handle.close();
        }
      } catch {
        table = null;
      }
    }
    this.tables.set(biff, table);
    return table;
  }
}

/**
 * Read a resource the way the engine would: `override/` first, then the biffs.
 *
 * The order is the point. Mods patch by dropping files into `override/`, so
 * checking the archives first would silently describe an unmodded game.
 */
export async function resolve(
  override: Override,
  resref: string,
  extension: string,
  biffs?: Biffs,
): Promise<Resource | null> {
  const loose = await override.read(resref, extension);
  if (loose !== null) return { resref, bytes: loose, source: "override" };

  if (biffs !== undefined) {
    const bytes = await biffs.read(resref, extension);
    if (bytes !== null) {
      return { resref, bytes, source: biffs.archiveOf(resref, extension) ?? "biff" };
    }
  }
  return null;
}

// --- spell.ids ------------------------------------------------------------

/**
 * Prefix per spell class, from the leading digit of a `spell.ids` number.
 *
 * Verified against the install rather than assumed: `2212 WIZARD_MIRROR_IMAGE`
 * resolves to SPWI212, `1505 CLERIC_TRUE_SIGHT` to SPPR505, and all four spot
 * checks were present in `override/`.
 */
const CLASS_PREFIX: Record<string, string> = {
  "1": "sppr", // cleric / priest
  "2": "spwi", // wizard
  "3": "spin", // innate
  "4": "spcl", // class abilities - bard song, blackguard, and so on
};

export interface SpellId {
  /** The script-facing number, e.g. 2212. */
  number: number;
  /** Symbolic name, e.g. WIZARD_MIRROR_IMAGE. Independent of dialog.tlk. */
  symbol: string;
  /** Decoded resource name, e.g. spwi212. */
  resref: string;
}

/**
 * Parse `override/spell.ids`.
 *
 * Plain text, tab-separated, with an `IDS V1.0` line first. The number encodes
 * the resref: leading digit is the spell class, the remaining three are level
 * and index concatenated, which is already the filename's numeric part. So 2212
 * is wizard, level 2, index 12 -> `spwi212`.
 *
 * This file is the reason the readers can be trusted. It names every spell
 * *without* going through `dialog.tlk`, so comparing its symbol against the
 * name a `.SPL` points at is an end-to-end check of every offset in between.
 */
export function parseSpellIds(text: string): SpellId[] {
  const out: SpellId[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("IDS ")) continue;

    const [rawNumber, ...rest] = trimmed.split(/\s+/);
    const symbol = rest.join(" ");
    if (symbol === "") continue;
    if (!/^[1-4]\d{3}$/.test(rawNumber)) continue;

    const prefix = CLASS_PREFIX[rawNumber[0]];
    if (prefix === undefined) continue;

    out.push({
      number: Number(rawNumber),
      symbol,
      resref: `${prefix}${rawNumber.slice(1)}`,
    });
  }
  return out;
}

/**
 * Loose comparison between a symbolic name and a display name.
 *
 * `WIZARD_MIRROR_IMAGE` vs "Mirror Image": drop the class prefix, split on
 * underscores, and ask whether the display name contains the remaining words.
 * Deliberately generous — the goal is proving that offsets are right, not
 * scoring translations, and a strict match would fail on every spell a mod
 * renamed.
 */
export function symbolMatchesName(symbol: string, name: string): boolean {
  const CLASSES = /^(WIZARD|CLERIC|INNATE|BARD|PRIEST|DRUID|PALADIN|RANGER|SHAMAN)_/;
  const words = symbol.replace(CLASSES, "").split("_").filter((w) => w.length > 2);
  if (words.length === 0) return false;

  const haystack = name.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  // Also matched against a space-stripped form, because symbols run compound
  // words together: DRUID_SHAPESHIFT_BROWNBEAR is displayed "Shapeshift: Brown
  // Bear", and "brownbear" only appears once the space is gone. Without this
  // the check reports an offset problem where there is only a naming style.
  const squashed = haystack.replace(/ /g, "");
  const hits = words.filter((w) => {
    const lower = w.toLowerCase();
    return haystack.includes(lower) || squashed.includes(lower);
  }).length;
  // Most of the words, rather than all: "WIZARD_PROTECTION_FROM_MAGIC_WEAPONS"
  // is displayed as "Protection From Magical Weapons" - "magic" is inside
  // "magical", but a spell renamed by a mod may legitimately drop a word.
  return hits / words.length >= 0.6;
}
