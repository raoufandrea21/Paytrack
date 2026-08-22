/**
 * How far ahead each kind of document warns you, and which kinds warn at all.
 *
 * One ladder for everything is wrong in both directions. A passport that needs
 * six months of validity left before an airline will board you has to shout in
 * February about an August expiry; car insurance a week ahead is plenty and a
 * six-month warning is noise you learn to ignore. So the ladder is per type,
 * with a fallback for anything not spoken for.
 *
 * Kept free of DOM and React on purpose: the reminder engine that reads this
 * runs inside the service worker as well as on the page.
 */
import { DOCUMENT_TYPES, typeIsPermanent } from './constants.js';

export const RULES_SETTING = 'reminder_rules';

/** The lead times offered on screen, in days. */
export const LEAD_CHOICES = [1, 3, 7, 14, 30, 60, 90, 180, 365];

/**
 * Defaults chosen from what actually goes wrong with each document.
 *
 * Passports lead by six months because most countries refuse entry inside that
 * window, so the passport is effectively expired long before its date. Residency
 * visas and Emirates IDs carry fines per day overdue, so they warn early and
 * again at the last minute. Insurance and registration are same-week errands.
 */
export const DEFAULT_LEADS = {
  passport: [180, 90, 30, 7],
  residency_visa: [90, 30, 7],
  emirates_id: [60, 30, 7],
  cyprus_id: [60, 30, 7],
  driving_license: [60, 30, 7],
  vehicle_registration: [30, 14, 3],
  car_insurance: [30, 14, 3],
  health_insurance: [60, 30, 7],
  vaccination: [30, 14, 3],
  power_of_attorney: [60, 30],
  other: [30, 7],
};

/** Used for any type with nothing of its own. */
export const FALLBACK_LEADS = [60, 30, 7];

/** How often to say it again once a document is already out of date. */
export const DEFAULT_OVERDUE_REPEAT = 7;
export const OVERDUE_CHOICES = [0, 1, 3, 7, 14, 30];

/** Documents that never expire are never nagged about. */
const isPermanent = (type) => typeIsPermanent(type);

export function defaultRules() {
  const types = {};
  for (const type of DOCUMENT_TYPES) {
    if (isPermanent(type.id)) continue;
    types[type.id] = [...(DEFAULT_LEADS[type.id] ?? FALLBACK_LEADS)];
  }
  return { types, muted: [], overdueRepeat: DEFAULT_OVERDUE_REPEAT };
}

const cleanLeads = (value) => {
  if (!Array.isArray(value)) return null;
  const days = value
    .map((n) => Math.round(Number(n)))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 1095);
  return [...new Set(days)].sort((a, b) => b - a);
};

/**
 * Turns whatever is in settings into a shape the engine can rely on. Anything
 * unrecognised falls back to the default rather than throwing: a bad saved
 * value must not be able to switch every reminder off silently.
 */
export function normaliseRules(raw) {
  const base = defaultRules();
  if (!raw || typeof raw !== 'object') return base;

  const types = { ...base.types };
  for (const [id, value] of Object.entries(raw.types ?? {})) {
    if (!(id in types)) continue;
    const leads = cleanLeads(value);
    if (leads) types[id] = leads;
  }

  const muted = Array.isArray(raw.muted)
    ? [...new Set(raw.muted.filter((id) => id in types))]
    : [];

  const repeat = Math.round(Number(raw.overdueRepeat));
  const overdueRepeat = OVERDUE_CHOICES.includes(repeat) ? repeat : base.overdueRepeat;

  return { types, muted, overdueRepeat };
}

export function isMuted(type, rules) {
  const safe = normaliseRules(rules);
  return isPermanent(type) || safe.muted.includes(type) || !(type in safe.types);
}

/** The lead times for one kind of document, longest first. Empty means silent. */
export function leadsFor(type, rules) {
  const safe = normaliseRules(rules);
  if (isMuted(type, safe)) return [];
  const leads = safe.types[type];
  return leads?.length ? [...leads] : [...FALLBACK_LEADS];
}

/**
 * Every rung the engine should test for one document, most urgent first.
 *
 * Overdue rungs are negative: a document nine days past its date with a weekly
 * repeat produces −7, and at sixteen days −14. Each is a value nobody has been
 * told about yet, so the reminders table dedupes the repeat for free without
 * needing a second table or a "last nagged" column.
 */
export function rungsFor(type, days, rules) {
  const leads = leadsFor(type, rules);
  if (leads.length === 0) return [];

  const ascending = [...leads].sort((a, b) => a - b);
  if (days >= 0) return ascending;

  const { overdueRepeat } = normaliseRules(rules);
  if (!overdueRepeat) return ascending;

  const elapsed = Math.floor(-days / overdueRepeat) * overdueRepeat;
  return elapsed > 0 ? [-elapsed, ...ascending] : ascending;
}

// ------------------------------------------------------------ plain English

/** "6 months", "2 weeks", "3 days" — whichever unit reads most naturally. */
export function describeDays(days) {
  const n = Math.abs(Math.round(days));
  if (n === 0) return 'the day it expires';
  if (n % 365 === 0) return n === 365 ? '1 year' : `${n / 365} years`;
  if (n >= 30 && n % 30 === 0) return n === 30 ? '1 month' : `${n / 30} months`;
  if (n % 7 === 0) return n === 7 ? '1 week' : `${n / 7} weeks`;
  return n === 1 ? '1 day' : `${n} days`;
}

/** "6 months, 1 month and 1 week before" — for the summary line on a card. */
export function describeLeads(leads) {
  if (!leads?.length) return 'Never';
  const words = [...leads].sort((a, b) => b - a).map(describeDays);
  if (words.length === 1) return `${words[0]} before`;
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)} before`;
}

/** One line for the whole rule set, for the Settings summary. */
export function describeRules(rules) {
  const safe = normaliseRules(rules);
  const tracked = Object.keys(safe.types).filter((id) => !safe.muted.includes(id));
  const silent = safe.muted.length;
  const parts = [`${tracked.length} kind${tracked.length === 1 ? '' : 's'} of document`];
  if (silent) parts.push(`${silent} silenced`);
  parts.push(
    safe.overdueRepeat
      ? `repeats every ${describeDays(safe.overdueRepeat)} once overdue`
      : 'no repeat once overdue',
  );
  return parts.join(' · ');
}

/** True when the saved rules are still exactly the shipped defaults. */
export function isDefaultRules(rules) {
  const safe = normaliseRules(rules);
  const base = defaultRules();
  if (safe.muted.length !== 0) return false;
  if (safe.overdueRepeat !== base.overdueRepeat) return false;
  return Object.entries(base.types).every(
    ([id, leads]) => (safe.types[id] ?? []).join(',') === leads.join(','),
  );
}
