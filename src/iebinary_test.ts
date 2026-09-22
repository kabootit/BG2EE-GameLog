/**
 * Tests for the game-file readers, run with `deno task test`.
 *
 * Built from synthetic bytes rather than real game files, so they run anywhere
 * — the game is not a test dependency, and `logs/` is no longer committed.
 *
 * These target the parts that fail *silently*. A wrong offset in a fixed-layout
 * binary format does not throw; it returns a plausible number. Every case here
 * is one where being wrong looks like working:
 *
 *   - the KEY locator packs three values into one 32-bit field
 *   - TLK string offsets are relative to the strings section, not to file start
 *   - BIF entries are addressed by their own locator, not by array position
 *   - SPL feature blocks are reached through an index, not a byte offset
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  BIFF_ENTRY_SIZE,
  BIFF_HEADER_SIZE,
  readBiffEntries,
  readBiffHeader,
  readCre,
  readKey,
  readSignature,
  readSpl,
  Tlk,
} from "./iebinary.ts";

/** Little-endian byte builder, so fixtures read like the format tables do. */
class Bytes {
  private readonly parts: number[] = [];

  ascii(s: string, pad = 0): this {
    for (const ch of s) this.parts.push(ch.charCodeAt(0) & 0xff);
    for (let i = s.length; i < pad; i++) this.parts.push(0);
    return this;
  }
  u16(n: number): this {
    this.parts.push(n & 0xff, (n >>> 8) & 0xff);
    return this;
  }
  u32(n: number): this {
    this.parts.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
    return this;
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.parts.push(0);
    return this;
  }
  at(offset: number): this {
    while (this.parts.length < offset) this.parts.push(0);
    return this;
  }
  done(): Uint8Array {
    return new Uint8Array(this.parts);
  }
}

Deno.test("a signature is read as ASCII, trimmed of padding", () => {
  assertEquals(readSignature(new Bytes().ascii("SPL ").ascii("V1  ").done()), {
    signature: "SPL",
    version: "V1",
  });
});

Deno.test("the wrong file type is rejected rather than misread", () => {
  // Worth asserting: without the signature check, a CRE handed to readSpl reads
  // its header at SPL offsets and returns a spell made of nonsense.
  const cre = new Bytes().ascii("CRE ").ascii("V1.0").zeros(200).done();
  assertThrows(() => readSpl("x", cre), Error, "not a SPL file");
});

// --- KEY ------------------------------------------------------------------

/**
 * One biff, one resource, with the locator fields given explicitly.
 *
 * Note the header runs to 0x18, not 0x14: IESDP labels it "Header (20 bytes)"
 * but the last field *starts* at 0x14 and is four bytes wide, so entries begin
 * at 24. Writing the fixture from the label produced a file whose declared
 * offsets pointed into its own header.
 */
const KEY_HEADER = 24;

function keyFixture(biffIndex: number, tileset: number, fileIndex: number): Uint8Array {
  const BIFFS_AT = KEY_HEADER;
  const RESOURCES_AT = BIFFS_AT + 12;
  const NAME_AT = RESOURCES_AT + 14;
  const name = "data/Spells.bif";
  const locator = (biffIndex << 20) | (tileset << 14) | fileIndex;
  return new Bytes()
    .ascii("KEY ").ascii("V1  ")
    .u32(1) // biff entry count
    .u32(1) // resource entry count
    .u32(BIFFS_AT)
    .u32(RESOURCES_AT)
    // biff entry, 12 bytes
    .u32(0) // file length, unused here
    .u32(NAME_AT) // offset to filename
    .u16(name.length + 1) // length including NUL
    .u16(0) // location bitfield
    // resource entry, 14 bytes
    .ascii("SPWI212", 8)
    .u16(0x03ee) // SPL
    .u32(locator)
    .at(NAME_AT).ascii(name).u32(0)
    .done();
}

/** Where the biff path lands in the fixture above, for the rewrite test. */
const KEY_NAME_AT = KEY_HEADER + 12 + 14;

Deno.test("the KEY locator splits into biff, tileset and file index", () => {
  // The whole point of this test: all three live in one 32-bit field, and
  // reading it as a plain integer yields a biff number that is merely wrong
  // rather than obviously broken.
  const { biffs, entries } = readKey(keyFixture(3, 17, 1234));
  assertEquals(biffs, ["data/Spells.bif"]);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].resref, "SPWI212");
  assertEquals(entries[0].type, 0x03ee);
  assertEquals(entries[0].biff, 3, "bits 31-20");
  assertEquals(entries[0].fileIndex, 1234, "bits 13-0");
});

Deno.test("a tileset index does not leak into the file index", () => {
  // 0x3fff masking matters: a nonzero tileset index sits directly above the
  // file index, so a 16-bit mask would fold part of it in.
  assertEquals(readKey(keyFixture(0, 63, 0)).entries[0].fileIndex, 0);
  assertEquals(readKey(keyFixture(0, 63, 16383)).entries[0].fileIndex, 16383);
});

Deno.test("a biff path has its NUL stripped and separators normalized", () => {
  // KEY records Windows separators; everything downstream joins with "/".
  const bytes = keyFixture(0, 0, 0);
  // Overwrite "data/Spells.bif" with a backslash form of the same length.
  const win = "data\\Spells.bif";
  for (let i = 0; i < win.length; i++) bytes[KEY_NAME_AT + i] = win.charCodeAt(i);
  assertEquals(readKey(bytes).biffs, ["data/Spells.bif"]);
});

// --- BIF ------------------------------------------------------------------

Deno.test("a biff header gives the file count and table offset", () => {
  const header = new Bytes()
    .ascii("BIFF").ascii("V1  ")
    .u32(7) // file entry count
    .u32(0) // tileset count
    .u32(4096) // file entries offset - deliberately not right after the header
    .done();
  assertEquals(readBiffHeader(header), { fileCount: 7, entriesAt: 4096 });
  assertEquals(header.length, BIFF_HEADER_SIZE);
});

Deno.test("biff entries are matched by locator, not by array position", () => {
  // The bug this guards: indexing the array directly works for archives whose
  // entries happen to be in locator order, and silently returns a different
  // resource for the rest.
  const table = new Bytes()
    .u32(9).u32(1000).u32(50).u16(0x03ee).u16(0) // fileIndex 9
    .u32(4).u32(2000).u32(60).u16(0x03ee).u16(0) // fileIndex 4
    .done();
  const entries = readBiffEntries(table, 2);
  assertEquals(entries.length, 2);
  assertEquals(entries.map((e) => e.fileIndex), [9, 4], "stored out of order");
  assertEquals(entries.find((e) => e.fileIndex === 4)?.offset, 2000);
  assertEquals(table.length, 2 * BIFF_ENTRY_SIZE);
});

Deno.test("a truncated biff table stops rather than reading past the end", () => {
  // The real failure that made every biffed spell come back null: a fixed-size
  // read cut the table short, and the loop must not invent entries from the
  // bytes that follow.
  const oneEntry = new Bytes().u32(1).u32(10).u32(20).u16(0x03ee).u16(0).done();
  assertEquals(readBiffEntries(oneEntry, 5).length, 1);
});

// --- TLK ------------------------------------------------------------------

/** Two strings, so the relative-offset rule is actually exercised. */
function tlkFixture(): Uint8Array {
  const STRINGS_AT = 18 + 26 * 2;
  return new Bytes()
    .ascii("TLK ").ascii("V1  ")
    .u16(0) // language id
    .u32(2) // string count
    .u32(STRINGS_AT)
    // entry 0
    .u16(1).ascii("", 8).u32(0).u32(0).u32(0).u32(5)
    // entry 1 - offset 5, relative to the strings section
    .u16(1).ascii("", 8).u32(0).u32(0).u32(5).u32(5)
    .at(STRINGS_AT).ascii("HelloWorld")
    .done();
}

Deno.test("TLK string offsets are relative to the strings section", () => {
  // Read as absolute file offsets these would land in the middle of the index
  // and return binary garbage that still decodes as a string.
  const tlk = new Tlk(tlkFixture());
  assertEquals(tlk.count, 2);
  assertEquals(tlk.get(0), "Hello");
  assertEquals(tlk.get(1), "World");
});

Deno.test("an out-of-range or empty strref is null, not an error", () => {
  const tlk = new Tlk(tlkFixture());
  // -1 as unsigned is the engine's own "no string" value and is everywhere in
  // the game files - 520 spells in this install carry it by design.
  assertEquals(tlk.get(0xffffffff), null);
  assertEquals(tlk.get(2), null);
  assertEquals(tlk.get(-1), null);
});

// --- SPL ------------------------------------------------------------------

/**
 * A spell with `abilities` extended headers all pointing at the same feature
 * block, which is how the engine expresses one effect scaling over levels.
 */
function splFixture(abilities: number): Uint8Array {
  const HEADER = 114;
  const ABILITY_AT = HEADER;
  const FEATURE_AT = ABILITY_AT + abilities * 40;

  const b = new Bytes()
    .ascii("SPL ").ascii("V1  ")
    .u32(12018) // unidentified name strref
    .u32(12018) // identified name strref
    .at(0x1c).u16(1) // spell type: wizard
    .at(0x25).ascii("") // primary type: illusionist
    .at(0x34).u32(2) // spell level
    .at(0x64).u32(ABILITY_AT).u16(abilities)
    .u32(FEATURE_AT) // feature block table offset
    .u16(0).u16(0) // no casting-level feature blocks
    .at(ABILITY_AT);

  for (let i = 0; i < abilities; i++) {
    // Each ability claims one feature block at index 0 of the table.
    b.at(ABILITY_AT + i * 40).at(ABILITY_AT + i * 40 + 0x1e).u16(1).u16(0);
  }

  // One feature block: opcode 12, dispelResist 3.
  b.at(FEATURE_AT)
    .u16(12).u16(0) // opcode, target+power
    .u32(0).u32(0) // param1, param2
    .u16(0x0301) // timing 1, dispelResist 3
    .u32(0).u16(0) // duration, probability
    .ascii("", 8) // resource
    .zeros(20);
  return b.done();
}

Deno.test("SPL features are reached through the table index, not a byte offset", () => {
  const spell = readSpl("spwi212", splFixture(1));
  assertEquals(spell.nameStrref, 12018);
  assertEquals(spell.type, "wizard");
  assertEquals(spell.school, "illusionist");
  assertEquals(spell.level, 2);
  assertEquals(spell.features.length, 1);
  assertEquals(spell.features[0].opcode, 12);
});

Deno.test("repeated feature blocks across abilities collapse to one effect", () => {
  // Real Mirror Image has 18 abilities over 5 blocks. Flattening naively
  // reported 55 effects for a spell that has 5, which inflated every count
  // downstream without looking obviously wrong.
  const spell = readSpl("spwi212", splFixture(18));
  assertEquals(spell.abilityCount, 18);
  assertEquals(spell.featureReads, 18, "read once per ability");
  assertEquals(spell.features.length, 1, "deduplicated to the one distinct effect");
});

Deno.test("the dispel bit is separated from the resistance bit", () => {
  // dispelResist is a 2-bit field: bit 0 is "a dispel removes this", bit 1 is
  // "ignores magic resistance". Treating the value as a boolean makes 2
  // (ignores resistance, NOT dispellable) read as dispellable.
  const spell = readSpl("x", splFixture(1));
  assertEquals(spell.features[0].dispelResist, 3);
  assertEquals(spell.features[0].dispellable, true);
});

// --- CRE ------------------------------------------------------------------

/**
 * A creature with negative AC and a negative save, because those are the
 * normal case in BG2 and the bytes are signed.
 */
function creFixture(): Uint8Array {
  const b = new Bytes()
    .ascii("CRE ").ascii("V1.0")
    .u32(12345) // long name strref
    .u32(12346) // short name strref
    .at(0x14).u32(2000) // XP for killing
    .at(0x24).u16(58).u16(64) // current / max HP
    .at(0x46).u16(0xfffc) // AC natural: -4
    .at(0x48).u16(0xfffe) // AC effective: -2
    .at(0x52).ascii("") // THAC0 placeholder, overwritten below
    .at(0x300).done();

  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  dv.setUint8(0x52, 5); // THAC0
  dv.setUint8(0x53, 3); // attacks
  // Saves: death -1, then 2, 3, 4, 5.
  [-1, 2, 3, 4, 5].forEach((v, i) => dv.setInt8(0x54 + i, v));
  // Resistances: fire 100, cold 0, ... magic 50 at index 4.
  [100, 0, 0, 0, 50, 0, 0, 10, 10, 10, 0].forEach((v, i) => dv.setInt8(0x59 + i, v));
  dv.setUint8(0x234, 12); // level 1
  dv.setUint8(0x272, 7); // race
  dv.setUint8(0x273, 9); // class
  return b;
}

Deno.test("a creature's name strrefs and stats are read", () => {
  const cre = readCre("wyvernsu", creFixture());
  assertEquals(cre.nameStrref, 12345);
  assertEquals(cre.shortNameStrref, 12346);
  assertEquals(cre.xpForKilling, 2000);
  assertEquals([cre.currentHp, cre.maxHp], [58, 64]);
  assertEquals(cre.thac0, 5);
  assertEquals(cre.attacks, 3);
  assertEquals(cre.levels[0], 12);
  assertEquals([cre.race, cre.class], [7, 9]);
});

Deno.test("negative AC and saves survive as negative", () => {
  // Signed single bytes and signed words. Read unsigned, an AC of -4 becomes
  // 252 and a save of -1 becomes 255 - both plausible-looking and both wrong.
  const cre = readCre("x", creFixture());
  assertEquals(cre.acNatural, -4);
  assertEquals(cre.acEffective, -2);
  assertEquals(cre.saves.death, -1);
  assertEquals(cre.saves.wands, 2);
});

Deno.test("resistances are named in file order", () => {
  // A fixed run of eleven bytes with nothing identifying them, so the order is
  // the only thing that makes them meaningful.
  const cre = readCre("x", creFixture());
  assertEquals(cre.resistances.fire, 100);
  assertEquals(cre.resistances.magic, 50);
  assertEquals(cre.resistances.slashing, 10);
  assertEquals(cre.resistances.missile, 0);
});
