/**
 * Two-way merge between this device and the copy in OneDrive.
 *
 * There is no server arbitrating, so the merge has to be something both devices
 * can compute independently and agree on. It is last-write-wins per record,
 * keyed by a uid that means the same thing everywhere, with deletions carried as
 * tombstones — without those, a document deleted on the phone is
 * indistinguishable from one the phone has not seen yet, and comes straight back
 * on the next merge.
 *
 * Last-write-wins loses a field when the same record is edited on both devices
 * between syncs. For a household filing cabinet that is the right trade: the
 * alternative is per-field merging and a conflict UI, for a case that arises
 * when two people edit one passport record in the same afternoon.
 */

export const SYNC_FORMAT = 'doctrack-sync';
export const SYNC_VERSION = 1;

const later = (a, b) => (String(a ?? '') >= String(b ?? '') ? a : b);
const stamp = (record) => String(record?.updated_at ?? record?.created_at ?? '');

/**
 * Photos live beside the state file, one per document, and the filename carries
 * the byte count.
 *
 * That last part is what makes a re-photographed document work. If the name were
 * just the uid, a clearer scan taken on the phone would land on top of the old
 * one — and the laptop, seeing a name it already knows, would never fetch it. A
 * different picture is a different file, and the record says which one is
 * current, so there is never a question of whose copy is newer.
 */
export function photoPath(uid, mediaType, side = 'front', bytes = 0) {
  const extension = mediaType === 'application/pdf' ? 'pdf' : mediaType === 'image/png' ? 'png' : 'jpg';
  return `photos/${uid}${side === 'back' ? '-back' : ''}${bytes ? `-${bytes}` : ''}.${extension}`;
}

export function emptyState() {
  return {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    members: [],
    documents: [],
    tombstones: [],
    settings: [],
    imports: [],
  };
}

/**
 * When the import log was last thrown away, so that throwing it away travels.
 *
 * The log merges as a union — there is nothing to tombstone, and 400 graves for
 * one reset would be absurd. So "Start again" stamps the moment instead, and
 * every device drops the entries older than it. Without this, clearing
 * everything and syncing would pull the whole log back and the folder would
 * re-read as "already read" — nothing at all.
 */
export const IMPORTS_EPOCH = 'imports_cleared_at';

/**
 * The settings worth carrying between devices.
 *
 * Deliberately a list rather than "everything except secrets". Reminder rules
 * and which OneDrive folder to read are decisions about the household, and
 * having to make them twice is the whole complaint. A Microsoft app ID, an API
 * key or a chosen extraction mode are decisions about *this device* — and the
 * key must never be written into a file in someone's cloud storage, which is
 * the other reason this is an allow-list and not a deny-list.
 */
export const SHARED_SETTINGS = [
  'reminder_rules',
  'onedrive_import_filter',
  'onedrive_import_folder',
  'onedrive_watch_folder',
  IMPORTS_EPOCH,
];

/** Strips a local row down to what travels: no blobs, no device-local ids. */
export function packMember(member) {
  return {
    uid: member.uid,
    name: member.name,
    relation: member.relation,
    auto_created: member.auto_created ?? 0,
    created_at: member.created_at,
    updated_at: stamp(member),
  };
}

/**
 * One row of the "already read from OneDrive" log, in a form another device can
 * use. The local document id is swapped for the document's uid, because the
 * auto-increment ids are per-device and pointing at the wrong record is worse
 * than pointing at none.
 */
export function packImport(row, documentUidById) {
  return {
    item_id: row.item_id,
    c_tag: row.c_tag ?? '',
    name: row.name ?? '',
    path: row.path ?? '',
    document_uid: row.document_id == null ? null : documentUidById.get(row.document_id) ?? null,
    outcome: row.outcome ?? '',
    imported_at: row.imported_at ?? '',
  };
}

export function packDocument(document, memberUidById) {
  return {
    uid: document.uid,
    member_uid: memberUidById.get(document.member_id) ?? null,
    type: document.type,
    label: document.label ?? '',
    number: document.number ?? '',
    issue_date: document.issue_date ?? '',
    expiry_date: document.expiry_date ?? '',
    notes: document.notes ?? '',
    status: document.status,
    review_needed: document.review_needed ?? 0,
    file_kind: document.file_kind ?? null,
    photo_type: document.photo_type ?? null,
    no_expiry: document.no_expiry ?? 0,
    has_photo: Boolean(document.photo),
    has_back: Boolean(document.photo_back),
    photo_bytes: document.photo?.size ?? 0,
    photo_back_bytes: document.photo_back?.size ?? 0,
    extraction: document.extraction ?? null,
    created_at: document.created_at,
    updated_at: stamp(document),
  };
}

/**
 * Merges two states into the one both sides should end up holding.
 *
 * Also reports what each side is missing, so the caller knows what to write
 * locally and whether the remote file needs rewriting at all.
 */
export function mergeStates(local, remote) {
  const localState = normalise(local);
  const remoteState = normalise(remote);

  // Tombstones first: a deletion outranks any version of the record older than
  // it, whichever device is holding that version.
  const tombstones = new Map();
  for (const t of [...localState.tombstones, ...remoteState.tombstones]) {
    if (!t?.uid) continue;
    const existing = tombstones.get(t.uid);
    tombstones.set(t.uid, existing ? { ...t, deleted_at: later(existing.deleted_at, t.deleted_at) } : t);
  }

  const merged = { ...emptyState(), tombstones: [...tombstones.values()] };
  const incoming = { members: [], documents: [] };
  let remoteIsStale = false;

  for (const kind of ['members', 'documents']) {
    const byUid = new Map();
    for (const record of localState[kind]) if (record?.uid) byUid.set(record.uid, { local: record });
    for (const record of remoteState[kind]) {
      if (!record?.uid) continue;
      byUid.set(record.uid, { ...(byUid.get(record.uid) ?? {}), remote: record });
    }

    for (const [uid, pair] of byUid) {
      const grave = tombstones.get(uid);
      const newest = pick(pair.local, pair.remote);
      // A record edited after it was deleted is a resurrection the user meant.
      if (grave && stamp(newest) <= grave.deleted_at) continue;

      const record = kind === 'documents' ? withPhotoPresence(newest, pair) : newest;
      merged[kind].push(record);
      if (!pair.local || stamp(pair.local) < stamp(record)) incoming[kind].push(record);
      if (!pair.remote || stamp(pair.remote) < stamp(record) || photoFactsDiffer(pair.remote, record)) {
        remoteIsStale = true;
      }
    }
  }

  // Settings the household shares, last write wins per key. Unstamped rows lose
  // to stamped ones, so a device upgrading from before stamps existed adopts
  // the other device's answer rather than overwriting it with an older one.
  const settings = mergeByKey(
    localState.settings.filter((row) => SHARED_SETTINGS.includes(row?.key)),
    remoteState.settings.filter((row) => SHARED_SETTINGS.includes(row?.key)),
    'key',
    'updated_at',
  );
  merged.settings = settings.all;
  incoming.settings = settings.newerRemotely;
  if (settings.remoteIsStale) remoteIsStale = true;

  // Which OneDrive files have already been read. Not state anyone can see —
  // it exists so a second device does not spend an hour recognising sixty
  // documents the first one has already filed.
  const epoch = String(merged.settings.find((row) => row.key === IMPORTS_EPOCH)?.value ?? '');
  const live = (rows) => (epoch ? rows.filter((row) => String(row?.imported_at ?? '') > epoch) : rows);
  const imports = mergeByKey(live(localState.imports), live(remoteState.imports), 'item_id', 'imported_at');
  // A cleared log is only reflected upward if the cloud still holds the old one.
  if (remoteState.imports.length !== imports.all.length) remoteIsStale = true;
  merged.imports = imports.all;
  incoming.imports = imports.newerRemotely;
  if (imports.remoteIsStale) remoteIsStale = true;

  if (remoteState.tombstones.length !== merged.tombstones.length) remoteIsStale = true;

  return { merged, incoming, remoteIsStale };
}

/**
 * Last-write-wins over a flat list of rows identified by one field.
 *
 * Reports both directions: what this device has not got yet, and whether the
 * copy in the cloud is missing anything — the sync run only rewrites the remote
 * file when something there is out of date.
 */
function mergeByKey(local, remote, idField, stampField) {
  const byId = new Map();
  for (const row of local) if (row?.[idField]) byId.set(row[idField], { local: row });
  for (const row of remote) {
    if (!row?.[idField]) continue;
    byId.set(row[idField], { ...(byId.get(row[idField]) ?? {}), remote: row });
  }

  const all = [];
  const newerRemotely = [];
  let remoteIsStale = false;

  for (const pair of byId.values()) {
    const at = (row) => String(row?.[stampField] ?? '');
    const winner =
      pair.local && (!pair.remote || at(pair.local) >= at(pair.remote)) ? pair.local : pair.remote;
    if (!winner) continue;
    all.push(winner);
    if (!pair.local || at(pair.local) < at(winner)) newerRemotely.push(winner);
    if (!pair.remote || at(pair.remote) < at(winner)) remoteIsStale = true;
  }

  return { all, newerRemotely, remoteIsStale };
}

/**
 * has_photo says whether the photo exists in the shared folder, not whether the
 * device that happened to win the merge is holding it.
 *
 * Without this, a device that pulled a record but has not fetched its photo yet
 * — or tried and failed — packs the record as having no photo, wins the merge on
 * an equal timestamp, and tells every other device the photo is gone. The file
 * is still sitting in OneDrive; nothing would ever ask for it again. Nothing in
 * the app deletes a photo, so presence only ever goes one way.
 */
function withPhotoPresence(record, pair) {
  // The newer record is asked first, so a photo replaced on that side wins; a
  // side that simply has not fetched the picture yet answers for nothing.
  const sides = [record, pair.local, pair.remote].filter(Boolean);
  const front = sides.find((s) => s.has_photo);
  const back = sides.find((s) => s.has_back);
  const facts = {
    has_photo: Boolean(front),
    has_back: Boolean(back),
    // The path a photo is stored under is built from its type, so the side that
    // knows it has to win even when the other side is the newer record.
    photo_type: front?.photo_type ?? record.photo_type ?? null,
    photo_bytes: front?.photo_bytes ?? 0,
    photo_back_bytes: back?.photo_back_bytes ?? 0,
  };
  return photoFactsDiffer(record, facts) ? { ...record, ...facts } : record;
}

const PHOTO_FACTS = ['has_photo', 'has_back', 'photo_type', 'photo_bytes', 'photo_back_bytes'];

// Both sides are read the same way, so a record that simply omits a field and
// one that spells out its empty value are not mistaken for a difference — that
// would make every merge look like a change and rewrite the cloud file forever.
const photoFact = (record, key) => {
  if (key.startsWith('has_')) return Boolean(record?.[key]);
  if (key === 'photo_type') return record?.[key] ?? null;
  return record?.[key] ?? 0;
};

function photoFactsDiffer(a, b) {
  return PHOTO_FACTS.some((key) => photoFact(a, key) !== photoFact(b, key));
}

function pick(a, b) {
  if (!a) return b;
  if (!b) return a;
  return stamp(a) >= stamp(b) ? a : b;
}

function normalise(state) {
  return {
    members: Array.isArray(state?.members) ? state.members : [],
    documents: Array.isArray(state?.documents) ? state.documents : [],
    tombstones: Array.isArray(state?.tombstones) ? state.tombstones : [],
    settings: Array.isArray(state?.settings) ? state.settings : [],
    imports: Array.isArray(state?.imports) ? state.imports : [],
  };
}

/**
 * Which sides of a document this device is missing: one it has never had, or
 * one that has been replaced elsewhere since — a different byte count is a
 * different picture.
 */
export function photoNeeds(record, localRow) {
  const stale = (mine, theirs) => Boolean(theirs) && Boolean(mine) && mine.size !== theirs;
  return {
    front: Boolean(record.has_photo) && (!localRow?.photo || stale(localRow.photo, record.photo_bytes)),
    back: Boolean(record.has_back)
      && (!localRow?.photo_back || stale(localRow.photo_back, record.photo_back_bytes)),
  };
}

/** Documents with a side this device still needs. */
export function photosToDownload(mergedDocuments, localDocuments) {
  const byUid = new Map(localDocuments.map((d) => [d.uid, d]));
  return mergedDocuments.filter((d) => {
    const needs = photoNeeds(d, byUid.get(d.uid));
    return needs.front || needs.back;
  });
}
