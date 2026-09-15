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
import { classify, EventLinker, type GameEvent, parseLine, stripColor } from "./parse.ts";

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
