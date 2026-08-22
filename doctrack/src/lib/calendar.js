/**
 * Every expiry as a calendar file.
 *
 * This exists because of what a web app cannot promise. DocTrack's reminders
 * fire when the app is opened, and in the background only where the browser
 * allows it — which on an iPhone is nowhere. A calendar has no such problem: it
 * is the one thing on a phone that is guaranteed to go off on a date months
 * from now whether or not anybody opened anything.
 *
 * So the reminder rules are written out as alarms on calendar events, once, and
 * the phone takes it from there. Re-importing replaces rather than duplicates,
 * because each event's identity is the document's own uid.
 *
 * Pure string work with no imports beyond the rules, so it is cheap to test and
 * runs anywhere.
 */
import { documentLabel, documentType } from './constants.js';
import { leadsFor, normaliseRules } from './reminderrules.js';
import { isValidISODate } from './dates.js';

const PRODID = '-//DocTrack//Document expiries//EN';

/**
 * RFC 5545 wants commas, semicolons, backslashes and newlines escaped in text
 * values. A name with a comma in it is not exotic, and an unescaped one silently
 * truncates the event title in most calendars.
 */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Lines are folded at 75 octets — octets, not characters, because an Arabic or
 * Greek name is multi-byte and folding by character length produces lines that
 * are still too long. A continuation starts with one space.
 */
export function foldLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out = [];
  let current = '';
  let width = 0;
  let limit = 75;

  for (const character of line) {
    const size = encoder.encode(character).length;
    if (width + size > limit) {
      out.push(current);
      current = ' ';
      width = 1;
      limit = 75;
    }
    current += character;
    width += size;
  }
  out.push(current);
  return out.join('\r\n');
}

const stampOf = (date) => `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
const dayOf = (iso) => iso.replace(/-/g, '');

/** The day after, because an all-day event's end date is exclusive. */
function nextDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + 1));
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * One event per document, alarmed at whatever the reminder rules say.
 *
 * Documents that never expire, or that have no date yet, are left out: an event
 * with no date is not a reminder, and a birth certificate in a calendar is
 * clutter that makes the real entries harder to see.
 */
export function buildCalendar(documents, members, rules, { now = new Date() } = {}) {
  const active = normaliseRules(rules);
  const nameOf = new Map((members ?? []).map((m) => [m.id, m.name]));
  const stamp = stampOf(now);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Document expiries',
  ];

  let events = 0;
  for (const doc of documents ?? []) {
    if (doc.status !== 'active') continue;
    if (doc.no_expiry || !isValidISODate(doc.expiry_date)) continue;

    const holder = nameOf.get(doc.member_id) ?? 'Unknown';
    const what = documentLabel(doc);
    const icon = documentType(doc.type).icon;

    lines.push('BEGIN:VEVENT');
    // The document's own uid, so re-importing an updated file replaces the
    // event rather than leaving the old date sitting in the calendar beside it.
    lines.push(`UID:${doc.uid ?? `doctrack-${doc.id}`}@doctrack`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${dayOf(doc.expiry_date)}`);
    lines.push(`DTEND;VALUE=DATE:${nextDay(doc.expiry_date)}`);
    lines.push(`SUMMARY:${escapeText(`${icon} ${holder}'s ${what} expires`)}`);
    lines.push(
      `DESCRIPTION:${escapeText(
        [
          `${what} for ${holder}.`,
          doc.number ? `Number ${doc.number}.` : '',
          'Added by DocTrack.',
        ]
          .filter(Boolean)
          .join(' '),
      )}`,
    );
    lines.push('TRANSP:TRANSPARENT');

    // One alarm per lead time, so the calendar nags on the same schedule the
    // app would have.
    for (const days of leadsFor(doc.type, active)) {
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(`TRIGGER:-P${days}D`);
      lines.push(`DESCRIPTION:${escapeText(`${holder}'s ${what} expires in ${days} days`)}`);
      lines.push('END:VALARM');
    }

    lines.push('END:VEVENT');
    events += 1;
  }

  lines.push('END:VCALENDAR');
  return { ics: `${lines.map(foldLine).join('\r\n')}\r\n`, events };
}

export function calendarFilename(date = new Date()) {
  return `doctrack-expiries-${date.toISOString().slice(0, 10)}.ics`;
}
