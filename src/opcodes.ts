/**
 * Working out what an effect opcode means, from labelled examples.
 *
 * The temptation here is to write an opcode table by hand — opcode 0 is an AC
 * bonus, 5 is charm, and so on. That would reproduce exactly the weakness this
 * whole exercise removes: a list of assertions with nothing behind them but
 * recall. IESDP documents ~400 opcodes and mods add behaviour to them.
 *
 * So the mapping is learned instead. `src/protections.ts` already carries 66
 * spells labelled `protection` / `disable` / `buff` / `dispel` by hand, and
 * those labels are the training data. Read each one's opcodes out of the game
 * files, find which opcodes actually separate the labels, and apply the result
 * to every other spell.
 *
 * Two properties make this honest rather than circular:
 *
 *   - **Base rates are divided out.** There are 26 labelled protections and 8
 *     buffs, so a raw count favours protection threefold for no reason. Scores
 *     are per-category rates, not counts.
 *   - **It is cross-validated.** `crossValidate()` re-derives the mapping with
 *     one spell held out and predicts that spell, for every spell in turn. That
 *     number says whether the mapping generalises or has merely memorised its
 *     own input, and only the first is worth anything.
 *
 * Opcodes that fail to separate anything get no vote. Display-string, sound and
 * portrait-icon effects appear in nearly every spell regardless of what it
 * does, and they are excluded by the purity threshold rather than by a list —
 * being uninformative is measurable, so it does not need to be asserted.
 */

/** A spell reduced to what the classifier sees. */
export interface Labelled {
  label: string;
  category: string;
  opcodes: number[];
}

/**
 * The category the files can actually support in place of `protection` and
 * `buff`.
 *
 * Those two are not mechanically distinct: they share ten opcodes between them,
 * against one to five for every other pair of labels, because the engine has no
 * notion of "protective" — Armor and Bless both simply grant AC. Trained on the
 * four-way split the classifier scored 67% with every protection/buff error at
 * 0.80 to 1.00 confidence, which is the worst possible failure: confidently
 * wrong. Merging the two takes it to 95%.
 *
 * Hand-written entries keep their finer label; this is only for spells nobody
 * has judged.
 */
export const MERGED_CATEGORY = "warded";

/** Collapse a hand label to what the files can distinguish. */
export function mergeCategory(category: string): string {
  return category === "protection" || category === "buff" ? MERGED_CATEGORY : category;
}

/** The subset of a feature block this module needs to read a removal class. */
export interface RemovalFeature {
  opcode: number;
  param2: number;
}

/**
 * Which class of state a removal spell strips, or null if it removes nothing.
 *
 * Unlike the category mapping, this one is exact rather than statistical, and it
 * came out of the seven labelled removal spells directly:
 *
 *   Spell Thrust   221 p1=5 p2=1     Spellstrike  221 p1=9 p2=1
 *   Secret Word    230 p1=8 p2=1     Pierce Magic 230 p1=8 p2=1
 *   Breach         221 p1=9 p2=2 and 221 p1=9 p2=7
 *   True Sight     220 p1=9 p2=5     True Seeing  220 p1=9 p2=5
 *   Dispel Magic    58              Remove Magic  58
 *
 * So `param2` names the class and `param1` is the caster-level cap. Opcode 58 is
 * the general dispel and goes by each effect's own dispel bit instead. This
 * reproduces all seven classes that were worked out by hand in an earlier
 * session, independently — which is the reason to trust either.
 */
export function stripsFromFeatures(features: RemovalFeature[]): string | null {
  const REMOVAL_OPCODES = new Set([220, 221, 230]);
  const BY_PARAM2: Record<number, string> = {
    1: "spell-protections",
    2: "combat-protections",
    5: "concealment",
    7: "combat-protections",
  };

  for (const f of features) {
    if (!REMOVAL_OPCODES.has(f.opcode)) continue;
    const cls = BY_PARAM2[f.param2];
    if (cls !== undefined) return cls;
  }
  // Checked last: a spell carrying both a targeted removal and a general dispel
  // should be reported by the more specific of the two.
  if (features.some((f) => f.opcode === 58)) return "dispellable";
  return null;
}

export interface Vote {
  category: string;
  /** How lopsided this opcode is, 0..1. 1 means it only ever appears in one category. */
  purity: number;
  /** How many labelled spells carry it. Low counts are not trustworthy. */
  support: number;
}

export interface Thresholds {
  /** An opcode must appear in at least this many labelled spells. */
  minSupport: number;
  /** ...and point at one category this strongly. */
  minPurity: number;
  /**
   * How lopsided a spell's own vote must be before an answer is given.
   *
   * Spells mix mechanics, so a spell whose opcodes vote 0.53/0.47 across two
   * categories has not been classified — it has been rounded. Abstaining there
   * costs a tag on the card; committing costs a wrong tag, which is worse,
   * because the whole point of reading the files is to stop guessing.
   */
  minConfidence: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minSupport: 2,
  minPurity: 0.6,
  minConfidence: 0.65,
};

/**
 * Learn which opcodes indicate which category.
 *
 * For opcode `o` and category `c` the score is the *fraction of category c's
 * spells* that carry `o`. Purity is then the winning score over the sum of all
 * scores, so an opcode carried by every protection and nothing else scores 1,
 * and one spread evenly across four categories scores 0.25.
 */
export function deriveVotes(
  labelled: Labelled[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Map<number, Vote> {
  const categorySize = new Map<string, number>();
  for (const l of labelled) {
    categorySize.set(l.category, (categorySize.get(l.category) ?? 0) + 1);
  }

  // opcode -> category -> how many spells of that category carry it
  const counts = new Map<number, Map<string, number>>();
  for (const l of labelled) {
    for (const op of new Set(l.opcodes)) {
      const perCategory = counts.get(op) ?? new Map<string, number>();
      perCategory.set(l.category, (perCategory.get(l.category) ?? 0) + 1);
      counts.set(op, perCategory);
    }
  }

  const votes = new Map<number, Vote>();
  for (const [op, perCategory] of counts) {
    const support = [...perCategory.values()].reduce((a, b) => a + b, 0);
    if (support < thresholds.minSupport) continue;

    // Rate per category, which is what removes the base-rate advantage.
    const rates = [...perCategory].map(([category, n]) =>
      [category, n / (categorySize.get(category) ?? 1)] as const
    );
    const total = rates.reduce((sum, [, r]) => sum + r, 0);
    if (total === 0) continue;

    const [category, best] = rates.reduce((a, b) => (b[1] > a[1] ? b : a));
    const purity = best / total;
    if (purity < thresholds.minPurity) continue;

    votes.set(op, { category, purity, support });
  }
  return votes;
}

export interface Classification {
  category: string;
  /** Winning score over total score. Low means the opcodes disagreed. */
  confidence: number;
  /** Opcodes that contributed, for explaining a result. */
  evidence: number[];
}

/**
 * Classify a spell from its opcodes.
 *
 * Each informative opcode votes for its category, weighted by how pure it is,
 * so a strong indicator outweighs a marginal one. No informative opcodes means
 * `unknown` — which is the correct answer surprisingly often, because most
 * spells are attacks and carry no lasting state at all.
 */
export function classifySpell(
  opcodes: number[],
  votes: Map<number, Vote>,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Classification | null {
  const tally = new Map<string, number>();
  const evidence: number[] = [];

  for (const op of new Set(opcodes)) {
    const vote = votes.get(op);
    if (vote === undefined) continue;
    tally.set(vote.category, (tally.get(vote.category) ?? 0) + vote.purity);
    evidence.push(op);
  }

  if (tally.size === 0) return null;
  const total = [...tally.values()].reduce((a, b) => a + b, 0);
  const [category, best] = [...tally].reduce((a, b) => (b[1] > a[1] ? b : a));
  const confidence = best / total;
  if (confidence < thresholds.minConfidence) return null;
  return { category, confidence, evidence: evidence.sort((a, b) => a - b) };
}

export interface CrossValidation {
  tested: number;
  correct: number;
  abstained: number;
  /** Where it was confidently wrong, which is the interesting failure. */
  mistakes: Array<{ label: string; expected: string; got: string; confidence: number }>;
}

/**
 * Leave-one-out: for each labelled spell, learn from the others and predict it.
 *
 * This is the only check that distinguishes a real mapping from one that has
 * memorised its training set. Deriving votes from all 66 and then scoring
 * against those same 66 would report near-perfect accuracy no matter how
 * meaningless the mapping was.
 *
 * Abstentions are counted separately from mistakes. Declining to guess is the
 * designed behaviour, not a failure — an unclassified spell shows untagged,
 * exactly as it does today.
 */
export function crossValidate(
  labelled: Labelled[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): CrossValidation {
  let correct = 0;
  let abstained = 0;
  const mistakes: CrossValidation["mistakes"] = [];

  for (let i = 0; i < labelled.length; i++) {
    const heldOut = labelled[i];
    const votes = deriveVotes(labelled.filter((_, j) => j !== i), thresholds);
    const got = classifySpell(heldOut.opcodes, votes, thresholds);

    if (got === null) abstained++;
    else if (got.category === heldOut.category) correct++;
    else {
      mistakes.push({
        label: heldOut.label,
        expected: heldOut.category,
        got: got.category,
        confidence: got.confidence,
      });
    }
  }

  return { tested: labelled.length, correct, abstained, mistakes };
}
