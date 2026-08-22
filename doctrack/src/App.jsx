import { useEffect } from 'react';
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
import { getSettings } from './db.js';
import { currentAccount } from './lib/onedrive.js';
import { runSync } from './lib/cloudsync.js';

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
  // The reliable reminder trigger: every launch, and every time the app comes
  // back to the foreground. Background sync, where it exists, is a bonus on top.
  useEffect(() => {
    checkRemindersNow();
    syncQuietly();

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      checkRemindersNow();
      syncQuietly();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return (
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
  );
}
