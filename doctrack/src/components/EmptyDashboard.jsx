import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSettings } from '../db.js';
import { currentAccount } from '../lib/onedrive.js';
import { LAST_SYNC_SETTING, runSync } from '../lib/cloudsync.js';
import { IMPORTS_EPOCH } from '../lib/sync.js';
import { Banner, Button, EmptyState, Spinner } from '../components/ui.jsx';

/**
 * The two outside facts this screen turns on, behind a seam.
 *
 * Same reasoning as lib/driveimport.js: whether a device is signed in and what
 * a sync does are the whole logic here, and they should not be untestable
 * merely because the transport needs a Microsoft account.
 */
export const signals = {
  account: (clientId) => currentAccount(clientId),
  sync: (settings) => runSync(settings),
};

/**
 * An empty dashboard, and why.
 *
 * A second device with nothing on it looks exactly like a brand-new install,
 * and the advice for the two is opposite: one should photograph its documents,
 * the other should not touch anything and wait for them to arrive. Telling
 * everybody to "upload documents" is how a phone ends up with a second, worse
 * copy of the household.
 *
 * So it works out which case this is and says so. Four states, and each one has
 * exactly one thing to press.
 */
export default function EmptyDashboard() {
  const [state, setState] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const settings = await getSettings();
      const clientId = settings.onedrive_client_id;
      const account = clientId ? await signals.account(clientId).catch(() => null) : null;
      if (!alive) return;
      setState({
        settings,
        clientId,
        account,
        lastSync: settings[LAST_SYNC_SETTING] ?? null,
        clearedAt: settings[IMPORTS_EPOCH] ?? null,
      });
    })();
    return () => { alive = false; };
  }, []);

  if (state === null) {
    return (
      <div className="flex justify-center py-16 text-slate-400"><Spinner className="size-7" /></div>
    );
  }

  const { clientId, account, lastSync, clearedAt } = state;

  // ------------------------------------------------- just started again
  //
  // An empty screen right after "Clear everything" is not a problem to
  // diagnose, it is the thing that was asked for — and the advice for it is the
  // opposite of every case below: read the folder again, do not go looking for
  // a device that has not synced. Only counted for a day, because a reset last
  // month explains nothing about why the app is empty today.
  const justCleared =
    clearedAt && Date.now() - new Date(clearedAt).getTime() < 24 * 60 * 60 * 1000;
  if (justCleared) {
    return (
      <EmptyState icon="🧹" title="Cleared, and ready to start again">
        <p>
          Everything was removed on purpose, and the record of which OneDrive files had been
          read went with it — so reading your folder again will pick up all of them from
          scratch.
        </p>
        <Button as="link" to="/onedrive" className="mt-4">Read my OneDrive folder</Button>
        <Link
          to="/upload"
          className="mt-3 block text-[14px] font-medium text-slate-500 underline-offset-4 hover:underline dark:text-slate-400"
        >
          Or upload documents from this device
        </Link>
      </EmptyState>
    );
  }

  // -------------------------------------------------- never set up at all
  if (!clientId) {
    return (
      <EmptyState icon="📄" title="Nothing on file yet">
        <p>
          Upload photos or PDFs of your documents and DocTrack will read them, sort them by
          person and set the reminders for you.
        </p>
        <Button as="link" to="/upload" className="mt-4">Upload documents</Button>
        <p className="mt-4 text-[13px] text-slate-500 dark:text-slate-400">
          Already have DocTrack set up on another device? Do not start again here — bring the
          documents across instead.
        </p>
        <Link
          to="/settings"
          className="mt-2 block text-[14px] font-semibold text-indigo-600 underline-offset-4 hover:underline dark:text-indigo-400"
        >
          Connect this device to the other one
        </Link>
        <Link
          to="/members/new"
          className="mt-3 block text-[14px] font-medium text-slate-500 underline-offset-4 hover:underline dark:text-slate-400"
        >
          Or add a person by hand
        </Link>
      </EmptyState>
    );
  }

  // ------------------------------------- set up, but not connected here yet
  if (!account) {
    return (
      <EmptyState icon="🔌" title="This device is not connected yet">
        <p>
          OneDrive is set up, but this device has not signed in — so none of your documents have
          arrived. Nothing is lost; they are still on your other device.
        </p>
        <Button as="link" to="/settings" className="mt-4">Connect OneDrive</Button>
        <Banner tone="info" className="mt-4 text-left">
          <p className="font-semibold">If signing in on this phone will not finish</p>
          <p className="mt-1">
            Microsoft's passkey screen gets stuck when the passkey lives on another device.
            You can skip it entirely: on your laptop go to Settings → Export a backup file,
            send the file to yourself, open it on this phone, then Settings → Restore from a
            backup.
          </p>
        </Banner>
      </EmptyState>
    );
  }

  // ------------------------------------------- connected, nothing pulled yet
  const primed = Boolean(lastSync);
  return (
    <EmptyState icon={primed ? '🗂️' : '☁️'} title={primed ? 'The shared folder is empty' : 'Nothing has arrived yet'}>
      <p>
        Connected as {account.username}.{' '}
        {primed
          ? 'This device has synced, and there was nothing in the shared folder to bring down. That usually means the other device has not sent its documents up yet — open DocTrack there and let it sync.'
          : 'This device has not finished a sync yet. Run one now and your documents will come down.'}
      </p>

      {result ? (
        <Banner tone={result.tone} className="mt-4 text-left">{result.text}</Banner>
      ) : null}

      <Button
        className="mt-4"
        disabled={syncing}
        onClick={async () => {
          setSyncing(true);
          setResult(null);
          try {
            const outcome = await signals.sync(state.settings);
            setResult(
              outcome.pulled > 0
                ? { tone: 'ok', text: `Brought down ${outcome.pulled} record${outcome.pulled === 1 ? '' : 's'}.` }
                : { tone: 'info', text: 'Sync finished, but the shared folder had nothing in it yet.' },
            );
          } catch (error) {
            setResult({ tone: 'error', text: error?.message ?? 'The sync could not finish.' });
          } finally {
            setSyncing(false);
          }
        }}
      >
        {syncing ? <Spinner /> : null}
        {syncing ? 'Syncing…' : 'Sync now'}
      </Button>

      <p className="mt-4 text-[13px] text-slate-500 dark:text-slate-400">
        Only add documents here if this is where they live. Photographing them again on a second
        device makes a duplicate, not a copy.
      </p>
    </EmptyState>
  );
}
