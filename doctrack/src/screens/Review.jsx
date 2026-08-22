import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, documentsNeedingReview } from '../db.js';
import { documentType } from '../lib/constants.js';
import { formatDate } from '../lib/dates.js';
import Screen from '../components/Screen.jsx';
import { Card, EmptyState, Spinner } from '../components/ui.jsx';

/**
 * Everything automatic filing saved but was not sure about. This is the only
 * place the app asks the user for anything, and it stays empty when scans are
 * clean.
 */
export default function Review() {
  const docs = useLiveQuery(() => documentsNeedingReview(), [], null);
  const members = useLiveQuery(() => db.members.toArray(), [], null);

  const rows = useMemo(() => {
    if (!docs || !members) return null;
    const names = new Map(members.map((m) => [m.id, m.name]));
    return docs.map((doc) => ({
      doc,
      holder: names.get(doc.member_id) ?? 'Unknown',
      reasons: reasonsFor(doc),
    }));
  }, [docs, members]);

  return (
    <Screen title="Needs checking" subtitle="Filed, but worth a second look" back="/">
      {rows === null ? (
        <div className="flex justify-center py-16 text-slate-400"><Spinner className="size-7" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon="✅" title="Nothing to check">
          <p>Everything uploaded so far read cleanly and filed itself.</p>
        </EmptyState>
      ) : (
        <div className="space-y-3 pb-4">
          <p className="px-1 text-[14px] text-slate-600 dark:text-slate-400">
            These are saved already. Open one to correct it — the reminders update as soon as you do.
          </p>
          {rows.map(({ doc, holder, reasons }) => (
            <Card key={doc.id} className="overflow-hidden">
              <Link
                to={`/documents/${doc.id}/edit`}
                className="block px-3.5 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-xl" aria-hidden="true">{documentType(doc.type).icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold">
                      {documentType(doc.type).label}
                    </p>
                    <p className="truncate text-[13px] text-slate-500 dark:text-slate-400">
                      {holder} ·{' '}
                      {doc.expiry_date ? `expires ${formatDate(doc.expiry_date)}` : 'no expiry date'}
                    </p>
                  </div>
                  <span className="text-[14px] font-semibold text-indigo-600 dark:text-indigo-400">
                    Fix
                  </span>
                </div>
                <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-[13px] text-amber-800 dark:border-slate-800 dark:text-amber-300">
                  {reasons.map((r, i) => (
                    <li key={i}>• {r}</li>
                  ))}
                </ul>
              </Link>
            </Card>
          ))}
        </div>
      )}
    </Screen>
  );
}

/**
 * Reasons are recomputed from the stored record rather than persisted, so a
 * document that gets its expiry date filled in stops complaining about it even
 * if the review flag is cleared separately.
 */
function reasonsFor(doc) {
  const reasons = [];
  if (!doc.expiry_date) reasons.push('No expiry date — no reminders will fire.');
  if (doc.type === 'other') reasons.push('Document type was not recognised.');
  if (!doc.number) reasons.push('No document number was read.');
  for (const warning of doc.extraction?.warnings ?? []) reasons.push(warning);
  return reasons.length > 0 ? reasons : ['Read with low confidence.'];
}
