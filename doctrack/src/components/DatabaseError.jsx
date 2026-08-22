import { useState } from 'react';
import { DATABASE_STATE, resetDatabase } from '../db.js';
import Screen from './Screen.jsx';
import { Banner, Button } from './ui.jsx';

/**
 * Shown when the local database will not open.
 *
 * Without this the app renders its normal shell and waits on queries that never
 * settle — a spinner with no explanation and no way out. Both causes have a
 * remedy the user can actually carry out, so both are named.
 */
export default function DatabaseError({ state, error }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const isBlocked = state === DATABASE_STATE.BLOCKED;

  return (
    <Screen title="DocTrack">
      <div className="space-y-4 pb-6">
        <Banner tone="error" title={isBlocked ? 'Another copy is in the way' : 'Storage could not be opened'}>
          {isBlocked ? (
            <p>
              DocTrack is open somewhere else on this device — another browser tab, or the app and
              the browser at the same time — and that older copy is holding your documents open
              while this one tries to update them.
            </p>
          ) : (
            <p>
              The store your documents live in did not open. This is almost always temporary.
            </p>
          )}
        </Banner>

        <div>
          <h2 className="mb-2 text-[15px] font-bold">Try this first</h2>
          <ol className="list-decimal space-y-1.5 pl-5 text-[14px] text-slate-600 dark:text-slate-400">
            {isBlocked ? (
              <>
                <li>Close every other DocTrack tab and window on this device.</li>
                <li>If it is installed, close the app fully — not just to the background.</li>
                <li>Then reload.</li>
              </>
            ) : (
              <>
                <li>Reload the page.</li>
                <li>If that does not help, close the app fully and open it again.</li>
              </>
            )}
          </ol>
        </div>

        <Button className="w-full" onClick={() => window.location.reload()}>
          Reload
        </Button>

        {error ? (
          <details className="rounded-xl bg-slate-100 px-3.5 py-3 dark:bg-slate-800/70">
            <summary className="cursor-pointer text-[13px] font-semibold text-slate-600 dark:text-slate-300">
              What went wrong
            </summary>
            <p className="mt-2 font-mono text-[12px] break-words text-slate-500 dark:text-slate-400">
              {error}
            </p>
            <p className="mt-2 text-[13px] text-slate-500 dark:text-slate-400">
              A screenshot of this line is what makes the cause fixable.
            </p>
          </details>
        ) : null}

        <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
          <p className="mb-3 text-[13px] text-slate-500 dark:text-slate-400">
            Still stuck? Clearing this device's copy will get the app running again — but it deletes
            every document stored on <em>this</em> device. Anything on your other devices, and any
            backup file you exported, is untouched.
          </p>
          <Button
            variant={confirmReset ? 'danger' : 'secondary'}
            className="w-full"
            onClick={async () => {
              if (!confirmReset) { setConfirmReset(true); return; }
              await resetDatabase();
              window.location.reload();
            }}
          >
            {confirmReset
              ? 'Delete this device’s documents and start over'
              : 'Clear this device’s storage'}
          </Button>
          {confirmReset ? (
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              className="mt-2 min-h-11 w-full text-[14px] text-slate-500 underline underline-offset-4 dark:text-slate-400"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    </Screen>
  );
}
