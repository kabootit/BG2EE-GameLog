/**
 * Fold tests, run with `deno task test`.
 *
 * These encode the verification steps from the plan, so they stay checked rather
 * than being confirmed once by eye. Sequences are shaped like real ones from
 * `logs/`.
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { type EventRow, foldCombatants } from "./combatants.ts";
import { EventLinker, parseLine } from "./parse.ts";

/**
 * Build rows the way the pipeline does — parse, link, then shape as the DB
 * stores them — so the fold is tested against what it will really receive.
 */
function rows(lines: string[], sides: Record<string, string> = {}): EventRow[] {
  const linker = new EventLinker();
  const out: EventRow[] = [];
  lines.forEach((text, i) => {
    const id = i + 1;
    const e = parseLine(
      `2026-01-01 00:00:00.000 B[1:2] INFO: LUA: A7LOG\t${id}\t${id * 60}\t${id * 1000}\tDay 1\tWORLD\t${text}`,
    );
    if (!e) return;
    const linked = linker.apply(e);
    out.push({
      id: linked.id,
      kind: linked.kind,
      actor: linked.actor,
      target: linked.target,
      detail: linked.detail,
      raw: linked.raw,
      game_ticks: linked.gameTicks,
      clock_ms: linked.clockMs,
      actor_side: linked.actor === null ? null : sides[linked.actor] ?? null,
      target_side: linked.target === null ? null : sides[linked.target] ?? null,
      summon: null,
      target_summon: null,
    });
  });
  return out;
}

const find = (r: ReturnType<typeof foldCombatants>, name: string) =>
  r.combatants.find((c) => c.name === name);

Deno.test("the three-line buff signature yields one observation, not three", () => {
  // Announcement, cast, and landed effect all describe the same Mirror Image.
  const r = foldCombatants(rows([
    "Red Wizard: Casting Mirror Image...",
    "Red Wizard: Casts Mirror Image : Red Wizard",
    "Red Wizard: Mirror Imaged",
  ]));
  const wiz = find(r, "Red Wizard")!;
  assertEquals(wiz.observations.length, 1);
  assertEquals(wiz.observations[0].name, "Mirror Image");
  assertEquals(wiz.observations[0].category, "protection");
  // The landed effect outranks the mere cast.
  assertEquals(wiz.observations[0].source, "effect");
  // Resolved, so no longer mid-cast.
  assertEquals(wiz.casting, null);
});

Deno.test("an unresolved announcement shows as casting", () => {
  const r = foldCombatants(rows(["Cowled Wizard: Casting Shadow Door..."]));
  assertEquals(find(r, "Cowled Wizard")!.casting, "Shadow Door");
});

Deno.test("probe evidence attaches to the creature that shrugged it off", () => {
  // "Korgan: Weapon Ineffective." - Korgan attacked; the Shade Wolf is protected.
  // Getting this backwards would claim a protection on a party member.
  const r = foldCombatants(rows([
    "Korgan: Attacks Shade Wolf",
    "Korgan: Attack Roll 9 + 3 = 12 : Hit",
    "Korgan: Weapon Ineffective.",
  ]));
  assertEquals(find(r, "Korgan")!.observations.length, 0);
  const wolf = find(r, "Shade Wolf")!;
  assertEquals(wolf.observations.length, 1);
  assertEquals(wolf.observations[0].name, "Protection From Magical Weapons");
  assertEquals(wolf.observations[0].source, "probe");
});

Deno.test("named immunity also attaches to the target", () => {
  const r = foldCombatants(rows(["Jaheira: Cambion was immune to my damage."]));
  assertEquals(find(r, "Jaheira")!.observations.length, 0);
  assertEquals(find(r, "Cambion")!.observations[0].name, "damage immunity");
});

Deno.test("a probe outranks a cast for the same protection", () => {
  const r = foldCombatants(rows([
    "Mage: Casts Protection From Magical Weapons : Mage",
    "Korgan: Attacks Mage",
    "Korgan: Weapon Ineffective.",
  ]));
  const mage = find(r, "Mage")!;
  assertEquals(mage.observations.length, 1);
  assertEquals(mage.observations[0].source, "probe");
});

Deno.test("a disable cast on someone else lands on them, not the caster", () => {
  const r = foldCombatants(rows([
    "Cowled Wizard: Casts Hold Person : Duergar",
    "Duergar: Held",
  ]));
  assertEquals(find(r, "Cowled Wizard")!.observations.length, 0);
  const duergar = find(r, "Duergar")!;
  assertEquals(duergar.observations[0].name, "Hold Person");
  assertEquals(duergar.observations[0].category, "disable");
});

Deno.test("an 'Effect : Target' line lands on the target, not the speaker", () => {
  // "Vampire: Domination : Rurik" means Rurik is dominated. Attributing it to
  // the speaker would put the enemy's own attack effect on the enemy.
  const r = foldCombatants(rows(["Vampire: Domination : Rurik"]));
  assertEquals(find(r, "Vampire")!.observations.length, 0);
  assertEquals(find(r, "Rurik")!.observations[0].name, "Domination");
  assertEquals(find(r, "Rurik")!.observations[0].category, "disable");
});

Deno.test("a self-buff in 'Effect : Target' form stays on the caster", () => {
  // Same shape, but the speaker names themselves, so it must still work.
  const r = foldCombatants(rows(["Gaul: Stoneskin : Gaul"]));
  assertEquals(find(r, "Gaul")!.observations[0].name, "Stoneskin");
});

Deno.test("a bare status name belongs to the speaker", () => {
  const r = foldCombatants(rows(["Duergar: Held"]));
  assertEquals(find(r, "Duergar")!.observations[0].name, "Hold Person");
});

Deno.test("interrupted dialogue is not mistaken for an effect", () => {
  // BG2 speech often trails off on an em dash, which the sentence test used to
  // miss - leaving a whole line of prose sitting in the inspector as a buff.
  const r = foldCombatants(rows([
    "Anomen: Excuse my dull and graceless talk, but—",
  ]));
  assertEquals(find(r, "Anomen")?.observations.length ?? 0, 0);
});

Deno.test("dispel clears dispellable state and spares the rest", () => {
  // Spell Turning is the survivor, not Protection From Magical Weapons: the
  // game files say PFMW's core effect carries the dispel bit, so it goes. This
  // test used PFMW until `deno task extract` showed the hand-written value was
  // wrong.
  const r = foldCombatants(rows([
    "Mage: Casts Mirror Image : Mage",
    "Mage: Casts Spell Turning : Mage",
    "Mage: Dispel Effects",
  ]));
  const names = find(r, "Mage")!.observations.map((o) => o.name);
  assertEquals(names, ["Spell Turning"]);
});

Deno.test("a dispel is never itself recorded as state", () => {
  const r = foldCombatants(rows(["Rurik: Casts Remove Magic : Mage"]));
  assertEquals(find(r, "Mage")!.observations.length, 0);
  assertEquals(find(r, "Rurik")!.observations.length, 0);
});

/**
 * The removal spells do not remove the same things, and getting this backwards
 * looks entirely plausible on screen — a card that drops Mirror Image and keeps
 * Spell Turning reads fine unless you know the spells. Filtering on
 * `dispellable` alone did exactly that to three of the six.
 */
const BUFFED = [
  "Mage: Casts Mirror Image : Mage", // combat, dispellable
  "Mage: Casts Protection From Magical Weapons : Mage", // combat, NOT dispellable
  "Mage: Casts Spell Turning : Mage", // spell, NOT dispellable
  "Mage: Casts Invisibility : Mage", // concealment, dispellable
];

const leftOn = (lines: string[]) =>
  find(foldCombatants(rows([...BUFFED, ...lines])), "Mage")!
    .observations.map((o) => o.name).sort();

Deno.test("Spell Thrust strips spell protections and leaves the rest", () => {
  // The inverse of Dispel Magic. Spell Turning goes despite being undispellable;
  // Mirror Image stays despite being dispellable.
  assertEquals(leftOn(["Rurik: Casts Spell Thrust : Mage"]), [
    "Invisibility",
    "Mirror Image",
    "Protection From Magical Weapons",
  ]);
});

Deno.test("Breach strips combat protections and nothing else", () => {
  // The third distinct class. Breach takes both combat protections and leaves
  // the spell protection standing, which is the exact inverse of Spell Thrust
  // above and unrelated to what Dispel Magic does. Three removal spells, three
  // different answers on the same four buffs.
  assertEquals(leftOn(["Rurik: Casts Breach : Mage"]), ["Invisibility", "Spell Turning"]);
});

Deno.test("True Sight strips only concealment", () => {
  assertEquals(leftOn(["Rurik: Casts True Sight : Mage"]), [
    "Mirror Image",
    "Protection From Magical Weapons",
    "Spell Turning",
  ]);
});

Deno.test("Dispel Magic still goes by dispellable", () => {
  // Only Spell Turning is undispellable among the four, so only it survives.
  // Contrast with Breach below, which takes the two combat protections and
  // leaves this one — the distinction a single flag cannot express.
  assertEquals(leftOn(["Mage: Dispel Effects"]), ["Spell Turning"]);
});

Deno.test("Spellstrike lands as an effect naming its target", () => {
  // "Shade Lord: Spellstrike : Anomen" - an `effect` line, so the strip belongs
  // to the target, not the speaker. Getting this inverted would strip the caster.
  const r = foldCombatants(rows([
    "Anomen: Casts Spell Turning : Anomen",
    "Anomen: Casts Mirror Image : Anomen",
    "Shade Lord: Casts Mirror Image : Shade Lord",
    "Shade Lord: Spellstrike : Anomen",
  ]));
  assertEquals(find(r, "Anomen")!.observations.map((o) => o.name), ["Mirror Image"]);
  // The caster keeps its own buffs.
  assertEquals(find(r, "Shade Lord")!.observations.map((o) => o.name), ["Mirror Image"]);
});

Deno.test("innate magic resistance survives a spell-protection strip", () => {
  // Caught by reading a real screenshot against the change, not by the tests
  // above: every one of them passed while "magic" was wrongly in the strip list.
  // Magic Resistance is an innate percentage rather than a cast protection, so
  // no amount of Spellstrike removes it - and Anomen visibly has it.
  const r = foldCombatants(rows([
    "Anomen: Casts Spell Turning : Anomen",
    "Anomen: Magic Resistance",
    "Shade Lord: Spellstrike : Anomen",
  ]));
  assertEquals(find(r, "Anomen")!.observations.map((o) => o.name), ["Magic Resistance"]);
});

Deno.test("'Spell Protections Removed' is a strip, not an observation", () => {
  // A `status` line on the creature it happened to. Before this name was in the
  // table it fell through to observe() and showed as an untagged observation —
  // state lost, displayed as state gained. Regression guard for what the
  // combatants screenshot in the README was actually showing.
  const r = foldCombatants(rows([
    "Anomen: Casts Spell Turning : Anomen",
    "Anomen: Casts Mirror Image : Anomen",
    "Anomen: Spell Protections Removed",
  ]));
  const obs = find(r, "Anomen")!.observations;
  assertEquals(obs.map((o) => o.name), ["Mirror Image"]);
  assertEquals(obs.some((o) => o.name === "Spell Protections Removed"), false);
});

Deno.test("death clears everything for that creature", () => {
  const r = foldCombatants(rows([
    "Mage: Casts Mirror Image : Mage",
    "Mage: Protected from Magical Weapons",
    "Mage: Death",
  ]));
  const mage = find(r, "Mage")!;
  assertEquals(mage.observations.length, 0);
  assertEquals(mage.diedAtId, 3);
});

Deno.test("identical names merge into one entry", () => {
  // Two Lesser Clay Golems share a display name and the engine exposes no
  // instance identity, so one merged entry is the honest representation.
  const r = foldCombatants(rows([
    "Lesser Clay Golem: Magic Resistance",
    "Lesser Clay Golem: Attacks Jaheira",
  ]));
  assertEquals(r.combatants.filter((c) => c.name === "Lesser Clay Golem").length, 1);
});

Deno.test("an unknown effect that lands is kept", () => {
  // IWDification adds 65+ spells; an unidentified effect still matters, so long
  // as something was actually seen to land.
  const r = foldCombatants(rows(["Shaman: Spirit Ward : Shaman"]));
  const obs = find(r, "Shaman")!.observations[0];
  assertEquals(obs.name, "Spirit Ward");
  assertEquals(obs.category, "unknown");
});

Deno.test("an unknown spell merely cast at someone is not state", () => {
  // Most spells are attacks. "Casts Icelance : Cernd" is damage, not a
  // condition, and showing it would bury the real protections.
  const r = foldCombatants(rows([
    "Mage: Casts Icelance : Cernd",
    "Mage: Casts Lightning Bolt : Cernd",
  ]));
  assertEquals(find(r, "Cernd")!.observations.length, 0);
});

Deno.test("a known protection is kept from a cast alone", () => {
  // The cut above must not lose the things we do understand.
  const r = foldCombatants(rows(["Mage: Casts Stoneskin : Mage"]));
  assertEquals(find(r, "Mage")!.observations[0].name, "Stoneskin");
});

Deno.test("the second cast-announcement form is not a landed effect", () => {
  // "is Casting Heal" reached the generic effect rule and showed up as an
  // effect literally named "is Casting Heal".
  const r = foldCombatants(rows([
    "Cernd: is Casting Heal",
    "Jan: is Casting Improved Invisibility : Anomen",
  ]));
  assertEquals(find(r, "Cernd")!.observations.length, 0);
  assertEquals(find(r, "Cernd")!.casting, "Heal");
  assertEquals(find(r, "Jan")!.casting, "Improved Invisibility");
  assertEquals(find(r, "Anomen")?.observations.length ?? 0, 0);
});

Deno.test("bookkeeping noise never becomes state", () => {
  // `status` is the catch-all bucket, so most of it is not state at all.
  const r = foldCombatants(rows([
    "Jan: Detecting Traps / Illusions",
    "Jan: Stopped Detecting Traps / Illusions",
    "Jan: Attacks Goblin",
  ]));
  assertEquals(find(r, "Jan")!.observations.length, 0);
  assertEquals(find(r, "Jan")!.lastAction, "attacking Goblin");
});

// The cases below were all found by running the fold over the real corpus after
// 37 synthetic tests passed. Every one of them was polluting the output.

Deno.test("engine broadcasts are not treated as creatures", () => {
  // "Your journal has been updated: Free Hendak" looks exactly like a creature
  // speaking, because the speaker split cannot tell the difference.
  const r = foldCombatants(rows([
    "Your journal has been updated: Free Hendak and the slaves",
    "The Party Has Gained An Item: Plate Mail",
    "The Party Has Gained Gold: 3900",
  ]));
  assertEquals(r.combatants.map((c) => c.name), []);
});

Deno.test("thief skill chatter is not state", () => {
  // ~2,100 rows of the status bucket are a thief toggling Detect Traps.
  const r = foldCombatants(rows([
    "Jan: Detecting Traps / Illusions",
    "Jan: Trap Detected",
    "Jan: Trap Disarmed",
    "Jan: Lock Pick Succeeded",
    "Jan: Trap Sprung",
  ]));
  assertEquals(find(r, "Jan")!.observations.length, 0);
});

Deno.test("per-event outcomes are not lasting conditions", () => {
  const r = foldCombatants(rows([
    "Anomen: Healed",
    "Anomen: Damage Taken (24)",
    "Anomen: Strength Modification",
    "Rage: Unaffected by effects from Cloudkill",
    "Jan: Evades effects from Flame Strike",
  ]));
  for (const name of ["Anomen", "Rage", "Jan"]) {
    assertEquals(find(r, name)!.observations.length, 0, name);
  }
});

Deno.test("drains persist and are kept as state", () => {
  // Unlike "Healed", level drain lasts until restored, so it is real state.
  const r = foldCombatants(rows([
    "Shadow Thief: Two Levels Drained",
    "Brennan Risling: Item Drained",
  ]));
  assertEquals(find(r, "Shadow Thief")!.observations[0].name, "Level Drain");
  assertEquals(find(r, "Shadow Thief")!.observations[0].category, "disable");
  assertEquals(find(r, "Brennan Risling")!.observations[0].name, "Item Drained");
});

Deno.test("a vanished summon is cleared like a death", () => {
  const r = foldCombatants(rows([
    "Fire Elemental: Magic Resistance",
    "Fire Elemental: Unsummoned",
  ]));
  const fe = find(r, "Fire Elemental")!;
  assertEquals(fe.observations.length, 0);
  assertEquals(fe.diedAtId, 2);
});

Deno.test("sides and ordering come through", () => {
  const r = foldCombatants(rows(
    [
      "Jaheira: Attacks Cambion",
      "Cambion: Mirror Imaged",
    ],
    { Jaheira: "party", Cambion: "opponent" },
  ));
  assertEquals(find(r, "Jaheira")!.side, "party");
  assertEquals(find(r, "Cambion")!.side, "opponent");
  // Most recently involved first.
  assertEquals(r.combatants[0].name, "Cambion");
});

Deno.test("observations carry the clocks needed to age them", () => {
  const r = foldCombatants(rows([
    "Red Wizard: Casts Mirror Image : Red Wizard",
    "PAUSED",
    "Red Wizard: Attacks Jan",
  ]));
  const obs = find(r, "Red Wizard")!.observations[0];
  assertExists(obs.clockMs);
  assertExists(obs.gameTicks);
  // Age is the caller's job, but the raw material has to be present.
  assertEquals(r.latestId, 3);
});

Deno.test("an empty stream folds to nothing", () => {
  const r = foldCombatants([]);
  assertEquals(r.combatants, []);
  assertEquals(r.latestId, 0);
});
