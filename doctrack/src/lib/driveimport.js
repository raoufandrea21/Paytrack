/**
 * Reading documents that are already in someone's OneDrive.
 *
 * The folder people keep their papers in is the filing they have already done:
 * a folder per person, sometimes a folder per kind inside that, "Expired" for
 * the old ones, and filenames that say what each document is and often what
 * year it belongs to. All of that is worth more than anything recognition can
 * work out from the pixels, and readPath() already knows how to read it.
 *
 * Nothing here writes to OneDrive. Every call is a listing or a download, which
 * is also why this keeps working when Microsoft has put a drive into read-only
 * mode — the state a full or frozen account ends up in.
 */
import * as graph from './onedrive.js';
import { alreadyImported, getSetting, recordImport } from '../db.js';
import { pairSides, readPath } from './filename.js';
import { prepareFile } from './files.js';
import { extractDocument, extractionAvailable, ExtractionError } from './extract.js';
import { fileDocument, describeResult } from './autofile.js';

/**
 * The drive, looked up here rather than imported straight into the screens.
 *
 * One place where reading someone's OneDrive is reached from, which is both
 * easier to audit — a listing and a download are the whole of it, and both are
 * GETs — and what lets the screens be driven against a stand-in.
 */
export const drive = {
  account: (...args) => graph.currentAccount(...args),
  listDriveFolder: (...args) => graph.listDriveFolder(...args),
  downloadDriveItem: (...args) => graph.downloadDriveItem(...args),
};

/** Only what a document could plausibly be. Everything else is somebody's life. */
const READABLE = /\.(jpe?g|png|webp|heic|heif|pdf)$/i;

/** Guards against pointing the app at a whole drive by accident. */
export const SCAN_LIMITS = { files: 400, depth: 6 };

export const isReadable = (name) => READABLE.test(String(name ?? ''));

/**
 * Everything worth reading under a folder, with the path it was found at.
 *
 * Breadth-first, so a wide folder of documents is found before the walk
 * disappears down one deep branch — and if the limit is hit, what it did find
 * is the shallow, likely part rather than an arbitrary corner.
 */
export async function scanFolder(clientId, root, { api = drive, limits = SCAN_LIMITS, onProgress } = {}) {
  const found = [];
  const skipped = { folders: 0, files: 0 };
  let queue = [{ id: root.id, path: root.name ?? '' }];
  let depth = 0;

  while (queue.length && depth < limits.depth && found.length < limits.files) {
    const next = [];
    for (const folder of queue) {
      onProgress?.({ looking: folder.path, found: found.length });
      const children = await api.listDriveFolder(clientId, folder.id);

      for (const child of children) {
        const path = folder.path ? `${folder.path}/${child.name}` : child.name;
        if (child.folder) {
          next.push({ id: child.id, path });
          continue;
        }
        if (!isReadable(child.name)) {
          skipped.files += 1;
          continue;
        }
        if (found.length >= limits.files) break;
        found.push({ item: child, path });
      }
    }
    queue = next;
    depth += 1;
  }

  if (queue.length) skipped.folders = queue.length;
  return { found, skipped, truncated: found.length >= limits.files };
}

/**
 * Turns what the scan found into the queue the importer works through.
 *
 * Two files that are the front and back of one card become one entry, exactly
 * as they do for an upload from a laptop — the pairing rule lives in one place
 * because getting it wrong makes two half-empty records instead of one good one.
 */
export function planImport(found) {
  const entries = found.map(({ item, path }) => ({
    item,
    path,
    file: item, // pairSides carries this through as backFile
    hints: readPath(path),
  }));

  return pairSides(entries).map((entry) => ({
    id: entry.item.id,
    name: entry.hints.filename,
    path: entry.path,
    item: entry.item,
    backItem: entry.backFile ?? null,
    hints: entry.hints,
  }));
}

/**
 * Reads one planned file and files it.
 *
 * Returns what happened in the same vocabulary the upload screen already
 * speaks, so both can be shown with the same component.
 */
export async function importOne(clientId, planned, settings, { api = drive } = {}) {
  const seen = await alreadyImported(planned.id);
  if (seen && seen.c_tag === (planned.item.cTag ?? '')) {
    return { outcome: 'skipped', message: `${planned.name} was read before` };
  }
  // Read before, and changed since. The record it produced is the one to
  // update — see fileDocument, which would otherwise have to guess.
  const replaces = seen?.document_id ?? null;

  if (planned.hints.portrait) {
    await remember(planned, 'portrait', null);
    return { outcome: 'portrait', message: `${planned.hints.baseName} looks like a personal photo` };
  }

  const blob = await api.downloadDriveItem(clientId, planned.id);
  if (!blob) return { outcome: 'failed', message: `${planned.name} could not be downloaded` };

  const named = new File([blob], planned.name, { type: blob.type || guessType(planned.name) });
  const prepared = await prepareFile(named);

  if (planned.backItem) {
    const backBlob = await api.downloadDriveItem(clientId, planned.backItem.id).catch(() => null);
    if (backBlob) {
      const backName = planned.backItem.name;
      prepared.back = (
        await prepareFile(new File([backBlob], backName, { type: backBlob.type || guessType(backName) }))
      ).blob;
    }
  }

  let extraction;
  try {
    extraction = await extractDocument(prepared.blob, settings);
  } catch (error) {
    return {
      outcome: 'failed',
      message: error instanceof ExtractionError
        ? `${planned.name}: ${error.message}`
        : `${planned.name} could not be read`,
    };
  }

  const result = await fileDocument({
    prepared,
    extraction,
    hints: { ...planned.hints, replaces },
  });
  await remember(planned, result.outcome, result.documentId);
  // The back of a card is a file in its own right; remembering it stops the
  // next run treating it as something new that has never been read.
  if (planned.backItem) {
    await recordImport({
      itemId: planned.backItem.id,
      cTag: planned.backItem.cTag,
      name: planned.backItem.name,
      path: `${planned.path} (back)`,
      documentId: result.documentId,
      outcome: 'back',
    });
  }

  return { outcome: result.outcome, message: describeResult(result), result };
}

function remember(planned, outcome, documentId) {
  return recordImport({
    itemId: planned.id,
    cTag: planned.item.cTag,
    name: planned.name,
    path: planned.path,
    documentId,
    outcome,
  });
}

/**
 * The whole run: scan, plan, then read one file at a time.
 *
 * One at a time on purpose. Sixty documents read in parallel is how a phone on
 * hotel wifi gets throttled halfway through, and the on-device reader can only
 * do one at a time anyway.
 */
export async function importFolder(clientId, root, settings, { api = drive, onItem, onProgress, shouldStop, filter } = {}) {
  if (!extractionAvailable(settings)) {
    throw new Error('Reading documents is switched off — turn it on in Settings first.');
  }

  const { found, skipped, truncated } = await scanFolder(clientId, root, { api, onProgress });
  const { taken, left } = selectForImport(found, { rootName: root.name, ...(filter ?? {}) });
  const planned = planImport(taken);
  onProgress?.({ planned: planned.length, found: found.length });

  const counts = { filed: 0, duplicate: 0, skipped: 0, failed: 0, portrait: 0 };
  for (const [index, entry] of planned.entries()) {
    if (shouldStop?.()) break;
    onItem?.({ ...entry, status: 'reading', message: 'Reading…', position: index + 1, total: planned.length });
    try {
      const outcome = await importOne(clientId, entry, settings, { api });
      onItem?.({ ...entry, ...outcome, status: outcome.outcome, position: index + 1, total: planned.length });
      counts[bucket(outcome.outcome)] += 1;
    } catch (error) {
      onItem?.({ ...entry, status: 'failed', message: error?.message ?? 'Could not read this one.' });
      counts.failed += 1;
    }
  }

  return { counts, planned: planned.length, skippedFiles: skipped.files, left, truncated };
}

const bucket = (outcome) => {
  if (['filed', 'needs_review', 'archived', 'renewed', 'updated'].includes(outcome)) return 'filed';
  if (outcome === 'duplicate') return 'duplicate';
  if (outcome === 'portrait') return 'portrait';
  if (outcome === 'skipped') return 'skipped';
  return 'failed';
};

function guessType(name) {
  const extension = String(name).split('.').pop()?.toLowerCase();
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Checking the chosen folder on its own, without anybody asking.
 *
 * "Do I have to press something every time I add a document?" is the question
 * that decides whether this app is useful or another chore, and the answer has
 * to be no. So the folder someone picked is looked at again whenever the app
 * opens, and anything new in it is read and filed the same way the first run
 * did it.
 *
 * Everything about it is deliberately quiet. It is throttled, so opening the
 * app four times in an hour does not mean four walks of the drive; it is
 * skipped entirely when there is nothing set up or the user has turned it off;
 * and it never reports a failure, because a folder that could not be reached is
 * not a reason to interrupt somebody looking up a passport.
 */
const WATCH_INTERVAL = 30 * 60 * 1000;
export const WATCH_SETTING = 'onedrive_watch_folder';
let lastWatchAt = 0;
let watchInFlight = false;

/** The folder being watched, or null when there is nothing to watch. */
export async function watchedFolder(settings) {
  if (!settings?.onedrive_client_id) return null;
  if (settings[WATCH_SETTING] === 0) return null;
  if (!graph.driveReadingAllowed()) return null;
  if (!extractionAvailable(settings)) return null;
  const folder = await getSetting('onedrive_import_folder');
  return folder?.id ? folder : null;
}

export async function readWatchedFolder(settings, { api = drive, force = false } = {}) {
  if (watchInFlight) return null;
  if (!force && Date.now() - lastWatchAt < WATCH_INTERVAL) return null;

  const folder = await watchedFolder(settings);
  if (!folder) return null;

  try {
    watchInFlight = true;
    lastWatchAt = Date.now();
    const filter = await getSetting(FILTER_SETTING);
    const result = await importFolder(settings.onedrive_client_id, folder, settings, { api, filter });
    if (result.counts.filed > 0) {
      console.info(`[doctrack] filed ${result.counts.filed} new document(s) from ${folder.name}`);
    }
    return result;
  } catch (error) {
    console.warn('[doctrack] could not check the OneDrive folder', error);
    return null;
  } finally {
    watchInFlight = false;
  }
}

/**
 * What to pick up out of a folder, and what to walk past.
 *
 * A drive folder built up over years holds more than the documents that expire:
 * old scans of things nobody tracks, other people's paperwork, photographs. The
 * first read of one turned every last file into something to verify, which is
 * how a tool meant to save work becomes work.
 *
 * So two questions get asked before anything is read, and both are answered
 * from the path alone — no downloading, no recognition, nothing to undo:
 * whose folder is it in, and does the filename say it is a kind being tracked.
 */
export const FILTER_SETTING = 'onedrive_import_filter';

/** The kinds worth tracking in a household. Everything else has to be asked for. */
export const DEFAULT_WANTED_TYPES = [
  'emirates_id', 'passport', 'residency_visa', 'cyprus_id', 'driving_license',
  'vehicle_registration', 'car_insurance', 'health_insurance', 'vaccination',
  'birth_certificate', 'marriage_certificate',
];

/**
 * The folder directly under the one being read — the person, or the group a
 * person sits in. Files loose in the root belong to nobody in particular.
 */
export function branchOf(path, rootName) {
  const segments = String(path ?? '').split('/');
  const start = segments[0] === rootName ? 1 : 0;
  return segments.length > start + 1 ? segments[start] : '';
}

/**
 * Splits what the scan found into what to read and what to leave, with a reason
 * for everything left — a number with no explanation is just a worry.
 */
export function selectForImport(found, { rootName = '', branches = null, types = null, unnamed = false } = {}) {
  const wantedBranch = branches ? new Set(branches) : null;
  const wantedType = types ? new Set(types) : null;

  const taken = [];
  const left = { person: 0, kind: 0, unnamed: 0 };

  for (const entry of found) {
    const branch = branchOf(entry.path, rootName);
    if (wantedBranch && !wantedBranch.has(branch)) {
      left.person += 1;
      continue;
    }

    const named = readPath(entry.path);
    // A front and a back are one document, and the back rarely names its kind
    // — judging it on its own would drop half of every card.
    const kind = named.type ?? (named.side === 'back' ? 'pair' : null);
    if (!kind) {
      if (!unnamed) {
        left.unnamed += 1;
        continue;
      }
    } else if (wantedType && kind !== 'pair' && !wantedType.has(kind)) {
      left.kind += 1;
      continue;
    }
    taken.push(entry);
  }

  return { taken, left };
}
