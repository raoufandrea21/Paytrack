/**
 * Why a document was put in the "needs checking" pile.
 *
 * Recomputed from the stored record rather than saved alongside it, so a
 * document fixed on another device stops complaining here the moment the
 * correction arrives — there is no stale explanation to clear up.
 *
 * Shared between the list and the form, because being told "this needs
 * checking", opening it, and finding no hint of what was wrong is the fastest
 * way to make somebody give up on a pile of thirty-eight.
 */
export function reviewReasonsFor(doc) {
  const reasons = [];
  if (!doc?.expiry_date && !doc?.no_expiry) {
    reasons.push('No expiry date — no reminders will fire.');
  }
  if (doc?.type === 'other' && !doc?.label) {
    reasons.push('Document type was not recognised — say what it is.');
  }
  if (!doc?.number) reasons.push('No document number was read.');
  for (const warning of doc?.extraction?.warnings ?? []) reasons.push(warning);
  return reasons.length > 0 ? reasons : ['Read with low confidence.'];
}
