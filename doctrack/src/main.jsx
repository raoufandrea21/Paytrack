import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.jsx';
import { armReloadAgainLater, reloadOntoNewBuild, watchForUpdates } from './lib/version.js';
import './index.css';

/**
 * HashRouter, not BrowserRouter: DocTrack is meant to be opened from a home
 * screen icon and served by any static host or from cache with no connection at
 * all. Hash routes never depend on a server rewrite rule.
 */
/**
 * Microsoft returns a sign-in result in the URL fragment, and the popup it uses
 * is this same app at this same origin. HashRouter, seeing a fragment that is
 * not one of its routes, rewrites it to "#/" — destroying the response before
 * MSAL can read it. The popup then sits waiting for a reply that no longer
 * exists until it times out and closes itself, which is what a user sees as
 * "it opened a window and then closed after a few minutes".
 *
 * So when this page IS the auth popup, it must do nothing at all: no router, no
 * service worker, no reminder check. MSAL reads the fragment from the opener
 * and closes the window itself.
 */
const isAuthPopup =
  Boolean(window.opener) && /[#?&](code|error|state)=/.test(window.location.href);

/**
 * A deploy renames every hashed chunk. A tab still running the previous build
 * then asks for a filename that no longer exists, and the lazy import dies with
 * "Failed to fetch dynamically imported module" — which the user meets as a
 * button that simply does not work. The service worker makes it likelier, not
 * less: it activates immediately and clears the old precache out from under any
 * page still using it.
 *
 * The page cannot recover in place; the fix is to reload onto the new build.
 * See src/lib/version.js, which owns every reason this app reloads itself.
 */
window.addEventListener('vite:preloadError', (event) => {
  if (isAuthPopup) return;
  if (reloadOntoNewBuild(event?.payload)) event.preventDefault();
});

armReloadAgainLater();

/**
 * A redirect sign-in comes back to this page with the result in the fragment.
 * MSAL has to read it before React mounts, because HashRouter rewrites any
 * fragment it does not recognise — which is how the popup flow lost its answer.
 */
async function consumeSignInResult() {
  if (!/[#?&](code|error)=/.test(window.location.href) || window.opener) return;

  // Take the fragment now and hand MSAL a copy. Leaving it in the address bar
  // while an import loads gives the router a chance to see it, decide it is not
  // a route, and redirect to the dashboard.
  const authFragment = window.location.hash;
  history.replaceState(null, '', `${window.location.pathname}#/settings`);

  try {
    const [{ getSetting }, onedrive] = await Promise.all([
      import('./db.js'),
      import('./lib/onedrive.js'),
    ]);
    const clientId = await getSetting('onedrive_client_id');
    if (clientId) await onedrive.completeRedirectSignIn(clientId, authFragment);
  } catch (error) {
    console.warn('[doctrack] could not finish signing in', error);
  } finally {
    // MSAL may have moved the URL while processing; put the route back.
    history.replaceState(null, '', `${window.location.pathname}#/settings`);
  }
}

function mount() {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </StrictMode>,
  );
}

if (!isAuthPopup) {
  consumeSignInResult().then(mount);
}

// Registered here rather than by the plugin so the app controls the timing and
// can surface failures instead of swallowing them.
if ('serviceWorker' in navigator && !isAuthPopup) {
  window.addEventListener('load', () => {
    const url = import.meta.env.DEV ? '/dev-sw.js?dev-sw' : '/sw.js';
    navigator.serviceWorker
      .register(url, { type: import.meta.env.DEV ? 'module' : 'classic', scope: '/' })
      // Registering is not the same as staying current: an installed app can go
      // for days without a page load, which is the only moment the browser
      // would otherwise look for a new build.
      .then(watchForUpdates)
      .catch((error) => {
        // Most common cause: an insecure origin (plain http:// over the LAN).
        // The app still works; only offline install and background sync don't.
        console.warn('[doctrack] service worker not registered', error);
      });
  });
}
