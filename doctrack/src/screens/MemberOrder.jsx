import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSetting, setSetting } from '../db.js';
import { ORDER_SETTING, applyOrder, hasOrder, moveItem } from '../lib/memberorder.js';
import Screen from '../components/Screen.jsx';
import { Banner, Button, Card, Spinner } from '../components/ui.jsx';

const ROW = 60; // px, and every row is exactly this tall — the drag depends on it.

/**
 * Put the family in the order you want to see them.
 *
 * A screen of its own rather than dragging on the dashboard, because on a phone
 * a press-and-move on a card you were only trying to tap is a misfire waiting to
 * happen. Here every row is the same height and does one thing, which is also
 * what makes the drag arithmetic honest.
 *
 * Pointer events, not HTML5 drag-and-drop: the latter does not fire on touch at
 * all, and this is a phone-first app. Up and down buttons sit beside the grip
 * for anybody who would rather not drag, or is using a keyboard.
 */
export default function MemberOrder() {
  const navigate = useNavigate();
  const members = useLiveQuery(() => db.members.orderBy('created_at').toArray(), [], null);

  const [order, setOrder] = useState(null); // array of uids
  const [saved, setSaved] = useState(false);
  const [dragging, setDragging] = useState(null); // { uid, from, at, offset }
  const listRef = useRef(null);

  useEffect(() => {
    if (!members) return;
    getSetting(ORDER_SETTING, null).then((stored) => {
      setOrder(applyOrder(members, stored).map((m) => m.uid));
    });
  }, [members]);

  const commit = async (next) => {
    setOrder(next);
    await setSetting(ORDER_SETTING, next);
    setSaved(true);
  };

  if (!members || order === null) {
    return (
      <Screen title="Order of people" back="/">
        <div className="flex justify-center py-16 text-slate-400"><Spinner className="size-7" /></div>
      </Screen>
    );
  }

  const byUid = new Map(members.map((m) => [m.uid, m]));
  const rows = order.map((uid) => byUid.get(uid)).filter(Boolean);

  // Where each row is drawn: everything below the dragged row shuffles up or
  // down to open the gap, so the list shows the result before you let go.
  const positionOf = (index) => {
    if (!dragging) return index * ROW;
    if (index === dragging.from) return dragging.at * ROW;
    let slot = index;
    if (dragging.from < index && index <= dragging.at) slot = index - 1;
    else if (dragging.at <= index && index < dragging.from) slot = index + 1;
    return slot * ROW;
  };

  const startDrag = (event, index) => {
    const box = listRef.current?.getBoundingClientRect();
    if (!box) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging({ from: index, at: index, offset: event.clientY - box.top - index * ROW });
  };

  const moveDrag = (event) => {
    if (!dragging) return;
    const box = listRef.current?.getBoundingClientRect();
    if (!box) return;
    const y = event.clientY - box.top - dragging.offset;
    const at = Math.max(0, Math.min(rows.length - 1, Math.round(y / ROW)));
    if (at !== dragging.at) setDragging({ ...dragging, at });
  };

  const endDrag = () => {
    if (!dragging) return;
    const { from, at } = dragging;
    setDragging(null);
    if (from !== at) commit(moveItem(order, from, at));
  };

  return (
    <Screen
      title="Order of people"
      subtitle="Drag to arrange. Saved as you go."
      back="/"
      footer={<Button className="w-full" onClick={() => navigate('/')}>Done</Button>}
    >
      <div className="space-y-3 pb-4">
        {saved ? <Banner tone="ok">Saved. This order is used on both your devices.</Banner> : null}

        <p className="px-1 text-[14px] text-slate-600 dark:text-slate-400">
          Hold the ⠿ handle and drag, or use the arrows. Anybody added later joins the
          bottom of the list.
        </p>

        <Card className="overflow-hidden p-1.5">
          <div
            ref={listRef}
            className="relative"
            style={{ height: rows.length * ROW }}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {rows.map((member, index) => (
              <div
                key={member.uid}
                className={`absolute inset-x-0 flex items-center gap-2 rounded-xl px-1 ${
                  dragging?.from === index
                    ? 'z-10 bg-indigo-50 shadow-lg ring-1 ring-indigo-300 dark:bg-indigo-950 dark:ring-indigo-800'
                    : 'transition-transform duration-150'
                }`}
                style={{ height: ROW, transform: `translateY(${positionOf(index)}px)` }}
              >
                <button
                  type="button"
                  onPointerDown={(event) => startDrag(event, index)}
                  aria-label={`Drag ${member.name}`}
                  className="flex size-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-slate-400 active:cursor-grabbing dark:text-slate-500"
                >
                  <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden="true">
                    <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
                    <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
                    <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
                  </svg>
                </button>

                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[12px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                  {initials(member.name)}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold">{member.name}</span>
                  <span className="block truncate text-[12px] text-slate-500 dark:text-slate-400">
                    {member.relation}
                  </span>
                </span>

                <Nudge
                  label={`Move ${member.name} up`}
                  disabled={index === 0}
                  onClick={() => commit(moveItem(order, index, index - 1))}
                  path="M6 15l6-6 6 6"
                />
                <Nudge
                  label={`Move ${member.name} down`}
                  disabled={index === rows.length - 1}
                  onClick={() => commit(moveItem(order, index, index + 1))}
                  path="M6 9l6 6 6-6"
                />
              </div>
            ))}
          </div>
        </Card>

        {hasOrder(order, members) ? (
          <button
            type="button"
            onClick={async () => {
              await setSetting(ORDER_SETTING, []);
              setOrder(members.map((m) => m.uid));
              setSaved(true);
            }}
            className="min-h-11 w-full text-[14px] font-semibold text-slate-500 underline-offset-4 hover:underline dark:text-slate-400"
          >
            Forget my order — sort by what needs renewing
          </button>
        ) : null}
      </div>
    </Screen>
  );
}

function Nudge({ label, disabled, onClick, path }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-10 shrink-0 items-center justify-center rounded-lg text-slate-500 disabled:opacity-25 dark:text-slate-400"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </button>
  );
}

function initials(name) {
  return String(name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
