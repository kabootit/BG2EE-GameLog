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
