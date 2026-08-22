import Dexie from 'dexie';

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

// ---------------------------------------------------------------- members

export function listMembers() {
  return db.members.orderBy('created_at').toArray();
}

export async function addMember({ name, relation }) {
  return db.members.add({
    name: name.trim(),
    relation,
    created_at: new Date().toISOString(),
  });
}

export function updateMember(id, changes) {
  return db.members.update(id, changes);
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

  const id = await db.members.add({
    name: name.trim(),
    relation,
    auto_created: 1,
    created_at: new Date().toISOString(),
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
 * An exact normalised match, or a unique first-name match. Anything looser and
 * "Mohammed Ali" would swallow "Mohammed Hassan".
 */
export function matchMemberByName(name, members) {
  const target = normaliseName(name);
  if (!target) return null;

  const exact = members.filter((m) => normaliseName(m.name) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const first = target.split(' ')[0];
  const byFirst = members.filter((m) => normaliseName(m.name).split(' ')[0] === first);
  return byFirst.length === 1 ? byFirst[0] : null;
}

/** Removing a member takes their documents with them — nothing is left orphaned. */
export function deleteMember(id) {
  return db.transaction('rw', db.members, db.documents, db.reminders, async () => {
    const docs = await db.documents.where('member_id').equals(id).toArray();
    await Promise.all(docs.map((d) => clearRemindersFor(d.id)));
    await db.documents.where('member_id').equals(id).delete();
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

export async function addDocument(doc) {
  const now = new Date().toISOString();
  return db.documents.add({
    ...BLANK_DOCUMENT,
    ...doc,
    member_id: Number(doc.member_id),
    status: 'active',
    created_at: now,
    updated_at: now,
  });
}

export async function updateDocument(id, changes) {
  const before = await db.documents.get(id);
  await db.documents.update(id, { ...changes, updated_at: new Date().toISOString() });
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
  return db.transaction('rw', db.documents, db.reminders, async () => {
    await clearRemindersFor(id);
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
    const newId = await db.documents.add({
      ...BLANK_DOCUMENT,
      member_id: previous.member_id,
      type: previous.type,
      ...replacement,
      renewed_from: oldId,
      status: 'active',
      created_at: now,
      updated_at: now,
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
