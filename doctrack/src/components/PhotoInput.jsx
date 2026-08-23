import { useRef, useState } from 'react';
import { ACCEPT_ATTRIBUTE, prepareFile } from '../lib/files.js';
import FilePreview, { FullScreenPreview } from './FilePreview.jsx';
import { Spinner } from './ui.jsx';

/**
 * Two inputs, on purpose.
 *
 * `capture="environment"` jumps straight to the rear camera, which is what makes
 * the add flow three taps — but a control with `capture` set cannot offer the
 * file picker at all, so a PDF emailed by an insurer would be unreachable. The
 * camera stays the primary button; files get their own quiet link underneath.
 */
export default function PhotoInput({ blob, onChange, onError, busy, label = 'Take photo' }) {
  const cameraRef = useRef(null);
  const fileRef = useRef(null);
  const [working, setWorking] = useState(false);
  const [full, setFull] = useState(false);

  async function handleFile(event) {
    const file = event.target.files?.[0];
    // Reset immediately so re-picking the same file still fires a change event.
    event.target.value = '';
    if (!file) return;

    setWorking(true);
    try {
      await onChange(await prepareFile(file));
    } catch (error) {
      onError?.(error.message ?? 'Could not read that file.');
    } finally {
      setWorking(false);
    }
  }

  const disabled = busy || working;

  return (
    <div>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        className="sr-only"
        tabIndex={-1}
      />
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        onChange={handleFile}
        className="sr-only"
        tabIndex={-1}
      />

      {blob ? (
        <div className="overflow-hidden rounded-2xl ring-1 ring-slate-300 dark:ring-slate-700">
          {/* Tapping the picture makes it bigger. Tapping "Replace" replaces
              it. Those were the same tap before, which meant that looking
              closely at a scan risked opening the camera over the top of it. */}
          <button
            type="button"
            onClick={() => setFull(true)}
            className="block max-h-72 w-full overflow-hidden"
            aria-label="View full size"
          >
            <FilePreview blob={blob} alt="Captured document" maxPages={1} />
          </button>
          <div className="flex divide-x divide-slate-200 border-t border-slate-200 dark:divide-slate-700 dark:border-slate-700">
            <button
              type="button"
              onClick={() => setFull(true)}
              className="min-h-11 flex-1 text-[14px] font-semibold text-indigo-600 dark:text-indigo-400"
            >
              View full size
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={disabled}
              className="min-h-11 flex-1 text-[14px] font-semibold text-slate-600 disabled:opacity-50 dark:text-slate-300"
            >
              Replace
            </button>
          </div>
          {full ? (
            <FullScreenPreview blob={blob} alt="Captured document" onClose={() => setFull(false)} />
          ) : null}
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => cameraRef.current?.click()}
            disabled={disabled}
            className="flex min-h-44 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-300 bg-white text-slate-600 transition-colors hover:border-indigo-400 hover:text-indigo-600 active:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-indigo-500"
          >
            {working ? (
              <>
                <Spinner className="size-7" />
                <span className="text-[15px] font-semibold">Processing…</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="size-9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 8.5A2.5 2.5 0 015.5 6h1.2a2 2 0 001.7-.95l.6-1A2 2 0 0110.7 3h2.6a2 2 0 011.7.95l.6 1A2 2 0 0017.3 6h1.2A2.5 2.5 0 0121 8.5v9A2.5 2.5 0 0118.5 20h-13A2.5 2.5 0 013 17.5z" />
                  <circle cx="12" cy="13" r="3.6" />
                </svg>
                <span className="text-[15px] font-semibold">{label}</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            className="mt-2 min-h-11 w-full text-[14px] font-medium text-slate-500 underline underline-offset-4 disabled:opacity-60 dark:text-slate-400"
          >
            Choose an image or PDF instead
          </button>
        </>
      )}
    </div>
  );
}
