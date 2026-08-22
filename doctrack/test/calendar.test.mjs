/**
 * The calendar file is the only reminder that works when nobody opens the app,
 * so a malformed one is not a cosmetic problem — it is silence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendar, calendarFilename, escapeText, foldLine } from '../src/lib/calendar.js';
import { defaultRules } from '../src/lib/reminderrules.js';

const now = new Date('2026-08-22T09:00:00Z');
const members = [{ id: 1, name: 'Raouf Andrea' }, { id: 2, name: 'Sandy Charif' }];
const doc = (over = {}) => ({
  id: 1, uid: 'uid-1', member_id: 1, type: 'passport', label: '', number: 'A1234567',
  expiry_date: '2027-03-14', no_expiry: 0, status: 'active', ...over,
});

const build = (docs, rules = defaultRules()) =>
  buildCalendar(docs, members, rules, { now });

test('a document becomes an all-day event on the day it expires', () => {
  const { ics, events } = build([doc()]);
  assert.equal(events, 1);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART;VALUE=DATE:20270314/);
  // Exclusive end, or the event lands on the wrong day in half the calendars.
  assert.match(ics, /DTEND;VALUE=DATE:20270315/);
  assert.match(ics, /END:VCALENDAR/);
});

test('the event says whose document it is', () => {
  const { ics } = build([doc()]);
  assert.match(ics, /SUMMARY:.*Raouf Andrea's Passport expires/);
  assert.match(ics, /DESCRIPTION:Passport for Raouf Andrea\. Number A1234567\./);
});

test('every line ends CRLF, as the format requires', () => {
  const { ics } = build([doc()]);
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'a bare newline would break strict parsers');
});

test('the reminder rules become alarms', () => {
  const { ics } = build([doc()]);
  // A passport leads by six months, three months, a month and a week.
  for (const days of [180, 90, 30, 7]) {
    assert.match(ics, new RegExp(`TRIGGER:-P${days}D`), `${days} days`);
  }
  assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, 4);
});

test('a silenced document type still gets its date, just no alarms', () => {
  const rules = { ...defaultRules(), muted: ['passport'] };
  const { ics, events } = build([doc()], rules);
  assert.equal(events, 1);
  assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, 0);
});

test('nothing without a date is written out', () => {
  const { events } = build([
    doc({ id: 2, uid: 'u2', expiry_date: '' }),
    doc({ id: 3, uid: 'u3', no_expiry: 1, type: 'birth_certificate' }),
    doc({ id: 4, uid: 'u4', expiry_date: 'not a date' }),
    doc({ id: 5, uid: 'u5', status: 'archived' }),
  ]);
  assert.equal(events, 0, 'an event with no date is not a reminder');
});

test('the event keeps the document\'s identity, so re-importing replaces it', () => {
  const first = build([doc()]).ics;
  const later = build([doc({ expiry_date: '2032-03-14' })]).ics;
  assert.match(first, /UID:uid-1@doctrack/);
  assert.match(later, /UID:uid-1@doctrack/);
  assert.notEqual(first, later, 'the date moved');
});

// ------------------------------------------------------------- the escaping

test('a comma in a name does not truncate the title', () => {
  assert.equal(escapeText('Charalambous, Raouf'), 'Charalambous\\, Raouf');
  assert.equal(escapeText('a;b'), 'a\\;b');
  assert.equal(escapeText('a\\b'), 'a\\\\b');
  assert.equal(escapeText('one\ntwo'), 'one\\ntwo');
  assert.equal(escapeText(null), '');
});

test('a comma in a real name is escaped in the file', () => {
  const { ics } = buildCalendar(
    [doc({ member_id: 2 })],
    [{ id: 2, name: 'Charif, Sandy' }],
    defaultRules(),
    { now },
  );
  assert.match(ics, /SUMMARY:.*Charif\\, Sandy's Passport expires/);
});

// -------------------------------------------------------------- the folding

test('a short line is left alone', () => {
  assert.equal(foldLine('SUMMARY:short'), 'SUMMARY:short');
});

test('a long line is folded with a leading space on the continuation', () => {
  const folded = foldLine('SUMMARY:' + 'x'.repeat(200));
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 1);
  assert.ok(parts.slice(1).every((p) => p.startsWith(' ')));
  assert.equal(parts.join('').replace(/\n? /g, ''), 'SUMMARY:' + 'x'.repeat(200));
});

test('folding counts bytes, not letters', () => {
  // Greek and Arabic names are two bytes a letter; folding by character count
  // produces lines that are still over the limit.
  const line = 'SUMMARY:' + 'Χαραλάμπους'.repeat(12);
  const encoder = new TextEncoder();
  for (const part of foldLine(line).split('\r\n')) {
    assert.ok(encoder.encode(part).length <= 75, `${encoder.encode(part).length} octets`);
  }
});

test('folding never splits a character in half', () => {
  const line = 'SUMMARY:' + '🪪'.repeat(40);
  for (const part of foldLine(line).split('\r\n')) {
    assert.ok(!part.includes('�'));
  }
  assert.equal(foldLine(line).split('\r\n').join('').replace(/^ | /g, ''), line);
});

test('the file is named for the day it was made', () => {
  assert.equal(calendarFilename(now), 'doctrack-expiries-2026-08-22.ics');
});
