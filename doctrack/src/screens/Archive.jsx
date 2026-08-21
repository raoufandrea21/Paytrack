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
    <Screen title="Archive" subtitle="Expired and replaced documents" back="/">
      {rows === null ? (
        <div className="flex justify-center py-16 text-slate-400"><Spinner className="size-7" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon="🗂️" title="Nothing archived yet">
          <p>When you renew a document, the old one is filed here instead of being deleted.</p>
        </EmptyState>
      ) : (
        <Card className="divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
          {rows.map(({ doc, holder }) => (
            <DocumentRow key={doc.id} document={doc} showHolder={holder} />
          ))}
        </Card>
      )}
    </Screen>
  );
}
