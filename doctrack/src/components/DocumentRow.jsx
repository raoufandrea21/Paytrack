import { Link } from 'react-router-dom';
import { documentLabel, documentType } from '../lib/constants.js';
import { expiryPhraseFor, formatDate, shortRemainingFor, urgencyForDocument } from '../lib/dates.js';
import { UrgencyChip } from './ui.jsx';

export default function DocumentRow({ document: doc, showHolder }) {
  const type = documentType(doc.type);
  const urgency = urgencyForDocument(doc);

  return (
    <Link
      to={`/documents/${doc.id}`}
      className="flex min-h-16 items-center gap-3 px-3.5 py-3 transition-colors hover:bg-slate-50 active:bg-slate-100 dark:hover:bg-slate-800/60 dark:active:bg-slate-800"
    >
      {/* The urgency bar is the thing you read first when scanning the list. */}
      <span className={`h-9 w-1 shrink-0 rounded-full ${urgency.bar}`} aria-hidden="true" />
      <span className="text-xl" aria-hidden="true">{type.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold">{documentLabel(doc)}</span>
        <span className="block truncate text-[13px] text-slate-500 dark:text-slate-400">
          {showHolder ? `${showHolder} · ` : ''}
          {doc.no_expiry ? 'No expiry' : doc.expiry_date ? formatDate(doc.expiry_date) : 'No expiry date'}
        </span>
      </span>
      <UrgencyChip urgency={urgency} className="shrink-0">
        {shortRemainingFor(doc)}
      </UrgencyChip>
      <span className="sr-only">{expiryPhraseFor(doc)}</span>
    </Link>
  );
}
