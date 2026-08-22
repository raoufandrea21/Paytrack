import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, documentsNeedingReview, duplicateMembers, mergeMembers } from '../db.js';
import { byUrgency, shortRemainingFor, urgencyForDocument } from '../lib/dates.js';
import Screen from '../components/Screen.jsx';
import DocumentRow from '../components/DocumentRow.jsx';
import { Button, Card, EmptyState, Spinner, UrgencyChip } from '../components/ui.jsx';

// How much of a long list is shown before it asks to be opened. Enough to see
// what is urgent, few enough that eight people still fit on a phone screen.
const VISIBLE_SOON = 6;
const VISIBLE_PER_MEMBER = 3;

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
  const duplicates = useLiveQuery(() => duplicateMembers(), [], []);

  // Which people are folded away. A per-device preference about a screen, not
  // anything about the documents, so it lives in the browser rather than the
  // database — and it is remembered, because collapsing the same six people on
  // every visit would be worse than not offering it.
  const [folded, setFolded] = useState(readFolded);
  const toggle = (id) => setFolded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    writeFolded(next);
    return next;
  });
  const setAllFolded = (ids) => {
    const next = new Set(ids);
    writeFolded(next);
    setFolded(next);
  };

  // Nothing should take this long. If it does, say so rather than spinning.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (members && documents) return undefined;
    const timer = setTimeout(() => setStalled(true), 12_000);
    return () => clearTimeout(timer);
  }, [members, documents]);

  const grouped = useMemo(() => {
    if (!members || !documents) return null;
    const byMember = new Map(members.map((m) => [m.id, []]));
    for (const doc of documents) {
      if (byMember.has(doc.member_id)) byMember.get(doc.member_id).push(doc);
    }
    return members
      .map((member) => {
        const docs = [...(byMember.get(member.id) ?? [])].sort(byUrgency);
        const worst = docs.length ? urgencyForDocument(docs[0]) : null;
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
    () => (documents ?? []).filter((d) => urgencyForDocument(d).rank <= 1).length,
    [documents],
  );

  /**
   * Everything falling due in the next two months, whoever it belongs to.
   *
   * With eight people on file the per-person cards answer "what does Lily
   * have"; they do not answer "what do I have to deal with this month", which
   * is the reason to open the app at all. Sorted hardest-first and named by
   * person, this is that answer without scrolling through anybody's card.
   */
  const soon = useMemo(() => {
    if (!members || !documents) return [];
    const names = new Map(members.map((m) => [m.id, shortNameFor(m, members)]));
    return documents
      .filter((d) => urgencyForDocument(d).rank <= 2)
      .sort(byUrgency)
      .map((d) => ({ doc: d, holder: names.get(d.member_id) ?? 'Unknown' }));
  }, [members, documents]);

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
        stalled ? (
          <EmptyState icon="⏳" title="This is taking too long">
            <p>
              Your documents are stored on this device and something is stopping DocTrack reading
              them. Closing every other DocTrack tab and window, then reloading, usually clears it.
            </p>
            <Button className="mt-4" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </EmptyState>
        ) : (
          <div className="flex justify-center py-16 text-slate-400">
            <Spinner className="size-7" />
          </div>
        )
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
          {soon.length > 0 ? <ComingUp entries={soon} /> : null}

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

          {duplicates.map((group) => (
            <div
              key={group[0].id}
              className="flex items-center gap-3 rounded-2xl bg-indigo-50 px-3.5 py-3 ring-1 ring-indigo-200 dark:bg-indigo-950/60 dark:ring-indigo-900"
            >
              <span className="text-xl" aria-hidden="true">👥</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold text-indigo-900 dark:text-indigo-200">
                  {group.length} entries for {group[0].name}
                </span>
                <span className="block text-[13px] text-indigo-800 dark:text-indigo-300">
                  Same person, listed twice. Merging moves all their documents together.
                </span>
              </span>
              <Button
                className="shrink-0 px-3"
                onClick={() => mergeMembers(group[0].id, group.map((m) => m.id))}
              >
                Merge
              </Button>
            </div>
          ))}

          {grouped.length > 1 ? (
            <div className="flex justify-end px-1">
              <button
                type="button"
                onClick={() => setAllFolded(
                  folded.size >= grouped.length ? [] : grouped.map((g) => g.member.id),
                )}
                className="min-h-11 text-[13px] font-semibold text-slate-500 underline-offset-4 hover:underline dark:text-slate-400"
              >
                {folded.size >= grouped.length ? 'Expand everyone' : 'Collapse everyone'}
              </button>
            </div>
          ) : null}

          {grouped.map(({ member, docs }) => (
            <MemberCard
              key={member.id}
              member={member}
              docs={docs}
              open={!folded.has(member.id)}
              onToggle={() => toggle(member.id)}
            />
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

/** The next two months for the whole household, in one list. */
function ComingUp({ entries }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? entries : entries.slice(0, VISIBLE_SOON);
  const hidden = entries.length - shown.length;
  const overdue = entries.filter((e) => urgencyForDocument(e.doc).rank === 0).length;

  return (
    <Card className="overflow-hidden ring-2 ring-indigo-200 dark:ring-indigo-900">
      <div className="flex items-baseline justify-between gap-2 px-3.5 pt-3 pb-2">
        <h2 className="text-[15px] font-bold">Next 60 days</h2>
        <p className="text-[13px] text-slate-500 dark:text-slate-400">
          {overdue > 0
            ? `${overdue} already ${overdue === 1 ? 'needs' : 'need'} renewing`
            : `${entries.length} coming up`}
        </p>
      </div>
      <div className="divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
        {shown.map(({ doc, holder }) => (
          <DocumentRow key={doc.id} document={doc} showHolder={holder} />
        ))}
        {hidden > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="block w-full px-3.5 py-3 text-left text-[14px] font-medium text-indigo-600 dark:text-indigo-400"
          >
            Show {hidden} more
          </button>
        ) : null}
      </div>
    </Card>
  );
}

function MemberCard({ member, docs, open, onToggle }) {
  // Someone with a dozen documents should not push everybody else off the
  // screen. The urgent few are always visible; the rest are one tap away.
  const [showAll, setShowAll] = useState(false);
  const shown = showAll || docs.length <= VISIBLE_PER_MEMBER + 1
    ? docs
    : docs.slice(0, VISIBLE_PER_MEMBER);
  const hidden = docs.length - shown.length;

  // Folded away, the card still has to be worth reading: how many documents,
  // and whether any of them need doing something about.
  const worst = docs.length ? urgencyForDocument(docs[0]) : null;
  const pressing = docs.filter((d) => urgencyForDocument(d).rank <= 1).length;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-1 px-1.5 pt-1.5 pb-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`member-${member.id}-documents`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[14px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
            {initials(member.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-bold">{member.name}</span>
            <span className="block truncate text-[13px] text-slate-500 dark:text-slate-400">
              {/* Auto-created people have no real relation yet, so "Other ·" is
                  noise until the user sets one. */}
              {member.auto_created && member.relation === 'Other' ? '' : `${member.relation} · `}
              {/* Folded, the useful number is how many need doing something
                  about, not how many exist — and it has to be short, because a
                  name, a relation, a chip and a chevron already share this row.
                  The chip beside it says how soon; this says how many. */}
              {!open && pressing > 0
                ? `${pressing} to renew`
                : `${docs.length} document${docs.length === 1 ? '' : 's'}`}
            </span>
          </span>
          {!open && worst && worst.rank <= 2 ? (
            <UrgencyChip urgency={worst} className="shrink-0">
              {shortRemainingFor(docs[0])}
            </UrgencyChip>
          ) : null}
          <svg
            viewBox="0 0 24 24"
            className={`size-5 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {open ? (
          <Link
            to={`/members/${member.id}/edit`}
            className="shrink-0 rounded-lg px-2 py-1.5 text-[13px] font-semibold text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            Edit
          </Link>
        ) : null}
      </div>

      {open ? (
        <div
          id={`member-${member.id}-documents`}
          className="divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800"
        >
          {docs.length === 0 ? (
            <Link
              to={`/documents/new?member=${member.id}`}
              className="block px-3.5 py-4 text-[14px] font-medium text-indigo-600 dark:text-indigo-400"
            >
              + Add a document for {member.name.split(' ')[0]}
            </Link>
          ) : (
            <>
              {shown.map((doc) => (
                <DocumentRow key={doc.id} document={doc} />
              ))}
              {hidden > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="block w-full px-3.5 py-3 text-left text-[14px] font-medium text-slate-500 dark:text-slate-400"
                >
                  Show {hidden} more document{hidden === 1 ? '' : 's'}
                </button>
              ) : null}
              <Link
                to={`/documents/new?member=${member.id}`}
                className="block px-3.5 py-3 text-[14px] font-medium text-indigo-600 dark:text-indigo-400"
              >
                + Add document
              </Link>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * A first name, which is how a household refers to each other and leaves room
 * for the date beside it on a phone. Two people sharing one keep their full
 * names, because a list that says "Maria" twice answers nothing.
 */
function shortNameFor(member, members) {
  const first = (m) => m.name.trim().split(/\s+/)[0] ?? m.name;
  const mine = first(member);
  const shared = members.filter((m) => first(m).toLowerCase() === mine.toLowerCase()).length > 1;
  return shared ? member.name : mine;
}

const FOLDED_KEY = 'doctrack.foldedMembers';

function readFolded() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FOLDED_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}

function writeFolded(ids) {
  try {
    window.localStorage.setItem(FOLDED_KEY, JSON.stringify([...ids]));
  } catch {
    /* private browsing; everyone just starts open next time */
  }
}

function initials(name) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
