import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSetting, setSetting } from '../db.js';
import { DOCUMENT_TYPES, documentType, typeIsPermanent } from '../lib/constants.js';
import {
  LEAD_CHOICES,
  OVERDUE_CHOICES,
  RULES_SETTING,
  defaultRules,
  describeDays,
  describeLeads,
  isDefaultRules,
  normaliseRules,
} from '../lib/reminderrules.js';
import { dueReminders } from '../lib/reminders.js';
import { buildCalendar, calendarFilename } from '../lib/calendar.js';
import Screen from '../components/Screen.jsx';
import { Banner, Button, Card, Spinner } from '../components/ui.jsx';

/**
 * When each kind of document should start warning you.
 *
 * Ordered by what you actually own: the kinds you have documents for come
 * first, with a count, and the rest sit below a fold. Editing a rule you will
 * never use is not a good use of the first screenful.
 */
export default function Reminders() {
  const [rules, setRules] = useState(null);
  const [saved, setSaved] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const documents = useLiveQuery(() => db.documents.toArray(), [], null);
  const members = useLiveQuery(() => db.members.toArray(), [], null);

  useEffect(() => {
    getSetting(RULES_SETTING, null).then((raw) => setRules(normaliseRules(raw)));
  }, []);

  // Saved as you go — an explicit Save button on a screen of toggles is a way
  // to lose changes, not a way to protect them.
  const commit = async (next) => {
    setRules(next);
    await setSetting(RULES_SETTING, next);
    setSaved(true);
  };

  const counts = useMemo(() => {
    const map = new Map();
    for (const doc of documents ?? []) {
      if (doc.status !== 'active') continue;
      map.set(doc.type, (map.get(doc.type) ?? 0) + 1);
    }
    return map;
  }, [documents]);

  const tracked = DOCUMENT_TYPES.filter((t) => !typeIsPermanent(t.id));
  const owned = tracked.filter((t) => counts.get(t.id));
  const rest = tracked.filter((t) => !counts.get(t.id));
  const listed = showAll ? [...owned, ...rest] : owned.length ? owned : tracked;

  if (rules === null) {
    return (
      <Screen title="Reminders" back="/settings">
        <div className="flex justify-center py-16 text-slate-400"><Spinner className="size-7" /></div>
      </Screen>
    );
  }

  return (
    <Screen
      title="Reminders"
      subtitle="When to warn you, and about what"
      back="/settings"
      actions={
        isDefaultRules(rules) ? null : (
          <button
            type="button"
            onClick={() => commit(defaultRules())}
            className="min-h-11 rounded-lg px-2 text-[14px] font-semibold text-indigo-600 dark:text-indigo-400"
          >
            Reset
          </button>
        )
      }
    >
      <div className="space-y-4 pb-6">
        {saved ? (
          <Banner tone="ok">Saved. New rules apply from the next check.</Banner>
        ) : null}

        <NextUp rules={rules} />

        <Card className="p-4">
          <h2 className="text-[15px] font-bold">Once something is out of date</h2>
          <p className="mt-1 text-[13px] text-slate-600 dark:text-slate-400">
            An expired document is the one worth being annoying about, so DocTrack says it
            again until you deal with it.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {OVERDUE_CHOICES.map((days) => (
              <Chip
                key={days}
                on={rules.overdueRepeat === days}
                onClick={() => commit({ ...rules, overdueRepeat: days })}
              >
                {days === 0 ? 'Say it once' : `Every ${describeDays(days)}`}
              </Chip>
            ))}
          </div>
        </Card>

        <div className="space-y-3">
          <h2 className="px-1 text-[13px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {owned.length && !showAll ? 'The documents you have' : 'Every kind of document'}
          </h2>

          {listed.map((type) => (
            <TypeRule
              key={type.id}
              type={type}
              count={counts.get(type.id) ?? 0}
              leads={rules.types[type.id] ?? []}
              muted={rules.muted.includes(type.id)}
              onToggleLead={(day) => {
                const current = new Set(rules.types[type.id] ?? []);
                if (current.has(day)) current.delete(day);
                else current.add(day);
                commit({
                  ...rules,
                  types: { ...rules.types, [type.id]: [...current].sort((a, b) => b - a) },
                });
              }}
              onToggleMute={() => {
                const muted = new Set(rules.muted);
                if (muted.has(type.id)) muted.delete(type.id);
                else muted.add(type.id);
                commit({ ...rules, muted: [...muted] });
              }}
            />
          ))}

          {owned.length && !showAll ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="min-h-11 w-full rounded-xl bg-white text-[14px] font-semibold text-indigo-600 ring-1 ring-slate-300 dark:bg-slate-800 dark:text-indigo-400 dark:ring-slate-700"
            >
              Show the other {rest.length} kinds
            </button>
          ) : null}
        </div>

        <CalendarExport documents={documents} members={members} rules={rules} />

        <p className="px-1 text-[13px] text-slate-500 dark:text-slate-400">
          Birth, marriage and education certificates never expire, so they are never
          reminded about. Reminders arrive on whichever devices you have allowed
          notifications on — set that up in Settings.
        </p>
      </div>
    </Screen>
  );
}

/**
 * The rules are abstract until you see them land on your own documents, so the
 * top of the screen answers "what would you tell me today?".
 */
function NextUp({ rules }) {
  const [due, setDue] = useState(null);

  useEffect(() => {
    let alive = true;
    dueReminders({ rules })
      .then((list) => alive && setDue(list))
      .catch(() => alive && setDue([]));
    return () => { alive = false; };
  }, [rules]);

  if (due === null) return null;

  return (
    <Card className="p-4">
      <h2 className="text-[15px] font-bold">What you would be told right now</h2>
      {due.length === 0 ? (
        <p className="mt-1 text-[13px] text-slate-600 dark:text-slate-400">
          Nothing is inside its warning window. Widen a rule below to hear about things
          sooner.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {due.slice(0, 5).map((item) => (
            <li key={`${item.document.id}:${item.threshold}`} className="text-[14px]">
              <span className="mr-1">{documentType(item.document.type).icon}</span>
              <span className="font-semibold">{item.holder}</span>
              <span className="text-slate-500 dark:text-slate-400">
                {' '}· {documentType(item.document.type).label} ·{' '}
                {item.days < 0 ? `${describeDays(item.days)} overdue` : `in ${describeDays(item.days)}`}
              </span>
            </li>
          ))}
          {due.length > 5 ? (
            <li className="text-[13px] text-slate-500 dark:text-slate-400">
              and {due.length - 5} more
            </li>
          ) : null}
        </ul>
      )}
    </Card>
  );
}

/**
 * The rules, written out as calendar alarms.
 *
 * A web app can only remind you when it is opened, or in the background where
 * the browser allows it — which on an iPhone is nowhere. A calendar has no such
 * problem: it is the one thing on a phone certain to go off on a date eight
 * months from now. So the same rules go out as a file the phone's own calendar
 * takes over, and after that nothing depends on anybody opening DocTrack.
 */
function CalendarExport({ documents, members, rules }) {
  const [done, setDone] = useState(null);

  return (
    <Card className="p-4">
      <h2 className="text-[15px] font-bold">Put these in your phone's calendar</h2>
      <p className="mt-1 text-[13px] text-slate-600 dark:text-slate-400">
        Saves every expiry date as a calendar entry with these same reminders on it. The
        calendar will then warn you whether or not you open DocTrack — worth doing on a
        phone, where a web app is not allowed to wake itself up. Do it again after adding
        documents; the entries update rather than doubling.
      </p>

      {done ? (
        <Banner tone="ok" className="mt-3">
          {done} {done === 1 ? 'date' : 'dates'} saved. Open the downloaded file and your
          phone will offer to add them.
        </Banner>
      ) : null}

      <Button
        variant="secondary"
        className="mt-3 w-full"
        disabled={!documents || !members}
        onClick={() => {
          const { ics, events } = buildCalendar(documents ?? [], members ?? [], rules);
          const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = calendarFilename();
          link.click();
          URL.revokeObjectURL(url);
          setDone(events);
        }}
      >
        Download calendar file
      </Button>
    </Card>
  );
}

function TypeRule({ type, count, leads, muted, onToggleLead, onToggleMute }) {
  return (
    <Card className={`p-4 ${muted ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <span className="text-[22px] leading-none">{type.icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-bold">{type.label}</h3>
          <p className="mt-0.5 truncate text-[13px] text-slate-500 dark:text-slate-400">
            {muted ? 'Never reminded' : describeLeads(leads)}
            {count ? ` · ${count} on file` : ''}
          </p>
        </div>
        <button
          type="button"
          aria-pressed={muted}
          onClick={onToggleMute}
          className={`min-h-11 shrink-0 rounded-lg px-2 text-[13px] font-semibold ${
            muted
              ? 'text-indigo-600 dark:text-indigo-400'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          {muted ? 'Turn on' : 'Silence'}
        </button>
      </div>

      {muted ? null : (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {LEAD_CHOICES.map((day) => (
            <Chip key={day} small on={leads.includes(day)} onClick={() => onToggleLead(day)}>
              {describeDays(day)}
            </Chip>
          ))}
        </div>
      )}
    </Card>
  );
}

function Chip({ on, small, children, ...props }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`min-h-9 rounded-full px-3 font-semibold transition ${
        small ? 'text-[13px]' : 'text-[14px]'
      } ${
        on
          ? 'bg-indigo-600 text-white'
          : 'bg-slate-100 text-slate-600 ring-1 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700'
      }`}
      {...props}
    >
      {children}
    </button>
  );
}
