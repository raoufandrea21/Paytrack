/**
 * The sync run itself: pull what OneDrive holds, merge it with this device,
 * write both sides back, then read anything new dropped in the Inbox folder.
 *
 * Ordering matters. Documents are applied before photos so the records exist
 * even if the photo transfer is interrupted, and the Inbox is processed last so
 * newly filed documents go up on the next run rather than racing this one.
 */
import { db, newUid, recordTombstone } from '../db.js';
import {
  mergeStates,
  packDocument,
  packMember,
  photoPath,
  photosToDownload,
  emptyState,
} from './sync.js';
import {
  FILED_FOLDER,
  INBOX_FOLDER,
  STATE_FILE,
  downloadFile,
  ensureFolder,
  listChildren,
  moveItem,
  readJson,
  uploadFile,
  writeJson,
} from './onedrive.js';
import { prepareFile } from './files.js';
import { extractDocument, extractionAvailable } from './extract.js';
import { fileDocument } from './autofile.js';

/** Reads this device's side of the world in the shape the merge expects. */
export async function localState() {
  const [members, documents, tombstones] = await Promise.all([
    db.members.toArray(),
    db.documents.toArray(),
    db.tombstones.toArray(),
  ]);
  const memberUidById = new Map(members.map((m) => [m.id, m.uid]));

  return {
    state: {
      ...emptyState(),
      members: members.map(packMember),
      documents: documents.map((d) => packDocument(d, memberUidById)),
      tombstones,
    },
    members,
    documents,
  };
}

/** Writes merged records into IndexedDB, matching on uid rather than local id. */
export async function applyIncoming(incoming, { members, documents }) {
  const memberByUid = new Map(members.map((m) => [m.uid, m]));
  const documentByUid = new Map(documents.map((d) => [d.uid, d]));
  let applied = 0;

  for (const record of incoming.members) {
    const existing = memberByUid.get(record.uid);
    if (existing) {
      await db.members.update(existing.id, { ...record, id: existing.id });
    } else {
      const id = await db.members.add({ ...record });
      memberByUid.set(record.uid, { ...record, id });
    }
    applied += 1;
  }

  // Refresh, because a document arriving in this same batch may belong to a
  // member that only just landed above.
  const memberIdByUid = new Map((await db.members.toArray()).map((m) => [m.uid, m.id]));

  for (const record of incoming.documents) {
    const memberId = memberIdByUid.get(record.member_uid);
    if (!memberId) continue; // its owner was deleted; the tombstone will follow

    const { member_uid: _ownerUid, has_photo: _hasPhoto, has_back: _hasBack, ...fields } = record;
    const existing = documentByUid.get(record.uid);
    if (existing) {
      await db.documents.update(existing.id, { ...fields, member_id: memberId });
    } else {
      await db.documents.add({ ...fields, member_id: memberId, photo: null });
    }
    applied += 1;
  }

  for (const grave of incoming.tombstones ?? []) {
    if (grave.kind === 'document') {
      const doc = documentByUid.get(grave.uid);
      if (doc) await db.documents.delete(doc.id);
    } else if (grave.kind === 'member') {
      const member = memberByUid.get(grave.uid);
      if (member) await db.members.delete(member.id);
    }
  }

  return applied;
}

/**
 * One full sync. Returns a plain-language summary for the settings screen.
 */
export async function runSync(settings, { onStatus } = {}) {
  const clientId = settings?.onedrive_client_id;
  if (!clientId) throw new Error('No Microsoft app ID saved.');

  const say = (text) => onStatus?.(text);

  say('Reading OneDrive…');
  const remote = await readJson(clientId, STATE_FILE);

  say('Merging…');
  const { state, members, documents } = await localState();
  const { merged, incoming, remoteIsStale } = mergeStates(state, remote);

  const applied = await applyIncoming(
    { ...incoming, tombstones: merged.tombstones },
    { members, documents },
  );

  if (remoteIsStale || !remote) {
    say('Saving to OneDrive…');
    await writeJson(clientId, STATE_FILE, merged);
  }

  const photos = await syncPhotos(clientId, merged, { say });
  const inbox = await processInbox(clientId, settings, { say });

  say(null);
  return { pulled: applied, pushed: remoteIsStale ? merged.documents.length : 0, photos, inbox };
}

/** Photos move in both directions, but only for records that lack them. */
async function syncPhotos(clientId, merged, { say }) {
  const local = await db.documents.toArray();
  const uploads = local.filter((d) => d.photo && d.uid);
  let uploaded = 0;
  let downloaded = 0;

  const remoteNames = new Set(
    (await listChildren(clientId, 'photos').catch(() => [])).map((item) => item.name),
  );

  for (const doc of uploads) {
    for (const [side, blob] of [['front', doc.photo], ['back', doc.photo_back]]) {
      if (!blob) continue;
      const path = photoPath(doc.uid, doc.photo_type, side);
      if (remoteNames.has(path.split('/').pop())) continue;
      say(`Uploading photo ${uploaded + 1}…`);
      await uploadFile(clientId, path, blob);
      uploaded += 1;
    }
  }

  const wanted = photosToDownload(merged.documents, local);
  for (const record of wanted) {
    say(`Fetching photo ${downloaded + 1}…`);
    const blob = await downloadFile(clientId, photoPath(record.uid, record.photo_type));
    if (!blob) continue;
    const row = await db.documents.where('uid').equals(record.uid).first();
    if (row) {
      const back = record.has_back
        ? await downloadFile(clientId, photoPath(record.uid, record.photo_type, 'back')).catch(() => null)
        : null;
      await db.documents.update(row.id, { photo: blob, photo_back: back, photo_type: record.photo_type });
      downloaded += 1;
    }
  }

  return { uploaded, downloaded };
}

/**
 * Anything dropped into OneDrive/Apps/DocTrack/Inbox is read, filed, and moved
 * to Filed so it is not read twice. This is the part that makes the folder feel
 * like the app: put a document in it from any device and it turns up tracked.
 */
export async function processInbox(clientId, settings, { say } = {}) {
  if (!extractionAvailable(settings)) return { filed: 0, skipped: 0 };

  await ensureFolder(clientId, INBOX_FOLDER);
  const children = await listChildren(clientId, INBOX_FOLDER);
  const files = children.filter((item) => item.file && !item.folder);

  let filed = 0;
  let skipped = 0;

  for (const [index, item] of files.entries()) {
    say?.(`Reading ${index + 1} of ${files.length} from the Inbox…`);
    try {
      const blob = await downloadFile(clientId, `${INBOX_FOLDER}/${item.name}`);
      if (!blob) { skipped += 1; continue; }

      const named = new File([blob], item.name, {
        type: blob.type || guessType(item.name),
      });
      const prepared = await prepareFile(named);
      const extraction = await extractDocument(prepared.blob, settings);
      const result = await fileDocument({ prepared, extraction });

      // Moved rather than deleted: the original stays in the user's own drive.
      await moveItem(clientId, item.id, FILED_FOLDER);
      if (result.outcome === 'duplicate') skipped += 1;
      else filed += 1;
    } catch (error) {
      console.warn('[doctrack] could not file', item.name, error);
      skipped += 1;
    }
  }

  return { filed, skipped };
}

function guessType(name) {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}

export { newUid, recordTombstone };
