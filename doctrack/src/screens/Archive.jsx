import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db.js';
import Screen from '../components/Screen.jsx';
import DocumentRow from '../components/DocumentRow.jsx';
import { Card, EmptyState, Spinner } from '../components/ui.jsx';

/** Renewal history lives here — nothing is ever deleted by renewing. */
export default function Archive() {
  const documents = useLiveQuery(
    () => db.documents.where('status').equals('archived').toArray(),
    [],
    null,
  );
  const members = useLiveQuery(() => db.members.toArray(), [], null);

  const rows = useMemo(() => {
    if (!documents || !members) return null;
    const names = new Map(members.map((m) => [m.id, m.name]));
    return [...documents]
      .sort((a, b) => (b.expiry_date ?? '').localeCompare(a.expiry_date ?? ''))
      .map((doc) => ({ doc, holder: names.get(doc.member_id) ?? 'Unknown' }));
  }, [documents, members]);

  return (
    <Screen title="Archive" subtitle="Kept, but not tracked" back="/">
      {rows === null ? (
        <div className="flex justify-center py-16 text-slate-400"><Spinner className="size-7" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon="🗂️" title="Nothing archived yet">
          <p>
            The archive is where documents go when they still matter but no longer need
            watching — the passport you renewed, the insurance on a car you sold.
          </p>
          <p className="mt-2">
            Renewing a document puts the old one here automatically, so you never lose the
            history. You can also archive one yourself from its page.
          </p>
        </EmptyState>
      ) : (
        <>
        <p className="mb-3 px-1 text-[14px] text-slate-600 dark:text-slate-400">
          Old versions of documents you renewed, and anything you archived by hand. They stay
          on file and stay searchable, but they are off the dashboard and nothing reminds you
          about them. Open one to restore it.
        </p>
        <Card className="divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
          {rows.map(({ doc, holder }) => (
            <DocumentRow key={doc.id} document={doc} showHolder={holder} />
          ))}
        </Card>
        </>
      )}
    </Screen>
  );
}
