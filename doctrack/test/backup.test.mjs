/**
 * The parts of backup that do not need a database. The transfer itself is
 * exercised in the browser, where there is one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_FORMAT, BACKUP_VERSION, backupFilename } from '../src/lib/backup.js';

const day = new Date('2026-08-23T09:00:00Z');

test('the two exports are named apart, so the wrong one is not sent', () => {
  assert.equal(backupFilename(day), 'doctrack-backup-2026-08-23.json');
  assert.equal(backupFilename(day, { photos: true }), 'doctrack-backup-2026-08-23.json');
  assert.equal(backupFilename(day, { photos: false }), 'doctrack-details-2026-08-23.json');
});

test('a backup announces what it is, so a stray JSON file is refused', () => {
  assert.equal(BACKUP_FORMAT, 'doctrack-backup');
  assert.equal(typeof BACKUP_VERSION, 'number');
});
