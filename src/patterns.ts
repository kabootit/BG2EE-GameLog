/**
 * Show what the classifier did not recognize.
 *
 * The rules in parse.ts are provisional: the engine's feedback wording varies by
 * game version and is rewritten by mods, so unmatched lines land in kind='other'
 * rather than being mislabeled. This report is how you turn a real session into
 * better rules - look at the most frequent unmatched text, add a rule, then
 * `deno task import` to re-classify without replaying.
 */
import { type Db, openDb } from "./db.ts";
import { isDeclined } from "./protections.ts";
import { type EventRow, foldCombatants } from "./combatants.ts";

function main() {
  const db = openDb();

  const kinds = db.prepare(
    `SELECT kind, count(*) AS n FROM events GROUP BY kind ORDER BY n DESC`,
  ).all() as Array<{ kind: string; n: number }>;

  if (kinds.length === 0) {
    console.log("No events yet. Run `deno task play` first.");
    db.close();
    return;
  }

  const total = kinds.reduce((sum, k) => sum + k.n, 0);
  console.log(`${total} events\n`);
  for (const { kind, n } of kinds) {
    const pct = ((n / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${pct}%  ${String(n).padStart(6)}  ${kind}`);
  }

  const limit = Number(Deno.args[0] ?? "40");

  // "other" is genuinely unrecognized. "status" is the catch-all for attributed
  // engine text that matched no rule ("Stunned", "Contingency Active") - it is
  // classified, but it is also where a missing rule hides, so report both.
  const report = (kind: string, heading: string) => {
    const rows = db.prepare(
      `SELECT raw, count(*) AS n FROM events WHERE kind = ?
       GROUP BY raw ORDER BY n DESC LIMIT ?`,
    ).all(kind, limit) as Array<{ raw: string; n: number }>;
    if (rows.length === 0) return;
    console.log(`\n${heading} (top ${limit}):\n`);
    for (const { raw, n } of rows) console.log(`  ${String(n).padStart(5)}  ${raw}`);
  };

  report("other", "Unrecognized lines");
  report("status", "Catch-all status lines - add a rule if any deserve their own kind");

  // Spell attribution only trusts damage types listed in SPELL_DAMAGE_TYPES.
  // This is where a type that should be on that list makes itself known: damage
  // arriving shortly after a cast by the same actor, but going unattributed.
  const types = db.prepare(
    `SELECT COALESCE(detail, '(none)') AS type,
            count(*)                                                     AS total,
            sum(CASE WHEN spell_candidate IS NOT NULL THEN 1 ELSE 0 END) AS after_cast,
            sum(CASE WHEN spell IS NOT NULL THEN 1 ELSE 0 END)           AS attributed
     FROM events WHERE kind = 'damage'
     GROUP BY type ORDER BY after_cast DESC, total DESC`,
  ).all() as Array<{ type: string; total: number; after_cast: number; attributed: number }>;

  if (types.length > 0) {
    console.log(`\nDamage types vs spell attribution:\n`);
    console.log(`  ${"type".padEnd(12)} ${"rows".padStart(6)} ${"after cast".padStart(11)} ${"attributed".padStart(11)}`);
    for (const t of types) {
      console.log(
        `  ${t.type.padEnd(12)} ${String(t.total).padStart(6)} ` +
          `${String(t.after_cast).padStart(11)} ${String(t.attributed).padStart(11)}`,
      );
    }
  }

  const candidates = db.prepare(
    `SELECT COALESCE(detail, '(none)') AS type, spell_candidate AS spell, count(*) AS n
     FROM events
     WHERE kind = 'damage' AND spell IS NULL AND spell_candidate IS NOT NULL
     GROUP BY type, spell ORDER BY n DESC LIMIT ?`,
  ).all(limit) as Array<{ type: string; spell: string; n: number }>;

  if (candidates.length > 0) {
    console.log(`\nUnattributed damage that followed a cast - promote the type if it is real:\n`);
    for (const c of candidates) {
      console.log(`  ${String(c.n).padStart(5)}  ${c.type.padEnd(12)} <- ${c.spell}`);
    }
    console.log(
      `\n  A high "after cast" count with 0 attributed means that damage type belongs in\n` +
        `  SPELL_DAMAGE_TYPES in src/parse.ts. A few stray rows are just a weapon hit that\n` +
        `  happened to land after a cast - check the ratio before promoting.`,
    );
  }

  reportProtectionCoverage(db, limit);

  console.log(`\nAdd rules to src/parse.ts, then: deno task import`);
  db.close();
}

/**
 * Which names the combatants view is showing without semantics.
 *
 * `src/protections.ts` is domain knowledge rather than log-derived, so it cannot
 * be complete — IWDification alone adds 65+ spells. This is how the gap stays
 * visible instead of silently shrinking the inspector's coverage.
 *
 * Driven by the fold, not by its own SQL. That distinction is the whole point:
 * an earlier version queried `detail` on kinds 'spell', 'cast_start' and
 * 'effect', which sounds equivalent and is not. Observations also come from the
 * `status` bucket, where the name lives in the raw text and `detail` is always
 * null — 5,230 such rows, none of them ever reported. "Spell Protections
 * Removed" sat untagged on screen through every run of this report without once
 * being listed as missing. Asking the fold what it produced makes the report and
 * the UI agree by construction.
 *
 * Not every unmapped name should be added: Magic Missile never will be. The
 * report lists candidates; judgment decides, and DECLINED records the verdict
 * so the queue shrinks instead of re-listing the same 100 names forever.
 */
function reportProtectionCoverage(db: Db, limit: number) {
  const sessions = (db.prepare(`SELECT DISTINCT session FROM events`).all() as Array<
    { session: string }
  >).map((s) => s.session);

  const rows = db.prepare(
    `SELECT id, kind, actor, target, detail, raw, game_ticks, clock_ms,
            actor_side, target_side, summon, target_summon
       FROM events WHERE session = ? ORDER BY id`,
  );

  // Per session, matching how the view scopes itself — a fold across session
  // boundaries would merge creatures that never met.
  const tally = new Map<string, number>();
  let shown = 0;
  for (const session of sessions) {
    const { combatants } = foldCombatants(rows.all(session) as unknown as EventRow[]);
    for (const c of combatants) {
      for (const o of c.observations) {
        shown++;
        if (o.category === "unknown") tally.set(o.name, (tally.get(o.name) ?? 0) + 1);
      }
    }
  }

  const undecided = [...tally]
    .filter(([name]) => !isDeclined(name))
    .sort((a, b) => b[1] - a[1]);
  const declined = tally.size - undecided.length;

  console.log(
    `\nProtection coverage: ${shown - [...tally.values()].reduce((a, b) => a + b, 0)}/${shown} ` +
      `observations the combatants view would show are categorized`,
  );
  console.log(
    `  ${tally.size} distinct names have no entry in src/protections.ts ` +
      `(${declined} of them declined, ${undecided.length} still to judge)`,
  );

  if (undecided.length > 0) {
    console.log(`\n  Untagged on screen — add to TABLE, or to DECLINED if not state:\n`);
    for (const [name, n] of undecided.slice(0, limit)) {
      console.log(`  ${String(n).padStart(5)}  ${name}`);
    }
    if (undecided.length > limit) {
      console.log(`  ... and ${undecided.length - limit} more`);
    }
  }
}

if (import.meta.main) main();
