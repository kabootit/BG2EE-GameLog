/**
 * Folds the event stream into per-creature state: what has been seen on each
 * combatant, how it was learned, and how long ago.
 *
 * The central constraint, established from 61k captured events: **the game never
 * announces an effect ending.** There is no "wears off" message, and durations
 * scale with caster level, which the log never reveals. So this deliberately
 * does not model "active" — it reports observations with their age and lets the
 * reader judge. The only things that clear state observably are death, a dispel,
 * and the end of the session.
 *
 * A pure fold over rows, with no database or network access, so it can be tested
 * directly and reused by any future renderer.
 */
import {
  asEffect,
  type Blocks,
  type Category,
  probeMeaning,
  STRIPPED_BLOCKS,
  type Strips,
  stripsOf,
} from "./protections.ts";

/**
 * The stored row shape, snake_case as SQLite returns it. Coupled to the schema
 * on purpose: a mapping layer here would be one more place for a field to go
 * missing silently.
 */
export interface EventRow {
  id: number;
  kind: string;
  actor: string | null;
  target: string | null;
  detail: string | null;
  raw: string;
  game_ticks: number | null;
  clock_ms: number | null;
  actor_side: string | null;
  target_side: string | null;
  summon: string | null;
  target_summon: string | null;
}

/** How an observation was learned, weakest to strongest. */
export type Source =
  /** A cast naming this creature as the target. Intent, not confirmation. */
  | "cast"
  /** The engine printed the effect on this creature. It landed. */
  | "effect"
  /** An attack proved it: the strongest evidence, because it is true *now*. */
  | "probe";

export interface Observation {
  /** Canonical name when known, otherwise exactly as the game printed it. */
  name: string;
  /** "unknown" when the name has no entry in protections.ts. */
  category: Category | "unknown";
  blocks: Blocks[];
  dispellable: boolean;
  counter: string | null;
  source: Source;
  /** Event id it was seen at, and clocks for aging. */
  id: number;
  gameTicks: number | null;
  clockMs: number | null;
}

export interface Combatant {
  name: string;
  side: string | null;
  isSummon: boolean;
  observations: Observation[];
  /** Spell announced but not yet resolved — an incoming effect. */
  casting: string | null;
  /** Most recent event mentioning them at all, as actor or target. */
  lastSeenId: number;
  lastSeenClockMs: number | null;
  /** Last thing they were seen doing, for context in the UI. */
  lastAction: string | null;
  /** Set on death. Kept rather than dropped so the caller can choose. */
  diedAtId: number | null;
}

export interface FoldResult {
  combatants: Combatant[];
  /** Newest event id folded, so the caller can report the age of the whole view. */
  latestId: number;
  latestClockMs: number | null;
}

/** Strength order — a probe supersedes an effect, which supersedes a cast. */
const STRENGTH: Record<Source, number> = { cast: 0, effect: 1, probe: 2 };

interface Mutable extends Combatant {
  /** Keyed by canonical name so a re-observation refreshes rather than duplicates. */
  byName: Map<string, Observation>;
}

function blank(name: string): Mutable {
  return {
    name,
    side: null,
    isSummon: false,
    observations: [],
    casting: null,
    lastSeenId: 0,
    lastSeenClockMs: null,
    lastAction: null,
    diedAtId: null,
    byName: new Map(),
  };
}

/**
 * Engine broadcasts whose "speaker" is a phrase, not a creature. The speaker
 * split in parse.ts cannot tell them apart — "Your journal has been updated:
 * Free Hendak" looks exactly like a creature talking — so they are excluded
 * here, where creature identity is what matters.
 *
 * Evidence-based: these are the only such prefixes in 61k events.
 */
const NOT_A_CREATURE = /^(?:Your\s|The\s+Party\s|HINT\b)/i;

/**
 * Text that says nothing about *persistent* state.
 *
 * `status` is the catch-all bucket for attributed-but-unmatched text, and it is
 * the largest kind after dialogue — roughly 2,100 of its rows are a thief
 * toggling Detect Traps. Without this filter every combatant accumulates dozens
 * of meaningless entries and the inspector is unreadable.
 *
 * Grouped by family rather than listed line by line, so a new message of a known
 * family is excluded without another edit.
 */
const NOT_STATE = new RegExp([
  // Thief skills: toggles and per-attempt outcomes.
  String.raw`^(?:Stopped\s+)?Detecting\b`,
  String.raw`^(?:Trap|Lock\s*Pick)\b`,
  // Transient outcomes of a single event, not a lasting condition.
  String.raw`^Healed\b`,
  String.raw`^Damage\s+Taken\b`,
  String.raw`^(?:Unaffected|Evades|Resisted|Immune)\b`,
  // Per-event stat notifications.
  String.raw`^Strength\s+Modification\b`,
  String.raw`^Spell\s+caster\s+level\b`,
  // Structural lines that can reach the status bucket.
  String.raw`^Quick\s+save`,
  String.raw`^LOCKED`,
  String.raw`^Death$`,
  String.raw`^Spell\s+Failed`,
  String.raw`^Casting\b`,
  String.raw`^Attack\s+Roll`,
  String.raw`^Roll:`,
  String.raw`^(?:Attacks|is\s+Attacking)\b`,
  String.raw`^Save\s+vs`,
  String.raw`^Weapon\s+Ineffective`,
  String.raw`^Critical\b`,
  String.raw`^Auto-?Paused`,
  String.raw`^(?:UN)?PAUSED$`,
].join("|"), "i");

/** A summon vanishing leaves no state behind, same as a death. */
const GONE = /^Unsummoned$/i;

/**
 * Unknown effect names are kept deliberately — IWDification adds 65+ spells and
 * an unidentified protection still matters — but prose must not slip through in
 * their place. A shape guard rather than another blocklist: effect names are
 * short and unpunctuated, prose is neither.
 *
 * Defense in depth. The classifier should have called that prose `dialogue`; this
 * stops one missed case from filling the inspector with speech.
 */
function looksLikeEffectName(text: string): boolean {
  return text.length <= 48 && text.split(/\s+/).length <= 6 && !/[.!?,;]/.test(text);
}

export function foldCombatants(rows: EventRow[]): FoldResult {
  const all = new Map<string, Mutable>();
  let latestId = 0;
  let latestClockMs: number | null = null;

  /** Null for engine broadcasts that only look like a creature speaking. */
  const get = (name: string | null) => {
    if (name === null || NOT_A_CREATURE.test(name)) return null;
    let c = all.get(name);
    if (c === undefined) {
      c = blank(name);
      all.set(name, c);
    }
    return c;
  };

  /** Record who is involved, regardless of what happened. */
  const touch = (c: Mutable, row: EventRow, side: string | null, isSummon: boolean) => {
    if (side !== null) c.side = side;
    if (isSummon) c.isSummon = true;
    if (row.id >= c.lastSeenId) {
      c.lastSeenId = row.id;
      c.lastSeenClockMs = row.clock_ms;
    }
  };

  const observe = (c: Mutable, rawName: string, source: Source, row: EventRow) => {
    const known = asEffect(rawName);
    // A dispel is an event, not state — it must never become an observation.
    if (known?.category === "dispel") return;

    // A cast of an *unknown* spell at someone says almost nothing: most spells
    // are attacks, and "Casts Icelance : Cernd" is damage, not a condition. Keep
    // unknowns only when something was seen to land on them, or when a probe
    // proved it. Known protections and disables still show from a cast alone.
    if (known === null && source === "cast") return;

    const name = known?.name ?? rawName;
    const existing = c.byName.get(name);
    // Keep the strongest evidence; on a tie the newer sighting wins, which is
    // what makes the age meaningful.
    if (existing && STRENGTH[existing.source] > STRENGTH[source] && existing.id >= row.id) return;

    c.byName.set(name, {
      name,
      category: known?.category ?? "unknown",
      blocks: known?.blocks ?? [],
      dispellable: known?.dispellable ?? true,
      counter: known?.counter ?? null,
      source,
      id: row.id,
      gameTicks: row.game_ticks,
      clockMs: row.clock_ms,
    });
  };

  /**
   * Drop what this particular removal event strips, leaving the rest in place.
   *
   * Which class it is decides the answer, and the classes disagree: Dispel Magic
   * takes Mirror Image and leaves Spell Turning, Spell Thrust does the reverse,
   * and Breach takes Protection From Magical Weapons that neither of them can.
   * Filtering on `dispellable` alone was getting the latter two backwards.
   */
  const dispel = (c: Mutable, strips: Strips) => {
    for (const [name, obs] of [...c.byName]) {
      const hit = strips === "dispellable"
        ? obs.dispellable
        : obs.blocks.some((b) => STRIPPED_BLOCKS[strips].includes(b));
      if (hit) c.byName.delete(name);
    }
    // An in-flight cast is interrupted by any of them.
    c.casting = null;
  };

  for (const row of rows) {
    latestId = Math.max(latestId, row.id);
    if (row.clock_ms !== null) latestClockMs = row.clock_ms;

    const actor = get(row.actor);
    const target = get(row.target);
    if (actor) touch(actor, row, row.actor_side, row.summon !== null);
    if (target) touch(target, row, row.target_side, row.target_summon !== null);

    switch (row.kind) {
      case "death":
        // The subject of "X: Death" is the speaker.
        if (actor) {
          actor.diedAtId = row.id;
          actor.byName.clear();
          actor.casting = null;
        }
        break;

      case "cast_start":
        // Announced but unresolved, and it names no target — so this is only
        // ever "this creature is casting X", never a landed effect.
        if (actor && row.detail !== null) actor.casting = row.detail;
        break;

      case "spell": {
        if (actor) actor.casting = null;
        if (row.detail === null) break;
        // A dispel lands on its target and strips, rather than adding.
        const strips = stripsOf(row.detail);
        if (strips !== null) {
          if (target) dispel(target, strips);
          else if (actor) dispel(actor, strips);
          break;
        }
        // The cast names its target, so the effect belongs to them. Self-buffs
        // name the caster, which falls out of this for free.
        if (target) observe(target, row.detail, "cast", row);
        break;
      }

      case "immune": {
        // The protection is on the creature that shrugged the hit off, not the
        // attacker who spoke the line. EventLinker fills `target` in for the
        // "Weapon Ineffective" form, which names nobody.
        const meaning = probeMeaning(row.detail);
        if (target && meaning !== null) observe(target, meaning, "probe", row);
        break;
      }

      case "status":
      case "effect": {
        // Who ends up with the effect differs between the two forms. A bare
        // `status` name belongs to the speaker ("Duergar: Held"), but an
        // `effect` line names its recipient ("Vampire: Domination : Rurik"
        // means Rurik is dominated, not the vampire).
        const subject = row.kind === "effect" ? (target ?? actor) : actor;
        if (subject === null) break;
        // `status` is the catch-all bucket, so most of it is not state at all.
        const text = row.detail ?? bodyOf(row.raw);
        if (text === null || NOT_STATE.test(text)) break;
        // Known names bypass the shape guard: some are long ("Protection From
        // Magical Weapons") and the table is the better authority.
        if (asEffect(text) === null && !looksLikeEffectName(text)) break;
        // A summon vanishing leaves nothing behind, same as dying.
        if (GONE.test(text)) {
          subject.diedAtId = row.id;
          subject.byName.clear();
          subject.casting = null;
          break;
        }
        // A removal reaches here in either form, and both name the creature it
        // happened *to*: "Anomen: Spell Protections Removed" as a status on the
        // subject, "Shade Lord: Spellstrike : Anomen" as an effect on the target.
        // Until both names were in protections.ts they fell through to observe()
        // and showed as untagged observations — read as state gained, when the
        // thing being reported is state lost.
        const stripped = stripsOf(text);
        if (stripped !== null) {
          dispel(subject, stripped);
          break;
        }
        observe(subject, text, "effect", row);
        break;
      }

      case "attack":
        if (actor && row.target !== null) actor.lastAction = `attacking ${row.target}`;
        break;
    }
  }

  const combatants: Combatant[] = [];
  for (const c of all.values()) {
    const { byName, ...rest } = c;
    combatants.push({
      ...rest,
      observations: [...byName.values()].sort((a, b) => b.id - a.id),
    });
  }

  // Most recently involved first: in a fight that is the order that matters.
  combatants.sort((a, b) => b.lastSeenId - a.lastSeenId);
  return { combatants, latestId, latestClockMs };
}

/** The text after "Speaker: ", which is where a bare effect name lives. */
function bodyOf(raw: string): string | null {
  const m = /^[A-Za-z][A-Za-z'\- ]{0,29}:\s*(.+)$/.exec(raw);
  return m === null ? null : m[1];
}
