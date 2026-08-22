import { useCallback, useEffect, useRef, useState } from 'react';
import { getSettings } from '../db.js';
import { ACCEPT_ATTRIBUTE, prepareFile } from '../lib/files.js';
import { pairSides, readPath } from '../lib/filename.js';
import { extractDocument, extractionAvailable, ExtractionError } from '../lib/extract.js';
import { fileDocument, describeResult } from '../lib/autofile.js';
import { documentType } from '../lib/constants.js';
import Screen from '../components/Screen.jsx';
import { Banner, Button, Spinner } from '../components/ui.jsx';
import { ImportQueue, ImportSummary } from '../components/ImportQueue.jsx';

/**
 * Pick any number of photos or PDFs and walk away. Each one is read, classified,
 * filed under the right person — creating that person if they are new — and its
 * reminders set, with no form in between.
 *
 * Files are processed one at a time rather than all at once: a phone uploading
 * eight photos in parallel over hotel wifi is how you get rate-limited halfway
 * through and lose track of what saved.
 */
export default function BulkAdd() {
  const inputRef = useRef(null);
  const folderRef = useRef(null);
  const cameraRef = useRef(null);
  const [settings, setSettings] = useState(null);
  const [items, setItems] = useState([]);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    getSettings().then(setSettings);
    return () => { cancelled.current = true; };
  }, []);

  const canExtract = settings ? extractionAvailable(settings) : false;

  const update = useCallback((id, patch) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  async function handleFiles(event) {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = '';
    await enqueue(chosen);
  }

  /** Dropping a selection onto the page is how this gets used on a laptop. */
  async function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    await enqueue([...(event.dataTransfer?.files ?? [])]);
  }

  async function enqueue(chosen) {
    if (chosen.length === 0) return;

    const read = chosen.map((file) => ({
      file,
      // webkitRelativePath is set when a whole folder was chosen; it is the path
      // inside it, which is where the owner's name lives.
      hints: readPath(file.webkitRelativePath || file.name),
    }));

    const queued = pairSides(read).map((entry, i) => ({
      id: `${Date.now()}-${i}`,
      name: entry.hints.filename,
      file: entry.file,
      backFile: entry.backFile ?? null,
      hints: entry.hints,
      status: 'queued',
      message: entry.hints.portrait ? 'Looks like a personal photo' : 'Waiting…',
    }));

    setItems((prev) => [...prev, ...queued]);
    await runQueue(queued);
  }

  async function runQueue(queued) {
    setRunning(true);
    for (const item of queued) {
      if (cancelled.current) break;
      await processOne(item);
    }
    setRunning(false);
  }

  async function processOne(item) {
    // A passport photo is a real file but nothing about it expires. Filing one
    // makes a record with no type, no number and no date, to be deleted by hand.
    if (item.hints.portrait) {
      update(item.id, {
        status: 'portrait',
        message: `${item.hints.baseName} looks like a personal photo — skipped`,
      });
      return;
    }

    update(item.id, { status: 'reading', message: 'Reading the document…' });

    let prepared;
    try {
      prepared = await prepareFile(item.file);
      if (item.backFile) {
        // One card, two files. Keep the back image with the record rather than
        // making a second, emptier one for the same document.
        prepared.back = (await prepareFile(item.backFile)).blob;
      }
    } catch (error) {
      update(item.id, { status: 'failed', message: error.message });
      return;
    }

    if (!canExtract) {
      update(item.id, {
        status: 'failed',
        message: 'Auto-fill is off — turn it on in Settings to file documents automatically.',
      });
      return;
    }

    let extraction;
    try {
      extraction = await extractDocument(prepared.blob, settings);
    } catch (error) {
      update(item.id, {
        status: 'failed',
        message:
          error instanceof ExtractionError
            ? error.message
            : 'Could not read this one. Add it by hand instead.',
      });
      return;
    }

    update(item.id, { status: 'filing', message: 'Filing…' });
    try {
      const result = await fileDocument({ prepared, extraction, hints: item.hints });
      update(item.id, {
        status: result.outcome,
        message: describeResult(result),
        documentId: result.documentId,
        memberCreated: result.memberCreated,
        typeIcon: documentType(result.type).icon,
        reasons: result.reasons,
      });
    } catch (error) {
      update(item.id, { status: 'failed', message: error?.message ?? 'Could not save.' });
    }
  }

  // A duplicate is not a filing — counting it as one would tell the user four
  // documents were saved when three rows exist.
  const saved = items.filter((i) =>
    ['filed', 'needs_review', 'archived'].includes(i.status));
  const duplicates = items.filter((i) => i.status === 'duplicate');
  const failed = items.filter((i) => i.status === 'failed');
  const skipped = items.filter((i) => i.status === 'portrait');
  const needsReview = items.filter((i) => i.status === 'needs_review');
  const anyNewPeople = items.some((i) => i.memberCreated);

  return (
    <Screen
      title="Upload documents"
      subtitle="Photos or PDFs — as many as you like"
      back="/"
      footer={
        items.length > 0 && !running ? (
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => inputRef.current?.click()}>
              Add more
            </Button>
            <Button as="link" to="/" className="flex-1">
              Done
            </Button>
          </div>
        ) : null
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        multiple
        onChange={handleFiles}
        className="sr-only"
        tabIndex={-1}
      />
      <input
        ref={folderRef}
        type="file"
        webkitdirectory=""
        directory=""
        multiple
        onChange={handleFiles}
        className="sr-only"
        tabIndex={-1}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={handleFiles}
        className="sr-only"
        tabIndex={-1}
      />

      <div className="space-y-3 pb-4">
        {!canExtract && settings ? (
          <Banner tone="warn" title="Auto-fill is switched off">
            <p className="mb-3">
              Automatic filing needs to read the documents. Turn it on in Settings, or add
              documents one at a time and type the details yourself.
            </p>
            <div className="flex gap-2">
              <Button as="link" to="/settings">Open Settings</Button>
              <Button as="link" to="/documents/new" variant="secondary">Add by hand</Button>
            </div>
          </Banner>
        ) : null}

        {items.length === 0 ? (
          <>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              disabled={!settings}
              className={`flex min-h-44 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed transition-colors disabled:opacity-60 ${
                dragging
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200'
                  : 'border-slate-300 bg-white text-slate-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
              }`}
            >
              <svg viewBox="0 0 24 24" className="size-9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V4m0 0L8 8m4-4l4 4" />
                <path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
              </svg>
              <span className="text-[16px] font-semibold">
                {dragging ? 'Drop them here' : 'Choose files'}
              </span>
              <span className="-mt-1.5 max-w-[17rem] text-center text-[13px] text-slate-500 dark:text-slate-400">
                Photos or PDFs. Pick as many as you like at once — hold Ctrl (or ⌘ on a Mac) to
                select several, or drag them onto this box.
              </span>
            </button>

            <Button variant="secondary" className="w-full" onClick={() => folderRef.current?.click()}>
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              </svg>
              Choose a whole folder
            </Button>

            <Button variant="secondary" className="w-full" onClick={() => cameraRef.current?.click()}>
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8.5A2.5 2.5 0 015.5 6h1.2a2 2 0 001.7-.95l.6-1A2 2 0 0110.7 3h2.6a2 2 0 011.7.95l.6 1A2 2 0 0017.3 6h1.2A2.5 2.5 0 0121 8.5v9A2.5 2.5 0 0118.5 20h-13A2.5 2.5 0 013 17.5z" />
                <circle cx="12" cy="13" r="3.6" />
              </svg>
              Take photos instead
            </Button>

            <Button as="link" to="/onedrive" variant="secondary" className="w-full">
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6.5 19a4.5 4.5 0 01-.6-8.96 6 6 0 0111.4-1.6A3.999 3.999 0 0118 19z" />
              </svg>
              Read a folder in my OneDrive
            </Button>

            <p className="px-2 text-center text-[13px] text-slate-500 dark:text-slate-400">
              Each document is read, sorted by person and type, and its reminders set
              automatically. You only get asked about the ones that were hard to read.
            </p>
            <p className="px-2 text-center text-[13px] text-slate-500 dark:text-slate-400">
              Choosing a folder is the better way if your documents are already filed per person —
              the folder name is used as the owner, which is far more reliable than reading a name
              off a photo.
            </p>
          </>
        ) : (
          <>
            {running ? (
              <Banner tone="info">
                <span className="inline-flex items-center gap-2">
                  <Spinner className="size-4" />
                  Working through {items.length} file{items.length === 1 ? '' : 's'} — you can leave
                  this open.
                </span>
              </Banner>
            ) : (
              <ImportSummary
                saved={saved.length}
                review={needsReview.length}
                duplicates={duplicates.length}
                skipped={skipped.length}
                failed={failed.length}
              />
            )}

            <ImportQueue items={items} />

            {anyNewPeople && !running ? (
              <p className="px-2 text-[13px] text-slate-500 dark:text-slate-400">
                New family members were created automatically. Rename anyone from the dashboard if
                the spelling is off.
              </p>
            ) : null}
          </>
        )}
      </div>
    </Screen>
  );
}
