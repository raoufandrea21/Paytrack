import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, documentsNeedingReview } from '../db.js';
import { documentLabel, documentType } from '../lib/constants.js';
import { formatDate } from '../lib/dates.js';
import { reviewReasonsFor } from '../lib/review.js';
import { startRun } from '../lib/reviewrun.js';
import Screen from '../components/Screen.jsx';
import { Button, Card, EmptyState, Spinner } from '../components/ui.jsx';

/**
 * Everything automatic filing saved but was not sure about. This is the only
 * place the app asks the user for anything, and it stays empty when scans are
 * clean.
 */
export default function Review() {
  const navigate = useNavigate();
  const docs = useLiveQuery(() => documentsNeedingReview(), [], null);
  const members = useLiveQuery(() => db.members.toArray(), [], null);

  const rows = useMemo(() => {
    if (!docs || !members) return null;
    const names = new Map(members.map((m) => [m.id, m.name]));
    return docs.map((doc) => ({
      doc,
      holder: names.get(doc.member_id) ?? 'Unknown',
      reasons: reviewReasonsFor(doc),
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
          {/* One button that starts the run, rather than thirty-eight
              round trips through this list. */}
          <Card className="p-4">
            <p className="text-[14px] text-slate-600 dark:text-slate-400">
              These are all saved already — nothing is lost while they sit here. Checking one
              takes you straight to the next, with the scan on the same screen, so you can
              work through the pile without coming back to this list.
            </p>
            <Button
              className="mt-3 w-full"
              onClick={() => {
                // The order is fixed here, so the counter means something and
                // skipping does not send you back over ground you covered.
                const ids = startRun(rows.map((r) => r.doc.id));
                navigate(`/documents/${ids[0]}/edit?queue=review`);
              }}
            >
              Check {rows.length === 1 ? 'it' : `all ${rows.length}`}, one after another
            </Button>
          </Card>
          {rows.map(({ doc, holder, reasons }) => (
            <Card key={doc.id} className="overflow-hidden">
              <Link
                to={`/documents/${doc.id}/edit`}
                className="block px-3.5 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-xl" aria-hidden="true">{documentType(doc.type).icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold">{documentLabel(doc)}</p>
                    <p className="truncate text-[13px] text-slate-500 dark:text-slate-400">
                      {holder} ·{' '}
                      {doc.no_expiry
                        ? 'no expiry'
                        : doc.expiry_date
                          ? `expires ${formatDate(doc.expiry_date)}`
                          : 'no expiry date'}
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
