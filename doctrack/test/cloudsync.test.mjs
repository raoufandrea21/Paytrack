/**
 * The sync loop against a fake OneDrive.
 *
 * The real thing cannot be exercised without a Microsoft account, so this covers
 * the part that would actually go wrong: two devices taking turns, each one's
 * changes surviving the other's, and nothing multiplying when a sync runs twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, mergeStates, packDocument, packMember } from '../src/lib/sync.js';

/** A device holding local state, syncing through a shared JSON blob. */
class Device {
  constructor(name, cloud) {
    this.name = name;
    this.cloud = cloud;
    this.members = [];
    this.documents = [];
    this.tombstones = [];
    this.nextId = 1;
  }

  addMember(uid, name, at) {
    this.members.push({ id: this.nextId++, uid, name, relation: 'Me', created_at: at, updated_at: at });
  }

  addDocument(uid, memberUid, at, fields = {}) {
    const member = this.members.find((m) => m.uid === memberUid);
    this.documents.push({
      id: this.nextId++, uid, member_id: member.id, type: 'passport', status: 'active',
      expiry_date: '2036-01-13', created_at: at, updated_at: at, ...fields,
    });
  }

  edit(uid, at, fields) {
    const doc = this.documents.find((d) => d.uid === uid);
    Object.assign(doc, fields, { updated_at: at });
  }

  remove(uid, at) {
    this.documents = this.documents.filter((d) => d.uid !== uid);
    this.tombstones.push({ uid, kind: 'document', deleted_at: at });
  }

  pack() {
    const byId = new Map(this.members.map((m) => [m.id, m.uid]));
    return {
      ...emptyState(),
      members: this.members.map(packMember),
      documents: this.documents.map((d) => packDocument(d, byId)),
      tombstones: this.tombstones,
    };
  }

  /** Mirrors runSync: pull, merge, apply locally, push when the cloud is behind. */
  sync() {
    const { merged, incoming, remoteIsStale } = mergeStates(this.pack(), this.cloud.state);

    for (const record of incoming.members) {
      const existing = this.members.find((m) => m.uid === record.uid);
      if (existing) Object.assign(existing, record);
      else this.members.push({ ...record, id: this.nextId++ });
    }
    for (const record of incoming.documents) {
      const member = this.members.find((m) => m.uid === record.member_uid);
      if (!member) continue;
      const existing = this.documents.find((d) => d.uid === record.uid);
      if (existing) Object.assign(existing, record, { member_id: member.id });
      else this.documents.push({ ...record, id: this.nextId++, member_id: member.id });
    }
    for (const grave of merged.tombstones) {
      this.documents = this.documents.filter((d) => d.uid !== grave.uid);
    }
    this.tombstones = merged.tombstones;

    if (remoteIsStale) {
      this.cloud.state = merged;
      this.cloud.writes += 1;
    }
    return { remoteIsStale };
  }
}

function setup() {
  const cloud = { state: null, writes: 0 };
  return { cloud, laptop: new Device('laptop', cloud), phone: new Device('phone', cloud) };
}

test('a document added on the laptop reaches the phone', () => {
  const { laptop, phone } = setup();
  laptop.addMember('m1', 'Raouf Charalambous', '2026-08-01');
  laptop.addDocument('d1', 'm1', '2026-08-01');

  laptop.sync();
  phone.sync();

  assert.equal(phone.documents.length, 1);
  assert.equal(phone.members[0].name, 'Raouf Charalambous');
});

test('each device keeps what the other added', () => {
  const { laptop, phone } = setup();
  laptop.addMember('m1', 'Raouf', '2026-08-01');
  laptop.addDocument('d1', 'm1', '2026-08-01');
  laptop.sync();
  phone.sync();

  laptop.addDocument('d2', 'm1', '2026-08-02', { type: 'emirates_id' });
  phone.addDocument('d3', 'm1', '2026-08-03', { type: 'driving_license' });

  laptop.sync();
  phone.sync();
  laptop.sync();

  const uids = (d) => d.documents.map((x) => x.uid).sort();
  assert.deepEqual(uids(laptop), ['d1', 'd2', 'd3']);
  assert.deepEqual(uids(phone), ['d1', 'd2', 'd3']);
});

test('the later correction wins when both devices edit the same record', () => {
  const { laptop, phone } = setup();
  laptop.addMember('m1', 'Raouf', '2026-08-01');
  laptop.addDocument('d1', 'm1', '2026-08-01', { number: 'ORIGINAL' });
  laptop.sync();
  phone.sync();

  laptop.edit('d1', '2026-08-05', { number: 'FROM LAPTOP' });
  phone.edit('d1', '2026-08-06', { number: 'FROM PHONE' });

  laptop.sync();
  phone.sync();
  laptop.sync();

  assert.equal(laptop.documents[0].number, 'FROM PHONE');
  assert.equal(phone.documents[0].number, 'FROM PHONE');
});

test('a deletion on one device removes it from the other', () => {
  const { laptop, phone } = setup();
  laptop.addMember('m1', 'Raouf', '2026-08-01');
  laptop.addDocument('d1', 'm1', '2026-08-01');
  laptop.sync();
  phone.sync();

  phone.remove('d1', '2026-08-04');
  phone.sync();
  laptop.sync();

  assert.equal(laptop.documents.length, 0);
  assert.equal(phone.documents.length, 0);
});

test('a deleted document does not come back on later syncs', () => {
  const { laptop, phone } = setup();
  laptop.addMember('m1', 'Raouf', '2026-08-01');
  laptop.addDocument('d1', 'm1', '2026-08-01');
  laptop.sync(); phone.sync();
  phone.remove('d1', '2026-08-04');
  phone.sync(); laptop.sync();

  for (let i = 0; i < 3; i += 1) { laptop.sync(); phone.sync(); }

  assert.equal(laptop.documents.length, 0);
  assert.equal(phone.documents.length, 0);
});

test('syncing when nothing changed does not rewrite the cloud file', () => {
  const { cloud, laptop, phone } = setup();
  laptop.addMember('m1', 'Raouf', '2026-08-01');
  laptop.addDocument('d1', 'm1', '2026-08-01');
  laptop.sync();
  phone.sync();

  const writes = cloud.writes;
  laptop.sync();
  phone.sync();
  assert.equal(cloud.writes, writes, 'a quiet sync should be read-only');
});

test('a device that has been offline for a while catches up in one sync', () => {
  const { laptop, phone } = setup();
  laptop.addMember('m1', 'Raouf', '2026-08-01');
  laptop.sync();
  phone.sync();

  for (let i = 0; i < 5; i += 1) {
    laptop.addDocument(`d${i}`, 'm1', `2026-08-1${i}`);
    laptop.sync();
  }

  phone.sync();
  assert.equal(phone.documents.length, 5);
});
