import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.jsx';
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
 * The page cannot recover in place; the fix is to reload onto the new build. A
 * session flag keeps that from becoming a loop when the chunk is genuinely
 * missing rather than merely renamed.
 */
const RELOAD_FLAG = 'doctrack.reloadedForUpdate';

function reloadOntoNewBuild(detail) {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch {
    return false; // private mode: better a broken button than a reload loop
  }
  console.warn('[doctrack] reloading to pick up a new build', detail);
  window.location.reload();
  return true;
}

window.addEventListener('vite:preloadError', (event) => {
  if (isAuthPopup) return;
  if (reloadOntoNewBuild(event?.payload)) event.preventDefault();
});

// Cleared once a build has run for a moment without tripping over itself, so a
// later update is free to reload again.
window.setTimeout(() => {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    /* nothing to clear */
  }
}, 10_000);

if (!isAuthPopup) {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </StrictMode>,
  );
}

// Registered here rather than by the plugin so the app controls the timing and
// can surface failures instead of swallowing them.
if ('serviceWorker' in navigator && !isAuthPopup) {
  window.addEventListener('load', () => {
    const url = import.meta.env.DEV ? '/dev-sw.js?dev-sw' : '/sw.js';
    navigator.serviceWorker
      .register(url, { type: import.meta.env.DEV ? 'module' : 'classic', scope: '/' })
      .catch((error) => {
        // Most common cause: an insecure origin (plain http:// over the LAN).
        // The app still works; only offline install and background sync don't.
        console.warn('[doctrack] service worker not registered', error);
      });
  });
}
