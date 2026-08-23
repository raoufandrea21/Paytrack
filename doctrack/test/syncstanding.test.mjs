/**
 * The line that settles an argument between two devices. It is read by someone
 * trying to work out why their phone is empty, so it must never be vague and
 * never be wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LAST_SYNC_SETTING, SHARED_COUNT_SETTING } from '../src/lib/cloudsync.js';

test('the two settings are device-local, not shared between devices', async () => {
  const { SHARED_SETTINGS } = await import('../src/lib/sync.js');
  assert.ok(!SHARED_SETTINGS.includes(LAST_SYNC_SETTING),
    'when this device synced is a fact about this device');
  assert.ok(!SHARED_SETTINGS.includes(SHARED_COUNT_SETTING),
    'and so is what it saw when it did');
});
