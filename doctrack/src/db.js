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
  number: '',
  issue_date: '',
  expiry_date: '',
  notes: '',
  photo: null,
  photo_type: null,
  extraction: null,
  renewed_from: null,
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
