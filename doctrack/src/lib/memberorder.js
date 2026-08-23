/**
 * The order the family is listed in, when the user has said what it should be.
 *
 * Kept as one setting — a list of uids — rather than a column on each person.
 * A reorder moves everybody at once, so a column would mean eight writes and
 * eight rows to merge for one drag; a single list is one write and one
 * last-write-wins merge, and it rides the existing settings sync between
 * devices for free.
 *
 * uids rather than local ids, because the ids are per-device and an order
 * written on the laptop has to mean the same thing on the phone.
 */
export const ORDER_SETTING = 'member_order';

/** The uids in the saved order, with anything unrecognised dropped. */
export function cleanOrder(saved, members = []) {
  if (!Array.isArray(saved)) return [];
  const known = new Set(members.map((m) => m.uid).filter(Boolean));
  return [...new Set(saved.filter((uid) => known.has(uid)))];
}

/**
 * Sorts people by the saved order.
 *
 * Somebody added since the order was saved has no place in it, and guessing one
 * would silently move them; they go to the end, in the order they were added,
 * where a new person is easy to notice.
 */
export function applyOrder(members = [], saved) {
  const order = cleanOrder(saved, members);
  if (order.length === 0) return [...members];

  const rank = new Map(order.map((uid, index) => [uid, index]));
  return [...members].sort((a, b) => {
    const ra = rank.has(a.uid) ? rank.get(a.uid) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.uid) ? rank.get(b.uid) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
  });
}

/** True when a saved order is actually in force. */
export function hasOrder(saved, members = []) {
  return cleanOrder(saved, members).length > 0;
}

/** Moves one entry of a list to a new index, returning a new list. */
export function moveItem(list, from, to) {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}
