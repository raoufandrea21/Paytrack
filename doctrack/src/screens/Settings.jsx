import { useEffect, useRef, useState } from 'react';
import { getSettings, setSetting } from '../db.js';
import { backupFilename, buildBackup, restoreBackup } from '../lib/backup.js';
import {
  DEFAULT_EXTRACTION_MODE,
  EXTRACTION_MODES,
  REMINDER_THRESHOLDS,
} from '../lib/constants.js';
import { EXTRACTION_MODEL } from '../../shared/extraction-spec.js';
import {
  checkRemindersNow,
  enableBackgroundSync,
  notificationPermission,
  requestNotificationPermission,
} from '../lib/notifications.js';
import { dueReminders } from '../lib/reminders.js';
import { currentAccount, resetConnection, signIn, signOut } from '../lib/onedrive.js';
import { runSync } from '../lib/cloudsync.js';
import Screen from '../components/Screen.jsx';
import { Banner, Button, Card, Field, Input, Select, Spinner } from '../components/ui.jsx';

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [permission, setPermission] = useState(notificationPermission());
  const [background, setBackground] = useState(null);
  const [checkResult, setCheckResult] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [transfer, setTransfer] = useState(null);
  const [clientId, setClientId] = useState('');
  const [account, setAccount] = useState(null);
  const [sync, setSync] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState(false);
  const importRef = useRef(null);
  const [pending, setPending] = useState(null);

  useEffect(() => {
    getSettings().then((loaded) => {
      setSettings(loaded);
      setApiKey(loaded.anthropic_api_key ?? '');
      setEndpoint(loaded.proxy_endpoint ?? '');
      setClientId(loaded.onedrive_client_id ?? '');
      if (loaded.onedrive_client_id) currentAccount(loaded.onedrive_client_id).then(setAccount);
    });
    dueReminders().then((due) => setPending(due.length));
  }, []);

  const mode = settings?.extraction_mode ?? DEFAULT_EXTRACTION_MODE;

  async function update(key, value) {
    await setSetting(key, value);
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSavedAt(Date.now());
  }

  if (!settings) {
    return (
      <Screen title="Settings" back="/">
        <div className="flex justify-center py-16 text-slate-400"><Spinner className="size-7" /></div>
      </Screen>
    );
  }

  return (
    <Screen title="Settings" back="/">
      <div className="space-y-4 pb-6">
        <Section title="Reminders">
          <p className="mb-3 text-[14px] text-slate-600 dark:text-slate-400">
            DocTrack notifies you {REMINDER_THRESHOLDS.slice().reverse().join(', ')} days before
            each expiry — once per document per milestone. The check runs every time you open the
            app, and in the background where the browser allows it.
          </p>

          {permission === 'unsupported' ? (
            <Banner tone="info">This browser does not support notifications. The dashboard still shows everything.</Banner>
          ) : permission === 'granted' ? (
            <Banner tone="info">
              Notifications are on.{' '}
              {pending === null ? '' : pending === 0 ? 'Nothing is due right now.' : `${pending} reminder${pending === 1 ? '' : 's'} pending.`}
            </Banner>
          ) : permission === 'denied' ? (
            <Banner tone="warn">
              Notifications are blocked for this site. Re-enable them in your browser's site settings.
            </Banner>
          ) : (
            <Button
              className="w-full"
              onClick={async () => {
                const result = await requestNotificationPermission();
                setPermission(result);
                if (result === 'granted') {
                  setBackground(await enableBackgroundSync());
                  await checkRemindersNow();
                }
              }}
            >
              Turn on reminders
            </Button>
          )}

          {permission === 'granted' ? (
            <div className="mt-3 flex flex-col gap-2">
              <Button
                variant="secondary"
                onClick={async () => {
                  const result = await checkRemindersNow();
                  setPending((await dueReminders()).length);
                  setCheckResult(
                    result.shown > 0
                      ? `Sent ${result.shown} reminder${result.shown === 1 ? '' : 's'}.`
                      : result.due.length > 0
                        ? 'Everything due has already been sent once.'
                        : 'Nothing is due right now.',
                  );
                }}
              >
                Run the check now
              </Button>
              <Button
                variant="ghost"
                onClick={async () => setBackground(await enableBackgroundSync())}
              >
                Enable background checks
              </Button>
              {checkResult ? (
                <p className="text-[13px] text-slate-600 dark:text-slate-300">{checkResult}</p>
              ) : null}
              {background ? (
                <p className="text-[13px] text-slate-500 dark:text-slate-400">
                  {background.enabled
                    ? 'Background checks registered.'
                    : `Background checks are not available here (${background.reason}). Opening the app still runs the check.`}
                </p>
              ) : null}
            </div>
          ) : null}
        </Section>

        <Section title="Reading documents">
          <Field label="How documents are read" htmlFor="mode">
            <Select
              id="mode"
              value={mode}
              onChange={(e) => update('extraction_mode', e.target.value)}
            >
              <option value={EXTRACTION_MODES.LOCAL}>On this device — free</option>
              <option value={EXTRACTION_MODES.PROXY}>Claude, through a server endpoint</option>
              <option value={EXTRACTION_MODES.DIRECT}>Claude, straight from this device</option>
              <option value={EXTRACTION_MODES.OFF}>Off — type everything myself</option>
            </Select>
          </Field>

          {mode === EXTRACTION_MODES.LOCAL ? (
            <div className="mt-3 space-y-3">
              <p className="text-[14px] text-slate-600 dark:text-slate-400">
                Text recognition runs inside this browser. No account, no API key, nothing to pay,
                and the photo never leaves the device — not even to be read.
              </p>
              <Banner tone="info">
                The first document takes about a minute while the reader downloads itself (~5 MB).
                After that it is quick, and it works offline.
              </Banner>
              <p className="text-[13px] text-slate-500 dark:text-slate-400">
                PDFs with a text layer — most of what arrives by email — are read exactly, with
                no recognition involved. Photos and scanned PDFs go through text recognition, which
                reads printed English: enough for UAE and Cypriot documents, since the English side
                of a bilingual card carries every field. Less accurate than Claude, so expect more
                documents in "Needs checking".
              </p>
            </div>
          ) : null}

          {mode !== EXTRACTION_MODES.LOCAL && mode !== EXTRACTION_MODES.OFF ? (
            <p className="mt-3 text-[14px] text-slate-600 dark:text-slate-400">
              Documents are sent to Anthropic's API ({EXTRACTION_MODEL}) to be read — more accurate
              than the on-device reader, handles PDFs and Arabic, and costs roughly a penny per
              document. Everything else still stays on this device.
            </p>
          ) : null}

          {mode === EXTRACTION_MODES.PROXY ? (
            <div className="mt-3">
              <Field
                label="Endpoint"
                htmlFor="endpoint"
                hint="Leave blank for /api/extract, which npm run dev serves for you."
              >
                <Input
                  id="endpoint"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  onBlur={() => update('proxy_endpoint', endpoint.trim())}
                  placeholder="/api/extract"
                  inputMode="url"
                  autoComplete="off"
                />
              </Field>
              <p className="mt-2 text-[13px] text-slate-500 dark:text-slate-400">
                The key lives in <code className="font-mono">.env.local</code> on the server and is
                never sent to the browser.
              </p>
            </div>
          ) : null}

          {mode === EXTRACTION_MODES.DIRECT ? (
            <div className="mt-3">
              <Field label="Anthropic API key" htmlFor="key">
                <Input
                  id="key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onBlur={() => update('anthropic_api_key', apiKey.trim())}
                  placeholder="sk-ant-…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Banner tone="warn" className="mt-3">
                The key is stored in this browser's IndexedDB and sent from the page itself. That is
                fine for a personal device you control; do not use a key with wide access, and set a
                spend limit on it.
              </Banner>
            </div>
          ) : null}
        </Section>

        <Section title="Sync with OneDrive">
          <p className="mb-3 text-[14px] text-slate-600 dark:text-slate-400">
            Keeps this device and your others in step through a folder in your own OneDrive —
            <span className="font-mono text-[13px]"> Apps/DocTrack</span>. Anything you drop into
            its <span className="font-mono text-[13px]">Inbox</span> folder gets read and filed by
            itself, from any device.
          </p>

          <Field
            label="Microsoft app ID"
            htmlFor="client-id"
            hint="From the one-time Azure registration — see the README. Setup only, not a password."
          >
            <Input
              id="client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              onBlur={() => update('onedrive_client_id', clientId.trim())}
              placeholder="00000000-0000-0000-0000-000000000000"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <div className="mt-3 flex flex-col gap-2">
            {account ? (
              <>
                <Banner tone="info">Connected as {account.username}.</Banner>
                <Button
                  disabled={syncing}
                  onClick={async () => {
                    setSyncing(true);
                    setSync('Starting…');
                    try {
                      const result = await runSync(
                        { ...settings, onedrive_client_id: clientId.trim() },
                        { onStatus: (text) => setSync(text ?? 'Finishing…') },
                      );
                      setSync(
                        `Up to date. ${result.pulled} record${result.pulled === 1 ? '' : 's'} came down, `
                        + `${result.photos.downloaded} photo${result.photos.downloaded === 1 ? '' : 's'} fetched, `
                        + `${result.inbox.filed} filed from the Inbox.`,
                      );
                    } catch (error) {
                      setSync(`Sync failed: ${error?.message ?? 'unknown error'}`);
                    } finally {
                      setSyncing(false);
                    }
                  }}
                >
                  {syncing ? <Spinner /> : null}
                  Sync now
                </Button>
                <Button
                  variant="ghost"
                  disabled={syncing}
                  onClick={async () => {
                    await signOut(clientId.trim()).catch(() => {});
                    setAccount(null);
                    setSync(null);
                  }}
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button
                disabled={!clientId.trim() || syncing}
                onClick={async () => {
                  setSync('Taking you to Microsoft — you will come straight back…');
                  try {
                    // The page navigates away and returns with the result, so
                    // nothing here runs afterwards on the happy path.
                    await signIn(clientId.trim());
                  } catch (error) {
                    setSync(error?.message ?? 'Could not sign in.');
                  }
                }}
              >
                Connect OneDrive
              </Button>
            )}
            {sync ? (
              <p className="text-[13px] text-slate-600 dark:text-slate-300">{sync}</p>
            ) : null}

            {/* Sign-in can wedge on a stuck "interaction in progress" flag left
                by a popup that timed out. This is the way out. */}
            <button
              type="button"
              className="min-h-11 text-[13px] text-slate-500 underline underline-offset-4 dark:text-slate-400"
              onClick={() => {
                resetConnection(clientId.trim());
                setAccount(null);
                setSync('Connection reset. Try Connect OneDrive again.');
              }}
            >
              Reset connection
            </button>
          </div>

          <p className="mt-3 text-[13px] text-slate-500 dark:text-slate-400">
            DocTrack can only see its own folder — the permission it asks for does not reach the
            rest of your OneDrive. Your files stay in your Microsoft account; there is no server in
            between.
          </p>
        </Section>

        <Section title="Backup and transfer">
          <p className="mb-3 text-[14px] text-slate-600 dark:text-slate-400">
            Everything lives on this device, so a phone and a laptop each keep their own copy.
            Export a file here and import it on the other device to bring them together — and keep
            a copy somewhere safe, because clearing this site's browser data erases the lot.
          </p>

          <div className="flex flex-col gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setTransfer(null);
                try {
                  const backup = await buildBackup();
                  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = backupFilename();
                  link.click();
                  URL.revokeObjectURL(url);
                  setTransfer({
                    tone: 'info',
                    text: `Exported ${backup.documents.length} document${backup.documents.length === 1 ? '' : 's'} for ${backup.members.length} ${backup.members.length === 1 ? 'person' : 'people'}. Your API key is not included.`,
                  });
                } catch (error) {
                  setTransfer({ tone: 'error', text: error?.message ?? 'Could not build the backup.' });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Spinner /> : null}
              Export a backup file
            </Button>

            <Button variant="secondary" disabled={busy} onClick={() => importRef.current?.click()}>
              Import a backup file
            </Button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              tabIndex={-1}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                setBusy(true);
                setTransfer(null);
                try {
                  const result = await restoreBackup(JSON.parse(await file.text()));
                  setTransfer({
                    tone: 'info',
                    text: `Added ${result.documentsAdded} document${result.documentsAdded === 1 ? '' : 's'} and ${result.membersAdded} ${result.membersAdded === 1 ? 'person' : 'people'}. ${result.skipped} already here.`,
                  });
                } catch (error) {
                  setTransfer({ tone: 'error', text: error?.message ?? 'Could not read that file.' });
                } finally {
                  setBusy(false);
                }
              }}
            />
          </div>

          {transfer ? <Banner tone={transfer.tone} className="mt-3">{transfer.text}</Banner> : null}

          <p className="mt-3 text-[13px] text-slate-500 dark:text-slate-400">
            Importing adds to what is already here rather than replacing it, and skips anything it
            recognises — so running it twice is harmless.
          </p>
        </Section>

        {savedAt ? (
          <p className="text-center text-[13px] text-emerald-600 dark:text-emerald-400">Saved.</p>
        ) : null}
      </div>
    </Screen>
  );
}

function Section({ title, children }) {
  return (
    <Card className="p-4">
      <h2 className="mb-2 text-[13px] font-bold tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {title}
      </h2>
      {children}
    </Card>
  );
}
