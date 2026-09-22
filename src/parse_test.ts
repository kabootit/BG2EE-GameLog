/**
 * Parser tests, run with `deno task test`.
 *
 * Every case here is a real line lifted from `logs/`, not an invented one. That
 * matters: the first rule set in this project was written against an imagined
 * format and matched almost nothing (see learnings/EVENT-STREAM-STRUCTURING.md).
 *
 * These exist because the parsing rules have been revised many times and each
 * revision was previously verified by eyeballing output once and discarding it.
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  classify,
  EventLinker,
  type GameEvent,
  parseLine,
  parseStats,
  PartyStats,
  SideResolver,
  stripColor,
} from "./parse.ts";

/** Wrap text the way the engine does, so parseLine is exercised end to end. */
const tap = (text: string, id = 9) =>
  `2026-01-01 00:00:00.000 Baldur[1:2] INFO: LUA: A7LOG\t${id}\t100\t200\tDay 1\tWORLD\t${text}`;

Deno.test("tap line survives the engine's log prefix", () => {
  const e = parseLine(tap("Vampire: Takes 13 slashing damage from Tyras"));
  assertEquals(e?.id, 9);
  assertEquals(e?.wallClock, "2026-01-01 00:00:00.000");
  assertEquals(e?.raw, "Vampire: Takes 13 slashing damage from Tyras");
});

Deno.test("non-tap output is ignored", () => {
  assertEquals(parseLine("INFO: Get Data Directory: /somewhere"), null);
  assertEquals(parseLine(""), null);
});

Deno.test("damage is read from the victim's end and inverted", () => {
  // The speaker is the victim; the attacker is in the "from" clause. Getting
  // this backwards inverts every damage statistic and still looks plausible.
  const e = classify("Vampire: Takes 13 slashing damage from Tyras");
  assertEquals(e.kind, "damage");
  assertEquals(e.actor, "Tyras");
  assertEquals(e.target, "Vampire");
  assertEquals(e.amount, 13);
  assertEquals(e.detail, "slashing");
});

Deno.test("damage source name is not polluted by trailing clauses", () => {
  for (const [text, actor, resisted] of [
    ["Alarion: Takes 18 crushing damage from Vampire (9 damage bonus)", "Vampire", null],
    ["Jaheira: Takes 2 slashing damage from Goblin (4 damage resisted)", "Goblin", 4],
    ["Vampire: Takes 13 slashing damage from Tyras", "Tyras", null],
  ] as const) {
    const e = parseLine(tap(text))!;
    assertEquals(e.actor, actor, text);
    assertEquals(e.resisted, resisted, text);
  }
});

Deno.test("a description of damage is not damage dealt", () => {
  // Future tense, about a game rule rather than an event. Anchoring is what
  // separates them, since a regex cannot see tense.
  const e = classify("Tyras: When the berserk state ends, the character will take 15 damage.");
  assertEquals(e.kind, "dialogue");
  assertEquals(e.amount, null);
});

Deno.test("'dies' does not match inside 'bodies'", () => {
  const e = classify("Alarion: Give me something to decorate this pit with broken bodies!");
  assertEquals(e.kind, "dialogue");
});

Deno.test("attack roll total goes to roll, never amount", () => {
  // amount is damage and experience - things worth summing. Mixing to-hit
  // totals into it silently inflates every damage figure.
  const e = classify("Attack Roll 6 + 2 = 8 : Miss");
  assertEquals(e.kind, "attack");
  assertEquals(e.roll, 8);
  assertEquals(e.amount, null);
  assertEquals(e.detail, "Miss");
});

Deno.test("Extra Combat Info breakdowns are told apart by component name", () => {
  // Note the speaker prefix: classify() strips one before matching, so a bare
  // body would have "Roll" eaten as the speaker and never reach these rules.
  const hit = classify("Goblin: Roll:13 +Luck:0 +SpecialAC:0 +HitMod:0 +Right:2 (+Weapon Bonus 0)");
  assertEquals(hit.kind, "tohit");
  assertEquals(hit.roll, 13);

  const dmg = classify("Goblin: Roll:3 +DamageMod:0 +Hand bonus:0 (+Proficiency 2) *Backstab:0");
  assertEquals(dmg.kind, "damageroll");
  assertEquals(dmg.roll, 3);
});

Deno.test("both attack declaration forms capture the target", () => {
  assertEquals(classify("Attacks Lesser Clay Golem").target, "Lesser Clay Golem");
  assertEquals(classify("is Attacking Goblin").target, "Goblin");
});

Deno.test("a failed cast is its own kind, never a spell", () => {
  // If this were `spell`, "Casting Failure" would become a damage source
  // attributed to every hit the caster landed for the next 60 rows.
  assertEquals(classify("Rurik: Spell Failed: Casting Failure").kind, "miscast");
});

Deno.test("cast announcement is captured with its spell name", () => {
  const e = parseLine(tap("Red Wizard: Casting Mirror Image..."))!;
  assertEquals(e.kind, "cast_start");
  assertEquals(e.actor, "Red Wizard");
  assertEquals(e.detail, "Mirror Image");
});

Deno.test("cast announcement survives punctuation in the spell name", () => {
  // Apostrophes and commas appear in real spell names and must not truncate it.
  const e = parseLine(tap("Anomen: Casting Protection From Evil, 10' Radius..."))!;
  assertEquals(e.kind, "cast_start");
  assertEquals(e.detail, "Protection From Evil, 10' Radius");
});

Deno.test("'Casting' is not mistaken for 'Casts'", () => {
  assertEquals(classify("Red Wizard: Casts Mirror Image : Red Wizard").kind, "spell");
  assertEquals(classify("Red Wizard: Casting Mirror Image...").kind, "cast_start");
});

Deno.test("the 'is Casting' form splits spell from target", () => {
  const e = classify("Jan: is Casting Improved Invisibility : Anomen");
  assertEquals(e.kind, "cast_start");
  assertEquals(e.detail, "Improved Invisibility");
  assertEquals(e.target, "Anomen");
});

Deno.test("'is Casting' with no target keeps the whole spell name", () => {
  const e = classify("Cernd: is Casting Call Woodland Beings");
  assertEquals(e.detail, "Call Woodland Beings");
  assertEquals(e.target, null);
});

Deno.test("a cast with no spell name yields a null detail, not a made-up one", () => {
  // The engine really does print this - 29 rows in 61k. The earlier rule made
  // the target group optional, so the lazy detail swallowed the separator and
  // invented a spell called ": Cat", which showed as "casting : Cat…" on a card
  // and padded the coverage report with names that were never spells.
  const e = classify("Cernd: is Casting : Cat");
  assertEquals(e.kind, "cast_start");
  assertEquals(e.actor, "Cernd");
  assertEquals(e.detail, null, "no spell name was printed, so none should be reported");
  assertEquals(e.target, "Cat");
});

Deno.test("immunity that names the protected creature attributes it to target", () => {
  // "Jaheira: Cambion was immune to my damage." - Jaheira attacked, Cambion is
  // protected. The protection belongs to the target, not the speaker.
  const e = parseLine(tap("Jaheira: Cambion was immune to my damage."))!;
  assertEquals(e.kind, "immune");
  assertEquals(e.actor, "Jaheira");
  assertEquals(e.target, "Cambion");
  assertEquals(e.detail, "damage");
});

Deno.test("Weapon Ineffective names nobody and leaves target for the linker", () => {
  // The protected creature is not in the text at all; EventLinker fills it in
  // from the speaker's most recent attack.
  const e = parseLine(tap("Korgan: Weapon Ineffective."))!;
  assertEquals(e.kind, "immune");
  assertEquals(e.actor, "Korgan");
  assertEquals(e.target, null);
  assertEquals(e.detail, "weapon");
});

/** Feed lines through parse + link the way play.ts and import.ts both do. */
function link(lines: string[]): GameEvent[] {
  const linker = new EventLinker();
  const out: GameEvent[] = [];
  lines.forEach((text, i) => {
    const e = parseLine(tap(text, i + 1));
    if (e) out.push(linker.apply(e));
  });
  return out;
}

Deno.test("Weapon Ineffective is attributed to whoever the speaker was attacking", () => {
  // The real sequence from logs/: the declared attack is 4 lines earlier and is
  // the only place the protected creature is named.
  const events = link([
    "Korgan: Attacks Shade Wolf",
    "Shade Wolf: Attacks Jan",
    "Korgan: Roll:9 +Luck:0 +SpecialAC:0 +HitMod:0 +Right:1 (+Weapon Bonus 0)",
    "Korgan: Attack Roll 9 + 3 = 12 : Hit",
    "Korgan: Weapon Ineffective.",
  ]);
  const immune = events.find((e) => e.kind === "immune")!;
  assertEquals(immune.actor, "Korgan");
  assertEquals(immune.target, "Shade Wolf");
});

Deno.test("an immunity that already names its target is not overwritten", () => {
  const events = link([
    "Jaheira: Attacks Cambion",
    "Jaheira: Attack Roll 18 + 2 = 20 : Hit",
    "Jaheira: Cambion was immune to my damage.",
  ]);
  const immune = events.find((e) => e.kind === "immune")!;
  assertEquals(immune.target, "Cambion");
});

Deno.test("immunity is not attributed across an unrelated gap", () => {
  // Beyond ATTACK_TARGET_WINDOW the attack is stale, and a wrong attribution is
  // worse than a blank one: it would claim a protection on the wrong creature.
  const filler = Array.from({ length: 20 }, () => "PAUSED");
  const events = link(["Korgan: Attacks Shade Wolf", ...filler, "Korgan: Weapon Ineffective."]);
  assertEquals(events.find((e) => e.kind === "immune")!.target, null);
});

Deno.test("speaker pattern does not swallow engine text that looks attributed", () => {
  // "Attack Roll 18 -4 = 14 : Hit" would parse as a speaker named
  // "Attack Roll 18 -4 = 14" if digits and "=" were allowed in names.
  const e = classify("Attack Roll 18 - 4 = 14 : Hit");
  assertEquals(e.kind, "attack");
  assertEquals(e.actor, null);
});

Deno.test("attributed prose is dialogue, attributed non-prose is status", () => {
  assertEquals(parseLine(tap("Alarion: Yes?"))!.kind, "dialogue");
  assertEquals(parseLine(tap("Red Wizard: Mirror Imaged"))!.kind, "status");
  assertEquals(parseLine(tap("Gaul: Contingency Active"))!.kind, "status");
});

Deno.test("capture-side marker is not read as a creature speaking", () => {
  // "capture resynced:" matches the speaker pattern, so it must be tested first
  // or the warning that rows are missing lands in a bucket the viewer hides.
  const e = parseLine(tap("capture resynced: combatLog was replaced"))!;
  assertEquals(e.kind, "resync");
  assertEquals(e.actor, null);
});

Deno.test("control characters are stripped at the parse boundary", () => {
  // Game text is third-party input: mods rewrite dialog.tlk. An ANSI escape
  // would be interpreted, not displayed, by the terminal reports.
  assertEquals(stripColor("Vampire\u001B[31m: hi"), "Vampire [31m: hi");
  assertEquals(stripColor("^0xffffb3f3Imoen^-: ^0xffbed7d7Attacks Golem^-"), "Imoen: Attacks Golem");
});

// --- side resolution ------------------------------------------------------
//
// Every sequence below is taken from the harpy/wyvern/beetle skirmish in
// session-20260916-204542.log, with the real edge counts. The bug these guard
// was reported from live play: summoned fire elementals showing as opponents.

/** Feed lines through the real resolver, the way import.ts does. */
function resolveSides(roster: string[], lines: string[]): SideResolver {
  const sides = new SideResolver();
  sides.addRoster(roster);
  const linker = new EventLinker();
  lines.forEach((text, i) => {
    const e = parseLine(tap(text, i + 1));
    if (e !== null) sides.observe(linker.apply(e));
  });
  return sides;
}

const PARTY = ["Rage", "Jan", "Jaheira", "Anomen", "Neera", "Cernd"];

const repeat = (line: string, n: number) => Array.from({ length: n }, () => line);

/**
 * The wyverns earn their opponent label by fighting the party.
 *
 * Real per-creature counts from the session, and they have to be. An
 * abbreviated version of this with one line per character gave the party so
 * little weight that 30 wyvern-on-harpy hits outvoted it and turned the
 * *wyverns* into allies. Ratios are what is under test here, so a fixture that
 * does not reproduce them proves nothing.
 */
const WYVERN_FIGHT = [
  ...repeat("Wyvern: Takes 9 piercing damage from Jan", 9),
  ...repeat("Wyvern: Takes 7 slashing damage from Jaheira", 7),
  ...repeat("Wyvern: Takes 6 magic damage from Neera", 6),
  ...repeat("Wyvern: Takes 6 crushing damage from Anomen", 6),
  ...repeat("Wyvern: Takes 5 slashing damage from Rage", 5),
  ...repeat("Wyvern: Takes 4 piercing damage from Cernd", 4),
];

Deno.test("a summon hit by friendly fire is still on the party's side", () => {
  // The reported bug. A conjured Fire Elemental took 8 hits from a Wyvern and
  // one from Neera's area spell; treating any party edge as decisive made that
  // single hit outweigh the eight and label it an opponent.
  const sides = resolveSides(PARTY, [
    ...WYVERN_FIGHT,
    ...repeat("Fire Elemental: Takes 5 poison damage from Wyvern", 8),
    "Fire Elemental: Takes 41 magic damage from Neera",
  ]);
  assertEquals(sides.sideOf("Wyvern"), "opponent");
  assertEquals(sides.sideOf("Fire Elemental"), "party");
  assertEquals(sides.isSummon("Fire Elemental"), true);
  // The friendly fire must not have cost Neera her own membership.
  assertEquals(sides.sideOf("Neera"), "party");
  assertEquals(sides.isSummon("Neera"), false);
});

Deno.test("a summon that never touches a party member is still party", () => {
  // A Greater Bearwere fought only wyverns and harpies, so it has no edge to
  // the roster at all and a roster-only rule left it neutral. Reaching it needs
  // a second round, once the wyverns are known to be opponents.
  const sides = resolveSides(PARTY, [
    ...WYVERN_FIGHT,
    ...repeat("Wyvern: Takes 12 slashing damage from Greater Bearwere", 18),
    "Greater Bearwere: Takes 6 piercing damage from Wyvern",
  ]);
  assertEquals(sides.sideOf("Greater Bearwere"), "party");
  assertEquals(sides.isSummon("Greater Bearwere"), true);
});

Deno.test("weight of evidence decides, not merely which edge came first", () => {
  // Same creature, evidence reversed: mostly fighting the party makes it an
  // opponent even though one opponent also hit it. Without this the fix above
  // would just be a blanket "anything a wyvern hits is ours".
  const sides = resolveSides(PARTY, [
    ...WYVERN_FIGHT,
    ...repeat("Harpy: Takes 4 missile damage from Jan", 13),
    "Harpy: Takes 3 piercing damage from Wyvern",
  ]);
  assertEquals(sides.sideOf("Harpy"), "opponent");
  assertEquals(sides.isSummon("Harpy"), false);
});

Deno.test("roster membership outranks any amount of fighting", () => {
  // A charmed party member attacking the party must not be relabeled an
  // opponent - the roster is observed, and inference never overrides it.
  const sides = resolveSides(PARTY, [
    ...WYVERN_FIGHT,
    ...repeat("Anomen: Takes 11 crushing damage from Jan", 12),
  ]);
  assertEquals(sides.sideOf("Jan"), "party");
  assertEquals(sides.isSummon("Jan"), false);
});

Deno.test("a creature in no fight at all stays neutral", () => {
  const sides = resolveSides(PARTY, [
    ...WYVERN_FIGHT,
    "Bartender: I've got nothing for you.",
  ]);
  assertEquals(sides.sideOf("Bartender"), "neutral");
});

Deno.test("enemies fighting each other stay enemies", () => {
  // The regression the first version of this fix caused. Wyverns bit and
  // poisoned the Harpies 30 times - more often than the party hit the Harpies -
  // with nothing charmed; the engine simply lets monster factions be mutually
  // hostile. Counting inferred-opponent edges as heavily as roster edges made
  // "fought by a Wyvern" enough to call a Harpy one of ours.
  const sides = resolveSides(PARTY, [
    ...WYVERN_FIGHT,
    ...repeat("Harpy: Takes 4 missile damage from Jan", 13),
    ...repeat("Harpy: Takes 6 slashing damage from Anomen", 8),
    ...repeat("Harpy: Takes 5 piercing damage from Cernd", 4),
    ...repeat("Harpy: Takes 7 piercing damage from Wyvern", 15),
    ...repeat("Harpy: Takes 3 poison damage from Wyvern", 15),
  ]);
  assertEquals(sides.sideOf("Harpy"), "opponent");
  assertEquals(sides.isSummon("Harpy"), false);
  assertEquals(sides.sideOf("Wyvern"), "opponent");
});

Deno.test("evidence quality is what separates the two cases", () => {
  // Side by side, because the counts alone do not distinguish them. Both
  // creatures are fought by the same opponent about as often; only the party's
  // own involvement differs, and that evidence is observed rather than inferred.
  const summon = resolveSides(PARTY, [
    ...WYVERN_FIGHT,
    ...repeat("Fire Elemental: Takes 5 poison damage from Wyvern", 8),
    "Fire Elemental: Takes 41 magic damage from Neera",
  ]);
  const enemy = resolveSides(PARTY, [
    ...WYVERN_FIGHT,
    ...repeat("Harpy: Takes 5 piercing damage from Wyvern", 8),
    ...repeat("Harpy: Takes 4 missile damage from Neera", 8),
  ]);
  assertEquals(summon.sideOf("Fire Elemental"), "party", "one stray party hit");
  assertEquals(enemy.sideOf("Harpy"), "opponent", "sustained party attention");
});

Deno.test("a saving throw is a die result, so it lands in roll", () => {
  // Parity with an attack, which puts its total in `roll` and its outcome in
  // `detail`. A save has no outcome to put anywhere - the game never prints one
  // - so `detail` carries the category instead.
  const e = classify("Anomen: Save vs. Death : 7");
  assertEquals(e.kind, "save");
  assertEquals(e.actor, "Anomen");
  assertEquals(e.roll, 7);
  assertEquals(e.amount, null, "not amount: that column is for things worth summing");
  assertEquals(e.detail, "Death");
});

Deno.test("a negative saving throw is real, not a parse artifact", () => {
  // "Cernd: Save vs. Spell : -1" appears in the corpus. Save penalties stack
  // onto a low roll, and the observed range across all sessions is -1 to 26 -
  // which is also how we know the number is the modified result, not a d20.
  const e = classify("Cernd: Save vs. Spell : -1");
  assertEquals(e.kind, "save");
  assertEquals(e.roll, -1);
});

Deno.test("every save category the corpus contains is recognized", () => {
  for (const [text, category] of [
    ["X: Save vs. Spell : 11", "Spell"],
    ["X: Save vs. Death : 21", "Death"],
    ["X: Save vs. Breath Weapon : 9", "Breath Weapon"],
    ["X: Save vs. Wand : 16", "Wand"],
    ["X: Save vs. Polymorph : 8", "Polymorph"],
  ] as const) {
    const e = classify(text);
    assertEquals(e.kind, "save", text);
    assertEquals(e.detail, category, text);
  }
});

// --- party saving-throw targets -------------------------------------------

/** The real A7STATS payload, verbatim from a session log. */
const ANOMEN_STATS =
  "Paralysis / Poison / Death: 3 (-2) | Rod / Staff / Wand: 7 (-2) | " +
  "Petrification / Polymorph: 6 (-2) | Breath Weapon: 9 (-2) | Spell: 8 (-2)";

const statsLine = (name: string, text: string) =>
  `2026-01-01 00:00:00.000 B[1:2] INFO: LUA: A7STATS\t${name}\t${text}`;

Deno.test("saving-throw targets are read from the engine's own wording", () => {
  // The two vocabularies differ and neither is derivable from the other: the
  // record screen says "Paralysis / Poison / Death" where the combat log says
  // "Death". The parenthesized figure is how much of the target came from
  // bonuses; the number before it is what the roll has to beat.
  const s = parseStats(statsLine("Anomen", ANOMEN_STATS))!;
  assertEquals(s.name, "Anomen");
  assertEquals(s.targets, {
    Death: 3,
    Wand: 7,
    Polymorph: 6,
    "Breath Weapon": 9,
    Spell: 8,
  });
});

Deno.test("a negative target is read as negative", () => {
  // Cernd's real values. A target below 1 means he cannot fail that save, which
  // is normal for a high-level character with save-boosting gear.
  const s = parseStats(statsLine("Cernd", "Paralysis / Poison / Death: -3 (-8) | Spell: -3 (-13)"))!;
  assertEquals(s.targets.Death, -3);
  assertEquals(s.targets.Spell, -3);
});

Deno.test("non-stats lines and unknown labels are ignored", () => {
  assertEquals(parseStats(tap("Anomen: Save vs. Death : 7")), null);
  assertEquals(parseStats("A7STATS\tAnomen"), null, "no payload");
  // An unrecognized label must not become a category of its own.
  assertEquals(parseStats(statsLine("X", "Something Else: 4")), null);
});

Deno.test("a save is judged against the targets in force when it was rolled", () => {
  // The reason this is a timeline and not a single value: saves move mid-session
  // as a Bless lands or an item is equipped, and the tap emits only on change.
  const stats = new PartyStats();
  stats.observe(10, parseStats(statsLine("Jan", "Paralysis / Poison / Death: 11"))!);
  stats.observe(50, parseStats(statsLine("Jan", "Paralysis / Poison / Death: 9 (-2)"))!);

  const save = (id: number, roll: number) => {
    const e = parseLine(tap(`Jan: Save vs. Death : ${roll}`, id))!;
    return stats.compare(e);
  };

  // Target 11 early, 9 later: a roll of 10 flips from failed to made.
  assertEquals(save(20, 10), false, "against the earlier target of 11");
  assertEquals(save(60, 10), true, "against the later target of 9");
});

Deno.test("a save rolled before any target was known stays unknown", () => {
  // Falling back to the earliest known values would be wrong in whichever
  // direction the character has since changed.
  const stats = new PartyStats();
  stats.observe(100, parseStats(statsLine("Jan", "Paralysis / Poison / Death: 9"))!);
  assertEquals(stats.compare(parseLine(tap("Jan: Save vs. Death : 10", 50))!), null);
});

Deno.test("no verdict is claimed for a creature the tap never reported", () => {
  // Every enemy. The log gives no target and creature names map to several stat
  // blocks, so there is nothing honest to compare against.
  const stats = new PartyStats();
  stats.observe(1, parseStats(statsLine("Anomen", ANOMEN_STATS))!);
  assertEquals(stats.compare(parseLine(tap("Wyvern: Save vs. Death : 4", 9))!), null);
  // And a category the stats line did not carry.
  assertEquals(stats.compare(parseLine(tap("Anomen: Save vs. Fear : 4", 9))!), null);
});

Deno.test("the boundary is at-or-above the target, not above it", () => {
  // AD&D2e: the save succeeds on a roll equal to the target.
  const stats = new PartyStats();
  stats.observe(1, parseStats(statsLine("Anomen", ANOMEN_STATS))!);
  const at = (roll: number) => stats.compare(parseLine(tap(`Anomen: Save vs. Death : ${roll}`, 9))!);
  assertEquals(at(2), false);
  assertEquals(at(3), true, "equal to the target succeeds");
  assertEquals(at(4), true);
});

Deno.test("a partial roster does not override speech", () => {
  // The reported bug. `characters` fills in incrementally as the game loads, so
  // a session that ends early emits a roster missing real members - one 574-line
  // session never got past five entries and omitted the protagonist. Preferring
  // the roster whenever one existed then overrode better evidence and called him
  // a summon, despite 23 dialogue lines in the same session.
  const sides = new SideResolver();
  sides.addRoster(["Jaheira", "Jan", "Cernd", "Anomen", "Neera"]);
  const linker = new EventLinker();
  for (const [i, text] of [
    "Rage: Well met.",
    "Water Kin Elemental: Takes 3 missile damage from Rage",
    "Water Kin Elemental: Takes 2 missile damage from Jan",
  ].entries()) {
    const e = parseLine(tap(text, i + 1));
    if (e !== null) sides.observe(linker.apply(e));
  }

  assertEquals(sides.sideOf("Rage"), "party");
  assertEquals(sides.isSummon("Rage"), false, "he spoke, so he is a member");
  assertEquals(sides.isSummon("Jan"), false, "in the roster");
  assertEquals(sides.sideOf("Water Kin Elemental"), "opponent");
});

Deno.test("a real summon is still a summon under the union rule", () => {
  // Widening membership must not let summons through. A summon appears in
  // neither signal: it never speaks, and the engine's `characters` table only
  // ever holds party members.
  const sides = new SideResolver();
  sides.addRoster(["Neera"]);
  const linker = new EventLinker();
  for (const [i, text] of [
    "Neera: I can do this.",
    ...Array.from({ length: 6 }, () => "Wyvern: Takes 9 piercing damage from Neera"),
    ...Array.from({ length: 6 }, () => "Fire Elemental: Takes 5 poison damage from Wyvern"),
  ].entries()) {
    const e = parseLine(tap(text, i + 1));
    if (e !== null) sides.observe(linker.apply(e));
  }

  assertEquals(sides.sideOf("Fire Elemental"), "party");
  assertEquals(sides.isSummon("Fire Elemental"), true, "silent and not in the roster");
  assertEquals(sides.isSummon("Neera"), false);
});

Deno.test("no save verdict is recorded, because a save row is already a success", () => {
  // The engine prints a save line only when the save succeeds - a failure shows
  // up as the effect landing instead - so computing "made" for a save row adds
  // nothing that the row's own existence did not already say. Hence
  // VERDICTS_TRUSTED, and hence "saves made" on the group-by heading.
  //
  // compare() still answers, so the arithmetic stays under test.
  const stats = new PartyStats();
  stats.observe(1, parseStats(statsLine("Anomen", ANOMEN_STATS))!);
  const rolled = (roll: number) => parseLine(tap(`Anomen: Save vs. Death : ${roll}`, 9))!;

  assertEquals(stats.compare(rolled(2)), false, "the rule still computes");
  assertEquals(stats.compare(rolled(9)), true);
  assertEquals(stats.verdict(rolled(2)), null, "but nothing is claimed");
  assertEquals(stats.verdict(rolled(9)), null);
});
