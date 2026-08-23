/**
 * The sync run itself: pull what OneDrive holds, merge it with this device,
 * write both sides back, then read anything new dropped in the Inbox folder.
 *
 * Ordering matters. Documents are applied before photos so the records exist
 * even if the photo transfer is interrupted, and the Inbox is processed last so
 * newly filed documents go up on the next run rather than racing this one.
 */
import { db, newUid, putSettingRow, recordTombstone, setSetting, settingRows } from '../db.js';
import {
  IMPORTS_EPOCH,
  mergeStates,
  packDocument,
  packImport,
  packMember,
  photoNeeds,
  photoPath,
  photosToDownload,
  emptyState,
} from './sync.js';
import * as graph from './onedrive.js';
import { FILED_FOLDER, INBOX_FOLDER, STATE_FILE } from './onedrive.js';
import { prepareFile } from './files.js';
import { readPath } from './filename.js';
import { extractDocument, extractionAvailable } from './extract.js';
import { fileDocument } from './autofile.js';

/** When this device last finished a sync. Never shared — see runSync. */
export const LAST_SYNC_SETTING = 'last_sync_at';

/** Reads this device's side of the world in the shape the merge expects. */
export async function localState() {
  const [members, documents, tombstones, settings, imports] = await Promise.all([
    db.members.toArray(),
    db.documents.toArray(),
    db.tombstones.toArray(),
    settingRows(),
    db.imports.toArray(),
  ]);
  const memberUidById = new Map(members.map((m) => [m.id, m.uid]));
  const documentUidById = new Map(documents.map((d) => [d.id, d.uid]));

  return {
    state: {
      ...emptyState(),
      members: members.map(packMember),
      documents: documents.map((d) => packDocument(d, memberUidById)),
      tombstones,
      settings,
      imports: imports.map((row) => packImport(row, documentUidById)),
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

    // The photo facts describe what is in the shared folder, not what this
    // device holds, so they must not be written onto the row — the blobs on the
    // row are the only truthful answer here.
    const {
      member_uid: _ownerUid,
      has_photo: _hasPhoto,
      has_back: _hasBack,
      photo_bytes: _photoBytes,
      photo_back_bytes: _backBytes,
      ...fields
    } = record;
    const existing = documentByUid.get(record.uid);
    if (existing) {
      await db.documents.update(existing.id, { ...fields, member_id: memberId });
    } else {
      await db.documents.add({ ...fields, member_id: memberId, photo: null });
    }
    applied += 1;
  }

  // The household's shared preferences — reminder rules, which folder to read.
  // Nothing here is a secret: what travels is decided by an allow-list in
  // sync.js, and the API key is not on it.
  for (const row of incoming.settings ?? []) {
    await putSettingRow(row);
    applied += 1;
  }

  // "Start again" on the other device. The log has no tombstones — it merges as
  // a union — so the reset travels as a stamp, and every device throws away
  // what it read before that moment. Applied after the settings above, so the
  // stamp that just arrived is the one in force.
  const clearedAt = String((await db.settings.get(IMPORTS_EPOCH))?.value ?? '');
  if (clearedAt) {
    const stale = (await db.imports.toArray())
      .filter((row) => String(row.imported_at ?? '') <= clearedAt)
      .map((row) => row.item_id);
    if (stale.length) await db.imports.bulkDelete(stale);
  }

  // The log of files already read out of OneDrive. Pointed back at this
  // device's own row ids, and only for documents that actually exist here —
  // a log entry aimed at nothing would make a real file look already-read.
  const documentIdByUid = new Map((await db.documents.toArray()).map((d) => [d.uid, d.id]));
  for (const row of incoming.imports ?? []) {
    if (!row?.item_id) continue;
    await db.imports.put({
      item_id: row.item_id,
      c_tag: row.c_tag ?? '',
      name: row.name ?? '',
      path: row.path ?? '',
      document_id: row.document_uid ? documentIdByUid.get(row.document_uid) ?? null : null,
      outcome: row.outcome ?? '',
      imported_at: row.imported_at ?? '',
    });
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
 *
 * `api` exists so the whole run can be exercised against a stand-in for
 * OneDrive. Everything here beyond signing in is ordinary logic — merging,
 * ordering, moving files — and it is the part most likely to be wrong, so it
 * should not be untestable merely because the transport needs a Microsoft
 * account.
 */
export async function runSync(settings, { onStatus, api = graph } = {}) {
  const clientId = settings?.onedrive_client_id;
  if (!clientId) throw new Error('No Microsoft app ID saved.');

  const say = (text) => onStatus?.(text);

  say('Reading OneDrive…');
  const remote = await api.readJson(clientId, STATE_FILE);

  say('Merging…');
  const { state, members, documents } = await localState();
  const { merged, incoming, remoteIsStale } = mergeStates(state, remote);

  const applied = await applyIncoming(
    { ...incoming, tombstones: merged.tombstones },
    { members, documents },
  );

  if (remoteIsStale || !remote) {
    say('Saving to OneDrive…');
    await api.writeJson(clientId, STATE_FILE, merged);
  }

  const photos = await syncPhotos(clientId, merged, { say, api });
  // By this point the records on both sides are already correct. A problem
  // reading the Inbox is worth reporting, but it must not turn a sync that
  // worked into "Sync failed".
  const inbox = await processInbox(clientId, settings, { say, api }).catch((error) => {
    console.warn('[doctrack] could not read the Inbox', error);
    return { filed: 0, skipped: 0, error: error?.message ?? 'the Inbox could not be read' };
  });

  // Recorded so a device that is connected but has nothing on it can tell the
  // difference between "never synced" and "synced, and the folder was empty" —
  // which are the same blank screen and completely different problems. Device-
  // local on purpose: it is a fact about this phone, not about the household,
  // so it is deliberately not in SHARED_SETTINGS.
  await setSetting(LAST_SYNC_SETTING, new Date().toISOString());

  say(null);
  return { pulled: applied, pushed: remoteIsStale ? merged.documents.length : 0, photos, inbox };
}

/**
 * Photos move in both directions, but only for records that lack them.
 *
 * One photo that will not transfer must not take the rest of the run with it.
 * A patchy connection or a single unreadable file would otherwise stop every
 * later photo and the Inbox behind them, and the next run would fail in the
 * same place. So each photo is attempted on its own and counted if it fails;
 * the records are already safe, and the missing photo is retried next time.
 */
async function syncPhotos(clientId, merged, { say, api = graph }) {
  const local = await db.documents.toArray();
  const uploads = local.filter((d) => d.photo && d.uid);
  let uploaded = 0;
  let downloaded = 0;
  let failed = 0;

  const remoteNames = new Set(
    (await api.listChildren(clientId, 'photos').catch(() => [])).map((item) => item.name),
  );

  for (const doc of uploads) {
    for (const [side, blob] of [['front', doc.photo], ['back', doc.photo_back]]) {
      if (!blob) continue;
      // The name carries the byte count, so a picture already up there is
      // skipped and a replacement is a name nobody has seen before.
      const path = photoPath(doc.uid, doc.photo_type, side, blob.size);
      if (remoteNames.has(path.split('/').pop())) continue;
      say(`Uploading photo ${uploaded + 1}…`);
      try {
        await api.uploadFile(clientId, path, blob);
        uploaded += 1;
      } catch (error) {
        console.warn('[doctrack] could not upload', path, error);
        failed += 1;
      }
    }
  }

  const localByUid = new Map(local.map((d) => [d.uid, d]));
  for (const record of photosToDownload(merged.documents, local)) {
    say(`Fetching photo ${downloaded + 1}…`);
    try {
      const row = await db.documents.where('uid').equals(record.uid).first();
      if (!row) continue;
      const needs = photoNeeds(record, localByUid.get(record.uid));
      const changes = {};

      if (needs.front) {
        const blob = await api.downloadFile(
          clientId,
          photoPath(record.uid, record.photo_type, 'front', record.photo_bytes),
        );
        // A side that will not come down must leave the copy already here
        // alone: overwriting it with nothing loses the only copy on this device.
        if (blob) {
          changes.photo = blob;
          changes.photo_type = record.photo_type;
        }
      }
      if (needs.back) {
        const back = await api
          .downloadFile(clientId, photoPath(record.uid, record.photo_type, 'back', record.photo_back_bytes))
          .catch(() => null);
        if (back) changes.photo_back = back;
      }

      if (Object.keys(changes).length === 0) continue;
      await db.documents.update(row.id, changes);
      downloaded += 1;
    } catch (error) {
      console.warn('[doctrack] could not fetch photo for', record.uid, error);
      failed += 1;
    }
  }

  return { uploaded, downloaded, failed };
}

/**
 * Anything dropped into OneDrive/Apps/DocTrack/Inbox is read, filed, and moved
 * to Filed so it is not read twice. This is the part that makes the folder feel
 * like the app: put a document in it from any device and it turns up tracked.
 */
export async function processInbox(clientId, settings, { say, api = graph } = {}) {
  if (!extractionAvailable(settings)) return { filed: 0, skipped: 0 };

  // The Inbox is an offer, not a requirement. Creating it needs a write, which
  // a read-only drive refuses, and looking inside one that does not exist is
  // not a failure of anything — reporting either as "sync could not finish"
  // turns a working sync into a warning about a folder nobody asked for.
  const children = await api
    .ensureFolder(clientId, INBOX_FOLDER)
    .then(() => api.listChildren(clientId, INBOX_FOLDER))
    .catch(() => null);
  if (!children) return { filed: 0, skipped: 0 };

  const files = children.filter((item) => item.file && !item.folder);

  let filed = 0;
  let skipped = 0;

  for (const [index, item] of files.entries()) {
    say?.(`Reading ${index + 1} of ${files.length} from the Inbox…`);
    try {
      const blob = await api.downloadFile(clientId, `${INBOX_FOLDER}/${item.name}`);
      if (!blob) { skipped += 1; continue; }

      const named = new File([blob], item.name, {
        type: blob.type || guessType(item.name),
      });
      const prepared = await prepareFile(named);
      const extraction = await extractDocument(prepared.blob, settings);
      // The Inbox is flat, so there is no folder to name the owner — but the
      // filename still says the kind, the year, and whether it is a portrait.
      const result = await fileDocument({
        prepared,
        extraction,
        hints: readPath(item.name),
      });

      // Moved rather than deleted: the original stays in the user's own drive.
      await api.moveItem(clientId, item.id, FILED_FOLDER);
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
