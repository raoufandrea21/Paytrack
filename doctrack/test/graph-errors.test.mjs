/**
 * What a person is told when OneDrive refuses.
 *
 * These arrive as JSON with the real reason buried in an innerError, and the
 * one that actually happens — a drive Microsoft has switched to read-only —
 * says "accessDenied" at the top level, which is not what is wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeGraphFailure } from '../src/lib/onedrive.js';

const graphBody = (code, innerCode, message) =>
  JSON.stringify({
    error: {
      code,
      message,
      innerError: { code: innerCode, date: '2026-08-22T15:04:46', 'request-id': 'd61e6224' },
    },
  });

test('a read-only drive is explained as a full or frozen account', () => {
  // Verbatim shape of what Microsoft returned to this app.
  const said = describeGraphFailure(403, graphBody('accessDenied', 'serviceReadOnly', 'Database Is Read Only'));
  assert.match(said, /read-only/i);
  assert.match(said, /onedrive\.com/);
  assert.match(said, /still on this device/i, 'and that nothing has been lost');
  assert.doesNotMatch(said, /innerError|request-id/, 'without the machine detail');
});

test('being out of space says so, and how much is needed', () => {
  assert.match(describeGraphFailure(507, graphBody('quotaLimitReached', '', 'Insufficient Storage')), /out of space/i);
  assert.match(describeGraphFailure(403, graphBody('quotaLimitReached', '', '')), /out of space/i);
});

test('an expired session sends you to the button that fixes it', () => {
  const said = describeGraphFailure(401, graphBody('InvalidAuthenticationToken', '', 'Access token has expired.'));
  assert.match(said, /sign in again/i);
  assert.match(said, /Connect OneDrive/);
});

test('throttling asks for patience rather than reporting a fault', () => {
  assert.match(describeGraphFailure(429, graphBody('activityLimitReached', '', 'Too many requests')), /slower pace|wait/i);
});

test("Microsoft's own outage is not reported as the user's problem", () => {
  assert.match(describeGraphFailure(503, 'Service Unavailable'), /Microsoft/);
  assert.match(describeGraphFailure(500, ''), /nothing is wrong here/i);
});

test('an unrecognised refusal still names the status rather than saying nothing', () => {
  assert.match(describeGraphFailure(400, graphBody('invalidRequest', '', 'Bad')), /\(400\)/);
});

test('a body that is not JSON does not throw', () => {
  assert.doesNotThrow(() => describeGraphFailure(403, '<html>gateway</html>'));
  assert.doesNotThrow(() => describeGraphFailure(500, undefined));
});

test('read-only is recognised even when only the raw text says so', () => {
  // Graph is not consistent about where it puts this; matching the whole body
  // is deliberate.
  assert.match(describeGraphFailure(403, 'the database is read only'), /read-only/i);
});
