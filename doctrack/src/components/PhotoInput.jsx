import { useEffect, useRef, useState } from 'react';
import { prepareImage, previewUrl } from '../lib/image.js';
import { Spinner } from './ui.jsx';

/**
 * `capture="environment"` opens the rear camera straight away on a phone, which
 * is the whole point of the fast add flow. On a laptop the same control falls
 * back to a normal file picker, so a second "choose a file" button would just be
 * noise — the browser already offers both where both exist.
 */
export default function PhotoInput({ blob, onChange, onError, busy, label = 'Take photo' }) {
  const inputRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const { url, revoke } = previewUrl(blob);
    setPreview(url);
    return revoke;
  }, [blob]);

  async function handleFile(event) {
    const file = event.target.files?.[0];
    // Reset immediately so re-picking the same file still fires a change event.
    event.target.value = '';
    if (!file) return;

    setWorking(true);
    try {
      const prepared = await prepareImage(file);
      await onChange(prepared);
    } catch (error) {
      onError?.(error.message ?? 'Could not read that photo.');
    } finally {
      setWorking(false);
    }
  }

  const disabled = busy || working;

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />

      {preview ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="relative block w-full overflow-hidden rounded-2xl ring-1 ring-slate-300 dark:ring-slate-700"
        >
          <img src={preview} alt="Captured document" className="max-h-72 w-full bg-slate-200 object-contain dark:bg-slate-800" />
          <span className="absolute right-2 bottom-2 rounded-lg bg-slate-900/80 px-2.5 py-1.5 text-[13px] font-semibold text-white">
            Retake
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="flex min-h-44 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-300 bg-white text-slate-600 transition-colors hover:border-indigo-400 hover:text-indigo-600 active:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-indigo-500"
        >
          {working ? (
            <>
              <Spinner className="size-7" />
              <span className="text-[15px] font-semibold">Processing photo…</span>
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="size-9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8.5A2.5 2.5 0 015.5 6h1.2a2 2 0 001.7-.95l.6-1A2 2 0 0110.7 3h2.6a2 2 0 011.7.95l.6 1A2 2 0 0017.3 6h1.2A2.5 2.5 0 0121 8.5v9A2.5 2.5 0 0118.5 20h-13A2.5 2.5 0 013 17.5z" />
                <circle cx="12" cy="13" r="3.6" />
              </svg>
              <span className="text-[15px] font-semibold">{label}</span>
              <span className="-mt-1.5 text-[13px] text-slate-500 dark:text-slate-400">
                or pick an existing image
              </span>
            </>
          )}
        </button>
      )}
    </div>
  );
}
