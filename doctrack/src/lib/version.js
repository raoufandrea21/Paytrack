/**
 * Which build is running, and how it gets replaced by a newer one.
 *
 * A web app that has been installed to a home screen behaves less like a web
 * page than people expect: the service worker serves the app shell from cache,
 * so opening it shows whatever build was cached last, and nothing forces a
 * reload. Someone can therefore use a build from days ago, hit a bug that was
 * fixed hours after it, and have no way of telling — the app looks perfectly
 * normal, it is simply the wrong one.
 *
 * So two things live here. The build identity, which makes the question
 * answerable at all, and the update path, which makes the answer stop being
 * "an old one".
 */

// Substituted at build time by vite.config.js. `typeof` rather than a bare
// reference because this module is also reachable from contexts that do not get
// the substitution, and a ReferenceError here would take the whole app down.
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
export const BUILT_AT = typeof __BUILT_AT__ === 'string' ? __BUILT_AT__ : null;

/** How long after a page loads a silent reload is still unsurprising. */
const QUIET_WINDOW = 12_000;
const RELOAD_FLAG = 'doctrack.reloadedForUpdate';

const bootedAt = Date.now();
const hadControllerAtBoot =
  typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller);

const waiting = new Set();
let updateReady = false;

/**
 * Reload onto whatever the server is serving now.
 *
 * A session flag stops this becoming a loop when the reload does not actually
 * fix anything — better a broken button than a page that reloads for ever.
 */
export function reloadOntoNewBuild(detail) {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch {
    return false; // private mode: no way to remember, so do not risk the loop
  }
  console.warn('[doctrack] reloading to pick up a new build', detail);
  window.location.reload();
  return true;
}

/** Cleared once a build has run for a moment without tripping over itself. */
export function armReloadAgainLater(after = 10_000) {
  window.setTimeout(() => {
    try {
      sessionStorage.removeItem(RELOAD_FLAG);
    } catch {
      /* nothing to clear */
    }
  }, after);
}

/**
 * Tell the browser to go and look for a newer worker.
 *
 * Registration alone checks once. Without this, an app left open — or an
 * installed one that is never really closed — can miss a deployment entirely.
 */
export function checkForUpdate() {
  if (!('serviceWorker' in navigator)) return Promise.resolve('unsupported');
  return navigator.serviceWorker
    .getRegistration()
    .then((registration) => {
      if (!registration) return 'unsupported';
      return registration.update().then(() => {
        // update() resolves as soon as the check is done, which can be a moment
        // before the new worker takes over — so ask the registration what it is
        // holding rather than waiting for the takeover to be announced.
        if (registration.installing || registration.waiting) return 'updating';
        return updateReady ? 'updating' : 'current';
      });
    })
    .catch(() => 'unsupported');
}

/** Notified when a newer build has taken over and the page is now the old one. */
export function onUpdateReady(listener) {
  if (updateReady) listener();
  waiting.add(listener);
  return () => waiting.delete(listener);
}

/**
 * Watch for a new build taking control.
 *
 * The worker skips waiting and claims its clients the moment it installs, so by
 * the time this fires the page is being served by the new build while still
 * running the old one in memory. Only a reload fixes that.
 *
 * Whether to reload without asking comes down to whether it could throw away
 * something the user typed. Just-opened or in the background, it cannot, so it
 * happens quietly. Otherwise the app says a new version is ready and lets them
 * pick the moment.
 */
export function watchForUpdates(registration) {
  if (!('serviceWorker' in navigator)) return;

  const recheck = () => registration.update().catch(() => {});
  recheck();

  // Coming back to the app is exactly when a deployment from an hour ago should
  // be noticed, and it is the only "open" an installed app ever really gets.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) recheck();
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first worker to ever take control is not an update — the page it is
    // claiming is already the newest build.
    if (!hadControllerAtBoot) return;

    if (document.hidden || Date.now() - bootedAt < QUIET_WINDOW) {
      reloadOntoNewBuild('a newer build took over');
      return;
    }
    updateReady = true;
    for (const listener of waiting) listener();
  });
}
