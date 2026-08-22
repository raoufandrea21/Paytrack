import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSettings } from '../db.js';
import { ACCEPT_ATTRIBUTE, prepareFile } from '../lib/files.js';
import { extractDocument, extractionAvailable, ExtractionError } from '../lib/extract.js';
import { fileDocument, describeResult } from '../lib/autofile.js';
import { documentType } from '../lib/constants.js';
import Screen from '../components/Screen.jsx';
import { Banner, Button, Card, Spinner } from '../components/ui.jsx';

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
  const cameraRef = useRef(null);
  const [settings, setSettings] = useState(null);
  const [items, setItems] = useState([]);
  const [running, setRunning] = useState(false);
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
    if (chosen.length === 0) return;

    const queued = chosen.map((file, i) => ({
      id: `${Date.now()}-${i}`,
      name: file.name || `Document ${i + 1}`,
      file,
      status: 'queued',
      message: 'Waiting…',
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
    update(item.id, { status: 'reading', message: 'Reading the document…' });

    let prepared;
    try {
      prepared = await prepareFile(item.file);
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
      const result = await fileDocument({ prepared, extraction });
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
  const saved = items.filter((i) => i.status === 'filed' || i.status === 'needs_review');
  const duplicates = items.filter((i) => i.status === 'duplicate');
  const failed = items.filter((i) => i.status === 'failed');
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
              disabled={!settings}
              className="flex min-h-40 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-300 bg-white text-slate-600 transition-colors hover:border-indigo-400 hover:text-indigo-600 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
            >
              <svg viewBox="0 0 24 24" className="size-9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V4m0 0L8 8m4-4l4 4" />
                <path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
              </svg>
              <span className="text-[16px] font-semibold">Choose files</span>
              <span className="-mt-1.5 text-[13px] text-slate-500 dark:text-slate-400">
                Photos or PDFs · select several at once
              </span>
            </button>

            <Button variant="secondary" className="w-full" onClick={() => cameraRef.current?.click()}>
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8.5A2.5 2.5 0 015.5 6h1.2a2 2 0 001.7-.95l.6-1A2 2 0 0110.7 3h2.6a2 2 0 011.7.95l.6 1A2 2 0 0017.3 6h1.2A2.5 2.5 0 0121 8.5v9A2.5 2.5 0 0118.5 20h-13A2.5 2.5 0 013 17.5z" />
                <circle cx="12" cy="13" r="3.6" />
              </svg>
              Take photos instead
            </Button>

            <p className="px-2 text-center text-[13px] text-slate-500 dark:text-slate-400">
              Each document is read, sorted by person and type, and its reminders set
              automatically. You only get asked about the ones that were hard to read.
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
              <Summary
                saved={saved.length}
                review={needsReview.length}
                duplicates={duplicates.length}
                failed={failed.length}
              />
            )}

            <Card className="divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
              {items.map((item) => (
                <QueueRow key={item.id} item={item} />
              ))}
            </Card>

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

function Summary({ saved, review, duplicates, failed }) {
  if (saved === 0 && failed === 0 && duplicates === 0) return null;
  const tone = failed > 0 || review > 0 ? 'warn' : 'info';
  const title =
    saved === 0
      ? 'Nothing new was filed'
      : `${saved} document${saved === 1 ? '' : 's'} filed`;

  return (
    <Banner tone={tone} title={title}>
      {review > 0 ? (
        <p>
          {review} need{review === 1 ? 's' : ''} checking —{' '}
          <Link to="/review" className="font-semibold underline underline-offset-2">
            review {review === 1 ? 'it' : 'them'} now
          </Link>
          .
        </p>
      ) : null}
      {duplicates > 0 ? (
        <p>
          {duplicates} {duplicates === 1 ? 'was' : 'were'} already on file and{' '}
          {duplicates === 1 ? 'was' : 'were'} skipped.
        </p>
      ) : null}
      {failed > 0 ? <p>{failed} could not be read. You can add those by hand.</p> : null}
      {review === 0 && failed === 0 && saved > 0 ? (
        <p>Everything read cleanly. Nothing else to do.</p>
      ) : null}
    </Banner>
  );
}

const STATUS_STYLE = {
  queued: { dot: 'bg-slate-300', text: 'text-slate-500 dark:text-slate-400' },
  reading: { dot: 'bg-indigo-500 animate-pulse', text: 'text-slate-600 dark:text-slate-300' },
  filing: { dot: 'bg-indigo-500 animate-pulse', text: 'text-slate-600 dark:text-slate-300' },
  filed: { dot: 'bg-emerald-500', text: 'text-slate-700 dark:text-slate-200' },
  needs_review: { dot: 'bg-amber-500', text: 'text-amber-800 dark:text-amber-300' },
  duplicate: { dot: 'bg-slate-400', text: 'text-slate-500 dark:text-slate-400' },
  failed: { dot: 'bg-red-500', text: 'text-red-700 dark:text-red-300' },
};

function QueueRow({ item }) {
  const style = STATUS_STYLE[item.status] ?? STATUS_STYLE.queued;
  const body = (
    <>
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-1.5">
          {item.typeIcon ? <span aria-hidden="true">{item.typeIcon}</span> : null}
          <span className={`block text-[15px] font-semibold ${style.text}`}>{item.message}</span>
        </span>
        <span className="block truncate text-[12px] text-slate-400 dark:text-slate-500">
          {item.name}
        </span>
      </span>
    </>
  );

  return item.documentId ? (
    <Link
      to={`/documents/${item.documentId}`}
      className="flex items-start gap-3 px-3.5 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60"
    >
      {body}
    </Link>
  ) : (
    <div className="flex items-start gap-3 px-3.5 py-3">{body}</div>
  );
}
