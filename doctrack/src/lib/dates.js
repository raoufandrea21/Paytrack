/**
 * Date handling for documents that may have been photographed in Arabic.
 *
 * Two rules run through all of this:
 *   - Everything is stored as a plain YYYY-MM-DD string. No Date objects in the
 *     database, so no timezone drift between the device and the record.
 *   - Ambiguity is never resolved by guessing. parseLooseDate returns null and
 *     the UI asks the human.
 */

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Converts Arabic-Indic and Eastern Arabic-Indic digits to 0-9. */
export function normaliseDigits(input) {
  if (typeof input !== 'string') return input;
  let out = '';
  for (const ch of input) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a !== -1) { out += String(a); continue; }
    const e = EASTERN_ARABIC_INDIC.indexOf(ch);
    if (e !== -1) { out += String(e); continue; }
    out += ch;
  }
  return out;
}

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  // Gregorian month names as printed on bilingual UAE documents
  'يناير': 1, 'فبراير': 2, 'مارس': 3, 'أبريل': 4, 'ابريل': 4, 'مايو': 5,
  'يونيو': 6, 'يوليو': 7, 'أغسطس': 8, 'اغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10,
  'اكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12,
  // Levantine variants that show up on some passports and insurance cards
  'كانون الثاني': 1, 'شباط': 2, 'آذار': 3, 'نيسان': 4, 'أيار': 5, 'حزيران': 6,
  'تموز': 7, 'آب': 8, 'أيلول': 9, 'تشرين الأول': 10, 'تشرين الثاني': 11,
  'كانون الأول': 12,
};

const pad = (n) => String(n).padStart(2, '0');

export function isValidISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function toISO(y, m, d) {
  const iso = `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
  return isValidISODate(iso) ? iso : null;
}

/**
 * Best-effort parse of a date as printed on a document.
 *
 * Returns { iso, ambiguous, raw } — iso is null when the string could not be
 * read confidently. `ambiguous` marks a DD/MM vs MM/DD coin flip that was
 * resolved as DD/MM (the UAE convention) and should be shown to the user.
 */
export function parseLooseDate(input, { today = new Date() } = {}) {
  const raw = typeof input === 'string' ? input : '';
  const text = normaliseDigits(raw).trim();
  if (!text) return { iso: null, ambiguous: false, raw };

  // Already ISO
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) {
    return { iso: toISO(+iso[1], +iso[2], +iso[3]), ambiguous: false, raw };
  }

  // 12 May 2027 / 12 مايو 2027 / May 12 2027
  const named = text.match(/^(\d{1,2})[\s.\-/]+([^\s\d.\-/]+(?:\s[^\s\d.\-/]+)?)[\s.\-/,]+(\d{2,4})$/u)
    || text.match(/^([^\s\d.\-/]+(?:\s[^\s\d.\-/]+)?)[\s.\-/]+(\d{1,2})[\s.\-/,]+(\d{2,4})$/u);
  if (named) {
    const monthFirst = /^\d/.test(named[1]) === false;
    const day = Number(monthFirst ? named[2] : named[1]);
    const monthWord = String(monthFirst ? named[1] : named[2]).toLowerCase().replace(/[.,]/g, '');
    const month = MONTH_NAMES[monthWord];
    if (month) {
      return { iso: toISO(expandYear(Number(named[3]), today), month, day), ambiguous: false, raw };
    }
  }

  // DD/MM/YYYY — the UAE default. Only genuinely ambiguous when both parts <= 12.
  const numeric = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = expandYear(Number(numeric[3]), today);
    if (a > 12 && b <= 12) return { iso: toISO(year, b, a), ambiguous: false, raw };
    if (b > 12 && a <= 12) return { iso: toISO(year, a, b), ambiguous: false, raw };
    if (a <= 12 && b <= 12) return { iso: toISO(year, b, a), ambiguous: true, raw };
  }

  return { iso: null, ambiguous: false, raw };
}

/** 27 -> 2027, 98 -> 1998, anchored on the current year. */
function expandYear(year, today) {
  if (year >= 1000) return year;
  const century = Math.floor(today.getFullYear() / 100) * 100;
  const candidate = century + year;
  return candidate - today.getFullYear() > 60 ? candidate - 100 : candidate;
}

// -------------------------------------------------------------- urgency

/** Local midnight, so "days until" counts calendar days the way a person does. */
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function daysUntil(isoDate, { today = new Date() } = {}) {
  if (!isValidISODate(isoDate)) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = startOfDay(new Date(y, m - 1, d));
  return Math.round((target - startOfDay(today)) / 86_400_000);
}

export const URGENCY = {
  unknown: {
    id: 'unknown', label: 'No expiry set', rank: 5,
    dot: 'bg-slate-400',
    chip: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    bar: 'bg-slate-300 dark:bg-slate-700',
  },
  red: {
    id: 'red', label: 'Urgent', rank: 0,
    dot: 'bg-red-500',
    chip: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
    bar: 'bg-red-500',
  },
  amber: {
    id: 'amber', label: 'Due soon', rank: 1,
    dot: 'bg-orange-500',
    chip: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200',
    bar: 'bg-orange-500',
  },
  yellow: {
    id: 'yellow', label: 'Coming up', rank: 2,
    dot: 'bg-yellow-400',
    chip: 'bg-yellow-100 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200',
    bar: 'bg-yellow-400',
  },
  filed: {
    id: 'filed', label: 'No expiry', rank: 4,
    dot: 'bg-sky-400',
    chip: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
    bar: 'bg-sky-300 dark:bg-sky-800',
  },
  green: {
    id: 'green', label: 'Valid', rank: 3,
    dot: 'bg-emerald-500',
    chip: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
    bar: 'bg-emerald-500',
  },
};

/** Red: expired or <= 7 days. Amber: <= 30. Yellow: <= 60. Green: beyond. */
export function urgencyFor(isoDate, options) {
  const days = daysUntil(isoDate, options);
  if (days === null) return { ...URGENCY.unknown, days: null };
  if (days <= 7) return { ...URGENCY.red, days };
  if (days <= 30) return { ...URGENCY.amber, days };
  if (days <= 60) return { ...URGENCY.yellow, days };
  return { ...URGENCY.green, days };
}

/**
 * "Expired 3 days ago", "Expires today", "42 days left", "about 5 years left".
 * Exact days stay exact while they matter; past a few months the precision is
 * noise, and "1846 days left" is harder to read than "about 5 years left".
 */
export function expiryPhrase(isoDate, options) {
  const days = daysUntil(isoDate, options);
  if (days === null) return 'No expiry date';
  if (days < 0) {
    const n = Math.abs(days);
    if (n >= 365) return `Expired over ${plural(Math.floor(n / 365), 'year')} ago`;
    return `Expired ${plural(n, 'day')} ago`;
  }
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  if (days <= 90) return `${days} days left`;
  if (days < 365) return `about ${plural(Math.round(days / 30), 'month')} left`;
  return `about ${plural(Math.round(days / 365), 'year')} left`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Compact form for the list chips: exact while it matters, rounded when it doesn't. */
export function shortRemaining(isoDate, options) {
  const days = daysUntil(isoDate, options);
  if (days === null) return 'Set date';
  if (days < 0) return 'Expired';
  if (days === 0) return 'Today';
  if (days <= 90) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.floor(days / 365)}y+`;
}

const DISPLAY = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric',
});

export function formatDate(isoDate) {
  if (!isValidISODate(isoDate)) return '—';
  const [y, m, d] = isoDate.split('-').map(Number);
  return DISPLAY.format(new Date(y, m - 1, d));
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Urgency for a whole record rather than a bare date.
 *
 * A birth certificate has no expiry and never will; showing it as "no date set"
 * treats a fact about the document as an omission by the user.
 */
export function urgencyForDocument(doc, options) {
  if (doc?.no_expiry) return { ...URGENCY.filed, days: null };
  return urgencyFor(doc?.expiry_date, options);
}

/** Compact chip text for a whole record. */
export function shortRemainingFor(doc, options) {
  if (doc?.no_expiry) return 'Filed';
  return shortRemaining(doc?.expiry_date, options);
}

/** "Kept on file" reads better than "No expiry date" for something permanent. */
export function expiryPhraseFor(doc, options) {
  if (doc?.no_expiry) return 'Kept on file — no expiry';
  return expiryPhrase(doc?.expiry_date, options);
}

/** Sorts documents so the ones that need attention are first. */
export function byUrgency(a, b) {
  const ua = urgencyForDocument(a);
  const ub = urgencyForDocument(b);
  if (ua.rank !== ub.rank) return ua.rank - ub.rank;
  if (ua.days === null) return 0;
  if (ub.days === null) return -1;
  return ua.days - ub.days;
}
