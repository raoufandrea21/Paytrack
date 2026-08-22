import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db.js';
import { DOCUMENT_TYPES, documentType } from '../lib/constants.js';
import { byUrgency } from '../lib/dates.js';
import Screen from '../components/Screen.jsx';
import DocumentRow from '../components/DocumentRow.jsx';
import { Card, EmptyState, Input, Spinner } from '../components/ui.jsx';

/**
 * Every document in one place — the filing cabinet. The dashboard answers "what
 * needs doing"; this answers "where is my passport".
 */
export default function Library() {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [person, setPerson] = useState('all');
  const [includeArchived, setIncludeArchived] = useState(false);

  const documents = useLiveQuery(() => db.documents.toArray(), [], null);
  const members = useLiveQuery(() => db.members.orderBy('created_at').toArray(), [], null);

  const rows = useMemo(() => {
    if (!documents || !members) return null;
    const names = new Map(members.map((m) => [m.id, m.name]));
    const needle = query.trim().toLowerCase();

    return documents
      .filter((d) => (includeArchived ? true : d.status === 'active'))
      .filter((d) => (type === 'all' ? true : d.type === type))
      .filter((d) => (person === 'all' ? true : d.member_id === Number(person)))
      .filter((d) => {
        if (!needle) return true;
        const haystack = [
          names.get(d.member_id) ?? '',
          documentType(d.type).label,
          d.number ?? '',
          d.notes ?? '',
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      })
      .sort(byUrgency)
      .map((d) => ({ doc: d, holder: names.get(d.member_id) ?? 'Unknown' }));
  }, [documents, members, query, type, person, includeArchived]);

  const typesPresent = useMemo(() => {
    const present = new Set((documents ?? []).map((d) => d.type));
    return DOCUMENT_TYPES.filter((t) => present.has(t.id));
  }, [documents]);

  return (
    <Screen
      title="All documents"
      subtitle={rows === null ? 'Loading…' : `${rows.length} shown`}
      back="/"
    >
      <div className="space-y-3 pb-4">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, number or type"
          aria-label="Search documents"
          dir="auto"
        />

        <FilterRow
          label="Type"
          value={type}
          onChange={setType}
          options={[
            { id: 'all', label: 'All types' },
            ...typesPresent.map((t) => ({ id: t.id, label: `${t.icon} ${t.label}` })),
          ]}
        />

        {members && members.length > 1 ? (
          <FilterRow
            label="Person"
            value={person}
            onChange={setPerson}
            options={[
              { id: 'all', label: 'Everyone' },
              ...members.map((m) => ({ id: String(m.id), label: m.name })),
            ]}
          />
        ) : null}

        <label className="flex items-center gap-2 px-1 text-[14px] text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="size-4 rounded"
          />
          Include archived and renewed
        </label>

        {rows === null ? (
          <div className="flex justify-center py-16 text-slate-400"><Spinner className="size-7" /></div>
        ) : rows.length === 0 ? (
          <EmptyState icon="🗄️" title="Nothing here">
            <p>
              {documents?.length
                ? 'No documents match those filters.'
                : 'Upload some documents and they will appear here.'}
            </p>
          </EmptyState>
        ) : (
          <Card className="divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
            {rows.map(({ doc, holder }) => (
              <DocumentRow key={doc.id} document={doc} showHolder={holder} />
            ))}
          </Card>
        )}
      </div>
    </Screen>
  );
}

/** Horizontally scrolling chips — more thumb-friendly than a select on a phone. */
function FilterRow({ label, value, onChange, options }) {
  return (
    <div className="-mx-3 overflow-x-auto px-3">
      <div className="flex w-max gap-2 pb-1" role="group" aria-label={label}>
        {options.map((option) => {
          const active = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange(option.id)}
              aria-pressed={active}
              className={`min-h-9 shrink-0 rounded-full px-3.5 text-[14px] font-semibold whitespace-nowrap transition-colors ${
                active
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white text-slate-600 ring-1 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
