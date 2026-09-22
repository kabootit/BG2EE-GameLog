/**
 * Shared page shell: escaping, the session picker, auto-refresh, and keeping the
 * tab links pointed at the right place.
 *
 * Each view is its own page (`/events`, `/combatants`) so the tabs are real
 * links — bookmarkable, and the browser's back button works. This module holds
 * the parts both pages need, so nothing is duplicated between them.
 */

export const $ = (id) => document.getElementById(id);

/**
 * Every value rendered by either page originates in game text, which any
 * installed mod can rewrite. Quotes are escaped too, because some values land in
 * attributes rather than text nodes.
 */
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const setStatus = (text) => ($("status").textContent = text);

/** Filters that both pages understand, and so are worth carrying across a tab switch. */
const SHARED_PARAMS = ["session"];

/** Read the current filter state from the URL, so a bookmark restores it. */
export function fromUrl() {
  return new URLSearchParams(location.search);
}

/**
 * Write filter state back to the URL and re-point the tabs at it.
 *
 * `replaceState` rather than `pushState`: adjusting a filter is not a navigation
 * step, and filling the back stack with them would make the back button useless
 * for actually leaving the page.
 */
export function toUrl(params) {
  const q = params.toString();
  history.replaceState(null, "", q ? `${location.pathname}?${q}` : location.pathname);
  syncTabs(params);
}

/** Carry the shared filters onto the tab links so switching views keeps them. */
function syncTabs(params) {
  const carry = new URLSearchParams();
  for (const key of SHARED_PARAMS) {
    const value = params.get(key);
    if (value) carry.set(key, value);
  }
  const q = carry.toString();
  for (const a of document.querySelectorAll("a.tab")) {
    a.href = q ? `${a.dataset.path}?${q}` : a.dataset.path;
  }
}

/**
 * What the sort chain becomes when a column header is clicked.
 *
 * A click always makes that column the primary sort. Clicking the column that
 * is already primary reverses it, and a third click drops it.
 *
 * New keys used to join as *least significant*, on the reasoning that a stray
 * click should not disturb the primary sort. In practice that made clicking look
 * broken: sort by `id`, then click `side`, and nothing moves. `id` is unique, so
 * no two rows ever tie on it, so a key behind it is never consulted — and the
 * same goes for any chain led by a unique column. Promoting on every click means
 * no click is ever a no-op, which is the property that was actually missing.
 *
 * Pure, and exported separately from the page, because this is the second sort
 * bug reported here and a state machine buried in an event handler cannot be
 * tested. See `src/web_test.ts`.
 *
 * @param sort current chain, `[{key, dir}]`, most significant first
 * @param key the column clicked
 * @param maxKeys how long the chain may grow
 * @returns a new chain; the input is not modified
 */
export function nextSort(sort, key, maxKeys) {
  const next = sort.map((s) => ({ ...s }));
  const i = next.findIndex((s) => s.key === key);

  if (i === -1) {
    next.unshift({ key, dir: "asc" });
    // The oldest key gives way once the chain is full.
    if (next.length > maxKeys) next.pop();
  } else if (i > 0) {
    // Already sorted, but buried behind something. Promote it unchanged — that
    // alone visibly reorders the table.
    next.unshift(...next.splice(i, 1));
  } else if (next[0].dir === "asc") {
    next[0].dir = "desc";
  } else {
    next.shift();
  }
  return next;
}

/**
 * Remove the leading "Name: " from a line when that name is already in a column
 * on the same row.
 *
 * Almost every line the engine writes is prefixed with whoever it belongs to,
 * and the parser splits that off into `actor` — so the text column repeated it:
 * "Jaheira: Save vs. Death : 11" next to an actor cell reading Jaheira.
 *
 * Conditional on the name matching, rather than stripping any prefix, because
 * the speaker is not always the actor. On a damage line the speaker is the
 * *victim* ("Vampire: Takes 13 slashing damage from Tyras" has actor Tyras),
 * and for a summon the name appears in the summon column instead. Matching
 * against every name the row displays means nothing is ever hidden that is not
 * visible elsewhere on the same row.
 */
export function stripSpeaker(text, row) {
  const m = /^([A-Za-z][A-Za-z'\- ]{0,29}):\s*(\S.*)$/.exec(text);
  if (m === null) return text;
  const shown = [row.actor, row.target, row.summon, row.target_summon];
  return shown.includes(m[1]) ? m[2] : text;
}

/**
 * Order rows in memory by a sort chain.
 *
 * Used for the group-by table, which is sorted here rather than in SQL. That is
 * a deliberate split from the events table: groups come back with no LIMIT, so
 * the client already holds every row and sorting locally is both exact and
 * instant. It also keeps aggregate names out of SQL entirely, so group sorting
 * adds nothing to the surface the `sql-injection` invariant has to cover.
 *
 * Empties sort last whatever the direction, matching the `col IS NULL, col DIR`
 * the server emits — a sparse column should not lead with a screen of blanks.
 * Ties fall back to the original order, so the sort is stable and the server's
 * own "busiest first" ordering survives underneath.
 */
export function sortRows(rows, chain) {
  if (chain.length === 0) return rows;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      for (const { key, dir } of chain) {
        const av = a.row[key];
        const bv = b.row[key];
        // Emptiness is settled ahead of the direction flip, or `desc` negates
        // it and a sparse column opens with a screen of blanks.
        const empty = compareEmpty(av, bv);
        if (empty !== null) {
          if (empty !== 0) return empty;
          continue;
        }
        const cmp = compareCells(av, bv);
        if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
      }
      return a.i - b.i;
    })
    .map((d) => d.row);
}

/** Empties last; null when both are present and the values decide it. */
function compareEmpty(a, b) {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (!aEmpty && !bEmpty) return null;
  if (aEmpty && bEmpty) return 0;
  return aEmpty ? 1 : -1;
}

function compareCells(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  // `numeric` so a text column holding digits still orders 2 before 10.
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * Whether a column would render nothing at all for these rows.
 *
 * Width is the scarcest thing on this table and the text column is what runs out
 * of it. With no kind selected every column is on screen, and several are dead
 * weight — `made?`, `resisted` and `spell` are blank for whole pages at a time,
 * yet each still holds its header's width. Dropping them hands that space to the
 * column that needs it.
 *
 * Tests what would actually be *drawn*, not merely whether the field is null:
 * a flag column shows only its true case, a verdict column only a known one, and
 * `actor` blanks itself on a summon row. A column whose every cell comes out
 * blank is costing width for nothing however much data is behind it.
 *
 * @param column the column definition
 * @param rows the rows about to be drawn
 * @param chain the active sort chain, since sorting un-blanks a column
 */
export function columnIsEmpty(column, rows, chain) {
  const sorted = chain.some((s) => s.key === column.key);
  return rows.every((row) => {
    const value = row[column.key];
    // Only the true case is ever drawn, so a column of zeroes is blank.
    if (column.flag) return !value;
    if (column.verdict) return value === null || value === undefined;
    if (cellHidden(column, row, sorted)) return true;
    return value === null || value === undefined || value === "";
  });
}

/**
 * Describe what a set of group aggregates actually covers.
 *
 * Group-by summarizes the same skip/show window the events table pages with, so
 * the numbers describe a slice rather than the session. That has to be said on
 * screen: a damage total from 500 events looks exactly like a damage total from
 * 70,000, and the earlier complaint about kind totals ignoring skip/show was the
 * same confusion in the other direction.
 *
 * Pure and tested for the reason the other helpers here are: this is wording
 * that has to stay true across four cases, and it was getting written inline.
 *
 * @param data the `/api/groups` response: `{matched, windowed, offset}`
 */
export function groupScope(data) {
  const { matched, windowed, offset } = data;
  const total = matched.toLocaleString();
  if (matched === 0) return "no matching events";
  if (windowed === 0) return `nothing in this window, of ${total} matched`;
  // The whole matched set, so there is no window worth describing.
  if (offset === 0 && windowed >= matched) return `all ${total} matched events`;
  const from = (offset + 1).toLocaleString();
  const to = (offset + windowed).toLocaleString();
  return `events ${from}–${to} of ${total} matched`;
}

/**
 * Whether a cell should be blanked, given that its column may be sorted.
 *
 * `actor` and `target` blank themselves when the creature is a summon, because
 * its name is shown in the neighbouring summon column instead — the name lives
 * in exactly one of the two, which keeps the actor column readable as "party
 * and opposition".
 *
 * But 2,528 rows carry the same name in both `target` and `target_summon`, so
 * sorting by `target` ordered on a value those cells refused to display: a run
 * of blanks in the middle of an otherwise alphabetical column, looking for all
 * the world like the sort had broken. A column being sorted on has to show what
 * it sorted by, so the blanking yields while it is in the sort chain.
 *
 * @param column the column definition
 * @param row the row being rendered
 * @param isSorted whether this column is part of the active sort chain
 */
export function cellHidden(column, row, isSorted) {
  return Boolean(column.hideWhen) && column.hideWhen(row) && !isSorted;
}

/** Fill a <select> from facet rows, preserving the current choice. */
export function fillSelect(id, rows, allLabel) {
  const select = $(id);
  const current = select.value;
  const options = rows.map((r) => `<option value="${esc(r.key)}">${esc(r.key)} (${r.n})</option>`);
  // Keep the active choice listed even when other filters reduce it to zero, or
  // the <select> silently falls back to "all" and the results change underneath.
  if (current && !rows.some((r) => String(r.key) === current)) {
    options.unshift(`<option value="${esc(current)}">${esc(current)} (0)</option>`);
  }
  select.innerHTML = `<option value="">${esc(allLabel)}</option>` + options.join("");
  select.value = current;
}

/**
 * Wire the controls both pages share and do the first load.
 *
 * `reload(reason)` is the page's own render function. The reason matters:
 * switching session invalidates page state that a plain refresh must keep. The
 * combatants page resets its id range on a session change, and would otherwise
 * have had auto-refresh wipe the chosen range every three seconds.
 *
 * Reasons: `{ first: true }`, `{ sessionChanged: true }`, or `{}` for a refresh.
 */
export async function initShell(reload) {
  const url = fromUrl();
  let timer = null;

  // Populate the session picker before the first render, so a session named in
  // the URL is actually selectable rather than being reset to "all".
  const facets = await (await fetch("/api/facets")).json();
  fillSelect("session", facets.sessions, "all sessions");
  const wanted = url.get("session");
  if (wanted) $("session").value = wanted;
  $("subtitle").textContent =
    `— ${facets.total} events total, ${facets.sessions.length} session(s)`;
  syncTabs(url);

  $("session").onchange = () => {
    const next = fromUrl();
    if ($("session").value) next.set("session", $("session").value);
    else next.delete("session");
    toUrl(next);
    reload({ sessionChanged: true });
  };

  $("refresh").onclick = () => reload({});
  $("auto").onchange = (e) => {
    clearInterval(timer);
    if (e.target.checked) timer = setInterval(() => reload({}), 3000);
  };

  await reload({ first: true });
}
