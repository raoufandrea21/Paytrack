/**
 * One pass through the "needs checking" pile.
 *
 * The list is frozen when the run starts, rather than recomputed at each step.
 * Recomputing looks tidier and behaves badly: the document you just confirmed
 * leaves the list, a sync from the other device can add to it, and the result is
 * a counter that jumps — "1 of 4", then "1 of 3" — and an order that doubles
 * back over things you skipped. A snapshot gives you what you actually agreed
 * to: these ones, in this order, and you are here.
 *
 * Held in sessionStorage so a reload part-way through does not lose your place,
 * and so it dies with the tab rather than following you around for weeks.
 */
const KEY = 'doctrack.reviewRun';

function store() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // a browser with storage blocked, which is not a reason to fail
  }
}

/** Begins a run over these document ids, in this order. */
export function startRun(ids) {
  const clean = (ids ?? []).map(Number).filter(Number.isFinite);
  try {
    store()?.setItem(KEY, JSON.stringify(clean));
  } catch { /* out of quota, or blocked; the run just falls back to live order */ }
  return clean;
}

export function currentRun() {
  try {
    const raw = store()?.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((id) => Number.isFinite(id)) : [];
  } catch {
    return [];
  }
}

export function endRun() {
  try {
    store()?.removeItem(KEY);
  } catch { /* nothing to clean up */ }
}

/**
 * Where you are, and what comes next.
 *
 * `stillPending` is the live set — a document already dealt with earlier in the
 * run, or fixed on the other device mid-run, is stepped over rather than shown
 * again. `index` and `total` are your place in the run and never move, so the
 * counter does not shrink under you; `remaining` counts everything in the run
 * still outstanding, including one you skipped past, because a skipped document
 * is still a document you have to come back to.
 */
export function positionIn(run, documentId, stillPending) {
  const ids = run ?? [];
  const pending = stillPending instanceof Set ? stillPending : new Set(stillPending ?? []);
  const at = ids.indexOf(Number(documentId));
  if (at === -1) return null;

  const nextId = ids.slice(at + 1).find((id) => pending.has(id)) ?? null;
  return {
    index: at + 1,
    total: ids.length,
    remaining: ids.filter((id) => pending.has(id)).length,
    nextId,
  };
}
