import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, deleteDocuments } from '../db.js';
import { DOCUMENT_TYPES, documentLabel, documentType } from '../lib/constants.js';
import { byUrgency, standingFor } from '../lib/dates.js';
import Screen from '../components/Screen.jsx';
import DocumentRow from '../components/DocumentRow.jsx';
import { Banner, Button, Card, EmptyState, Input, Spinner } from '../components/ui.jsx';

/**
 * Every document in one place — the filing cabinet. The dashboard answers "what
 * needs doing"; this answers "where is my passport".
 */
/**
 * The three states a document can be in, as far as anybody cares. Kept here
 * rather than in the dashboard so the tiles that link in and the list they
 * land on cannot drift apart.
 */
const WHEN = {
  overdue: { label: 'Out of date' },
  soon: { label: 'Due within 60 days' },
  fine: { label: 'Nothing to do yet' },
};

export default function Library() {
  // Arrived at from a dashboard tile, so the state lives in the URL — the back
  // button then means what it looks like it means.
  const [params, setParams] = useSearchParams();
  const when = WHEN[params.get('when')] ? params.get('when') : 'all';
  const setWhen = (next) => setParams(next === 'all' ? {} : { when: next }, { replace: true });

  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [person, setPerson] = useState('all');
  const [includeArchived, setIncludeArchived] = useState(false);
  // Selecting is a mode rather than a permanent row of checkboxes: the common
  // case is looking something up, and a tick box beside every document makes
  // that job noisier for the sake of one that is done rarely.
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);

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
      .filter((d) => (when === 'all' ? true : standingFor(d) === when))
      .filter((d) => {
        if (!needle) return true;
        const haystack = [
          names.get(d.member_id) ?? '',
          documentLabel(d),
          d.number ?? '',
          d.notes ?? '',
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      })
      .sort(byUrgency)
      .map((d) => ({ doc: d, holder: names.get(d.member_id) ?? 'Unknown' }));
  }, [documents, members, query, type, person, includeArchived, when]);

  const typesPresent = useMemo(() => {
    const present = new Set((documents ?? []).map((d) => d.type));
    return DOCUMENT_TYPES.filter((t) => present.has(t.id));
  }, [documents]);

  return (
    <Screen
      title="All documents"
      subtitle={
        rows === null
          ? 'Loading…'
          : picking
            ? `${chosen.size} selected`
            // Arriving from a dashboard tile, the count on its own is a
            // mystery — it has to say what it counted.
            : `${rows.length} ${when === 'all' ? 'shown' : WHEN[when].label.toLowerCase()}`
      }
      back="/"
      actions={
        rows?.length ? (
          <button
            type="button"
            onClick={() => {
              setPicking((on) => !on);
              setChosen(new Set());
              setConfirming(false);
            }}
            className="min-h-11 rounded-lg px-2 text-[14px] font-semibold text-indigo-600 dark:text-indigo-400"
          >
            {picking ? 'Done' : 'Select'}
          </button>
        ) : null
      }
      footer={
        picking && chosen.size > 0 ? (
          <div className="flex flex-col gap-2">
            {confirming ? (
              <Banner tone="warn">
                Deleting {chosen.size} document{chosen.size === 1 ? '' : 's'} for good, on this
                device and — at the next sync — on your others.
              </Banner>
            ) : null}
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => { setChosen(new Set()); setConfirming(false); }}
              >
                Clear
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                onClick={async () => {
                  if (!confirming) {
                    setConfirming(true);
                    return;
                  }
                  await deleteDocuments([...chosen]);
                  setChosen(new Set());
                  setConfirming(false);
                  setPicking(false);
                }}
              >
                {confirming ? 'Yes, delete them' : `Delete ${chosen.size}`}
              </Button>
            </div>
          </div>
        ) : null
      }
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
          label="When"
          value={when}
          onChange={setWhen}
          options={[
            { id: 'all', label: 'Any time' },
            ...Object.entries(WHEN).map(([id, w]) => ({ id, label: w.label })),
          ]}
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

        {picking && rows?.length ? (
          <button
            type="button"
            onClick={() => setChosen(
              chosen.size === rows.length ? new Set() : new Set(rows.map((r) => r.doc.id)),
            )}
            className="min-h-11 w-full rounded-xl bg-white px-3 text-left text-[14px] font-semibold text-indigo-600 ring-1 ring-slate-300 dark:bg-slate-800 dark:text-indigo-400 dark:ring-slate-700"
          >
            {chosen.size === rows.length
              ? 'Select none'
              : `Select all ${rows.length} shown`}
          </button>
        ) : null}

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
              picking ? (
                <label
                  key={doc.id}
                  className="flex cursor-pointer items-center gap-2 pl-3.5 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(doc.id)}
                    onChange={() => setChosen((prev) => {
                      const next = new Set(prev);
                      if (next.has(doc.id)) next.delete(doc.id);
                      else next.add(doc.id);
                      return next;
                    })}
                    className="size-5 shrink-0 rounded"
                  />
                  <span className="pointer-events-none min-w-0 flex-1">
                    <DocumentRow document={doc} showHolder={holder} />
                  </span>
                </label>
              ) : (
                <DocumentRow key={doc.id} document={doc} showHolder={holder} />
              )
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
