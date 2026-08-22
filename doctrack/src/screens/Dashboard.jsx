import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db.js';
import { byUrgency, urgencyFor } from '../lib/dates.js';
import Screen from '../components/Screen.jsx';
import DocumentRow from '../components/DocumentRow.jsx';
import { Button, Card, EmptyState, Spinner } from '../components/ui.jsx';

/**
 * Home screen. One card per family member, their documents inside sorted by
 * urgency, and the members with something expiring soonest floated to the top —
 * so the thing you need to act on is the first thing on screen.
 */
export default function Dashboard() {
  const members = useLiveQuery(() => db.members.orderBy('created_at').toArray(), [], null);
  const documents = useLiveQuery(
    () => db.documents.where('status').equals('active').toArray(),
    [],
    null,
  );

  const grouped = useMemo(() => {
    if (!members || !documents) return null;
    const byMember = new Map(members.map((m) => [m.id, []]));
    for (const doc of documents) {
      if (byMember.has(doc.member_id)) byMember.get(doc.member_id).push(doc);
    }
    return members
      .map((member) => {
        const docs = [...(byMember.get(member.id) ?? [])].sort(byUrgency);
        const worst = docs.length ? urgencyFor(docs[0].expiry_date) : null;
        return { member, docs, worst };
      })
      .sort((a, b) => {
        const ra = a.worst?.rank ?? 4;
        const rb = b.worst?.rank ?? 4;
        if (ra !== rb) return ra - rb;
        return (a.worst?.days ?? Infinity) - (b.worst?.days ?? Infinity);
      });
  }, [members, documents]);

  const attention = useMemo(
    () => (documents ?? []).filter((d) => urgencyFor(d.expiry_date).rank <= 1).length,
    [documents],
  );

  return (
    <Screen
      title="DocTrack"
      subtitle={
        grouped === null
          ? 'Loading…'
          : attention > 0
            ? `${attention} document${attention === 1 ? ' needs' : 's need'} attention`
            : 'Everything is in date'
      }
      actions={
        <Link
          to="/settings"
          className="flex size-10 items-center justify-center rounded-full text-slate-600 hover:bg-slate-200/70 active:bg-slate-300/70 dark:text-slate-300 dark:hover:bg-slate-800"
          aria-label="Settings"
        >
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.14.35.4.64.73.83.3.17.64.26 1 .26H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </Link>
      }
      footer={
        grouped?.length ? (
          <Button as="link" to="/documents/new" className="w-full">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add document
          </Button>
        ) : null
      }
    >
      {grouped === null ? (
        <div className="flex justify-center py-16 text-slate-400">
          <Spinner className="size-7" />
        </div>
      ) : grouped.length === 0 ? (
        <EmptyState icon="👨‍👩‍👧" title="No family members yet">
          <p>Add the first person, then start photographing their documents.</p>
          <Button as="link" to="/members/new" className="mt-4">
            Add family member
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {grouped.map(({ member, docs }) => (
            <MemberCard key={member.id} member={member} docs={docs} />
          ))}

          <Link
            to="/members/new"
            className="flex min-h-12 items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 text-[15px] font-semibold text-slate-500 hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-400"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add family member
          </Link>

          <div className="pb-2 text-center">
            <Link to="/archive" className="text-[14px] font-medium text-slate-500 underline-offset-4 hover:underline dark:text-slate-400">
              View archived documents
            </Link>
          </div>
        </div>
      )}
    </Screen>
  );
}

function MemberCard({ member, docs }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 px-3.5 pt-3 pb-2">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[14px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
          {initials(member.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold">{member.name}</p>
          <p className="truncate text-[13px] text-slate-500 dark:text-slate-400">
            {member.relation} · {docs.length} document{docs.length === 1 ? '' : 's'}
          </p>
        </div>
        <Link
          to={`/members/${member.id}/edit`}
          className="rounded-lg px-2 py-1.5 text-[13px] font-semibold text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          Edit
        </Link>
      </div>

      <div className="divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
        {docs.length === 0 ? (
          <Link
            to={`/documents/new?member=${member.id}`}
            className="block px-3.5 py-4 text-[14px] font-medium text-indigo-600 dark:text-indigo-400"
          >
            + Add the first document for {member.name.split(' ')[0]}
          </Link>
        ) : (
          <>
            {docs.map((doc) => (
              <DocumentRow key={doc.id} document={doc} />
            ))}
            <Link
              to={`/documents/new?member=${member.id}`}
              className="block px-3.5 py-3 text-[14px] font-medium text-indigo-600 dark:text-indigo-400"
            >
              + Add document
            </Link>
          </>
        )}
      </div>
    </Card>
  );
}

function initials(name) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
