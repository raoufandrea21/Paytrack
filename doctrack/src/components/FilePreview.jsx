import { useEffect, useState } from 'react';
import { previewUrl } from '../lib/files.js';
import { renderPdfPages } from '../lib/pdf.js';
import { Spinner } from './ui.jsx';

/**
 * Shows what a document actually looks like — including when it is a PDF.
 *
 * Phones will not render a PDF in an <object>, and a desktop that does still
 * puts it behind a viewer chrome that fights the page. But the app already
 * carries pdf.js, because that is how it reads scans in the first place, so a
 * PDF can simply be drawn into pictures and shown like any other document. It
 * turns "📕 PDF attached" — which is a description, not a preview — into the
 * thing you were trying to look at.
 *
 * Rendering is deliberate work, so it happens once per blob and the result is
 * held until the blob changes.
 */
export default function FilePreview({ blob, alt = 'Document', maxPages = 3, className = '' }) {
  const isPdf = blob?.type === 'application/pdf';
  const [url, setUrl] = useState(null);
  const [pages, setPages] = useState(null); // array of object URLs, or null
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!blob) { setUrl(null); return undefined; }
    const { url: made, revoke } = previewUrl(blob);
    setUrl(made);
    return revoke;
  }, [blob]);

  useEffect(() => {
    if (!blob || !isPdf) { setPages(null); setFailed(false); return undefined; }

    let alive = true;
    let urls = [];
    setPages(null);
    setFailed(false);

    renderPdfPages(blob, { pages: maxPages, scale: 1.6 })
      .then((images) => {
        if (!alive) return;
        urls = images.map((image) => URL.createObjectURL(image));
        setPages(urls);
      })
      .catch(() => alive && setFailed(true));

    return () => {
      alive = false;
      for (const made of urls) URL.revokeObjectURL(made);
    };
  }, [blob, isPdf, maxPages]);

  if (!blob) return null;

  if (!isPdf) {
    return <img src={url} alt={alt} className={`w-full bg-slate-100 object-contain dark:bg-slate-800 ${className}`} />;
  }

  // A PDF that will not render is still a file the user can open themselves.
  if (failed) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="flex min-h-32 w-full flex-col items-center justify-center gap-2 bg-slate-100 py-8 text-indigo-600 dark:bg-slate-800 dark:text-indigo-400"
      >
        <span className="text-3xl" aria-hidden="true">📕</span>
        <span className="text-[14px] font-semibold">Open the PDF</span>
      </a>
    );
  }

  if (pages === null) {
    return (
      <div className="flex min-h-32 w-full flex-col items-center justify-center gap-2 bg-slate-100 py-8 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <Spinner className="size-6" />
        <span className="text-[13px] font-semibold">Opening the PDF…</span>
      </div>
    );
  }

  return (
    <div className={className}>
      {pages.map((page, index) => (
        <img
          key={page}
          src={page}
          alt={pages.length > 1 ? `${alt}, page ${index + 1}` : alt}
          className="w-full border-b border-slate-200 bg-slate-100 object-contain last:border-b-0 dark:border-slate-800 dark:bg-slate-800"
        />
      ))}
    </div>
  );
}

/**
 * The same file, filling the screen.
 *
 * Checking a date against a scan on a phone means reading small print, and the
 * inline preview is a third of a screen wide. This is the "look properly" step.
 */
export function FullScreenPreview({ blob, alt, onClose }) {
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-slate-950/95"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <div
        className="sticky top-0 z-10 flex justify-end bg-slate-950/80 p-2 backdrop-blur"
        style={{ paddingTop: 'calc(0.5rem + var(--safe-top))' }}
      >
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-xl bg-white/15 px-4 text-[15px] font-bold text-white hover:bg-white/25"
        >
          Close
        </button>
      </div>
      <div className="p-2 pb-16">
        <FilePreview blob={blob} alt={alt} maxPages={10} className="rounded-xl" />
      </div>
    </div>
  );
}
