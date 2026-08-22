import { Link } from 'react-router-dom';
import { Banner, Card } from './ui.jsx';

/**
 * What a batch of documents did, and what each one became.
 *
 * Shared by the two ways documents arrive in bulk — files chosen on a device,
 * and files read out of a OneDrive folder — because they are the same event to
 * the person watching, and a second vocabulary for it would only be a second
 * thing to learn.
 */
export function ImportQueue({ items }) {
  return (
    <Card className="divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
      {items.map((item) => (
        <QueueRow key={item.id} item={item} />
      ))}
    </Card>
  );
}

export function ImportSummary({ saved, review, duplicates, skipped, failed }) {
  if (saved === 0 && failed === 0 && duplicates === 0 && skipped === 0) return null;
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
      {skipped > 0 ? (
        <p>
          {skipped} personal {skipped === 1 ? 'photo' : 'photos'} skipped — nothing about them
          expires.
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
  archived: { dot: 'bg-slate-400', text: 'text-slate-600 dark:text-slate-300' },
  portrait: { dot: 'bg-slate-300', text: 'text-slate-500 dark:text-slate-400' },
  needs_review: { dot: 'bg-amber-500', text: 'text-amber-800 dark:text-amber-300' },
  duplicate: { dot: 'bg-slate-400', text: 'text-slate-500 dark:text-slate-400' },
  failed: { dot: 'bg-red-500', text: 'text-red-700 dark:text-red-300' },
};

export function QueueRow({ item }) {
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
