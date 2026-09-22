/**
 * Readers for the Infinity Engine's on-disk formats.
 *
 * Pure functions over `Uint8Array` — no I/O, so every one of these is testable
 * against a byte fixture and reusable by anything that has already loaded a
 * file. `resources.ts` does the reading; this file only decodes.
 *
 * **Every offset here comes from IESDP**, not from memory:
 * https://gibberlings3.github.io/iesdp/file_formats/index.htm
 *
 * A wrong offset does not throw — it silently yields a plausible-looking number,
 * which is the whole hazard with fixed-offset binary formats. The guard is in
 * `extract.ts`: `spell.ids` names every spell independently of `dialog.tlk`, so
 * if these offsets are right the two agree, and if any is wrong the agreement
 * rate collapses. Trust that check, not this comment.
 *
 * All Infinity Engine integers are little-endian.
 */

/** Every format starts with a 4-byte signature and a 4-byte version. */
export interface Signature {
  signature: string;
  version: string;
}

const ASCII = new TextDecoder("ascii");

/**
 * BG2:EE stores strings as UTF-8. Fatal decoding is deliberate: a silent
 * replacement character would be indistinguishable from game text that really
 * contains one, and this project already has one unexplained mojibake to chase.
 * Callers that can tolerate bad bytes catch it.
 */
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Fixed-length ASCII field, NUL-padded. Used for signatures and resrefs. */
function fixedString(bytes: Uint8Array, at: number, len: number): string {
  const end = Math.min(at + len, bytes.length);
  const raw = ASCII.decode(bytes.subarray(at, end));
  const nul = raw.indexOf("\0");
  return (nul === -1 ? raw : raw.slice(0, nul)).trim();
}

export function readSignature(bytes: Uint8Array): Signature {
  return { signature: fixedString(bytes, 0, 4), version: fixedString(bytes, 4, 4) };
}

/** Throw unless the file starts with the signature we expect. */
function expect(bytes: Uint8Array, signature: string, what: string): void {
  const found = readSignature(bytes);
  if (found.signature !== signature) {
    throw new Error(`not a ${what} file: signature is "${found.signature}", expected "${signature}"`);
  }
}

// --- KEY: the resource index ---------------------------------------------

/**
 * Resource types, by the 2-byte code in a KEY resource entry.
 *
 * Only the ones this project reads. A resref is not unique on its own — the
 * same eight characters can name a spell and a creature — so the type is part
 * of the key, not decoration.
 */
export const RES_TYPE: Record<string, number> = {
  bmp: 0x0001,
  wav: 0x0004,
  bam: 0x03e8,
  wed: 0x03e9,
  itm: 0x03ed,
  spl: 0x03ee,
  bcs: 0x03ef,
  cre: 0x03f1,
  are: 0x03f2,
  dlg: 0x03f3,
  "2da": 0x03f4,
  eff: 0x03f8,
  vvc: 0x03fb,
  pro: 0x03fd,
  ids: 0x03f0,
  sto: 0x03f6,
};

export interface KeyEntry {
  resref: string;
  type: number;
  /** Which biff holds it, as an index into `biffs`. */
  biff: number;
  /** Which entry within that biff. Matched against the biff's own locators. */
  fileIndex: number;
}

export interface KeyIndex {
  /** Biff paths as recorded, e.g. `data/Spells.bif`. Backslashes normalized. */
  biffs: string[];
  entries: KeyEntry[];
}

/**
 * Parse `chitin.key`.
 *
 * The locator is one packed 32-bit field and the split is not guessable: bits
 * 31-20 are the biff index, 19-14 a tileset index, and 13-0 the file index
 * within that biff. Reading it as a plain integer, or shifting by the wrong
 * amount, yields a valid-looking biff number pointing at the wrong archive.
 */
export function readKey(bytes: Uint8Array): KeyIndex {
  expect(bytes, "KEY", "KEY");
  const dv = view(bytes);

  const biffCount = dv.getUint32(0x08, true);
  const resourceCount = dv.getUint32(0x0c, true);
  const biffsAt = dv.getUint32(0x10, true);
  const resourcesAt = dv.getUint32(0x14, true);

  const biffs: string[] = [];
  for (let i = 0; i < biffCount; i++) {
    const at = biffsAt + i * 12;
    const nameAt = dv.getUint32(at + 0x04, true);
    const nameLen = dv.getUint16(at + 0x08, true);
    // The length includes the NUL terminator, which must not reach the path.
    const raw = ASCII.decode(bytes.subarray(nameAt, nameAt + Math.max(0, nameLen - 1)));
    biffs.push(raw.replace(/\\/g, "/").replace(/\0+$/, ""));
  }

  const entries: KeyEntry[] = [];
  for (let i = 0; i < resourceCount; i++) {
    const at = resourcesAt + i * 14;
    if (at + 14 > bytes.length) break;
    const locator = dv.getUint32(at + 0x0a, true);
    entries.push({
      resref: fixedString(bytes, at, 8),
      type: dv.getUint16(at + 0x08, true),
      biff: locator >>> 20,
      fileIndex: locator & 0x3fff,
    });
  }

  return { biffs, entries };
}

// --- BIF: the archives ----------------------------------------------------

export interface BiffEntry {
  /** Bits 0-13 of the locator, which is what a KEY file index matches. */
  fileIndex: number;
  offset: number;
  size: number;
  type: number;
}

export interface BiffHeader {
  fileCount: number;
  /** Byte offset of the file table. Can be well past any fixed read window. */
  entriesAt: number;
}

/** Bytes needed to read a biff header. */
export const BIFF_HEADER_SIZE = 20;

/** Size of one file-table entry, for sizing the second read. */
export const BIFF_ENTRY_SIZE = 16;

export function readBiffHeader(bytes: Uint8Array): BiffHeader {
  expect(bytes, "BIFF", "BIFF");
  const dv = view(bytes);
  return {
    fileCount: dv.getUint32(0x08, true),
    entriesAt: dv.getUint32(0x10, true),
  };
}

/**
 * Parse a biff's file table from exactly the table's bytes.
 *
 * Takes the table alone rather than the whole archive, so the caller can seek
 * to it and read precisely `fileCount * 16` bytes. An earlier version read a
 * fixed 64 KB from the start of the file and parsed at absolute offsets, which
 * silently truncated any table with more than ~4,096 entries — and Spells.bif
 * has more than that, so every biffed spell came back null.
 *
 * Entries are *not* addressed by position: each carries its own locator, and
 * the KEY's file index is matched against bits 0-13 of it. Indexing the array
 * directly happens to work for most archives and returns the wrong resource for
 * the rest.
 */
export function readBiffEntries(table: Uint8Array, fileCount: number): BiffEntry[] {
  const dv = view(table);
  const entries: BiffEntry[] = [];
  for (let i = 0; i < fileCount; i++) {
    const at = i * BIFF_ENTRY_SIZE;
    if (at + BIFF_ENTRY_SIZE > table.length) break;
    entries.push({
      fileIndex: dv.getUint32(at + 0x00, true) & 0x3fff,
      offset: dv.getUint32(at + 0x04, true),
      size: dv.getUint32(at + 0x08, true),
      type: dv.getUint16(at + 0x0c, true),
    });
  }
  return entries;
}

// --- CRE: creatures -------------------------------------------------------

/**
 * The eleven resistance percentages, in the order the file stores them.
 *
 * A fixed run of single bytes at 0x59, so the names have to come from
 * somewhere and the order is the only thing identifying them.
 */
export const RESISTANCES = [
  "fire",
  "cold",
  "electricity",
  "acid",
  "magic",
  "magicFire",
  "magicCold",
  "slashing",
  "crushing",
  "piercing",
  "missile",
] as const;

export type Resistance = typeof RESISTANCES[number];

/** The five saving throws, in file order at 0x54. Lower is better. */
export const SAVES = ["death", "wands", "polymorph", "breath", "spells"] as const;

export type Save = typeof SAVES[number];

export interface Creature {
  resref: string;
  /** Strref of the full name. The one the combat log prints. */
  nameStrref: number;
  /** Strref of the short name, which is sometimes the only one set. */
  shortNameStrref: number;
  xpForKilling: number;
  currentHp: number;
  maxHp: number;
  /** Natural and effective AC. Signed: lower is better, and negatives are normal. */
  acNatural: number;
  acEffective: number;
  thac0: number;
  attacks: number;
  saves: Record<Save, number>;
  resistances: Record<Resistance, number>;
  /** Class levels; most creatures use only the first. */
  levels: [number, number, number];
  race: number;
  class: number;
}

/**
 * Parse a `.CRE`.
 *
 * This is the half of the game data the log never prints. Enemy HP, AC, saves
 * and resistances are simply not in the combat log — the README said they were
 * unknowable, which is true of the log and false of the files.
 *
 * Offsets per IESDP. Note AC and the save/resistance runs are *signed* single
 * bytes in places: a save of -1 and an AC of -4 are both ordinary, and reading
 * them unsigned turns them into 255 and 252 without erroring.
 */
export function readCre(resref: string, bytes: Uint8Array): Creature {
  expect(bytes, "CRE", "CRE");
  const dv = view(bytes);

  const saves = {} as Record<Save, number>;
  SAVES.forEach((name, i) => {
    saves[name] = dv.getInt8(0x54 + i);
  });

  const resistances = {} as Record<Resistance, number>;
  RESISTANCES.forEach((name, i) => {
    resistances[name] = dv.getInt8(0x59 + i);
  });

  return {
    resref,
    nameStrref: dv.getUint32(0x08, true),
    shortNameStrref: dv.getUint32(0x0c, true),
    xpForKilling: dv.getUint32(0x14, true),
    currentHp: dv.getUint16(0x24, true),
    maxHp: dv.getUint16(0x26, true),
    acNatural: dv.getInt16(0x46, true),
    acEffective: dv.getInt16(0x48, true),
    thac0: dv.getUint8(0x52),
    attacks: dv.getUint8(0x53),
    saves,
    resistances,
    levels: [dv.getUint8(0x234), dv.getUint8(0x235), dv.getUint8(0x236)],
    race: dv.getUint8(0x272),
    class: dv.getUint8(0x273),
  };
}

// --- TLK: the string table ------------------------------------------------

/**
 * `dialog.tlk` — every string the game displays, indexed by "strref".
 *
 * This is the file that matters most to this project: the combat log prints
 * these strings, so a strref resolved here is the exact text that appeared on
 * screen. It is 11 MB and holds a few hundred thousand entries, so the index is
 * parsed once and strings are decoded on demand rather than all up front.
 *
 * Header is 18 bytes; each index entry is 26. Per-entry string offsets are
 * relative to the strings section named in the header, **not** to file start —
 * getting that wrong yields text from the wrong place rather than an error.
 */
export class Tlk {
  private readonly bytes: Uint8Array;
  private readonly dv: DataView;
  private readonly stringsAt: number;
  readonly count: number;

  private static readonly HEADER = 18;
  private static readonly ENTRY = 26;

  constructor(bytes: Uint8Array) {
    expect(bytes, "TLK", "TLK");
    this.bytes = bytes;
    this.dv = view(bytes);
    this.count = this.dv.getUint32(0x0a, true);
    this.stringsAt = this.dv.getUint32(0x0e, true);
  }

  /**
   * Resolve a strref to its string, or null when there is none.
   *
   * Out-of-range is null rather than an error: a strref of -1 (0xFFFFFFFF) is
   * the engine's own "no string" value and appears throughout the game files.
   */
  get(strref: number): string | null {
    if (!Number.isInteger(strref) || strref < 0 || strref >= this.count) return null;

    const entry = Tlk.HEADER + strref * Tlk.ENTRY;
    const offset = this.dv.getUint32(entry + 0x12, true);
    const length = this.dv.getUint32(entry + 0x16, true);
    if (length === 0) return null;

    const start = this.stringsAt + offset;
    const end = start + length;
    if (end > this.bytes.length) return null;

    try {
      return UTF8.decode(this.bytes.subarray(start, end));
    } catch {
      // Not UTF-8. Worth surfacing rather than hiding: see the mojibake note at
      // the top of this file.
      return null;
    }
  }

  /** Raw bytes behind a strref, for questions decoding cannot answer. */
  bytesOf(strref: number): Uint8Array | null {
    if (!Number.isInteger(strref) || strref < 0 || strref >= this.count) return null;
    const entry = Tlk.HEADER + strref * Tlk.ENTRY;
    const offset = this.dv.getUint32(entry + 0x12, true);
    const length = this.dv.getUint32(entry + 0x16, true);
    if (length === 0) return null;
    const start = this.stringsAt + offset;
    if (start + length > this.bytes.length) return null;
    return this.bytes.subarray(start, start + length);
  }
}

// --- SPL: spells ----------------------------------------------------------

/** Spell type, from the 2-byte field at 0x1C. */
export const SPELL_TYPES: Record<number, string> = {
  0: "special",
  1: "wizard",
  2: "priest",
  3: "psionic",
  4: "innate",
  5: "bardsong",
};

/**
 * Primary type, the 1-byte field at 0x25. These are the magic schools, and the
 * numbering is the engine's own (MSCHOOL.IDS).
 */
export const SCHOOLS: Record<number, string> = {
  0: "none",
  1: "abjurer",
  2: "conjurer",
  3: "diviner",
  4: "enchanter",
  5: "illusionist",
  6: "invoker",
  7: "necromancer",
  8: "transmuter",
  9: "generalist",
};

/**
 * One effect. The unit of meaning in a spell: what a spell *does* is the list
 * of these it applies, and `opcode` is which effect.
 *
 * `dispellable` is read straight from the file rather than inferred. The field
 * is a 2-bit enum where bit 0 is "a dispel removes this" and bit 1 is "ignores
 * magic resistance", so values 1 and 3 both mean dispellable.
 */
export interface Feature {
  opcode: number;
  target: number;
  power: number;
  param1: number;
  param2: number;
  timing: number;
  /** Raw 0-3 value, kept so the resistance bit is not thrown away. */
  dispelResist: number;
  dispellable: boolean;
  duration: number;
  /** A referenced resource — another spell, a BAM icon, a creature. */
  resource: string;
  savingThrow: number;
}

export interface Spell {
  resref: string;
  /** Strref of the unidentified/generic name — the one the log prints. */
  nameStrref: number;
  identifiedStrref: number;
  type: string;
  school: string;
  level: number;
  /**
   * Every distinct effect the spell applies, from both sources, flattened.
   *
   * Two places carry them: the "casting" blocks on the header, applied when the
   * spell goes off, and blocks hung off each extended header (ability). Keeping
   * them separate would mean every caller reimplemented the merge, and for
   * "what does this spell do" the union is the answer.
   *
   * **Deduplicated**, because most spells carry one extended header per caster
   * level and those headers overwhelmingly point at the same feature blocks.
   * Mirror Image has 11 abilities over 5 blocks; flattening naively reported 55
   * effects for a spell that has 5. Identity is every field, so per-level
   * variants that genuinely differ — a longer duration, more dice — survive as
   * separate entries.
   */
  features: Feature[];
  /** How many extended headers (abilities) the spell has. */
  abilityCount: number;
  /** Feature blocks read before deduplication, for diagnosing the above. */
  featureReads: number;
}

/** Identity of an effect: every field, so real variants are not collapsed. */
function featureKey(f: Feature): string {
  return [
    f.opcode,
    f.target,
    f.power,
    f.param1,
    f.param2,
    f.timing,
    f.dispelResist,
    f.duration,
    f.resource,
    f.savingThrow,
  ].join("|");
}

const FEATURE_SIZE = 48;
const ABILITY_SIZE = 40;

function readFeature(bytes: Uint8Array, dv: DataView, at: number): Feature {
  const dispelResist = dv.getUint8(at + 0x0d);
  return {
    opcode: dv.getUint16(at + 0x00, true),
    target: dv.getUint8(at + 0x02),
    power: dv.getUint8(at + 0x03),
    param1: dv.getUint32(at + 0x04, true),
    param2: dv.getUint32(at + 0x08, true),
    timing: dv.getUint8(at + 0x0c),
    dispelResist,
    // Bit 0 is the dispel bit; bit 1 is resistance, which is a different
    // question and must not leak into this one.
    dispellable: (dispelResist & 1) === 1,
    duration: dv.getUint32(at + 0x0e, true),
    resource: fixedString(bytes, at + 0x14, 8),
    savingThrow: dv.getUint32(at + 0x24, true),
  };
}

/**
 * Parse a `.SPL`.
 *
 * The one genuinely confusing part: an extended header's "feature block offset"
 * is an **index** into the file-wide feature block table, not a byte offset. So
 * the address is `featureTable + index * 48`. Reading it as a byte offset
 * happens to produce valid-looking effects for spells whose table starts near
 * zero, which is exactly the kind of bug that survives casual testing.
 */
export function readSpl(resref: string, bytes: Uint8Array): Spell {
  expect(bytes, "SPL", "SPL");
  const dv = view(bytes);

  const featureTable = dv.getUint32(0x6a, true);
  const castingIndex = dv.getUint16(0x6e, true);
  const castingCount = dv.getUint16(0x70, true);
  const abilityAt = dv.getUint32(0x64, true);
  const abilityCount = dv.getUint16(0x68, true);

  const features: Feature[] = [];
  const seen = new Set<string>();
  let featureReads = 0;
  const take = (index: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const at = featureTable + (index + i) * FEATURE_SIZE;
      if (at + FEATURE_SIZE > bytes.length) return;
      featureReads++;
      const f = readFeature(bytes, dv, at);
      const key = featureKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      features.push(f);
    }
  };

  take(castingIndex, castingCount);
  for (let a = 0; a < abilityCount; a++) {
    const at = abilityAt + a * ABILITY_SIZE;
    if (at + ABILITY_SIZE > bytes.length) break;
    take(dv.getUint16(at + 0x20, true), dv.getUint16(at + 0x1e, true));
  }

  return {
    featureReads,
    resref,
    nameStrref: dv.getUint32(0x08, true),
    identifiedStrref: dv.getUint32(0x0c, true),
    type: SPELL_TYPES[dv.getUint16(0x1c, true)] ?? `type${dv.getUint16(0x1c, true)}`,
    school: SCHOOLS[dv.getUint8(0x25)] ?? `school${dv.getUint8(0x25)}`,
    level: dv.getUint32(0x34, true),
    features,
    abilityCount,
  };
}
