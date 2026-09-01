import { ROSTER_MARKER, TAP_MARKER } from "./config.ts";

export type Side = "party" | "opponent" | "neutral";

export type Kind =
  | "attack"
  | "damage"
  | "critical"
  | "death"
  | "xp"
  | "gold"
  | "save"
  | "spell"
  | "miscast"
  | "effect"
  | "status"
  | "action"
  | "song"
  | "pause"
  | "level"
  | "loot"
  | "party"
  | "dialogue"
  | "other";

export interface GameEvent {
  id: number;
  wallClock: string | null;
  gameTicks: number | null;
  clockMs: number | null;
  gameTime: string;
  screen: string;
  kind: Kind;
  actor: string | null;
  target: string | null;
  amount: number | null;
  /** Sub-type: damage type, save type, spell name, hit/miss, pause reason. */
  detail: string | null;
  /** Set on a damage event that a preceding "Critical Hit" line belongs to. */
  critical: boolean;
  /** Inferred: the spell a damage event is attributed to. Null for weapon damage. */
  spell: string | null;
  /**
   * The cast that *would* have been attributed if the damage type were trusted.
   * Always recorded, whatever the type, so a spell type missing from
   * SPELL_DAMAGE_TYPES shows up in `deno task patterns` instead of vanishing.
   */
  spellCandidate: string | null;
  /** Which side the actor / target are on. Resolved by SideResolver, not by the line itself. */
  actorSide: Side | null;
  targetSide: Side | null;
  /**
   * The actor's / target's name when that creature was summoned, so summons can
   * be shown apart from the party. Both sides are needed: a summon is often the
   * victim rather than the aggressor, and a summon-as-actor column alone hides
   * every creature that took damage without dealing any.
   */
  summon: string | null;
  targetSummon: string | null;
  raw: string;
}

/**
 * Infinity Engine colour markup. The engine formats these as "^" followed by
 * "0x" + 8 hex digits to open, and "^-" to close.
 */
const COLOUR = /\^(?:0x[0-9a-fA-F]{8}|#[0-9a-fA-F]{6,8}|-)/g;

export function stripColour(s: string): string {
  return s.replace(COLOUR, "").trim();
}

/**
 * Almost every line the engine puts in the message window is prefixed with the
 * creature it belongs to: "Alarion: I'm ready.", "Tyras:  Enrage : Tyras",
 * "Zeris: Singing Bard Song". Splitting that off first gives the actor for free
 * and leaves a much simpler body to classify.
 *
 * The name pattern deliberately excludes digits and "=", so engine text such as
 * "Attack Roll 18 -4 = 14 : Hit" is not mistaken for a speaker called
 * "Attack Roll 18 -4 = 14".
 */
const SPEAKER = /^(?<speaker>[A-Za-z][A-Za-z'\- ]{0,29}):\s*(?<rest>.+)$/;

/** Prose ends in sentence punctuation; engine status text ("Contingency Active") does not. */
const SENTENCE = /[.!?]["')\]]?$/;

/**
 * Classification rules, tried in order against the text with the speaker
 * removed; first match wins.
 *
 * Derived from real captured output over a full session (706 events), including
 * combat resolution. Still guesses, because they have not been observed yet:
 * experience, gold, loot, level-up and party messages.
 *
 * Anything unmatched is kept verbatim rather than mislabelled - "other" when it
 * has no speaker, "status" when it does. Run `deno task patterns` to see both
 * buckets, add rules, then `deno task import` to re-classify without replaying.
 */
const RULES: Array<{ kind: Kind; re: RegExp }> = [
  { kind: "pause", re: /^(?:UN)?PAUSED$/i },
  { kind: "pause", re: /^Auto-?Paused\s*:\s*(?<detail>.+)$/i },

  // "*attempts to hide in shadows*"
  { kind: "action", re: /^\*(?<detail>.+)\*$/ },

  { kind: "song", re: /^(?:Stopped\s+)?Singing\s+(?<detail>.+)$/i },

  // "Takes 18 crushing damage from Vampire (9 damage bonus)".
  // The speaker is the victim here, so the rule names a `source` group; classify()
  // then makes the source the actor, which is what makes "damage dealt per actor"
  // group correctly.
  {
    kind: "damage",
    re:
      /^Takes\s+(?<amount>\d+)\s+(?<detail>[A-Za-z]+)\s+damage\s+from\s+(?<source>.+?)(?:\s*\(\d+\s+damage\s+bonus\))?$/i,
  },
  // Anchored at the start so a *description* of damage ("...will take 15
  // damage.") is not counted as damage being dealt.
  { kind: "damage", re: /^Damage\s+Taken\s*[:=]\s*(?<amount>\d+)/i },
  {
    kind: "damage",
    re: /^(?:takes?|suffers?|receives?)\s+(?<amount>\d+)\s+(?:points?\s+of\s+)?damage\b/i,
  },

  // "Attack Roll 6 + 16 = 22 : Hit" -> amount is the total, detail is Hit/Miss.
  {
    kind: "attack",
    re:
      /^Attack\s+Roll\s+-?\d+\s*[+-]\s*\d+\s*=\s*(?<amount>-?\d+)\s*:\s*(?<detail>[A-Za-z]+)$/i,
  },
  { kind: "attack", re: /^Attack\s+Roll\s*[:=]?\s*(?<amount>-?\d+)/i },
  { kind: "attack", re: /^Attacks\s+(?<target>.+)$/i },

  // "Critical Hit", "Critical Hit Averted"
  { kind: "critical", re: /^Critical\s+(?<detail>.+)$/i },

  // "Save vs. Spell : 11", "Save vs. Death : 21"
  { kind: "save", re: /^Save\s+vs\.?\s*(?<detail>[A-Za-z][A-Za-z .]*?)\s*:\s*(?<amount>-?\d+)$/i },
  { kind: "save", re: /\bSav(?:e|ing)\s+Throw\b/i },

  { kind: "death", re: /^Death$/i },
  // Leading \b matters: without it, "dies" matches inside "bodies".
  { kind: "death", re: /\b(?:has\s+died|has\s+been\s+killed|is\s+dead|dies|slain)\b/i },

  // "Casts Magic Missile : Vampire" - the cast names its primary target, so
  // split it off rather than leaving it glued to the spell name.
  { kind: "spell", re: /^Casts?\s+(?<detail>.+?)\s+:\s+(?<target>.+)$/i },
  { kind: "spell", re: /^Casts?\s+(?<detail>.+)$/i },
  // Distinct kind: a failed cast must never be attributed as a damage source.
  { kind: "miscast", re: /^Spell\s+Failed\s*:\s*(?<detail>.+)$/i },

  { kind: "level", re: /\blevel(?:ed|led)?\s*up\b|\bgained\s+a\s+level\b/i },
  { kind: "xp", re: /\bexperience\b[^0-9]{0,24}(?<amount>\d+)/i },
  { kind: "xp", re: /(?<amount>\d+)\s+experience\b/i },
  { kind: "gold", re: /(?<amount>\d+)\s+gold\b/i },
  { kind: "loot", re: /\byou\s+(?:found|acquired|received|obtained)\b/i },
  { kind: "party", re: /\bgather\s+your\s+party\b|\bjoined\s+the\s+party\b/i },

  // "Enrage : Tyras", "Stoneskin : Gaul" - an effect applied to someone.
  // Last, so more specific colon-separated forms above win first.
  { kind: "effect", re: /^[A-Za-z][A-Za-z'\- ]{0,30}?\s+:\s+(?<target>.+)$/ },
];

function toInt(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function clean(v: string | undefined): string | null {
  if (v === undefined) return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

type Classified = Pick<GameEvent, "kind" | "actor" | "target" | "amount" | "detail">;

export function classify(text: string): Classified {
  const speaker = SPEAKER.exec(text);
  const actor = clean(speaker?.groups?.speaker);
  const body = speaker?.groups?.rest ?? text;

  for (const { kind, re } of RULES) {
    const m = re.exec(body);
    if (m) {
      const g = m.groups ?? {};
      // A `source` group means the line is written from the receiving end
      // ("Vampire: Takes 13 slashing damage from Tyras"). Flip it so the actor
      // is whoever did it and the target is whoever it happened to.
      const source = clean(g.source);
      return {
        kind,
        actor: source ?? actor,
        target: source ? actor : clean(g.target),
        amount: toInt(g.amount),
        detail: clean(g.detail),
      };
    }
  }

  // Attributed prose is speech; attributed non-prose is engine status text
  // ("Stunned", "Contingency Active", "Two Levels Drained"). Unattributed and
  // unmatched stays "other", which is what `deno task patterns` reports on.
  const kind: Kind = actor === null ? "other" : SENTENCE.test(body) ? "dialogue" : "status";
  return { kind, actor, target: null, amount: null, detail: null };
}

/**
 * Parse one captured line. Returns null for anything that is not a tap line —
 * the game writes plenty of unrelated output to stdout.
 *
 * Wire format: A7LOG <id> <gameTicks> <clockMs> <gameTime> <screen> <text>
 *
 * The engine does not emit that verbatim. Infinity_Log output reaches stdout
 * wrapped in the platform log prefix, e.g.
 *
 *   2026-08-31 00:11:26.976 BaldursGateIIEnhancedEdition[884:110912] INFO: LUA: A7LOG<TAB>0<TAB>...
 *
 * so the marker is located rather than anchored, and the leading timestamp is
 * kept as real wall-clock time for the event.
 */
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s/;

export function parseLine(line: string): GameEvent | null {
  // The pty adds \r, and macOS `script` opens the transcript with a "^D\b\b" artifact.
  const trimmed = line.replace(/\r/g, "").replace(/^\^D[\b]*/, "");

  const at = trimmed.indexOf(`${TAP_MARKER}\t`);
  if (at === -1) return null;

  // Guard against the marker appearing inside game text: it is a tap line only
  // if nothing precedes it, or what precedes it is the engine's Lua log prefix.
  const prefix = trimmed.slice(0, at);
  if (prefix.length > 0 && !prefix.includes("LUA:")) return null;

  const f = trimmed.slice(at).split("\t");
  if (f.length < 7) return null;

  const id = toInt(f[1]);
  if (id === null) return null;

  const raw = stripColour(f.slice(6).join("\t"));
  return {
    id,
    wallClock: WALL_CLOCK.exec(prefix)?.[1] ?? null,
    gameTicks: toInt(f[2]),
    clockMs: toInt(f[3]),
    gameTime: f[4],
    screen: f[5],
    raw,
    critical: false,
    spell: null,
    spellCandidate: null,
    actorSide: null,
    targetSide: null,
    summon: null,
    targetSummon: null,
    ...classify(raw),
  };
}

/**
 * The engine reports a critical as its own line, separate from the damage it
 * produced:
 *
 *   Vampire: Attack Roll 19 + 7 = 26 : Hit
 *   Vampire: Critical Hit
 *   Mireille: Takes 64 crushing damage from Vampire (32 damage bonus)
 *
 * The crit line's speaker is the attacker, which is also the damage line's
 * `actor` once the source swap has been applied - so a crit can be attached to
 * the damage it caused by matching on actor. Crits always precede their damage,
 * so a single forward pass works for both live capture and re-import.
 *
 * "Critical Hit Averted" is deliberately excluded: it means a critical was
 * prevented, and the damage that follows it is ordinary damage.
 */
/**
 * Damage types attributed to spells.
 *
 * Deliberately narrow. The engine never says what caused a damage line - it only
 * names the creature - so the spell has to be inferred from a preceding cast, and
 * a wrong attribution is worse than a blank one. Physical types (slashing,
 * crushing, piercing, missile) are weapon hits and must never be attributed.
 *
 * "acid" is excluded on evidence: the one acid line in the captured data
 * (8 acid from Gaul) follows a Greater Malison cast, which deals no damage at
 * all - attributing it would have been wrong.
 *
 * This list is expected to grow as more spell schools show up in play. You do
 * not have to remember to revisit it: every damage row records its
 * `spellCandidate` regardless of type, and `deno task patterns` reports which
 * types are arriving after a cast but going unattributed. Promote a type here
 * when that report shows the evidence, then `deno task import` to re-apply it.
 */
const SPELL_DAMAGE_TYPES = new Set(["magic"]);

/**
 * Party roster line emitted by the tap: `A7ROSTER<TAB>Name<TAB>Name...`
 * Returns null for anything else.
 */
export function parseRoster(line: string): string[] | null {
  const trimmed = line.replace(/\r/g, "");
  const at = trimmed.indexOf(`${ROSTER_MARKER}\t`);
  if (at === -1) return null;
  const prefix = trimmed.slice(0, at);
  if (prefix.length > 0 && !prefix.includes("LUA:")) return null;
  const names = trimmed.slice(at).split("\t").slice(1).map((n) => n.trim()).filter(Boolean);
  return names.length > 0 ? names : null;
}

/**
 * Works out who is on the party's side and who is fighting them.
 *
 * Nothing in a log line states this, so it comes from two kinds of evidence:
 *
 *  1. The party roster emitted by the tap (`characters[].name`) - authoritative,
 *     but only present in sessions captured after the roster tap was added.
 *  2. "Auto-Paused" lines. Auto-pause is a party-side feature, so anyone who
 *     triggers one is on the party's side. In the captured data this named
 *     exactly the six party members plus their four summons, and never an enemy.
 *     This works retroactively on sessions recorded before the roster existed.
 *
 * Everyone else is classified by who they fight: an unknown name that trades
 * damage or attacks with a party-side name is an opponent. Names that only ever
 * talk (arena announcers, quest givers) stay "neutral" rather than being forced
 * into a side they were never on.
 *
 * Party membership always wins over the combat graph, which is what keeps
 * friendly fire from mislabelling an ally - the captured session has Rurik
 * hitting Zeris for 8, and Zeris stays party because auto-pause named him.
 */
export class SideResolver {
  private roster = new Set<string>();
  private autoPaused = new Set<string>();
  private spoke = new Set<string>();
  private edges: Array<[string, string]> = [];
  private dirty = true;
  private sides = new Map<string, Side>();
  private summons = new Set<string>();

  addRoster(names: string[]): void {
    for (const name of names) {
      if (!this.roster.has(name)) {
        this.roster.add(name);
        this.dirty = true;
      }
    }
  }

  observe(event: GameEvent): void {
    if (event.actor === null) return;

    // Speech separates party members from their summons: you can click a party
    // member and get a response, and summoned creatures never say anything.
    if (event.kind === "dialogue" && !this.spoke.has(event.actor)) {
      this.spoke.add(event.actor);
      this.dirty = true;
    }

    if (event.kind === "pause" && /Auto-?Paused/i.test(event.raw)) {
      if (!this.autoPaused.has(event.actor)) {
        this.autoPaused.add(event.actor);
        this.dirty = true;
      }
      return;
    }

    // A hostile exchange. Attacks and damage both count; healing and effects do not.
    if ((event.kind === "damage" || event.kind === "attack") && event.target !== null) {
      this.edges.push([event.actor, event.target]);
      this.dirty = true;
    }
  }

  resolve(): Map<string, Side> {
    if (!this.dirty) return this.sides;

    const sides = new Map<string, Side>();
    const allies = new Set([...this.roster, ...this.autoPaused]);

    // Summons fight on the party's side, so they *are* party for the purpose of
    // `side`. Which of them were summoned is tracked separately, for the summon
    // column, rather than being folded into the side - keeping it out means
    // "party vs opponent" totals still account for everything the party fielded.
    //
    // The roster is exact when present; before the roster tap existed, speech is
    // the stand-in, since party members answer when clicked and summons never
    // say anything. A member who is never clicked would be taken for a summon,
    // which the roster corrects for good.
    this.summons = new Set<string>();
    for (const name of allies) {
      sides.set(name, "party");
      const isMember = this.roster.size > 0 ? this.roster.has(name) : this.spoke.has(name);
      if (!isMember) this.summons.add(name);
    }

    // Anyone unaccounted for who trades blows with that side is an opponent.
    // One pass is enough: nothing here ever adds to `allies`.
    for (const [a, b] of this.edges) {
      for (const [x, y] of [[a, b], [b, a]] as const) {
        if (allies.has(y) && !sides.has(x)) sides.set(x, "opponent");
      }
    }

    this.sides = sides;
    this.dirty = false;
    return sides;
  }

  sideOf(name: string | null): Side | null {
    if (name === null) return null;
    return this.resolve().get(name) ?? "neutral";
  }

  /** Was this creature summoned, rather than a party member? */
  isSummon(name: string | null): boolean {
    if (name === null) return false;
    this.resolve();
    return this.summons.has(name);
  }

  /** Apply the current resolution to an event. */
  label(event: GameEvent): GameEvent {
    return {
      ...event,
      actorSide: this.sideOf(event.actor),
      targetSide: this.sideOf(event.target),
      summon: this.isSummon(event.actor) ? event.actor : null,
      targetSummon: this.isSummon(event.target) ? event.target : null,
    };
  }
}

/**
 * Attaches context to damage events that the engine reports on separate lines.
 *
 * Both links are forward-only - the cause always precedes the damage - so one
 * pass serves live capture and re-import alike.
 */
export class EventLinker {
  /** A crit resolves almost immediately; a spell's damage can lag well behind. */
  private static readonly CRIT_WINDOW = 10;
  private static readonly SPELL_WINDOW = 60;

  private pendingCrit = new Map<string, number>();
  private lastCast = new Map<string, { id: number; spell: string }>();

  apply(event: GameEvent): GameEvent {
    if (event.actor === null) return event;

    if (event.kind === "critical") {
      if (/^Hit$/i.test(event.detail ?? "")) this.pendingCrit.set(event.actor, event.id);
      return event;
    }

    // Only successful casts are candidates. "miscast" is a separate kind
    // precisely so a failed cast cannot become a damage source.
    if (event.kind === "spell" && event.detail !== null) {
      this.lastCast.set(event.actor, { id: event.id, spell: event.detail });
      return event;
    }

    if (event.kind !== "damage") return event;

    let linked = event;

    const critAt = this.pendingCrit.get(event.actor);
    if (critAt !== undefined && event.id - critAt <= EventLinker.CRIT_WINDOW) {
      this.pendingCrit.delete(event.actor);
      linked = { ...linked, critical: true };
    }

    // Most recent cast by this actor, so a later cast supersedes an earlier one.
    // An area spell produces several damage lines from one cast, so the cast is
    // not consumed on use.
    const cast = this.lastCast.get(event.actor);
    if (cast !== undefined && event.id - cast.id <= EventLinker.SPELL_WINDOW) {
      // Record the candidate whatever the damage type; only commit to `spell`
      // for types we trust. The gap between the two is the review queue.
      linked = { ...linked, spellCandidate: cast.spell };
      if (SPELL_DAMAGE_TYPES.has((event.detail ?? "").toLowerCase())) {
        linked = { ...linked, spell: cast.spell };
      }
    }

    return linked;
  }
}
