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

/** Photos live beside the state file, one per document. */
export function photoPath(uid, mediaType, side = 'front') {
  const extension = mediaType === 'application/pdf' ? 'pdf' : mediaType === 'image/png' ? 'png' : 'jpg';
  return `photos/${uid}${side === 'back' ? '-back' : ''}.${extension}`;
}

export function emptyState() {
  return { format: SYNC_FORMAT, version: SYNC_VERSION, members: [], documents: [], tombstones: [] };
}

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

      merged[kind].push(newest);
      if (!pair.local || stamp(pair.local) < stamp(newest)) incoming[kind].push(newest);
      if (!pair.remote || stamp(pair.remote) < stamp(newest)) remoteIsStale = true;
    }
  }

  if (remoteState.tombstones.length !== merged.tombstones.length) remoteIsStale = true;

  return { merged, incoming, remoteIsStale };
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
  };
}

/** Documents whose photo this device has but the remote copy does not. */
export function photosToUpload(localDocuments, remotePhotoNames) {
  const present = new Set(remotePhotoNames ?? []);
  return localDocuments
    .filter((d) => d.photo && d.uid)
    .filter((d) => !present.has(photoPath(d.uid, d.photo_type).split('/').pop()));
}

/** Documents this device knows about but has no photo for yet. */
export function photosToDownload(mergedDocuments, localDocuments) {
  const haveLocally = new Set(localDocuments.filter((d) => d.photo).map((d) => d.uid));
  return mergedDocuments.filter((d) => d.has_photo && !haveLocally.has(d.uid));
}
