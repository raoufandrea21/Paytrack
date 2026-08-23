import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { clearEverything, getSettings, setSetting } from '../db.js';
import { backupFilename, buildBackup, restoreBackup } from '../lib/backup.js';
import {
  DEFAULT_EXTRACTION_MODE,
  EXTRACTION_MODES,
} from '../lib/constants.js';
import { EXTRACTION_MODEL } from '../../shared/extraction-spec.js';
import {
  checkRemindersNow,
  enableBackgroundSync,
  notificationPermission,
  requestNotificationPermission,
} from '../lib/notifications.js';
import { dueReminders } from '../lib/reminders.js';
import { RULES_SETTING, describeRules } from '../lib/reminderrules.js';
import {
  ACCOUNT_KINDS,
  accountKind,
  clearSignInProblem,
  currentAccount,
  driveQuota,
  resetConnection,
  setAccountKind,
  signIn,
  signInProblem,
  signOut,
} from '../lib/onedrive.js';
import { LAST_SYNC_SETTING, SHARED_COUNT_SETTING, runSync } from '../lib/cloudsync.js';
import { BUILD_ID, BUILT_AT, checkForUpdate } from '../lib/version.js';
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
  const [syncFailure, setSyncFailure] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [appUpdate, setAppUpdate] = useState(null);
  const [kind, setKind] = useState(accountKind);
  const [problem, setProblem] = useState(null);
  const importRef = useRef(null);
  const [pending, setPending] = useState(null);
  const [wiping, setWiping] = useState(false);
  const [wiped, setWiped] = useState(null);

  useEffect(() => {
    getSettings().then((loaded) => {
      setSettings(loaded);
      setApiKey(loaded.anthropic_api_key ?? '');
      setEndpoint(loaded.proxy_endpoint ?? '');
      setClientId(loaded.onedrive_client_id ?? '');
      if (loaded.onedrive_client_id) {
        currentAccount(loaded.onedrive_client_id).then((found) => {
          setAccount(found);
          // Only worth raising when they are not, in fact, connected.
          setProblem(signInProblem({ signedIn: Boolean(found) }));
        });
      }
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
            {describeRules(settings?.[RULES_SETTING])}. The check runs every time you open the app, and in the
            background where the browser allows it.
          </p>

          <Button as="link" to="/reminders" variant="secondary" className="mb-3 w-full">
            Choose when to be reminded
          </Button>

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

          {problem ? (
            <Banner tone="warn" className="mt-3">
              <p>{problem.message}</p>
              {problem.detail ? (
                <p className="mt-1 font-mono text-[12px] break-all opacity-80">{problem.detail}</p>
              ) : null}
            </Banner>
          ) : null}

          {account ? null : (
            <Field
              label="What kind of Microsoft account?"
              htmlFor="account-kind"
              hint={ACCOUNT_KINDS.find((k) => k.id === kind)?.hint}
            >
              <Select
                id="account-kind"
                value={kind}
                onChange={(e) => {
                  setAccountKind(e.target.value);
                  setKind(e.target.value);
                  clearSignInProblem();
                  setProblem(null);
                  setSync(null);
                }}
              >
                {ACCOUNT_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>{k.label}</option>
                ))}
              </Select>
            </Field>
          )}

          <div className="mt-3 flex flex-col gap-2">
            {account ? (
              <>
                <Banner tone="info">
                  <p>Connected as {account.username}.</p>
                  {/* The two numbers that settle an argument between devices:
                      when this one last synced, and how much was in the shared
                      folder when it did. A laptop saying sixty and a phone
                      saying none locates the problem immediately. */}
                  <p className="mt-1 text-[13px]">{syncStanding(settings)}</p>
                </Banner>
                <Button
                  disabled={syncing}
                  onClick={async () => {
                    setSyncing(true);
                    setSyncFailure(null);
                    setSync('Starting…');
                    try {
                      const result = await runSync(
                        { ...settings, onedrive_client_id: clientId.trim() },
                        { onStatus: (text) => setSync(text ?? 'Finishing…') },
                      );
                      setSync(describeSync(result));
                    } catch (error) {
                      setSync(null);
                      // A refusal that names storage is worth a number: "read
                      // only" means nothing until you see the drive is full.
                      const quota = /read-only|out of space/i.test(error?.message ?? '')
                        ? await driveQuota(clientId.trim())
                        : null;
                      setSyncFailure({
                        message: error?.message ?? 'The sync did not finish.',
                        detail: error?.detail ?? null,
                        quota,
                      });
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
                    setProblem(null);
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

            {syncFailure ? (
              <Banner tone="warn" title="Sync could not finish">
                <p>{syncFailure.message}</p>
                {syncFailure.quota ? (
                  <p className="mt-1 font-semibold">
                    OneDrive is using {formatBytes(syncFailure.quota.used)} of{' '}
                    {formatBytes(syncFailure.quota.total)}
                    {syncFailure.quota.state === 'exceeded' ? ' — over the limit.' : '.'}
                  </p>
                ) : null}
                {/* Reading is unaffected by a read-only drive, so when that is
                    what went wrong, say the thing that still works. */}
                {/read-only|out of space/i.test(syncFailure.message) ? (
                  <p className="mt-1">
                    Reading the documents already in your OneDrive still works — that only ever
                    reads.{' '}
                    <Link to="/onedrive" className="font-semibold underline underline-offset-2">
                      Read my OneDrive
                    </Link>
                    .
                  </p>
                ) : null}
                <p className="mt-1">
                  Backup and transfer below still moves everything between your devices.
                </p>
                {syncFailure.detail ? (
                  <p className="mt-1 font-mono text-[12px] break-all opacity-70">
                    {syncFailure.detail}
                  </p>
                ) : null}
              </Banner>
            ) : null}

            {/* Sign-in can wedge on a stuck "interaction in progress" flag left
                by an attempt that was abandoned halfway. This is the way out. */}
            <button
              type="button"
              className="min-h-11 text-[13px] text-slate-500 underline underline-offset-4 dark:text-slate-400"
              onClick={() => {
                resetConnection(clientId.trim());
                clearSignInProblem();
                setAccount(null);
                setProblem(null);
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

          {account ? (
            <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800">
              <p className="text-[14px] text-slate-600 dark:text-slate-400">
                Already keep your documents in a OneDrive folder? DocTrack can read them where they
                are and set the reminders, without moving or changing anything.
              </p>
              <Button as="link" to="/onedrive" variant="secondary" className="mt-2 w-full">
                Read the documents already in my OneDrive
              </Button>
            </div>
          ) : null}
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

        <Section title="Start again">
          <p className="text-[14px] text-slate-600 dark:text-slate-400">
            Removes every person and every document, and forgets which OneDrive files have been
            read — so the next read of your folder starts from nothing. Your settings stay:
            the Microsoft app ID, the folder, the reminder rules.
          </p>
          <Banner tone="warn" className="mt-3">
            This is not only this device. The deletion travels with the next sync, so your other
            devices clear too. <span className="font-semibold">Export a backup first</span> if
            there is any chance you will want it back.
          </Banner>

          {wiped ? (
            <Banner tone="info" className="mt-3">
              Cleared {wiped.documents} document{wiped.documents === 1 ? '' : 's'} and{' '}
              {wiped.members} {wiped.members === 1 ? 'person' : 'people'}. Read your OneDrive
              folder again whenever you are ready.
            </Banner>
          ) : null}

          <Button
            variant={wiping ? 'danger' : 'ghost'}
            className="mt-3 w-full"
            onClick={async () => {
              if (!wiping) {
                setWiping(true);
                return;
              }
              setWiped(await clearEverything());
              setWiping(false);
            }}
          >
            {wiping ? 'Tap again to clear everything' : 'Clear everything and start again'}
          </Button>
          {wiping ? (
            <button
              type="button"
              className="mt-2 min-h-11 w-full text-[13px] font-semibold text-slate-500 dark:text-slate-400"
              onClick={() => setWiping(false)}
            >
              Cancel
            </button>
          ) : null}
        </Section>

        <Section title="This app">
          <p className="text-[14px] text-slate-600 dark:text-slate-400">
            Version <span className="font-mono text-[13px]">{BUILD_ID}</span>
            {BUILT_AT ? ` · built ${builtOn(BUILT_AT)}` : ''}
          </p>
          <p className="text-[14px] text-slate-600 dark:text-slate-400">
            Served from <span className="font-mono text-[13px]">{window.location.host}</span>
          </p>
          <p className="mt-1 text-[13px] text-slate-500 dark:text-slate-400">
            Worth checking if something that was fixed still looks broken — an app added to the
            home screen keeps running the copy it saved until it is told to look for a newer one.
            If the address above is not the one you normally use, this copy was saved from a
            one-off preview link and will never update: open the usual address and add that to
            your home screen instead.
          </p>
          <Button
            variant="secondary"
            className="mt-3 w-full"
            disabled={appUpdate === 'checking'}
            onClick={async () => {
              setAppUpdate('checking');
              setAppUpdate(await checkForUpdate());
            }}
          >
            {appUpdate === 'checking' ? <Spinner /> : null}
            Check for updates
          </Button>
          {appUpdate && appUpdate !== 'checking' ? (
            <>
              <p className="mt-2 text-[13px] text-slate-600 dark:text-slate-300">
                {UPDATE_WORDING[appUpdate] ?? UPDATE_WORDING.unsupported}
              </p>
              {appUpdate === 'ready' ? (
                <Button className="mt-2 w-full" onClick={() => window.location.reload()}>
                  Reload now
                </Button>
              ) : null}
            </>
          ) : null}
        </Section>

        {savedAt ? (
          <p className="text-center text-[13px] text-emerald-600 dark:text-emerald-400">Saved.</p>
        ) : null}
      </div>
    </Screen>
  );
}

/** Storage sizes as a person reads them, not as a computer stores them. */
function formatBytes(bytes) {
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** "Last synced 5 minutes ago · 62 documents in the shared folder." */
function syncStanding(settings) {
  const at = settings?.[LAST_SYNC_SETTING];
  if (!at) return 'This device has not finished a sync yet.';

  const shared = settings?.[SHARED_COUNT_SETTING];
  const minutes = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000));
  const when =
    minutes < 1 ? 'just now'
      : minutes < 60 ? `${minutes} minute${minutes === 1 ? '' : 's'} ago`
        : minutes < 60 * 24 ? `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? '' : 's'} ago`
          : `${Math.round(minutes / 1440)} day${Math.round(minutes / 1440) === 1 ? '' : 's'} ago`;

  const count = Number.isFinite(Number(shared))
    ? ` · ${shared} document${Number(shared) === 1 ? '' : 's'} in the shared folder`
    : '';
  return `Last synced ${when}${count}.`;
}

const UPDATE_WORDING = {
  current: 'You already have the newest version.',
  ready: 'A newer version is ready.',
  downloading: 'A newer version is downloading. It will be ready shortly.',
  failed: 'A newer version could not be downloaded — check the connection and try again.',
  unsupported: 'This browser cannot check by itself. Reloading the page picks up a new version.',
};

/** A build stamp is only useful if a person can compare it to "today". */
function builtOn(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'an unknown date';
  return at.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
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

/**
 * What the sync actually did, in a sentence. Quiet runs say so plainly rather
 * than reciting four zeroes, and anything that did not transfer is named — a
 * silent partial sync is how someone ends up trusting a phone that is behind.
 */
function describeSync(result) {
  const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const parts = [];
  if (result.pulled) parts.push(`${count(result.pulled, 'record')} came down`);
  if (result.pushed) parts.push(`${count(result.pushed, 'record')} went up`);
  if (result.photos.downloaded) parts.push(`${count(result.photos.downloaded, 'photo')} fetched`);
  if (result.photos.uploaded) parts.push(`${count(result.photos.uploaded, 'photo')} uploaded`);
  if (result.inbox.filed) parts.push(`${count(result.inbox.filed, 'document')} filed from the Inbox`);
  if (result.inbox.skipped) parts.push(`${count(result.inbox.skipped, 'Inbox file')} skipped`);

  const trouble = [];
  if (result.photos.failed) {
    trouble.push(`${count(result.photos.failed, 'photo')} would not transfer — the next sync tries again.`);
  }
  if (result.inbox.error) trouble.push(`The Inbox could not be read: ${result.inbox.error}`);

  const summary = parts.length ? `Synced. ${parts.join(', ')}.` : 'Up to date — nothing to sync.';
  return [summary, ...trouble].join(' ');
}
