import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSettings, getSetting, setSetting } from '../db.js';
import { extractionAvailable } from '../lib/extract.js';
import { allowDriveReading, driveReadingAllowed, signIn } from '../lib/onedrive.js';
import {
  DEFAULT_WANTED_TYPES,
  FILTER_SETTING,
  WATCH_SETTING,
  drive,
  importFolder,
} from '../lib/driveimport.js';
import { DOCUMENT_TYPES } from '../lib/constants.js';
import Screen from '../components/Screen.jsx';
import { Banner, Button, Card, EmptyState, Spinner } from '../components/ui.jsx';
import { ImportQueue, ImportSummary } from '../components/ImportQueue.jsx';

/**
 * Read the documents already sitting in someone's OneDrive.
 *
 * This is the shortest path from "I have years of documents in a folder" to
 * "the app knows about all of them". The folders people keep papers in are
 * filing they have already done — a folder per person, "Expired" for the old
 * ones, filenames that say what each thing is — and that is read along with the
 * document itself.
 *
 * Nothing is written back. The app only ever lists and downloads, which also
 * means this keeps working when Microsoft has a drive in read-only mode.
 */
export default function DriveImport() {
  const [settings, setSettings] = useState(null);
  const [account, setAccount] = useState(undefined);
  const [allowed, setAllowed] = useState(driveReadingAllowed);
  const [trail, setTrail] = useState([]); // [{id, name}], root is implicit
  const [folders, setFolders] = useState(null);
  const [error, setError] = useState(null);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [watching, setWatching] = useState(true);
  const [branches, setBranches] = useState(null); // null = everyone
  const [types, setTypes] = useState(DEFAULT_WANTED_TYPES);
  const [unnamed, setUnnamed] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [items, setItems] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [summary, setSummary] = useState(null);
  const [last, setLast] = useState(null);
  const stop = useRef(false);

  const clientId = settings?.onedrive_client_id ?? '';
  const here = trail.at(-1) ?? null;

  useEffect(() => {
    getSettings().then(async (loaded) => {
      setSettings(loaded);
      setLast(await getSetting('onedrive_import_folder'));
      setWatching(loaded[WATCH_SETTING] !== 0);
      const saved = await getSetting(FILTER_SETTING);
      if (saved) {
        setBranches(saved.branches ?? null);
        setTypes(saved.types ?? DEFAULT_WANTED_TYPES);
        setUnnamed(Boolean(saved.unnamed));
      }
      setAccount(loaded.onedrive_client_id ? await drive.account(loaded.onedrive_client_id) : null);
    });
    return () => { stop.current = true; };
  }, []);

  const open = useCallback(async (folder) => {
    if (!clientId) return;
    setError(null);
    setFolders(null);
    try {
      const children = await drive.listDriveFolder(clientId, folder?.id ?? null);
      setFolders(children.filter((c) => c.folder).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (failure) {
      setFolders([]);
      setError(failure?.message ?? 'Could not read that folder.');
      setNeedsConsent(looksLikePermission(failure));
    }
  }, [clientId]);

  useEffect(() => {
    if (account && allowed) open(here);
  }, [account, allowed, here, open]);

  const filter = () => ({ branches, types, unnamed });

  async function run(folder) {
    stop.current = false;
    setRunning(true);
    setItems([]);
    setSummary(null);
    setProgress({ looking: folder.name });
    await setSetting('onedrive_import_folder', { id: folder.id, name: folder.name });
    setLast({ id: folder.id, name: folder.name });

    try {
      await setSetting(FILTER_SETTING, filter());
      const result = await importFolder(clientId, folder, settings, {
        filter: filter(),
        onProgress: setProgress,
        shouldStop: () => stop.current,
        onItem: (entry) => setItems((prev) => {
          const next = prev.filter((p) => p.id !== entry.id);
          return [...next, { ...entry, typeIcon: entry.result ? undefined : entry.typeIcon }];
        }),
      });
      setSummary(result);
    } catch (failure) {
      setError(failure?.message ?? 'The folder could not be read.');
      setNeedsConsent(looksLikePermission(failure));
    } finally {
      setProgress(null);
      setRunning(false);
    }
  }

  if (!settings || account === undefined) {
    return (
      <Screen title="Read my OneDrive" back="/">
        <div className="flex justify-center py-16 text-slate-400"><Spinner className="size-7" /></div>
      </Screen>
    );
  }

  if (!clientId || !account) {
    return (
      <Screen title="Read my OneDrive" back="/">
        <EmptyState icon="🔗" title="Connect OneDrive first">
          <p>
            DocTrack needs to be connected to your Microsoft account before it can read the
            documents already in your OneDrive.
          </p>
          <Button as="link" to="/settings" className="mt-4">Open Settings</Button>
        </EmptyState>
      </Screen>
    );
  }

  if (!extractionAvailable(settings)) {
    return (
      <Screen title="Read my OneDrive" back="/">
        <EmptyState icon="👀" title="Reading documents is switched off">
          <p>Turn it back on in Settings and this can fill itself in for you.</p>
          <Button as="link" to="/settings" className="mt-4">Open Settings</Button>
        </EmptyState>
      </Screen>
    );
  }

  const askForAccess = async () => {
    allowDriveReading(true);
    setAllowed(true);
    setNeedsConsent(false);
    // Microsoft only grants a new permission through a fresh sign-in, so this
    // leaves the page and comes straight back.
    await signIn(clientId).catch((failure) => setError(failure?.message ?? null));
  };

  if (!allowed) {
    return (
      <Screen title="Read my OneDrive" back="/">
        <Card className="p-4">
          <h2 className="text-[16px] font-bold">Let DocTrack read your documents</h2>
          <p className="mt-2 text-[14px] text-slate-600 dark:text-slate-400">
            Right now DocTrack can only see its own folder. To read the documents you already keep
            in OneDrive, Microsoft has to grant it permission to look at your files.
          </p>
          <Banner tone="info" className="mt-3">
            The permission is <span className="font-semibold">read-only</span>. DocTrack can list
            and open your files; it cannot change, move or delete anything, and it never uploads
            them anywhere — the reading happens on this device.
          </Banner>
          <Button className="mt-3 w-full" onClick={askForAccess}>
            Ask Microsoft for read access
          </Button>
          <p className="mt-2 text-[13px] text-slate-500 dark:text-slate-400">
            You will be taken to Microsoft to approve it, then straight back here.
          </p>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen
      title="Read my OneDrive"
      subtitle={running ? 'Reading…' : here ? here.name : 'Pick the folder your documents are in'}
      back="/"
      footer={
        running ? (
          <Button variant="secondary" className="w-full" onClick={() => { stop.current = true; }}>
            Stop
          </Button>
        ) : summary ? (
          // The results carry their own two buttons; a third one saying the
          // same thing is just something else to read.
          null
        ) : here ? (
          <Button className="w-full" onClick={() => run(here)}>
            Read everything in “{here.name}”
          </Button>
        ) : last ? (
          <Button className="w-full" onClick={() => run(last)}>
            Check “{last.name}” for new documents
          </Button>
        ) : null
      }
    >
      <div className="space-y-3 pb-4">
        {error ? (
          <Banner tone="warn" title={needsConsent ? 'Read access has not been granted yet' : undefined}>
            <p>
              {needsConsent
                ? 'Being connected is not the same as being allowed to read your files — that is a '
                  + 'second permission, and Microsoft has not been asked for it yet.'
                : error}
            </p>
            {needsConsent ? (
              <Button className="mt-2 w-full" onClick={askForAccess}>
                Ask Microsoft for read access
              </Button>
            ) : null}
          </Banner>
        ) : null}

        {running ? (
          <Banner tone="info">
            <span className="inline-flex items-center gap-2">
              <Spinner className="size-4" />
              {progress?.planned
                ? `Reading ${items.length} of ${progress.planned} — you can leave this open.`
                : `Looking through ${progress?.looking ?? 'your folders'}…`}
            </span>
          </Banner>
        ) : null}

        {summary ? (
          <>
            <ImportSummary
              saved={summary.counts.filed}
              review={items.filter((i) => i.status === 'needs_review').length}
              duplicates={summary.counts.duplicate}
              skipped={summary.counts.portrait}
              failed={summary.counts.failed}
            />
            {summary.counts.skipped > 0 || leftBehind(summary) > 0 ? (
              <p className="px-2 text-[13px] text-slate-500 dark:text-slate-400">
                {summary.counts.skipped > 0
                  ? `${summary.counts.skipped} had been read before and were left alone. `
                  : ''}
                {leftBehind(summary) > 0 ? describeLeft(summary.left) : ''}
              </p>
            ) : null}
            <label className="flex items-start gap-2.5 rounded-xl bg-white px-3 py-3 ring-1 ring-slate-300 dark:bg-slate-800 dark:ring-slate-700">
              <input
                type="checkbox"
                checked={watching}
                onChange={async (e) => {
                  setWatching(e.target.checked);
                  await setSetting(WATCH_SETTING, e.target.checked ? 1 : 0);
                }}
                className="mt-0.5 size-4 shrink-0 rounded"
              />
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold">
                  Keep checking this folder for me
                </span>
                <span className="block text-[13px] text-slate-500 dark:text-slate-400">
                  Every time you open DocTrack it looks again, and anything you have added since is
                  read and filed on its own. Nothing already read is read twice.
                </span>
              </span>
            </label>

            {summary.truncated ? (
              <Banner tone="warn">
                That folder holds more documents than one run reads. Run it again to carry on —
                everything already read is skipped.
              </Banner>
            ) : null}
          </>
        ) : null}

        {items.length > 0 ? <ImportQueue items={items} /> : null}

        {!running && !summary ? (
          <>
            <Breadcrumb trail={trail} onGo={(depth) => setTrail(trail.slice(0, depth))} />
            {folders === null ? (
              <div className="flex justify-center py-10 text-slate-400"><Spinner className="size-6" /></div>
            ) : folders.length === 0 ? (
              <p className="px-2 text-[14px] text-slate-500 dark:text-slate-400">
                No folders in here. {here ? 'Read this one, or go back up.' : ''}
              </p>
            ) : (
              <Card className="divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
                {folders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => setTrail([...trail, { id: folder.id, name: folder.name }])}
                    className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  >
                    <span className="text-xl" aria-hidden="true">📁</span>
                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{folder.name}</span>
                    <span className="text-slate-400" aria-hidden="true">›</span>
                  </button>
                ))}
              </Card>
            )}

            {here ? (
              <Card className="overflow-hidden">
                <button
                  type="button"
                  onClick={() => setTuning((t) => !t)}
                  aria-expanded={tuning}
                  className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <span className="text-xl" aria-hidden="true">🎯</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-bold">What to pick up</span>
                    <span className="block truncate text-[13px] text-slate-500 dark:text-slate-400">
                      {describeFilter({ branches, types, folders })}
                    </span>
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    className={`size-5 shrink-0 text-slate-400 transition-transform ${tuning ? 'rotate-180' : ''}`}
                    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>

                {tuning ? (
                  <div className="space-y-4 border-t border-slate-100 px-3.5 py-3 dark:border-slate-800">
                    {(folders ?? []).length > 0 ? (
                      <Choices
                        title="Whose documents?"
                        hint="The folders inside this one. Anything not ticked is walked past."
                        options={folders.map((f) => ({ id: f.name, label: f.name }))}
                        chosen={branches ?? folders.map((f) => f.name)}
                        onChange={setBranches}
                      />
                    ) : null}

                    <Choices
                      title="Which kinds?"
                      hint="Worked out from the filename, before anything is downloaded."
                      options={DOCUMENT_TYPES.filter((t) => t.id !== 'other').map((t) => ({
                        id: t.id,
                        label: `${t.icon}  ${t.label}`,
                      }))}
                      chosen={types}
                      onChange={setTypes}
                    />

                    <label className="flex items-start gap-2.5 text-[13px]">
                      <input
                        type="checkbox"
                        checked={unnamed}
                        onChange={(e) => setUnnamed(e.target.checked)}
                        className="mt-0.5 size-4 shrink-0 rounded"
                      />
                      <span className="text-slate-600 dark:text-slate-300">
                        Also read files whose name does not say what they are — camera filenames
                        like <span className="font-mono text-[12px]">IMG_2207.jpg</span>. Slower,
                        and more of them end up in “Needs checking”.
                      </span>
                    </label>
                  </div>
                ) : null}
              </Card>
            ) : null}

            <p className="px-2 text-[13px] text-slate-500 dark:text-slate-400">
              Pick the folder that holds everybody's documents — the one with a folder per person
              inside it. DocTrack reads the folder names to work out who each document belongs to,
              and “Expired” folders are filed as history rather than as reminders.
            </p>

            {last && !here ? (
              <p className="px-2 text-[13px] text-slate-500 dark:text-slate-400">
                Last read: {last.name}. Anything new in there will be picked up; everything already
                read is skipped.
              </p>
            ) : null}
          </>
        ) : null}

        {summary && !running ? (
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => { setSummary(null); setItems([]); }}>
              Pick another folder
            </Button>
            <Button as="link" to="/" className="flex-1">Done</Button>
          </div>
        ) : null}
      </div>
    </Screen>
  );
}

/**
 * A refusal that means "you have not been given this permission", rather than
 * something being wrong with the folder. Both arrive as a failed request; only
 * one of them has a button that fixes it.
 */
function looksLikePermission(failure) {
  const text = `${failure?.status ?? ''} ${failure?.message ?? ''}`;
  return /sign in again|not signed in|403|401|permission|consent|scope/i.test(text);
}

/** A tick list that is readable before it is opened. */
function Choices({ title, hint, options, chosen, onChange }) {
  const picked = new Set(chosen);
  const all = options.map((o) => o.id);
  const everything = picked.size >= options.length;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[14px] font-bold">{title}</p>
        <button
          type="button"
          onClick={() => onChange(everything ? [] : all)}
          className="text-[13px] font-semibold text-indigo-600 underline-offset-4 hover:underline dark:text-indigo-400"
        >
          {everything ? 'None' : 'All'}
        </button>
      </div>
      <p className="mt-0.5 text-[13px] text-slate-500 dark:text-slate-400">{hint}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {options.map((option) => {
          const on = picked.has(option.id);
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(
                on ? chosen.filter((id) => id !== option.id) : [...picked, option.id],
              )}
              className={`min-h-9 rounded-full px-3 py-1.5 text-[13px] font-semibold ring-1 transition-colors ${
                on
                  ? 'bg-indigo-600 text-white ring-indigo-600'
                  : 'bg-white text-slate-600 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const leftBehind = (summary) =>
  (summary.left?.person ?? 0) + (summary.left?.kind ?? 0) + (summary.left?.unnamed ?? 0);

function describeLeft(left = {}) {
  const parts = [];
  if (left.person) parts.push(`${left.person} for people you did not tick`);
  if (left.kind) parts.push(`${left.kind} of kinds you did not tick`);
  if (left.unnamed) parts.push(`${left.unnamed} whose name does not say what they are`);
  return parts.length ? `Walked past ${parts.join(', ')}.` : '';
}

function describeFilter({ branches, types, folders }) {
  const people = branches === null || branches.length === (folders ?? []).length
    ? 'Everyone'
    : branches.length === 0
      ? 'Nobody yet'
      : `${branches.length} of ${(folders ?? []).length} folders`;
  const kinds = types.length === 0
    ? 'no kinds yet'
    : types.length >= DOCUMENT_TYPES.length - 1
      ? 'every kind'
      : `${types.length} kinds`;
  return `${people} · ${kinds}`;
}

function Breadcrumb({ trail, onGo }) {
  return (
    <nav className="flex flex-wrap items-center gap-1 px-1 text-[13px] text-slate-500 dark:text-slate-400">
      <button type="button" onClick={() => onGo(0)} className="font-semibold underline-offset-4 hover:underline">
        OneDrive
      </button>
      {trail.map((folder, i) => (
        <span key={folder.id} className="flex items-center gap-1">
          <span aria-hidden="true">/</span>
          <button
            type="button"
            onClick={() => onGo(i + 1)}
            className="max-w-[9rem] truncate font-semibold underline-offset-4 hover:underline"
          >
            {folder.name}
          </button>
        </span>
      ))}
    </nav>
  );
}
