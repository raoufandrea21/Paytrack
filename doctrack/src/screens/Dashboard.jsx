import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, documentsNeedingReview } from '../db.js';
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
  const reviewCount = useLiveQuery(async () => (await documentsNeedingReview()).length, [], 0);

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
          <div className="flex gap-2">
            <Button as="link" to="/upload" className="flex-1">
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V4m0 0L8 8m4-4l4 4" />
                <path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
              </svg>
              Upload documents
            </Button>
            <Button as="link" to="/library" variant="secondary" className="px-4" aria-label="All documents">
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              </svg>
            </Button>
          </div>
        ) : null
      }
    >
      {grouped === null ? (
        <div className="flex justify-center py-16 text-slate-400">
          <Spinner className="size-7" />
        </div>
      ) : grouped.length === 0 ? (
        <EmptyState icon="📄" title="Nothing on file yet">
          <p>
            Upload photos or PDFs of your documents and DocTrack will read them, sort them by
            person and set the reminders for you.
          </p>
          <Button as="link" to="/upload" className="mt-4">
            Upload documents
          </Button>
          <Link
            to="/members/new"
            className="mt-3 block text-[14px] font-medium text-slate-500 underline-offset-4 hover:underline dark:text-slate-400"
          >
            Or add a person by hand
          </Link>
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {reviewCount > 0 ? (
            <Link
              to="/review"
              className="flex items-center gap-3 rounded-2xl bg-amber-100 px-3.5 py-3 ring-1 ring-amber-200 dark:bg-amber-950/60 dark:ring-amber-900"
            >
              <span className="text-xl" aria-hidden="true">⚠️</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold text-amber-900 dark:text-amber-200">
                  {reviewCount} document{reviewCount === 1 ? '' : 's'} need
                  {reviewCount === 1 ? 's' : ''} checking
                </span>
                <span className="block text-[13px] text-amber-800 dark:text-amber-300">
                  Filed automatically, but something was hard to read.
                </span>
              </span>
              <span className="text-amber-700 dark:text-amber-300" aria-hidden="true">›</span>
            </Link>
          ) : null}

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

          <div className="flex justify-center gap-4 pb-2 text-[14px] font-medium text-slate-500 dark:text-slate-400">
            <Link to="/library" className="underline-offset-4 hover:underline">
              All documents
            </Link>
            <Link to="/archive" className="underline-offset-4 hover:underline">
              Archive
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
            {/* Auto-created people have no real relation yet, so "Other ·" is
                noise until the user sets one. */}
            {member.auto_created && member.relation === 'Other' ? '' : `${member.relation} · `}
            {docs.length} document{docs.length === 1 ? '' : 's'}
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
            + Add a document for {member.name.split(' ')[0]}
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
