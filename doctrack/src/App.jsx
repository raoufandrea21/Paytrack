import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Dashboard from './screens/Dashboard.jsx';
import DocumentEditor from './screens/DocumentEditor.jsx';
import DocumentDetail from './screens/DocumentDetail.jsx';
import MemberForm from './screens/MemberForm.jsx';
import Archive from './screens/Archive.jsx';
import BulkAdd from './screens/BulkAdd.jsx';
import Library from './screens/Library.jsx';
import Review from './screens/Review.jsx';
import Settings from './screens/Settings.jsx';
import { checkRemindersNow } from './lib/notifications.js';
import { DATABASE_STATE, getSettings, openDatabase } from './db.js';
import DatabaseError from './components/DatabaseError.jsx';
import { currentAccount } from './lib/onedrive.js';
import { runSync } from './lib/cloudsync.js';
import { onUpdateReady } from './lib/version.js';

/** Don't hammer OneDrive when the app is being opened and closed repeatedly. */
const SYNC_INTERVAL = 2 * 60 * 1000;
let lastSyncAt = 0;
let syncInFlight = false;

/**
 * Quiet background sync. Failures are logged and dropped on purpose: the app
 * works entirely offline, so a sync that cannot reach OneDrive is a non-event
 * and should never interrupt someone looking up a passport. The Settings screen
 * is where sync reports for itself.
 */
async function syncQuietly() {
  if (syncInFlight || Date.now() - lastSyncAt < SYNC_INTERVAL) return;
  try {
    const settings = await getSettings();
    if (!settings.onedrive_client_id) return;
    if (!(await currentAccount(settings.onedrive_client_id))) return;

    syncInFlight = true;
    lastSyncAt = Date.now();
    await runSync(settings);
  } catch (error) {
    console.warn('[doctrack] background sync skipped', error);
  } finally {
    syncInFlight = false;
  }
}

export default function App() {
  // Dexie opens lazily, so a failed or blocked upgrade would otherwise show as
  // a spinner that never resolves. Gate the app on a definite answer.
  const [database, setDatabase] = useState({ state: DATABASE_STATE.OPENING, error: null });
  const [newBuild, setNewBuild] = useState(false);

  useEffect(() => {
    openDatabase().then(setDatabase);
  }, []);

  // A new build that arrives while the app is being used cannot reload the page
  // out from under a half-typed form, so it says so instead and waits to be told.
  useEffect(() => onUpdateReady(() => setNewBuild(true)), []);

  // The reliable reminder trigger: every launch, and every time the app comes
  // back to the foreground. Background sync, where it exists, is a bonus on top.
  useEffect(() => {
    if (database.state !== DATABASE_STATE.READY) return undefined;
    checkRemindersNow();
    syncQuietly();

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      checkRemindersNow();
      syncQuietly();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [database.state]);

  // Rendered above every branch below, including the ones that report a
  // failure — a database that will not open is exactly the sort of thing a
  // newer build might have fixed, and that screen is where someone is stuck.
  const banner = newBuild ? (
    <>
      <UpdateBanner />
      {/* Holds the space the fixed banner covers, so nothing is hidden behind
          it while the page is at the top. */}
      <div className="h-12" aria-hidden="true" />
    </>
  ) : null;

  if (database.state === DATABASE_STATE.OPENING) {
    return (
      <>
        {banner}
        <div className="flex min-h-full items-center justify-center p-8 text-slate-400">
          <span className="text-[15px]">Opening your documents…</span>
        </div>
      </>
    );
  }

  if (database.state !== DATABASE_STATE.READY) {
    return (
      <>
        {banner}
        <DatabaseError state={database.state} error={database.error} />
      </>
    );
  }

  return (
    <>
      {banner}
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/members/new" element={<MemberForm mode="add" />} />
        <Route path="/members/:id/edit" element={<MemberForm mode="edit" />} />
        <Route path="/upload" element={<BulkAdd />} />
        <Route path="/library" element={<Library />} />
        <Route path="/review" element={<Review />} />
        <Route path="/documents/new" element={<DocumentEditor mode="add" />} />
        <Route path="/documents/:id" element={<DocumentDetail />} />
        <Route path="/documents/:id/edit" element={<DocumentEditor mode="edit" />} />
        <Route path="/documents/:id/renew" element={<DocumentEditor mode="renew" />} />
        <Route path="/archive" element={<Archive />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

/**
 * Sits above everything until it is dealt with. Running an old build is
 * invisible from the inside, so this is the only warning anybody gets.
 */
function UpdateBanner() {
  return (
    <div
      className="fixed inset-x-0 top-0 z-50 flex items-center gap-3 bg-indigo-600 px-3.5 py-2.5 text-white shadow-lg"
      style={{ paddingTop: 'calc(0.625rem + var(--safe-top))' }}
    >
      <span className="min-w-0 flex-1 text-[14px] font-semibold">
        A newer version of DocTrack is ready.
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="shrink-0 rounded-lg bg-white/15 px-3 py-1.5 text-[14px] font-bold hover:bg-white/25"
      >
        Reload
      </button>
    </div>
  );
}
