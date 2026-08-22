import Dexie from 'dexie';
import { editDistance } from './lib/mrz.js';

/**
 * Everything lives here, on the device. No backend, no sync, no auth.
 *
 * Tables
 *   members    FamilyMember
 *   documents  Document (photo held as a Blob in the row itself)
 *   reminders  one row per (document, threshold) already notified about
 *   settings   single-row key/value store (API key, mode, endpoint)
 */
export const db = new Dexie('doctrack');

db.version(1).stores({
  members: '++id, name, relation, created_at',
  documents: '++id, member_id, type, expiry_date, status, created_at, renewed_from',
  reminders: '&key, document_id, threshold, notified_at',
  settings: '&key',
});

/** Stable across devices, unlike the auto-increment ids, which collide. */
export const newUid = () =>
  (globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

// v2 adds automatic filing: documents save themselves, and anything the reader
// was unsure about is indexed so the dashboard can surface it in one query.
db.version(2)
  .stores({
    members: '++id, name, relation, created_at, auto_created',
    documents:
      '++id, member_id, type, expiry_date, status, created_at, renewed_from, review_needed',
    reminders: '&key, document_id, threshold, notified_at',
    settings: '&key',
  })
  .upgrade((tx) =>
    tx
      .table('documents')
      .toCollection()
      .modify((doc) => {
        // Existing rows were all confirmed by hand, so none of them need review.
        doc.review_needed = 0;
        doc.file_kind = doc.photo ? 'image' : null;
      }),
  );

// v3 adds what syncing needs: an identity that means the same thing on two
// devices, and a record of deletions — without tombstones a delete on the phone
// looks identical to a record the phone has not seen yet, and comes straight
// back on the next merge.
db.version(3)
  .stores({
    // uid is indexed but not unique. A unique index has to be satisfied the
    // instant it is created, before the upgrade below has given the existing
    // rows their uids — and a failed upgrade leaves the database unopenable,
    // which the app can only show as a spinner that never stops.
    members: '++id, uid, name, relation, created_at, auto_created',
    documents:
      '++id, uid, member_id, type, expiry_date, status, created_at, renewed_from, review_needed',
    reminders: '&key, document_id, threshold, notified_at',
    tombstones: '&uid, kind, deleted_at',
    settings: '&key',
  })
  .upgrade(async (tx) => {
    const stamp = new Date().toISOString();
    await tx.table('members').toCollection().modify((m) => {
      m.uid ??= newUid();
      m.updated_at ??= m.created_at ?? stamp;
    });
    await tx.table('documents').toCollection().modify((d) => {
      d.uid ??= newUid();
      d.updated_at ??= d.created_at ?? stamp;
    });
  });

/** Records a deletion so the other device does not resurrect it. */
export function recordTombstone(uid, kind) {
  if (!uid) return Promise.resolve();
  return db.tombstones.put({ uid, kind, deleted_at: new Date().toISOString() });
}

/**
 * Opening the database, and saying so when it will not open.
 *
 * Dexie opens lazily on the first query, so a failure has nowhere to surface:
 * every query simply never settles and the app sits on "Loading…" forever. Two
 * things cause it in practice — an upgrade that throws, and an older copy of the
 * app still holding the database open in another tab or window, which blocks the
 * version change indefinitely.
 */
export const DATABASE_STATE = { OPENING: 'opening', READY: 'ready', BLOCKED: 'blocked', FAILED: 'failed' };

let blocked = false;

db.on('blocked', () => {
  // Another tab or window is still on the previous version and will not let go.
  blocked = true;
  console.warn('[doctrack] the database upgrade is blocked by another open copy of the app');
});

/**
 * Resolves to { state, error } the UI can act on. Never rejects.
 *
 * The error text is carried in the result rather than read from a module
 * variable: a remote device cannot be debugged, so the only way to learn what
 * actually went wrong is for the screen to show it.
 */
export function openDatabase({ timeoutMs = 8000 } = {}) {
  const failure = () => (blocked ? DATABASE_STATE.BLOCKED : DATABASE_STATE.FAILED);

  const opened = db
    .open()
    .then(() => ({ state: DATABASE_STATE.READY, error: null }))
    .catch((error) => {
      console.error('[doctrack] could not open the database', error);
      return { state: failure(), error: `${error?.name ?? 'Error'}: ${error?.message ?? 'unknown'}` };
    });

  // A blocked upgrade never settles either way, so the wait needs its own end.
  const gaveUp = new Promise((resolve) => {
    setTimeout(
      () => resolve({
        state: failure(),
        error: `Storage did not open within ${Math.round(timeoutMs / 1000)} seconds.`,
      }),
      timeoutMs,
    );
  });

  return Promise.race([opened, gaveUp]);
}

/**
 * Deletes everything and starts over. The escape hatch when an upgrade has left
 * the database in a state it cannot open — destructive, and only ever offered
 * with that said plainly.
 */
export async function resetDatabase() {
  db.close();
  await db.delete();
}

// ---------------------------------------------------------------- members

export function listMembers() {
  return db.members.orderBy('created_at').toArray();
}

export async function addMember({ name, relation }) {
  const now = new Date().toISOString();
  return db.members.add({
    uid: newUid(),
    name: name.trim(),
    relation,
    created_at: now,
    updated_at: now,
  });
}

export function updateMember(id, changes) {
  return db.members.update(id, { ...changes, updated_at: new Date().toISOString() });
}

/**
 * Used by automatic filing. Returns the existing member when the name clearly
 * belongs to someone already on file, otherwise creates them.
 *
 * Matching is deliberately strict — see matchMemberByName. Filing a document
 * under the wrong person is worse than creating a duplicate the user can merge
 * by renaming.
 */
export async function findOrCreateMember(name, { relation = 'Other' } = {}) {
  const members = await db.members.toArray();
  const existing = matchMemberByName(name, members);
  if (existing) return { member: existing, created: false };

  const now = new Date().toISOString();
  const id = await db.members.add({
    uid: newUid(),
    name: name.trim(),
    relation,
    auto_created: 1,
    created_at: now,
    updated_at: now,
  });
  return { member: await db.members.get(id), created: true };
}

const normaliseName = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z\u0600-\u06ff\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * An exact normalised match, a unique first-name match, or — for a long enough
 * name — a unique near match.
 *
 * The near match exists because a reader that turns "Raouf" into "Raoquf"
 * otherwise creates a second copy of a person who is already on file, and the
 * user ends up with their household listed twice. Tolerance is one edit per six
 * characters and only applies from eight characters up, so short names cannot
 * absorb each other; "Mohammed Ali" and "Mohammed Hassan" stay four edits apart
 * and separate.
 */
export function matchMemberByName(name, members) {
  const target = normaliseName(name);
  if (!target) return null;

  const exact = members.filter((m) => normaliseName(m.name) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  // First-name matching is for when only a first name was read. Once both
  // sides carry a surname, differing surnames mean different people —
  // "Mohammed Hassan" must not land on "Mohammed Ali".
  const words = target.split(' ');
  const first = words[0];
  const byFirst = members.filter((m) => {
    const stored = normaliseName(m.name).split(' ');
    if (stored[0] !== first) return false;
    return words.length === 1 || stored.length === 1;
  });
  if (byFirst.length === 1) return byFirst[0];
  if (byFirst.length > 1) return null;

  if (target.length >= 8) {
    const tolerance = Math.floor(target.length / 6);
    const near = members.filter(
      (m) => editDistance(target, normaliseName(m.name), tolerance) <= tolerance,
    );
    if (near.length === 1) return near[0];
  }

  return null;
}

/** Members whose names normalise to the same thing — the same person, twice. */
export async function duplicateMembers() {
  const members = await db.members.toArray();
  const groups = new Map();
  for (const member of members) {
    const key = normaliseName(member.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(member);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * Folds several member records into one, moving every document across. Used
 * when a rename makes two entries the same person — which is exactly what
 * happens after correcting a misread name.
 */
export function mergeMembers(keepId, mergeIds) {
  const others = mergeIds.filter((id) => id !== keepId);
  if (others.length === 0) return Promise.resolve(0);

  return db.transaction('rw', db.members, db.documents, db.tombstones, async () => {
    let moved = 0;
    const now = new Date().toISOString();
    for (const id of others) {
      const documents = await db.documents.where('member_id').equals(id).toArray();
      for (const doc of documents) {
        await db.documents.update(doc.id, { member_id: keepId, updated_at: now });
        moved += 1;
      }
      const member = await db.members.get(id);
      await recordTombstone(member?.uid, 'member');
      await db.members.delete(id);
    }
    return moved;
  });
}

/** Removing a member takes their documents with them — nothing is left orphaned. */
export function deleteMember(id) {
  return db.transaction('rw', db.members, db.documents, db.reminders, db.tombstones, async () => {
    const member = await db.members.get(id);
    const docs = await db.documents.where('member_id').equals(id).toArray();
    for (const doc of docs) {
      await clearRemindersFor(doc.id);
      await recordTombstone(doc.uid, 'document');
    }
    await db.documents.where('member_id').equals(id).delete();
    await recordTombstone(member?.uid, 'member');
    await db.members.delete(id);
  });
}

// -------------------------------------------------------------- documents

export function listDocuments({ includeArchived = false } = {}) {
  return includeArchived
    ? db.documents.toArray()
    : db.documents.where('status').equals('active').toArray();
}

/** Everything automatic filing could not read confidently. */
export function documentsNeedingReview() {
  return db.documents
    .where('review_needed')
    .equals(1)
    .filter((d) => d.status === 'active')
    .toArray();
}

export function clearReviewFlag(id) {
  return db.documents.update(id, { review_needed: 0, updated_at: new Date().toISOString() });
}

export function getDocument(id) {
  return db.documents.get(id);
}

export function documentsForMember(memberId, { includeArchived = false } = {}) {
  return db.documents
    .where('member_id')
    .equals(memberId)
    .filter((d) => includeArchived || d.status === 'active')
    .toArray();
}

const BLANK_DOCUMENT = {
  type: 'other',
  // Free text, only meaningful when type is 'other'. Not indexed — the whole
  // table is loaded for the library screen anyway.
  label: '',
  // Set when a document has no expiry by nature — a birth certificate — or
  // when the user says so. Filed, not tracked. 0/1 rather than a boolean.
  no_expiry: 0,
  number: '',
  issue_date: '',
  expiry_date: '',
  notes: '',
  photo: null,
  photo_type: null,
  file_kind: null,
  extraction: null,
  renewed_from: null,
  // Dexie cannot index booleans, so this is 0/1 rather than false/true.
  review_needed: 0,
};

/**
 * A document with no expiry date that is not marked as never expiring cannot
 * remind anyone of anything, which is the one thing this app is for. However it
 * got that way — an unreadable scan, or a date left blank by hand — it is
 * unfinished, and belongs in "Needs checking" until someone says otherwise.
 */
const cannotRemind = (row) => Boolean(!row.no_expiry && !row.expiry_date && row.status !== 'archived');

export async function addDocument(doc) {
  const now = new Date().toISOString();
  const row = {
    ...BLANK_DOCUMENT,
    uid: newUid(),
    ...doc,
    member_id: Number(doc.member_id),
    // Usually active, but a document arriving from an "Expired" folder is
    // history the moment it lands — so the caller's status wins if it set one.
    status: doc.status ?? 'active',
    created_at: now,
    updated_at: now,
  };
  return db.documents.add({
    ...row,
    review_needed: cannotRemind(row) ? 1 : (row.review_needed ?? 0),
  });
}

export async function updateDocument(id, changes) {
  const before = await db.documents.get(id);
  const after = { ...before, ...changes };
  // Only ever raised here, never lowered: clearing the flag stays the caller's
  // decision, but saving a document that still cannot remind anyone re-raises it.
  const patch = cannotRemind(after) ? { ...changes, review_needed: 1 } : changes;
  await db.documents.update(id, { ...patch, updated_at: new Date().toISOString() });
  // A moved expiry date invalidates every reminder already sent for this
  // document. Editing anything else must not re-fire notifications the user
  // has already seen, so compare rather than assuming.
  if ('expiry_date' in changes && changes.expiry_date !== before?.expiry_date) {
    await clearRemindersFor(id);
  }
}

export function archiveDocument(id) {
  return db.transaction('rw', db.documents, db.reminders, async () => {
    await db.documents.update(id, {
      status: 'archived',
      updated_at: new Date().toISOString(),
    });
    await clearRemindersFor(id);
  });
}

export function unarchiveDocument(id) {
  return db.documents.update(id, {
    status: 'active',
    updated_at: new Date().toISOString(),
  });
}

export function deleteDocument(id) {
  return db.transaction('rw', db.documents, db.reminders, db.tombstones, async () => {
    const doc = await db.documents.get(id);
    await clearRemindersFor(id);
    await recordTombstone(doc?.uid, 'document');
    await db.documents.delete(id);
  });
}

/**
 * Renewal keeps history: the old row is archived rather than deleted, and the
 * new row points back at it via renewed_from.
 */
export function renewDocument(oldId, replacement) {
  return db.transaction('rw', db.documents, db.reminders, async () => {
    const previous = await db.documents.get(oldId);
    if (!previous) throw new Error(`Document ${oldId} no longer exists.`);
    const now = new Date().toISOString();
    const row = {
      ...BLANK_DOCUMENT,
      uid: newUid(),
      member_id: previous.member_id,
      type: previous.type,
      ...replacement,
      renewed_from: oldId,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    const newId = await db.documents.add({
      ...row,
      review_needed: cannotRemind(row) ? 1 : (row.review_needed ?? 0),
    });
    await db.documents.update(oldId, { status: 'archived', updated_at: now });
    await clearRemindersFor(oldId);
    return newId;
  });
}

/** Walks the renewed_from chain, newest first. */
export async function renewalHistory(documentId) {
  const chain = [];
  const seen = new Set();
  let current = await db.documents.get(documentId);
  while (current?.renewed_from != null && !seen.has(current.renewed_from)) {
    seen.add(current.renewed_from);
    current = await db.documents.get(current.renewed_from);
    if (!current) break;
    chain.push(current);
  }
  return chain;
}

// -------------------------------------------------------------- reminders

const reminderKey = (documentId, threshold) => `${documentId}:${threshold}`;

export function clearRemindersFor(documentId) {
  return db.reminders.where('document_id').equals(documentId).delete();
}

export async function wasReminded(documentId, threshold) {
  return Boolean(await db.reminders.get(reminderKey(documentId, threshold)));
}

export function markReminded(documentId, threshold) {
  return db.reminders.put({
    key: reminderKey(documentId, threshold),
    document_id: documentId,
    threshold,
    notified_at: new Date().toISOString(),
  });
}

// --------------------------------------------------------------- settings

export async function getSetting(key, fallback = null) {
  const row = await db.settings.get(key);
  return row === undefined ? fallback : row.value;
}

export function setSetting(key, value) {
  return db.settings.put({ key, value });
}

export async function getSettings() {
  const rows = await db.settings.toArray();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
