/**
 * What the log cannot tell us: which spells and effects are *notable state*, and
 * what each one means.
 *
 * DOMAIN KNOWLEDGE, NOT LOG-DERIVED. Every other inference in this project is
 * read out of the captured data; this table is not, and that distinction matters
 * when judging how much to trust it. The names come from what the corpus
 * actually contains — `deno task patterns` reports coverage — but the semantics
 * attached to them come from the game's rules.
 *
 * Deliberately incomplete. IWDification adds 65+ spells to this install, so
 * unknown names must stay visible rather than being dropped: an unidentified
 * effect is still worth showing.
 */

/** Why a viewer cares about this effect. */
export type Category =
  /** Defensive — makes the creature harder to hurt. The original ask. */
  | "protection"
  /** Offensive state applied *to* the creature — it is disabled or weakened. */
  | "disable"
  /** Makes the creature stronger without blocking anything. */
  | "buff"
  /** Not state at all: an event that strips state. Drives clearing. */
  | "dispel";

/** What a protection stops. Empty for non-protections. */
export type Blocks =
  | "melee"
  | "ranged"
  | "weapons"
  | "physical"
  | "magic"
  | "spells"
  | "vision"
  | "mind"
  | "elemental";

/**
 * What a removal event takes off. Only meaningful for `category: "dispel"`.
 *
 * This axis is not optional detail: the six removal spells in this table do not
 * remove the same things, and folding them onto `dispellable` alone gets several
 * of them backwards. Spell Thrust strips Spell Turning and never touches Mirror
 * Image; Dispel Magic does the exact opposite; Breach removes Protection From
 * Magical Weapons, which no amount of Dispel Magic will.
 */
export type Strips =
  /** Dispel / Remove Magic — everything magically applied, by `dispellable`. */
  | "dispellable"
  /** Spell Thrust family — spell protections only, dispellable or not. */
  | "spell-protections"
  /** Breach — combat protections only, including undispellable ones. */
  | "combat-protections"
  /** True Sight family — concealment only. */
  | "concealment";

/**
 * Which `blocks` values each strip class removes. `dispellable` is special.
 *
 * Note that `spell-protections` does *not* include "magic". Magic Resistance is
 * an innate percentage, not a cast protection, and nothing in the Spell Thrust
 * family touches it — listing it here made Spellstrike wrongly wipe it off a
 * creature that simply has it.
 */
export const STRIPPED_BLOCKS: Record<Exclude<Strips, "dispellable">, Blocks[]> = {
  "spell-protections": ["spells"],
  "combat-protections": ["melee", "ranged", "weapons", "physical"],
  concealment: ["vision"],
};

export interface Effect {
  /** Canonical display name, as the spell is cast. */
  name: string;
  category: Category;
  blocks: Blocks[];
  /** Does Dispel Magic / Remove Magic clear it? Drives what a dispel wipes. */
  dispellable: boolean;
  /** For dispels only: what this event removes. Defaults to `dispellable`. */
  strips?: Strips;
  /**
   * The message the engine prints when it lands, when that differs from the
   * spell name — "Mirror Image" is cast, "Mirror Imaged" is the effect. Some
   * effects only ever appear in this form, with no cast observed.
   */
  effect?: string;
  /** How to get past it. The reason a player opens an inspector at all. */
  counter?: string;
}

const TABLE: Effect[] = [
  // --- Protections: weapons ------------------------------------------------
  {
    name: "Mirror Image",
    effect: "Mirror Imaged",
    category: "protection",
    blocks: ["melee", "ranged"],
    dispellable: true,
    counter: "each hit destroys one image; area spells ignore them",
  },
  {
    name: "Protection From Magical Weapons",
    effect: "Protected from Magical Weapons",
    category: "protection",
    blocks: ["weapons"],
    dispellable: false,
    counter: "non-magical weapons still land; short duration, wait it out",
  },
  {
    name: "Stoneskin",
    category: "protection",
    blocks: ["physical"],
    dispellable: true,
    counter: "each hit removes a skin; dispellable",
  },
  { name: "Ghost Armor", category: "protection", blocks: ["physical"], dispellable: true },
  { name: "Armor", category: "protection", blocks: ["physical"], dispellable: true },
  { name: "Shield", category: "protection", blocks: ["physical"], dispellable: true },
  {
    name: "Barkskin",
    effect: "Bark Skin",
    category: "protection",
    blocks: ["physical"],
    dispellable: true,
  },
  { name: "Blur", category: "protection", blocks: ["melee", "ranged"], dispellable: true },

  // --- Protections: spells -------------------------------------------------
  {
    name: "Spell Turning",
    effect: "Protected by Spell Turning",
    category: "protection",
    blocks: ["spells"],
    dispellable: false,
    counter: "returns spells to the caster; strip with Spell Thrust or Breach",
  },
  {
    name: "Spell Deflection",
    // Found by the coverage report once it started driving off the fold: the
    // spell was in the table but its effect message was not, so a creature seen
    // only through "Protected by Spell Deflection" showed up untagged.
    effect: "Protected by Spell Deflection",
    category: "protection",
    blocks: ["spells"],
    dispellable: false,
    counter: "absorbs spell levels; strip with Spell Thrust",
  },
  {
    name: "Minor Globe of Invulnerability",
    category: "protection",
    blocks: ["spells"],
    dispellable: false,
    counter: "blocks levels 1-3 outright; use higher-level spells",
  },
  { name: "Globe of Invulnerability", category: "protection", blocks: ["spells"], dispellable: false },
  {
    name: "Minor Spell Turning",
    effect: "Protected by Minor Spell Turning",
    category: "protection",
    blocks: ["spells"],
    dispellable: false,
    counter: "strip with Spell Thrust",
  },
  {
    name: "Iron Skins",
    category: "protection",
    blocks: ["physical"],
    dispellable: true,
    counter: "the druid form of Stoneskin; each hit removes a skin",
  },
  {
    // What a "was immune to my damage" probe implies. Named so the probe result
    // is categorized rather than sitting as "unknown".
    name: "damage immunity",
    category: "protection",
    blocks: ["physical"],
    dispellable: false,
    counter: "try another damage type",
  },
  {
    name: "Protection From Energy",
    category: "protection",
    blocks: ["elemental"],
    dispellable: true,
  },
  { name: "Fire Shield (Red)", category: "protection", blocks: ["elemental"], dispellable: true },
  { name: "Fire Shield (Blue)", category: "protection", blocks: ["elemental"], dispellable: true },
  {
    name: "Magic Resistance",
    category: "protection",
    blocks: ["magic"],
    dispellable: false,
    counter: "innate percentage; use non-magical damage",
  },
  {
    name: "Spell Ineffective",
    category: "protection",
    blocks: ["spells"],
    dispellable: false,
    counter: "something absorbed it; strip protections first",
  },

  // --- Protections: concealment -------------------------------------------
  {
    name: "Invisibility",
    effect: "Invisible",
    category: "protection",
    blocks: ["vision"],
    dispellable: true,
    counter: "See Invisibility or True Sight",
  },
  {
    name: "Shadow Door",
    category: "protection",
    blocks: ["vision"],
    dispellable: true,
    counter: "True Sight reveals it",
  },
  {
    name: "Improved Invisibility",
    category: "protection",
    blocks: ["vision", "melee"],
    dispellable: true,
  },
  { name: "Sanctuary", category: "protection", blocks: ["vision"], dispellable: true },
  { name: "Non-Detection", category: "protection", blocks: ["vision"], dispellable: true },

  // --- Protections: mind --------------------------------------------------
  {
    name: "Protection From Evil",
    effect: "Protected from Evil",
    category: "protection",
    blocks: ["mind"],
    dispellable: true,
  },
  { name: "Chaotic Commands", category: "protection", blocks: ["mind"], dispellable: true },
  { name: "Resist Fear", category: "protection", blocks: ["mind"], dispellable: true },

  // --- Buffs ---------------------------------------------------------------
  { name: "Haste", effect: "Hasted", category: "buff", blocks: [], dispellable: true },
  { name: "Improved Haste", category: "buff", blocks: [], dispellable: true },
  { name: "Strength of One", category: "buff", blocks: [], dispellable: true },
  { name: "Draw Upon Holy Might", category: "buff", blocks: [], dispellable: true },
  { name: "Barbarian Rage", category: "buff", blocks: ["mind"], dispellable: false },
  { name: "Contingency", effect: "Contingency Active", category: "buff", blocks: [], dispellable: false },
  { name: "Chain Contingency", category: "buff", blocks: [], dispellable: false },

  // --- Disables: applied TO the creature, so it is vulnerable now ----------
  {
    name: "Hold Person",
    effect: "Held",
    category: "disable",
    blocks: [],
    dispellable: true,
    counter: "helpless while it lasts - hit it now",
  },
  { name: "Domination", effect: "Dominated", category: "disable", blocks: [], dispellable: true },
  { name: "Fatigue", effect: "Fatigued", category: "disable", blocks: [], dispellable: false },
  { name: "Charm Person", effect: "Charmed", category: "disable", blocks: [], dispellable: true },
  { name: "Dire Charm", effect: "Dire charmed", category: "disable", blocks: [], dispellable: true },
  { name: "Chaos", category: "disable", blocks: [], dispellable: true },
  { name: "Confusion", effect: "Confused", category: "disable", blocks: [], dispellable: true },
  { name: "Horror", category: "disable", blocks: [], dispellable: true },
  { name: "Emotion, Fear", category: "disable", blocks: [], dispellable: true },
  { name: "Blindness", effect: "Blinded", category: "disable", blocks: [], dispellable: true },
  { name: "Silence", category: "disable", blocks: [], dispellable: true, counter: "cannot cast" },
  { name: "Sleep", effect: "Unconscious", category: "disable", blocks: [], dispellable: true },
  { name: "Stun", effect: "Stunned", category: "disable", blocks: [], dispellable: true },
  { name: "Web", category: "disable", blocks: [], dispellable: true },
  { name: "Entangle", effect: "Entangled", category: "disable", blocks: [], dispellable: true },
  { name: "Slow", effect: "Slowed", category: "disable", blocks: [], dispellable: true },
  { name: "Greater Malison", effect: "Saving Throws Lowered", category: "disable", blocks: [], dispellable: true },
  // Level and item drain persist until restored, so they are state, not a
  // transient notification — unlike "Healed" or "Strength Modification", which
  // the fold filters out.
  { name: "Level Drain", effect: "Two Levels Drained", category: "disable", blocks: [], dispellable: false },
  { name: "Item Drained", category: "disable", blocks: [], dispellable: false },
  { name: "Poison", effect: "Poisoned", category: "disable", blocks: [], dispellable: true },
  { name: "Disease", effect: "Diseased", category: "disable", blocks: [], dispellable: true },
  { name: "Panic", category: "disable", blocks: [], dispellable: true },
  { name: "Paralyze", effect: "Paralyzed", category: "disable", blocks: [], dispellable: true, counter: "helpless - hit it now" },
  { name: "Harpy Wail", category: "disable", blocks: [], dispellable: true, counter: "sleep effect; Chaotic Commands prevents it" },
  { name: "Bless", category: "buff", blocks: [], dispellable: true },

  // --- Dispels: events that strip state, not state itself -----------------
  // See `Strips`. These are grouped by what they remove, not by spell level,
  // because what they remove is the only part the fold acts on.
  { name: "Dispel Magic", effect: "Dispel Effects", category: "dispel", blocks: [], dispellable: false, strips: "dispellable" },
  { name: "Remove Magic", category: "dispel", blocks: [], dispellable: false, strips: "dispellable" },

  { name: "Spell Thrust", category: "dispel", blocks: [], dispellable: false, strips: "spell-protections" },
  { name: "Secret Word", category: "dispel", blocks: [], dispellable: false, strips: "spell-protections" },
  { name: "Pierce Magic", category: "dispel", blocks: [], dispellable: false, strips: "spell-protections" },
  {
    // The level 9 version: strips every spell protection with nothing able to
    // stop it. Observed as an `effect` line naming its target — "Shade Lord:
    // Spellstrike : Anomen".
    name: "Spellstrike",
    category: "dispel",
    blocks: [],
    dispellable: false,
    strips: "spell-protections",
  },
  {
    // Not a spell: the engine's confirmation that a strip landed, printed on the
    // creature it happened to ("Anomen: Spell Protections Removed"). Shared by
    // the whole Spell Thrust family, so it is its own entry rather than the
    // `effect` of any one of them. This is the strongest removal signal in the
    // log — a named creature, confirmed stripped, no inference needed.
    name: "Spell Protections Removed",
    category: "dispel",
    blocks: [],
    dispellable: false,
    strips: "spell-protections",
  },

  { name: "Breach", category: "dispel", blocks: [], dispellable: false, strips: "combat-protections" },

  // Two separate spells in BG2EE - the cleric's and the mage's - with the same
  // effect, so both are listed rather than paired as name/effect.
  { name: "True Sight", category: "dispel", blocks: [], dispellable: false, strips: "concealment" },
  { name: "True Seeing", category: "dispel", blocks: [], dispellable: false, strips: "concealment" },
  { name: "Invisibility Purge", category: "dispel", blocks: [], dispellable: false, strips: "concealment" },
];

/**
 * What an `immune` probe result implies. These are the strongest signal in the
 * log: unlike a cast, a probe proves the protection is up *right now*.
 */
const PROBE_MEANING: Record<string, string> = {
  weapon: "Protection From Magical Weapons",
  damage: "damage immunity",
};

/**
 * Names judged and deliberately given no semantics: they are not persistent
 * state, so there is nothing for this table to say about them.
 *
 * **Report scope only — this does not hide anything.** A declined name still
 * appears on its card, untagged, exactly as any unrecognized name does. The two
 * are deliberately separate concerns: `NOT_STATE` in combatants.ts decides what
 * the view shows, and this list decides what the coverage report still asks
 * about. Being sure a name is not a protection is not a reason to stop showing
 * that the creature did it.
 *
 * It exists so the report has a finite queue. Without it every run re-lists
 * Magic Missile and Cure Serious Wounds among the "missing" names, the ratio
 * never improves, and the genuinely unjudged entries — the two-occurrence
 * `Physical Mirror` that *is* a protection — stay buried under high-frequency
 * noise that will never be added. Recording the verdict is what turns the report
 * from a standing complaint into a shrinking worklist.
 *
 * Grouped by why, because the reason is the reusable part: a future name that
 * looks like one of these groups can be declined on the same grounds.
 */
const DECLINED_GROUPS: Record<string, string[]> = {
  // Damage. Shows in the events table, where amounts belong; not a condition.
  damage: [
    "Magic Missile", "Chromatic Orb", "Lightning Bolt", "Fireball", "Cone of Cold",
    "Melf's Minute Meteors", "Melf's Acid Arrow", "Flame Arrow", "Agannazar's Scorcher",
    "Ice Shard", "Icelance", "Magma Ball", "Mist Ball", "Sooty Ball", "Water Jet",
    "Flame Strike", "Flame Fan", "Flame Jet", "Skull Trap", "Disintegrate",
    "Lance of Disruption", "Abi-Dalzim's Horrid Wilting", "Cloudkill", "Death Spell",
    "Vampiric Touch", "Larloch's Minor Drain", "Unholy Blight", "Call Lightning",
    "Smashing Wave", "Boiling Rain Storm", "Salt Crystals", "Glass Dust", "Grit",
    "Breathes Grit", "Mimic Acid", "Mimic Glue", "Spike Growth", "Spike Stones",
    "Blade Barrier", "Teleport Field", "Mordenkainen's Sword",
  ],
  // Healing and restoration. Transient, and the HP is already in the log.
  healing: [
    "Cure Light Wounds", "Cure Moderate Wounds", "Cure Medium Wounds",
    "Cure Serious Wounds", "Cure Critical Wounds", "Mass Cure", "Heal",
    "Lesser Restoration", "Cause Serious Wounds", "Cause Critical Wounds",
  ],
  // Summoning. The creature it produces is tracked in its own right, and the
  // `summon` column already separates it out.
  summoning: [
    "Summon Insects", "Insect Plague", "Giant Insect", "Conjure Fire Elemental",
    "Conjure Animals", "Conjure Lesser Water Elemental", "Animate Dead",
    "Call Woodland Beings", "Monster Summoning II", "Monster Summoning III",
    "Animal Summoning II", "Aerial Servant", "Summon Planetar", "Summon Deva",
    "Spider Spawn", "Shadow Monsters", "Create Bruiser Mates", "Simulacrum",
  ],
  // Movement and form changes. Real, but they say nothing about durability, and
  // a shapeshift's own name is more use than "Shapeshift: Polar Bear" as state.
  movement: [
    "Dimension Door", "Shadowstep", "Teleport", "Polymorph Self",
    "Shapeshift: Natural Form", "Shapeshift: Fire Elemental", "Shapeshift: Polar Bear",
    "Shapeshift: Baby Wyvern", "Shapeshift: Mustard Jelly", "Beast Claw",
  ],
  // Wild magic and misc engine chatter with no state behind it.
  other: [
    "Nahal's Reckless Dweomer", "Limited Wish", "Time Stop", "Power Attack",
    "Activate Shot Ability", "Enrage", "Berserk",
    "Wild Surge: Silence", "Wild Surge: Color change",
    "Teleport Without Error", "Releases Acidic Vapor", "Irritated by Glass Dust",
  ],
  // Thief skill feedback. Attributed to a creature and shaped like an effect
  // name, so it clears the fold's shape guard, but it reports an *action* and
  // its outcome rather than any lasting condition.
  thieving: [
    "Pick Pockets Succeeded", "Searching for traps", "Hide In Shadows Failed",
    "Attempting to hide in shadows",
  ],
};

const DECLINED = new Set(
  Object.values(DECLINED_GROUPS).flat().map((n) => norm(n)),
);

/**
 * Judged and left out on purpose — keeps the coverage queue finite.
 *
 * For the report only. The fold must not consult this: a declined name is still
 * shown on its card, just uncategorized.
 */
export function isDeclined(name: string | null): boolean {
  return name !== null && DECLINED.has(norm(name));
}

const BY_NAME = new Map<string, Effect>();
for (const e of TABLE) {
  BY_NAME.set(norm(e.name), e);
  if (e.effect) BY_NAME.set(norm(e.effect), e);
}

/** Case- and spacing-insensitive, since the engine's wording varies. */
function norm(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Look a spell or effect name up. Null means "no semantics known". */
export function asEffect(name: string | null): Effect | null {
  if (name === null) return null;
  return BY_NAME.get(norm(name)) ?? null;
}

/** Is this name an event that strips state rather than state itself? */
export function isDispel(name: string | null): boolean {
  return asEffect(name)?.category === "dispel";
}

/**
 * What this removal event strips. `dispellable` is the conservative default for
 * a dispel with no explicit class, and null for anything that is not a dispel.
 */
export function stripsOf(name: string | null): Strips | null {
  const e = asEffect(name);
  return e?.category === "dispel" ? e.strips ?? "dispellable" : null;
}

/** What an `immune` event's detail implies, for display beside a probe result. */
export function probeMeaning(detail: string | null): string | null {
  if (detail === null) return null;
  return PROBE_MEANING[detail] ?? null;
}
