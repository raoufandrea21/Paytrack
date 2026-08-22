/**
 * Backup and transfer.
 *
 * DocTrack keeps everything in IndexedDB on the device, which is what makes it
 * free, private and offline — and also means a phone and a laptop each start
 * empty. There is no server to sync through, so the transfer is a file: export
 * on one device, import on the other.
 *
 * It doubles as the answer to the more serious risk. Clearing the browser's
 * site data wipes the lot, and on some platforms uninstalling the app does too.
 */
import { db } from '../db.js';

export const BACKUP_FORMAT = 'doctrack-backup';
export const BACKUP_VERSION = 1;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read a stored photo.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const response = await fetch(dataUrl);
  return response.blob();
}

/**
 * Everything, photos included, as one JSON object.
 *
 * The API key is deliberately left out: a backup is a file people email to
 * themselves and drop in cloud storage, and a spendable credential should not
 * ride along inside it.
 */
export async function buildBackup() {
  const [members, documents, reminders, settings] = await Promise.all([
    db.members.toArray(),
    db.documents.toArray(),
    db.reminders.toArray(),
    db.settings.toArray(),
  ]);

  const packed = [];
  for (const doc of documents) {
    packed.push({
      ...doc,
      photo: doc.photo ? await blobToDataUrl(doc.photo) : null,
    });
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    members,
    documents: packed,
    reminders,
    settings: settings.filter((row) => row.key !== 'anthropic_api_key'),
  };
}

export function backupFilename(date = new Date()) {
  const stamp = date.toISOString().slice(0, 10);
  return `doctrack-backup-${stamp}.json`;
}

/**
 * Restores a backup alongside whatever is already here.
 *
 * Merging rather than replacing, because the likeliest use is a phone that
 * already has a couple of documents on it receiving the laptop's collection.
 * People are matched by name, documents by holder, type, number and expiry —
 * so importing the same file twice does not double everything up.
 */
export async function restoreBackup(payload, { onProgress } = {}) {
  if (payload?.format !== BACKUP_FORMAT) {
    throw new Error('That file is not a DocTrack backup.');
  }
  if (Number(payload.version) > BACKUP_VERSION) {
    throw new Error('That backup came from a newer version of DocTrack.');
  }

  const existingMembers = await db.members.toArray();
  const memberIdMap = new Map();
  const norm = (s) => String(s ?? '').trim().toLowerCase();

  let membersAdded = 0;
  for (const member of payload.members ?? []) {
    const match = existingMembers.find((m) => norm(m.name) === norm(member.name));
    if (match) {
      memberIdMap.set(member.id, match.id);
      continue;
    }
    const { id, ...rest } = member;
    const newId = await db.members.add(rest);
    memberIdMap.set(id, newId);
    existingMembers.push({ ...rest, id: newId });
    membersAdded += 1;
  }

  const existingDocs = await db.documents.toArray();
  const signature = (d) =>
    [d.member_id, d.type, norm(d.label), norm(d.number), d.expiry_date].join('|');
  const seen = new Set(existingDocs.map(signature));

  let documentsAdded = 0;
  let skipped = 0;
  const incoming = payload.documents ?? [];

  for (const [index, doc] of incoming.entries()) {
    onProgress?.((index + 1) / incoming.length);

    const memberId = memberIdMap.get(doc.member_id);
    if (!memberId) { skipped += 1; continue; }

    const { id, photo, renewed_from: _renewedFrom, ...rest } = doc;
    const candidate = { ...rest, member_id: memberId };
    if (seen.has(signature(candidate))) { skipped += 1; continue; }

    // renewed_from pointed at an id in the other device's database, so the
    // chain cannot be carried over — the archived rows still come across as
    // records, just no longer linked.
    await db.documents.add({
      ...candidate,
      renewed_from: null,
      photo: photo ? await dataUrlToBlob(photo) : null,
    });
    seen.add(signature(candidate));
    documentsAdded += 1;
  }

  return { membersAdded, documentsAdded, skipped };
}
