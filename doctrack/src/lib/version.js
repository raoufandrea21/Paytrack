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
    .then(async (registration) => {
      if (!registration) return 'unsupported';
      await registration.update();

      // update() resolves once the browser has compared sw.js and, if it
      // differs, *started* installing — not when the new build is ready. Asking
      // `updateReady` here would answer "you are up to date" at the precise
      // moment a new version is downloading, and be contradicted seconds later
      // by the banner. So follow the new worker to the end of its life.
      const arriving = registration.installing ?? registration.waiting;
      if (!arriving) return updateReady ? 'ready' : 'current';
      return settle(arriving);
    })
    .catch(() => 'unsupported');
}

/**
 * Wait for an arriving worker to either take over or die.
 *
 * A precache that fails — one asset missing, storage full, the connection lost
 * partway through fifteen megabytes on a phone — leaves the worker `redundant`
 * and fires no controllerchange at all. Reported as "up to date", that is a lie
 * the user has no way to see through.
 */
function settle(worker) {
  return new Promise((resolve) => {
    const done = (answer) => {
      worker.removeEventListener('statechange', onChange);
      resolve(answer);
    };
    const onChange = () => {
      if (worker.state === 'activated') done('ready');
      if (worker.state === 'redundant') done('failed');
    };
    worker.addEventListener('statechange', onChange);
    onChange();
    // Not every browser reaches a final state promptly; do not hang the button.
    setTimeout(() => done(updateReady ? 'ready' : 'downloading'), 20_000);
  });
}

function announce() {
  updateReady = true;
  for (const listener of waiting) listener();
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

    // Only stay quiet if the reload really went ahead. A refused one — the
    // loop guard, or private mode — would otherwise leave the page on the old
    // build, with the new worker already in control and the old build's chunks
    // already deleted, and nothing on screen to say so.
    const quiet = document.hidden || Date.now() - bootedAt < QUIET_WINDOW;
    if (quiet && reloadOntoNewBuild('a newer build took over')) return;

    announce();
  });
}
