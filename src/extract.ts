/**
 * Read spell data out of the installed game files.
 *
 *   deno task extract
 *
 * `src/protections.ts` is the one file in this project whose contents are not
 * derived from captured data, and it has already produced two real bugs. The
 * game ships the authoritative version: spell semantics are fields in `.SPL`
 * files, not a matter of opinion. This reads them.
 *
 * Nothing it produces is committed. Output goes to the `spells` table in
 * `events.db`, which is gitignored — `dialog.tlk` is copyrighted and this repo
 * is public.
 *
 * Runs in three stages, in this order for a reason:
 *
 *   1. **Validate the readers.** `spell.ids` names every spell independently of
 *      `dialog.tlk`, so if every offset is right the two agree. Reported as a
 *      match rate, because a wrong offset yields plausible numbers rather than
 *      an error and this is the only thing that catches it.
 *   2. **Calibrate.** The 71 hand-written entries are treated as labels: read
 *      their opcodes and find which ones separate the categories.
 *   3. **Apply and report disagreements**, so a misread opcode surfaces instead
 *      of silently overwriting good data.
 */
import { DB_PATH, DIALOG_TLK, GAME_DIR, OVERRIDE_DIR } from "./config.ts";
import { makeSpellWriter, openDb } from "./db.ts";
import { type Feature, readCre, readSpl, type Spell, Tlk } from "./iebinary.ts";
import {
  Biffs,
  Override,
  parseSpellIds,
  resolve,
  type SpellId,
  symbolMatchesName,
} from "./resources.ts";
import { handWritten } from "./protections.ts";
import {
  classifySpell,
  crossValidate,
  deriveVotes,
  type Labeled,
  mergeCategory,
  NON_SEMANTIC_OPCODES,
  semanticOpcodes,
  stripsFromFeatures,
} from "./opcodes.ts";

/** A spell with its display name resolved. */
interface Named {
  spell: Spell;
  name: string | null;
  symbol: string | null;
  /** "override" or the archive it came out of. Stored for provenance. */
  source: string;
}

function pct(n: number, of: number): string {
  return of === 0 ? "n/a" : `${((n / of) * 100).toFixed(1)}%`;
}

/**
 * Preference among spells sharing a display name, by resource prefix.
 *
 * Spellbook spells first, then creature innates, then class abilities, then
 * mod-internal resrefs. Needed because effect count is noisy in both
 * directions: a creature's innate Haste carries 73 effects against the real
 * `spwi305`'s 69, and ranking on count alone made the innate win. The name a
 * log line shows is nearly always a spellbook spell being cast.
 */
function classRank(resref: string): number {
  if (/^(spwi|sppr)/.test(resref)) return 0;
  if (/^spin/.test(resref)) return 1;
  if (/^spcl/.test(resref)) return 2;
  return 3;
}

/** "Display string" — param1 is a strref, and that string is what the log prints. */
const OP_DISPLAY_STRING = 139;

/**
 * Is this spell's state removable by Dispel Magic?
 *
 * "Any effect has the dispel bit" is the obvious reading and it is wrong. A
 * spell's incidentals — the portrait icon (142), the sound (174), a chained
 * `Cast spell` (146) — routinely carry dispelResist=3 while the effect doing
 * the actual work carries 2. True Sight is the clear case: its removal effects
 * (220, 221, 116) are all 2, but ten copies of opcode 146 are 3, so "any"
 * reports it dispellable and "most" agrees with them.
 *
 * For a removal spell the question has no answer worth giving — a dispel is an
 * event, not state, so there is nothing on the creature to remove later. Those
 * are excluded rather than guessed at, which is what the two True Sight
 * disagreements turned out to be.
 */
function dispellableFromFile(spell: Spell, category: string): boolean | null {
  if (category === "dispel") return null;
  const real = spell.features.filter((f) => !NON_SEMANTIC_OPCODES.has(f.opcode));
  if (real.length === 0) return null;
  return real.some((f) => f.dispellable);
}

async function main() {
  // --- load -------------------------------------------------------------
  let tlk: Tlk;
  try {
    tlk = new Tlk(await Deno.readFile(DIALOG_TLK));
  } catch (e) {
    console.error(`Could not read ${DIALOG_TLK}`);
    console.error(`  ${e instanceof Error ? e.message : e}`);
    console.error(`\nSet BG2EE_GAME_DIR if the game is not at:\n  ${GAME_DIR}`);
    Deno.exit(1);
  }

  const override = await Override.load();
  if (override.size === 0) {
    console.error(`No loose resources found in ${OVERRIDE_DIR}`);
    Deno.exit(1);
  }

  let ids: SpellId[] = [];
  const idsBytes = await override.read("spell", "ids");
  if (idsBytes !== null) ids = parseSpellIds(new TextDecoder().decode(idsBytes));

  console.log(`dialog.tlk       ${tlk.count} strings`);
  console.log(`override/        ${override.size} loose files`);
  console.log(`spell.ids        ${ids.length} spells\n`);

  // Biffed resources. Absent is survivable — everything below still works off
  // whatever `override/` holds, it just covers less.
  let biffs: Biffs | null = null;
  try {
    biffs = await Biffs.load();
    console.log(`chitin.key       ${biffs.size} resources across ${biffs.archiveCount} archives`);
    console.log(`                 ${biffs.list("spl").length} of them spells`);
  } catch (e) {
    console.log(`chitin.key       unreadable (${e instanceof Error ? e.message : e})`);
  }
  console.log();

  // --- read every spell we can reach ------------------------------------
  //
  // Override first, then anything the archives hold that override/ did not, so
  // the mod-patched version of a spell always wins.
  const bySymbol = new Map(ids.map((i) => [i.resref, i.symbol]));
  const resrefs = [...new Set([
    ...override.list("spl"),
    ...(biffs === null ? [] : biffs.list("spl")),
  ])].sort();

  const named: Named[] = [];
  const unreadable: string[] = [];
  let fromOverride = 0;
  let fromBiff = 0;

  for (const resref of resrefs) {
    const found = await resolve(override, resref, "spl", biffs ?? undefined);
    if (found === null) continue;
    try {
      const spell = readSpl(resref, found.bytes);
      named.push({
        spell,
        name: tlk.get(spell.nameStrref),
        symbol: bySymbol.get(resref) ?? null,
        source: found.source,
      });
      if (found.source === "override") fromOverride++;
      else fromBiff++;
    } catch {
      unreadable.push(resref);
    }
  }

  const missing = ids.filter((i) => !named.some((n) => n.spell.resref === i.resref));

  console.log(
    `read ${named.length} spells: ${fromOverride} from override/, ${fromBiff} from archives` +
      (unreadable.length > 0 ? `, ${unreadable.length} unreadable` : ""),
  );
  if (missing.length === 0) {
    console.log(`every spell.ids entry accounted for`);
  } else {
    // Not a gap in the readers: `spell.ids` is the engine's symbol table and
    // lists entries for spells this install does not ship, so these are absent
    // from chitin.key too. Distinguished from "could not read it", which would
    // be a bug.
    const indexed = biffs === null
      ? 0
      : missing.filter((m) => biffs!.has(m.resref, "spl")).length;
    console.log(
      `${missing.length} spell.ids entries unread — ${missing.length - indexed} are not in ` +
        `chitin.key either, so this install does not have them` +
        (indexed > 0 ? `; ${indexed} ARE indexed and failed to read, which is a bug` : ""),
    );
  }
  console.log();

  // --- stage 1: does the chain prove itself? ----------------------------
  //
  // Only the spells that spell.ids names can be checked, since the symbol is
  // the independent witness. That is 881 of them here, which is plenty.
  // A spell carrying strref -1 has no display name by design — creature
  // innates, cutscene helpers, visual effects. Counting those as failures to
  // resolve made the rate look like a regression when archive reading was added
  // (98.9% to 78.7%) while nothing had actually got worse: the population had
  // changed. They are excluded from the denominator, and counted separately so
  // the exclusion is visible rather than quietly shrinking the divisor.
  const NAMELESS = 0xffffffff;
  const claimsName = named.filter((n) => n.symbol !== null && n.spell.nameStrref !== NAMELESS);
  const nameless = named.filter((n) => n.symbol !== null && n.spell.nameStrref === NAMELESS);
  const resolved = claimsName.filter((n) => n.name !== null);
  const agree = resolved.filter((n) => symbolMatchesName(n.symbol!, n.name!));

  console.log(`--- reader validation ---`);
  console.log(
    `  named by spell.ids             : ${claimsName.length + nameless.length}` +
      `  (${nameless.length} carry strref -1, no display name by design)`,
  );
  console.log(`  name strref resolved in tlk    : ${resolved.length}  ${
    pct(resolved.length, claimsName.length)
  }`);
  console.log(`  symbol agrees with display name: ${agree.length}  ${
    pct(agree.length, resolved.length)
  }`);

  if (resolved.length === 0 || agree.length / resolved.length < 0.5) {
    console.error(
      `\nFAIL: the offsets are wrong. A correct chain agrees on almost every\n` +
        `spell; this does not. Do not trust anything downstream of here.`,
    );
    for (const n of resolved.slice(0, 10)) {
      console.error(`  ${n.spell.resref}  ${n.symbol}  ->  ${JSON.stringify(n.name)}`);
    }
    Deno.exit(1);
  }

  // Split by whether the engine's own symbol table names the spell. Unnamed
  // internals — cutscene helpers, auto-hit effects — carry strref -1 by design
  // and must not be counted as failures to resolve.
  const fromArchive = named.filter((n) => n.source !== "override");
  const archiveNamed = fromArchive.filter((n) => n.symbol !== null);
  const NO_STRING = 0xffffffff;
  console.log(
    `\n  from archives: ${fromArchive.length} spells, ${archiveNamed.length} named by spell.ids, ` +
      `${fromArchive.filter((n) => n.spell.nameStrref === NO_STRING).length} carry strref -1`,
  );
  console.log(`  archive spells that spell.ids names:`);
  for (const n of archiveNamed.slice(0, 8)) {
    console.log(
      `    ${n.spell.resref.padEnd(10)} strref=${n.spell.nameStrref}` +
        `  ${n.symbol}  -> ${JSON.stringify(n.name)}`,
    );
  }

  // Every archive spell reading strref -1 is either a genuine property of
  // what is left in the biffs, or a bug in the KEY/BIF locator arithmetic
  // producing valid-looking SPL files from the wrong offsets. A resref present
  // in *both* places settles it: the override copy is known good, so if the
  // biffed copy of the same spell parses to the same name the readers agree,
  // and if it does not the archive path is wrong.
  if (biffs !== null) {
    console.log(`\n  same spell read both ways (override is known good):`);
    for (const resref of ["spwi212", "spwi611", "spwi701", "sppr505"]) {
      if (!biffs.has(resref, "spl")) {
        console.log(`    ${resref.padEnd(10)} not in chitin.key, cannot compare`);
        continue;
      }
      const raw = await biffs.read(resref, "spl");
      let archive = "unreadable";
      if (raw !== null) {
        try {
          const spell = readSpl(resref, raw);
          archive = `strref=${spell.nameStrref} ${JSON.stringify(tlk.get(spell.nameStrref))}`;
        } catch (e) {
          archive = `parse failed: ${e instanceof Error ? e.message : e}`;
        }
      }
      const loose = named.find((n) => n.spell.resref === resref);
      console.log(
        `    ${resref.padEnd(10)} override: strref=${loose?.spell.nameStrref} ` +
          `${JSON.stringify(loose?.name ?? null)}\n` +
          `    ${" ".repeat(10)} archive:  ${archive}`,
      );
    }
  }

  console.log(`\n  samples:`);
  for (const want of ["spwi212", "sppr505", "spwi611", "spwi701"]) {
    const hit = named.find((n) => n.spell.resref === want);
    console.log(
      `    ${want}  ${JSON.stringify(hit?.name ?? null)}` +
        `  level ${hit?.spell.level}  ${hit?.spell.type}/${hit?.spell.school}` +
        `  ${hit?.spell.features.length ?? 0} effects` +
        `  (${hit?.spell.abilityCount} abilities, ${hit?.spell.featureReads} reads)`,
    );
  }

  const disagree = resolved.filter((n) => !symbolMatchesName(n.symbol!, n.name!));
  if (disagree.length > 0) {
    console.log(`\n  ${disagree.length} disagree (mod renames, or a bad offset):`);
    for (const n of disagree.slice(0, 12)) {
      console.log(`    ${n.spell.resref}  ${n.symbol}  ->  ${JSON.stringify(n.name)}`);
    }
  }

  // --- stage 2: what do the known protections actually contain? ---------
  //
  // Diagnostics only at this point. The mapping is derived from this, so it is
  // printed before anything depends on it.
  // Display names are not unique, so this is a one-to-many index. "Breach"
  // exists as both a wizard spell and a creature innate; picking by resref sort
  // order chose the innate, which carries no mechanics at all — 2 effects
  // against the real spell's list. The log shows only the name, so the player
  // cannot tell them apart either; what the table needs is whichever resref
  // actually implements the thing.
  const byName = new Map<string, Named[]>();
  for (const n of named) {
    if (n.name === null) continue;
    const key = n.name.toLowerCase().replace(/\s+/g, " ").trim();
    const list = byName.get(key);
    if (list === undefined) byName.set(key, [n]);
    else list.push(n);
  }

  /**
   * Pick the resref that best represents a display name.
   *
   * Being named by `spell.ids` comes first. That file is the game's own
   * registry of castable spells, so a resref in it is the real thing while one
   * that is not is a creature innate, a contingency wrapper or a mod's internal
   * helper. Ranking by effect count instead chose `spdm102` over `spwi201` for
   * Blur — more effects, but not the spell anyone casts.
   *
   * Effect count then breaks ties among canonical entries, which is what
   * separates a real implementation from a stub: "Breach" exists as a wizard
   * spell and as an innate carrying no mechanics at all.
   */
  const best = (list: Named[]): Named =>
    [...list].sort((a, b) =>
      Number(b.symbol !== null) - Number(a.symbol !== null) ||
      classRank(a.spell.resref) - classRank(b.spell.resref) ||
      b.spell.features.length - a.spell.features.length ||
      a.spell.resref.localeCompare(b.spell.resref)
    )[0];

  console.log(`\n--- calibration: the 71 hand-written entries ---`);
  const table = handWritten();
  const matched: Array<{
    label: string;
    category: string;
    spell: Spell;
    /**
     * How the entry was tied to a spell, which is how much the tie is worth.
     * A name match is strong. An effect-text match is weaker, because many
     * unrelated things print the same message: "Diseased" comes from a spell
     * and from a shadow's touch, and those do not agree on dispellability.
     */
    how: "name" | "effect";
    /** Named by spell.ids, so a real castable spell rather than an internal. */
    canonical: boolean;
  }> = [];
  const unmatched: string[] = [];

  // Effect text -> spell, built from opcode 139's strref. Needed because the
  // hand table is keyed on whatever the log printed, and for some entries that
  // is the landed-effect message rather than the spell's name: nothing is
  // called "Spell Protections Removed" or "Stunned", but spells say so when
  // they take hold. Name lookup misses all of those.
  const byEffectText = new Map<string, Named[]>();
  for (const n of named) {
    for (const f of n.spell.features) {
      if (f.opcode !== OP_DISPLAY_STRING) continue;
      const text = tlk.get(f.param1);
      if (text === null) continue;
      const key = text.toLowerCase().replace(/\s+/g, " ").trim();
      // The cast announcement is not a landed effect, and indexing it would
      // make "Casting Stoneskin..." look like a state a creature is in.
      if (key === "" || key.startsWith("casting ")) continue;
      const list = byEffectText.get(key);
      if (list === undefined) byEffectText.set(key, [n]);
      else if (!list.includes(n)) list.push(n);
    }
  }

  const ambiguous: string[] = [];
  const viaEffect: string[] = [];
  const probeOnly = table.filter((e) => e.probeOnly).map((e) => e.name);
  for (const e of table) {
    // Probe pseudo-entries describe an observed creature property rather than a
    // spell, so matching them against the files invents disagreements. See the
    // `probeOnly` note in protections.ts.
    if (e.probeOnly) continue;
    const key = e.name.toLowerCase().replace(/\s+/g, " ").trim();
    // Try the spell's own name, then the effect message it prints, then the
    // hand-written `effect` alias if there is one.
    const effectKey = e.effect?.toLowerCase().replace(/\s+/g, " ").trim();
    const list = byName.get(key) ??
      byEffectText.get(key) ??
      (effectKey === undefined ? undefined : byEffectText.get(effectKey));
    if (list === undefined) {
      unmatched.push(e.name);
      continue;
    }
    const how = byName.has(key) ? "name" as const : "effect" as const;
    if (how === "effect") viaEffect.push(e.name);
    const hit = best(list);
    matched.push({
      label: e.name,
      category: e.category,
      spell: hit.spell,
      how,
      canonical: hit.symbol !== null,
    });
    if (list.length > 1) {
      ambiguous.push(
        `${e.name}: ${list.length} resrefs, chose ${hit.spell.resref} ` +
          `(${list.map((n) => `${n.spell.resref}/${n.spell.features.length}`).join(" ")})`,
      );
    }
  }

  console.log(`  matched to a spell : ${matched.length}/${table.length - probeOnly.length}`);
  console.log(`  probe-only, skipped: ${probeOnly.join(", ")}`);
  console.log(`  effect-text index   ${byEffectText.size} distinct landed-effect messages`);
  if (viaEffect.length > 0) {
    console.log(`  matched by effect  : ${viaEffect.join(", ")}`);
  }
  if (unmatched.length > 0) {
    console.log(`  no spell found     : ${unmatched.join(", ")}`);
  }
  if (ambiguous.length > 0) {
    console.log(`\n  names shared by several resrefs (resref/effect-count):`);
    for (const a of ambiguous) console.log(`    ${a}`);
  }

  // Which opcodes appear under each label. This is the raw material for the
  // opcode mapping, so it is shown rather than summarised.
  const byCategory = new Map<string, Map<number, number>>();
  for (const m of matched) {
    const counts = byCategory.get(m.category) ?? new Map<number, number>();
    for (const op of new Set(m.spell.features.map((f: Feature) => f.opcode))) {
      counts.set(op, (counts.get(op) ?? 0) + 1);
    }
    byCategory.set(m.category, counts);
  }

  for (const [category, counts] of [...byCategory].sort()) {
    const total = matched.filter((m) => m.category === category).length;
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12);
    console.log(`\n  ${category} (${total} spells) — opcode: seen in n`);
    console.log(`    ${top.map(([op, n]) => `${op}:${n}`).join("  ")}`);
  }

  // Opcode alone does not separate the removal classes: 221 and 240 appear in
  // both Spell Thrust (strips spell protections) and Breach (strips combat
  // protections). Whatever distinguishes them has to be in the parameters, so
  // print those rather than guessing.
  console.log(`\n--- removal spells: every non-cosmetic effect, with parameters ---`);
  for (const m of matched.filter((x) => x.category === "dispel")) {
    console.log(`\n  ${m.label}  (${m.spell.resref})`);
    for (const f of m.spell.features) {
      if (NON_SEMANTIC_OPCODES.has(f.opcode)) continue;
      const res = f.resource === "" ? "" : `  resource=${f.resource}`;
      console.log(
        `    op ${String(f.opcode).padStart(3)}  p1=${String(f.param1).padStart(6)}` +
          `  p2=${String(f.param2).padStart(6)}  timing=${f.timing}${res}`,
      );
    }
  }

  // Opcode 139's param1 is a strref, so this is the effect text the log prints.
  // Building this map mechanically is the point of the whole exercise: today
  // those strings are hand-written in protections.ts and only discovered by
  // noticing an untagged card.
  console.log(`\n--- effect messages, resolved from opcode 139 ---`);
  for (const m of matched.slice(0, 18)) {
    const strings = m.spell.features
      .filter((f: Feature) => f.opcode === OP_DISPLAY_STRING)
      .map((f: Feature) => tlk.get(f.param1))
      .filter((s): s is string => s !== null && s.trim() !== "");
    if (strings.length > 0) {
      console.log(`  ${m.label.padEnd(34)} -> ${[...new Set(strings)].join(" | ")}`);
    }
  }

  console.log(`\n--- dispellable, file vs hand ---`);
  let same = 0;
  const differ: Array<{ label: string; spell: Spell; hand: boolean; weak: boolean }> = [];
  let notApplicable = 0;
  for (const m of matched) {
    const hand = table.find((e) => e.name === m.label)!;
    const fromFile = dispellableFromFile(m.spell, m.category);
    if (fromFile === null) notApplicable++;
    else if (fromFile === hand.dispellable) same++;
    else {
      differ.push({
        label: m.label,
        spell: m.spell,
        hand: hand.dispellable,
        weak: m.how === "effect" || !m.canonical,
      });
    }
  }
  console.log(
    `  agree: ${same}/${matched.length - notApplicable}` +
      `  (${notApplicable} removal spells excluded — a dispel leaves no state to remove)`,
  );

  // Judge each disagreement rather than accepting the file. "Any effect" is a
  // suspect aggregation: a protection whose core effect resists dispelling can
  // still carry a dispellable portrait icon, and that would flip the answer for
  // the wrong reason. Print the parts so the aggregation can be chosen on
  // evidence.
  for (const d of differ) {
    const parts = d.spell.features
      .filter((f: Feature) => !NON_SEMANTIC_OPCODES.has(f.opcode))
      .map((f: Feature) => `${f.opcode}:${f.dispelResist}`);
    const tally = new Map<string, number>();
    for (const p of parts) tally.set(p, (tally.get(p) ?? 0) + 1);
    console.log(
      `\n    ${d.label}  (${d.spell.resref})  hand=${d.hand}` +
        (d.weak
          ? `  [WEAK MATCH — tied by effect text or to a non-canonical resref,\n` +
            `       so this is one source of that message, not necessarily the one\n` +
            `       the hand entry meant. Do not overwrite on this alone.]`
          : `  [strong match]`) +
        `\n      non-cosmetic opcode:dispelResist -> ${
          [...tally].map(([k, n]) => (n > 1 ? `${k}x${n}` : k)).join("  ")
        }`,
    );
  }

  // --- stage 3: learn the category mapping and check it generalizes -----
  const labeled: Labeled[] = matched.map((m) => ({
    label: m.label,
    category: m.category,
    opcodes: semanticOpcodes(m.spell.features.map((f: Feature) => f.opcode)),
  }));

  const votes = deriveVotes(labeled);
  console.log(`\n--- category mapping, learned from the labels ---`);
  console.log(`  ${votes.size} opcodes carry usable signal, of ${
    new Set(labeled.flatMap((l) => l.opcodes)).size
  } seen`);

  const byVoteCategory = new Map<string, Array<[number, number]>>();
  for (const [op, v] of votes) {
    const list = byVoteCategory.get(v.category) ?? [];
    list.push([op, v.purity]);
    byVoteCategory.set(v.category, list);
  }
  for (const [category, list] of [...byVoteCategory].sort()) {
    const top = list.sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([op, p]) => `${op}(${p.toFixed(2)})`);
    console.log(`    ${category.padEnd(11)} ${top.join(" ")}`);
  }

  // Which opcodes land in more than one category. An opcode shared between two
  // labels means those two labels are not distinguishable by that mechanic, and
  // if that happens a lot the scheme is the problem rather than the classifier.
  const opCategories = new Map<number, Set<string>>();
  for (const l of labeled) {
    for (const op of new Set(l.opcodes)) {
      const set = opCategories.get(op) ?? new Set<string>();
      set.add(l.category);
      opCategories.set(op, set);
    }
  }
  const pairShared = new Map<string, number[]>();
  for (const [op, cats] of opCategories) {
    if (cats.size !== 2) continue;
    const key = [...cats].sort().join(" / ");
    const list = pairShared.get(key) ?? [];
    list.push(op);
    pairShared.set(key, list);
  }
  console.log(`\n  opcodes appearing under exactly two labels:`);
  for (const [pair, ops] of [...pairShared].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${pair.padEnd(24)} ${ops.length} opcodes: ${ops.sort((a, b) => a - b).join(",")}`);
  }

  const cv = crossValidate(labeled);
  console.log(`\n  leave-one-out: ${cv.correct} correct, ${cv.mistakes.length} wrong, ` +
    `${cv.abstained} abstained, of ${cv.tested}`);
  console.log(
    `  accuracy where it committed: ${pct(cv.correct, cv.correct + cv.mistakes.length)}`,
  );
  for (const m of cv.mistakes) {
    console.log(
      `    ${m.label.padEnd(30)} expected ${m.expected}, got ${m.got} ` +
        `(confidence ${m.confidence.toFixed(2)})`,
    );
  }

  // Test the hypothesis the mistakes suggest: that protection and buff are one
  // class as far as the engine is concerned, and the split is a player-facing
  // judgment with nothing in the files behind it. If merging them fixes the
  // accuracy, the scheme was at fault and not the derivation.
  const mergedCv = crossValidate(
    labeled.map((l) => ({
      ...l,
      category: l.category === "buff" || l.category === "protection" ? "helps-them" : l.category,
    })),
  );
  console.log(
    `\n  same test with protection and buff merged: ${mergedCv.correct} correct, ` +
      `${mergedCv.mistakes.length} wrong, ${mergedCv.abstained} abstained`,
  );
  console.log(
    `  accuracy where it committed: ${
      pct(mergedCv.correct, mergedCv.correct + mergedCv.mistakes.length)
    }`,
  );
  for (const m of mergedCv.mistakes) {
    console.log(
      `    ${m.label.padEnd(30)} expected ${m.expected}, got ${m.got} ` +
        `(confidence ${m.confidence.toFixed(2)})`,
    );
  }

  // --- stage 4: apply and store -----------------------------------------
  //
  // Trained on the merged labels, because that is the distinction the files can
  // actually support. Hand-written entries keep `protection`/`buff`; `hydrate()`
  // never displaces them.
  const mergedVotes = deriveVotes(
    labeled.map((l) => ({ ...l, category: mergeCategory(l.category) })),
  );

  const summons = await resolveSummons(named, tlk, override, biffs);
  reportSummons(named, summons);

  const db = openDb();
  const spells = makeSpellWriter(db);
  spells.clear();

  let classified = 0;
  let abstained = 0;
  const spread = new Map<string, number>();

  for (const n of named) {
    const features = n.spell.features;
    const got = classifySpell(semanticOpcodes(features.map((f: Feature) => f.opcode)), mergedVotes);
    const strips = stripsFromFeatures(features);
    // A spell that strips is a removal event, whatever the opcode vote says.
    const category = strips !== null ? "dispel" : got?.category ?? null;

    if (category === null) abstained++;
    else {
      classified++;
      spread.set(category, (spread.get(category) ?? 0) + 1);
    }

    const effectText = [...new Set(
      features
        .filter((f: Feature) => f.opcode === OP_DISPLAY_STRING)
        .map((f: Feature) => tlk.get(f.param1))
        .filter((s): s is string =>
          s !== null && s.trim() !== "" && !s.toLowerCase().startsWith("casting ")
        ),
    )];

    spells.insert({
      resref: n.spell.resref,
      symbol: n.symbol,
      name: n.name,
      level: n.spell.level,
      type: n.spell.type,
      school: n.spell.school,
      category,
      confidence: got?.confidence ?? null,
      dispellable: category === null ? null : dispellableFromFile(n.spell, category),
      strips,
      effectText,
      summons: summons.get(n.spell.resref) ?? [],
      source: n.source,
    });
  }
  db.close();

  console.log(`\n  applied to all ${named.length} spells: ${classified} classified, ` +
    `${abstained} left unknown`);
  console.log(`    ${
    [...spread].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join("  ")
  }`);
  console.log(`\n  wrote ${named.length} rows to the spells table in ${DB_PATH}`);

  reportEncoding(tlk);
}

/**
 * Which creature, if any, each spell summons — by display name.
 *
 * The opcode is not the discriminator and must not be used as one. Opcode 177
 * is "use this resource", and Dispel Magic uses it too; what makes a feature a
 * summon is that its resource resolves to a `.CRE`. Derived that way rather
 * than asserted, and it self-validates: "Wyvern Call" turns out to summon a
 * creature displayed as "Wyvern", "Call Woodland Beings" one displayed as
 * "Nymph". Both match what the session logs show appearing.
 *
 * **Only the direct form.** Most summoning spells point at an EFF file which in
 * turn names the creature — Conjure Fire Elemental references `spfir1p`,
 * Aerial Servant `spserv` — and resolving those needs an EFF reader this does
 * not have. Those spells come back empty rather than wrong. It matters less
 * than it sounds: their creatures have unique names, so side inference already
 * places them correctly. The direct form is what covers the case inference
 * cannot handle, where a summon shares a name with an enemy.
 */
async function resolveSummons(
  named: Named[],
  tlk: Tlk,
  override: Override,
  biffs: Biffs | null,
): Promise<Map<string, string[]>> {
  // resref -> display name, or null for "exists but has no name". Cached
  // because one creature is referenced by many spells and this is file I/O.
  const creatureNames = new Map<string, string | null>();

  const creatureName = async (resref: string): Promise<string | null> => {
    if (resref === "") return null;
    const key = resref.toLowerCase();
    const cached = creatureNames.get(key);
    if (cached !== undefined) return cached;

    let name: string | null = null;
    if (override.has(resref, "cre") || (biffs !== null && biffs.has(resref, "cre"))) {
      const res = await resolve(override, resref, "cre", biffs ?? undefined);
      if (res !== null) {
        try {
          const cre = readCre(resref, res.bytes);
          name = tlk.get(cre.nameStrref) ?? tlk.get(cre.shortNameStrref);
        } catch {
          name = null;
        }
      }
    }
    creatureNames.set(key, name);
    return name;
  };

  const out = new Map<string, string[]>();
  for (const n of named) {
    const found: string[] = [];
    for (const f of n.spell.features) {
      const name = await creatureName(f.resource);
      if (name !== null && name.trim() !== "" && !found.includes(name)) found.push(name);
    }
    if (found.length > 0) out.set(n.spell.resref, found);
  }
  return out;
}

/** Report the summon mapping, including the cases it cannot reach. */
function reportSummons(named: Named[], summons: Map<string, string[]>) {
  console.log(`\n--- spells that name the creature they summon ---`);
  console.log(`  ${summons.size} of ${named.length} spells resolve a summoned creature`);

  const byName = new Map<string, Named>();
  for (const n of named) if (n.name !== null && !byName.has(n.name)) byName.set(n.name, n);

  // Spells the session logs prove are summons. The ones that come back empty
  // are the EFF-indirection cases, named so the gap is specific.
  const KNOWN = [
    "Wyvern Call",
    "Call Woodland Beings",
    "Conjure Fire Elemental",
    "Aerial Servant",
    "Animate Dead",
    "Giant Insect",
  ];
  for (const label of KNOWN) {
    const hit = byName.get(label);
    const got = hit === undefined ? undefined : summons.get(hit.spell.resref);
    console.log(
      `  ${label.padEnd(26)} ${got === undefined ? "— (indirect, needs an EFF reader)" : got.join(", ")}`,
    );
  }
}

/**
 * Ground truth for the one captured string this project cannot explain.
 *
 * Sessions contain `Contingency‚ÄîStoneskin`, which is the UTF-8 em-dash
 * (`e2 80 94`) decoded as single-byte characters and re-encoded — six bytes
 * where three belong. The bad bytes are in the log file on disk, so the fault
 * is in capture or in the engine, and re-importing cannot repair sessions
 * already taken.
 *
 * `dialog.tlk` settles which: it holds the bytes the engine started from.
 */
function reportEncoding(tlk: Tlk) {
  console.log(`\n--- encoding check: what dialog.tlk actually holds ---`);

  const hex = (b: Uint8Array) => [...b].map((n) => n.toString(16).padStart(2, "0")).join(" ");
  let found = 0;

  for (let strref = 0; strref < tlk.count && found < 4; strref++) {
    const s = tlk.get(strref);
    if (s === null || !s.includes("Contingency")) continue;
    // Only the ones carrying a non-ASCII byte are interesting.
    if (!/[^\x20-\x7e]/.test(s)) continue;
    found++;

    const bytes = tlk.bytesOf(strref)!;
    const odd = [...s].filter((c) => c.codePointAt(0)! > 0x7e);
    console.log(`\n  strref ${strref}: ${JSON.stringify(s)}`);
    console.log(`    non-ASCII chars: ${
      odd.map((c) => `${JSON.stringify(c)} U+${c.codePointAt(0)!.toString(16).toUpperCase()}`)
        .join(", ")
    }`);
    console.log(`    bytes: ${hex(bytes.subarray(0, Math.min(bytes.length, 40)))}`);
  }

  if (found === 0) {
    console.log(`  no non-ASCII "Contingency" string in this dialog.tlk`);
    return;
  }
  console.log(
    `\n  A clean "e2 80 94" above means the engine emitted correct UTF-8 and the\n` +
      `  corruption is downstream — in capture, not in the game data.`,
  );
}

if (import.meta.main) await main();
