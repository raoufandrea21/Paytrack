import { useEffect, useState } from 'react';
import { getSettings, setSetting } from '../db.js';
import { EXTRACTION_MODES, REMINDER_THRESHOLDS } from '../lib/constants.js';
import { EXTRACTION_MODEL } from '../../shared/extraction-spec.js';
import {
  checkRemindersNow,
  enableBackgroundSync,
  notificationPermission,
  requestNotificationPermission,
} from '../lib/notifications.js';
import { dueReminders } from '../lib/reminders.js';
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
  const [pending, setPending] = useState(null);

  useEffect(() => {
    getSettings().then((loaded) => {
      setSettings(loaded);
      setApiKey(loaded.anthropic_api_key ?? '');
      setEndpoint(loaded.proxy_endpoint ?? '');
    });
    dueReminders().then((due) => setPending(due.length));
  }, []);

  const mode = settings?.extraction_mode ?? EXTRACTION_MODES.PROXY;

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

        <Section title="Auto-fill from photos">
          <p className="mb-3 text-[14px] text-slate-600 dark:text-slate-400">
            Photos are sent to Anthropic's API ({EXTRACTION_MODEL}) to read the fields. Everything
            else — the photos themselves, the records, the history — never leaves this device.
          </p>

          <Field label="How to reach the API" htmlFor="mode">
            <Select
              id="mode"
              value={mode}
              onChange={(e) => update('extraction_mode', e.target.value)}
            >
              <option value={EXTRACTION_MODES.PROXY}>Through a server endpoint (recommended)</option>
              <option value={EXTRACTION_MODES.DIRECT}>Straight from this device</option>
              <option value={EXTRACTION_MODES.OFF}>Off — type everything myself</option>
            </Select>
          </Field>

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

        <Section title="Your data">
          <p className="text-[14px] text-slate-600 dark:text-slate-400">
            Members, documents and photos are stored in IndexedDB on this device only. There is no
            account, no server copy and no sync. Clearing this site's browser data deletes
            everything — and uninstalling the app can do that too, so keep the original documents.
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
