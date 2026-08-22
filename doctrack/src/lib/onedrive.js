/**
 * OneDrive access, via Microsoft Graph.
 *
 * Everything lives in the *app folder* — OneDrive/Apps/DocTrack — reached
 * through the `Files.ReadWrite.AppFolder` scope. That scope grants access to
 * that one folder and nothing else, so signing in cannot expose the rest of
 * somebody's drive no matter what this code does. It is also a real folder the
 * user can open in File Explorer, which is what makes the Inbox idea work.
 */
import { SYNC_FORMAT } from './sync.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const APP_ROOT = '/me/drive/special/approot';
const APP_FOLDER_SCOPES = ['Files.ReadWrite.AppFolder', 'User.Read', 'offline_access'];

/**
 * Reading the documents already in someone's OneDrive needs more than the app
 * folder — it needs to see the rest of the drive. Files.Read is the smallest
 * scope that allows that, and it is read-only: with it the app can list and
 * download, and cannot create, change, move or delete anything, whatever this
 * code does.
 *
 * It is asked for only when the user turns folder reading on, so anyone who
 * only wants sync is never asked to hand over more than the app folder.
 */
export const READ_SCOPE = 'Files.Read';
const READING_KEY = 'doctrack.readDrive';

export function driveReadingAllowed() {
  try {
    return window.localStorage.getItem(READING_KEY) === '1';
  } catch {
    return false;
  }
}

export function allowDriveReading(allowed) {
  try {
    if (allowed) window.localStorage.setItem(READING_KEY, '1');
    else window.localStorage.removeItem(READING_KEY);
  } catch {
    /* private browsing; reading stays off */
  }
  clients.clear();
}

export const SCOPES = APP_FOLDER_SCOPES;

/** What to ask Microsoft for, given what the user has turned on. */
export function requestedScopes() {
  return driveReadingAllowed() ? [READ_SCOPE, ...APP_FOLDER_SCOPES] : APP_FOLDER_SCOPES;
}

/** Graph rejects a plain PUT above this; anything larger needs a session. */
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

export const STATE_FILE = 'doctrack.json';
export const INBOX_FOLDER = 'Inbox';
export const FILED_FOLDER = 'Filed';

export class OneDriveError extends Error {
  constructor(message, { status, cause, detail } = {}) {
    super(message);
    this.name = 'OneDriveError';
    this.status = status;
    this.detail = detail;
    this.cause = cause;
  }
}

/**
 * What a Graph refusal means, in words.
 *
 * Left raw, these arrive as a wall of JSON with the actual reason buried in an
 * innerError three levels down — which tells someone their sync is broken and
 * nothing about what to do. The codes worth naming are the ones a person can
 * act on; everything else keeps the status and the raw body underneath.
 */
export function describeGraphFailure(status, body) {
  const text = String(body ?? '');
  let code = '';
  let inner = '';
  let message = '';
  try {
    const parsed = JSON.parse(text);
    code = parsed?.error?.code ?? '';
    inner = parsed?.error?.innerError?.code ?? '';
    message = parsed?.error?.message ?? '';
  } catch {
    /* not JSON; the patterns below still read the raw text */
  }
  const all = `${code} ${inner} ${message} ${text}`;

  // The one that actually happens: Microsoft puts a personal OneDrive into
  // read-only when it is full or the account is frozen. Reads keep working,
  // which is why this only ever surfaces at the moment of writing.
  if (/serviceReadOnly|read.?only/i.test(all)) {
    return 'Your OneDrive is not accepting changes right now — Microsoft has it in read-only mode. '
      + 'That usually means the storage is full or the account is frozen, so open onedrive.com and '
      + 'check; if it looks fine, this can be temporary at Microsoft\'s end. Nothing is lost — every '
      + 'document is still on this device.';
  }
  if (status === 507 || /quotaLimitReached|insufficientStorage|storage.?limit/i.test(all)) {
    return 'Your OneDrive is out of space. Free some up at onedrive.com and sync again — '
      + 'DocTrack itself needs only a few megabytes.';
  }
  if (status === 401 || /InvalidAuthenticationToken|unauthenticated/i.test(all)) {
    return 'Microsoft needs you to sign in again. Use Disconnect, then Connect OneDrive.';
  }
  if (status === 403) {
    return 'Microsoft refused the change. If you have just connected, the permission may not have '
      + 'been granted — try Disconnect and connect again.';
  }
  if (status === 429 || /activityLimitReached|throttl/i.test(all)) {
    return 'Microsoft is asking for a slower pace. Wait a minute and sync again.';
  }
  if (status >= 500) {
    return 'OneDrive is having trouble at Microsoft\'s end. Nothing is wrong here — try again shortly.';
  }
  return `OneDrive refused the request (${status}).`;
}

/**
 * How full the drive is, when Microsoft will say.
 *
 * Only asked for after a write has already failed, to turn "read-only" into a
 * number the user can act on. The app-folder scope may not stretch to reading
 * the drive itself, so this is allowed to come back empty.
 */
export async function driveQuota(clientId) {
  try {
    const drive = await graph(clientId, '/me/drive', {
      scopes: driveReadingAllowed() ? READ_SCOPES : APP_FOLDER_SCOPES,
    });
    const quota = drive?.quota;
    if (!quota || typeof quota.total !== 'number') return null;
    return { state: quota.state ?? '', used: quota.used ?? 0, total: quota.total };
  } catch {
    return null;
  }
}

/**
 * Which sign-in endpoint to use depends on how the app was registered, and
 * getting it wrong is a hard rejection rather than a warning:
 *
 *   consumers     personal Microsoft accounts only
 *   organizations work or school accounts only
 *   common        both — but only for an app registered as multitenant.
 *                 Microsoft rejects /common outright for a personal-only app
 *                 (AADSTS50194), so it cannot simply be the default.
 *
 * This used to try each in turn and keep the one that worked. That cannot work
 * with a redirect: the wrong endpoint is rejected by Microsoft's own /authorize
 * page, which never sends the browser back here, so there is no rejection for
 * the app to catch and nothing to fall through to. Worse, an authorization code
 * is single-use and tied to the endpoint that issued it, so retrying the same
 * answer elsewhere is meaningless even in principle.
 *
 * So it is a question with three answers, and the user is simply asked.
 */
export const ACCOUNT_KINDS = [
  { id: 'consumers', label: 'Personal Microsoft account', hint: 'outlook.com, hotmail.com, or a personal account on any address' },
  { id: 'organizations', label: 'Work or school account', hint: 'an account your employer or school gave you' },
  { id: 'common', label: 'Either — registered as multitenant', hint: 'only if the Azure registration allows both' },
];
export const DEFAULT_ACCOUNT_KIND = 'consumers';

const authorityUrl = (name) => `https://login.microsoftonline.com/${name}`;

let msalPromise = null;
const clients = new Map();

async function getClient(clientId, authority = 'consumers') {
  if (!clientId) throw new OneDriveError('No Microsoft app ID saved yet.');

  const key = `${clientId}:${authority}`;
  if (clients.has(key)) return clients.get(key);

  if (!msalPromise) {
    msalPromise = import('@azure/msal-browser').catch((error) => {
      msalPromise = null;
      throw new OneDriveError(
        'The app updated in the background. Reload the page and try again.',
        { cause: error },
      );
    });
  }
  const { PublicClientApplication } = await msalPromise;

  const app = new PublicClientApplication({
    auth: {
      clientId,
      authority: authorityUrl(authority),
      // No trailing slash and no path, which is what has to be registered in
      // Azure under "Single-page application" — it is matched as an exact
      // string, and "Web" instead of SPA fails later and less legibly.
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: 'localStorage' },
  });
  await app.initialize();
  clients.set(key, app);
  return app;
}

/**
 * The kind of account, mirrored out of IndexedDB into localStorage.
 *
 * Sign-in has to know it in places that run before the database is open — the
 * redirect coming back is one — and reading it synchronously here keeps that
 * path from depending on anything else being ready. Settings is what writes it.
 */
const KIND_KEY = 'doctrack.accountKind';

export function accountKind() {
  try {
    const saved = window.localStorage.getItem(KIND_KEY);
    return ACCOUNT_KINDS.some((k) => k.id === saved) ? saved : DEFAULT_ACCOUNT_KIND;
  } catch {
    return DEFAULT_ACCOUNT_KIND;
  }
}

export function setAccountKind(kind) {
  try {
    window.localStorage.setItem(KIND_KEY, kind);
  } catch {
    /* private browsing; the default applies */
  }
  clients.clear(); // the authority is baked into a client at construction
}

/**
 * MSAL records "an interaction is in progress" in browser storage and refuses
 * to start another until it clears. A sign-in abandoned halfway — the back
 * button, a closed tab, a phone that went to sleep on the Microsoft page —
 * leaves that flag set, and every later attempt fails with
 * interaction_in_progress until storage is cleaned.
 */
function clearStaleInteraction() {
  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      for (const key of Object.keys(store)) {
        if (key.includes('interaction.status')) store.removeItem(key);
      }
    } catch {
      /* storage unavailable; nothing to clear */
    }
  }
}

/**
 * Wipes every trace of a previous connection: MSAL's caches, the remembered
 * endpoint, and any stuck interaction flag. The way out when sign-in wedges.
 */
export function resetConnection(clientId) {
  clearStaleInteraction();
  clients.clear();
  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      for (const key of Object.keys(store)) {
        // The chosen account kind is a setting, not connection state, so it
        // survives a reset — resetting should not silently change what the
        // next attempt asks Microsoft for.
        if (key.startsWith('msal.') || key.includes(clientId) || key.startsWith('doctrack.authority.')) {
          store.removeItem(key);
        }
      }
    } catch {
      /* storage unavailable */
    }
  }
}

export async function currentAccount(clientId) {
  try {
    const client = await getClient(clientId, accountKind());
    return client.getAllAccounts()[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * A sign-in that left the page and has not come back yet.
 *
 * Every way this can fail — the wrong account kind, an unregistered redirect
 * address, a phone that lost the tab — ends with Microsoft showing its own
 * error page and never returning here. There is no callback to catch, so the
 * only trace is one of these left behind before leaving.
 */
const STARTED_KEY = 'doctrack.signin.started';
const PROBLEM_KEY = 'doctrack.signin.problem';
/** After this long, an unfinished sign-in is stale rather than in progress. */
const ATTEMPT_WINDOW = 15 * 60 * 1000;

const write = (key, value) => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing; the app just cannot explain itself later */
  }
};

const read = (key) => {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
};

/**
 * What to tell someone whose sign-in did not work, or null when there is
 * nothing to say. Settings shows this instead of leaving the Connect button
 * looking exactly as they left it.
 */
export function signInProblem({ signedIn = false } = {}) {
  // Connected now, so whatever went wrong on an earlier attempt is history —
  // and a warning above the words "Connected as…" is just confusing.
  if (signedIn) {
    clearSignInProblem();
    return null;
  }

  const problem = read(PROBLEM_KEY);
  if (problem) return problem;

  const started = read(STARTED_KEY);
  if (!started) return null;
  if (Date.now() - started.at > ATTEMPT_WINDOW) {
    write(STARTED_KEY, null);
    return null;
  }
  return {
    kind: 'never-came-back',
    message:
      'Microsoft did not send you back. If it sat on "Signing in with your passkey", the passkey '
      + 'is probably kept on another device — go back on Microsoft\'s page and choose another way '
      + 'to sign in. If you saw an error page with a code on it instead, the account type below '
      + 'does not match how the app is registered, or this app\'s address is not the one '
      + 'registered in Azure. Nothing here is stuck: everything works without OneDrive, and '
      + 'Backup and transfer moves documents between your devices.',
  };
}

export function clearSignInProblem() {
  write(PROBLEM_KEY, null);
  write(STARTED_KEY, null);
}

/**
 * Consumes a sign-in result sitting in the URL. Must run before anything else
 * touches the fragment — HashRouter would rewrite it away.
 *
 * `client` exists so the shape of the call below can be checked without a
 * Microsoft account. It is worth the seam: handing MSAL the fragment as a bare
 * string instead of `{ hash }` broke every sign-in there has ever been, and the
 * only symptom was a null nobody could account for.
 */
export async function completeRedirectSignIn(clientId, authFragment = null, { client: given } = {}) {
  // The caller takes the fragment out of the address bar before loading MSAL,
  // so it has to be handed over rather than read from the URL.
  const fragment = authFragment ?? window.location.hash;
  if (!clientId || !/[#?&](code|error)=/.test(fragment)) return null;

  try {
    const client = given ?? (await getClient(clientId, accountKind()));
    // An object, not the string: MSAL v5 reads `options.hash`, and handed a
    // bare string it silently falls back to window.location.hash — which the
    // caller has already replaced with the route. The whole sign-in then ends
    // in a null nobody can explain. navigateToLoginRequestUrl belongs here too;
    // it is no longer a config option and defaults to true, which sends the app
    // back to where sign-in started with the answer still in its pocket.
    const result = await client.handleRedirectPromise({
      hash: fragment,
      navigateToLoginRequestUrl: false,
    });
    if (result?.account) {
      clearSignInProblem();
      return result.account;
    }
    write(PROBLEM_KEY, {
      kind: 'no-result',
      message: 'Microsoft sent an answer back but it could not be read. Try connecting again.',
    });
  } catch (error) {
    write(PROBLEM_KEY, {
      kind: 'rejected',
      message: describeSignInError(error),
      detail: `${error?.errorCode ?? ''} ${error?.errorMessage ?? error?.message ?? ''}`.trim(),
    });
  }
  return null;
}

/** Microsoft's codes, in words, for the handful that actually come up. */
function describeSignInError(error) {
  const text = `${error?.errorCode ?? ''} ${error?.errorMessage ?? ''} ${error?.message ?? ''}`;
  if (/AADSTS50194|multi-?tenant/i.test(text)) {
    return 'This app is registered for one kind of account only, so "Either" will not work. Pick Personal or Work below.';
  }
  if (/AADSTS50011|redirect.?uri/i.test(text)) {
    return `The address of this app is not registered in Azure. Add ${window.location.origin} there as a Single-page application redirect.`;
  }
  if (/AADSTS700016|unauthorized_client|AADSTS90002/i.test(text)) {
    return 'Microsoft did not recognise the app ID, or not for this kind of account. Check the app ID and the account type below.';
  }
  if (/interaction_in_progress/i.test(text)) {
    return 'A previous sign-in was left half-finished. Use "Reset connection" and try again.';
  }
  return 'Microsoft turned the sign-in down. The details are below.';
}

/**
 * Signs in by leaving the page, not by opening one.
 *
 * The popup flow was tried and abandoned. It depends on the opened window
 * handing its result back to whoever opened it, and that handshake has too many
 * ways to fail here: an installed PWA opens a separate app window rather than a
 * popup, a blocker or a reload severs the link, and a previous attempt can leave
 * MSAL's interaction lock set. Each failure looks identical to the user — a
 * window that sits on the Microsoft redirect holding the code, plainly visible
 * in its address bar, and never closes.
 *
 * A redirect has no second window to coordinate with. The app navigates to
 * Microsoft and comes back to itself with the result in the fragment, which
 * completeRedirectSignIn() consumes on the next load. Nothing is lost by
 * leaving: every document lives in IndexedDB, not in the page.
 *
 * Returns nothing, because the page is on its way out.
 */
export async function signIn(clientId, { client: given } = {}) {
  clearStaleInteraction();
  clearSignInProblem();
  const client = given ?? (await getClient(clientId, accountKind()));

  // Left behind deliberately. If Microsoft refuses at its own end the browser
  // never comes back here, so this breadcrumb is the only evidence that an
  // attempt happened at all.
  write(STARTED_KEY, { at: Date.now(), kind: accountKind(), origin: window.location.origin });

  await client.loginRedirect({ scopes: requestedScopes(), prompt: 'select_account' });
  return null;
}

async function activeClient(clientId) {
  const client = await getClient(clientId, accountKind());
  if (!client.getAllAccounts()[0]) throw new OneDriveError('Not signed in to Microsoft.');
  return client;
}

/**
 * Disconnects this device, and only this device.
 *
 * Signing out at Microsoft's end would mean opening their page, and this app
 * has been bitten enough by windows that never come back. Nothing is left
 * behind locally either way: the tokens are gone, and connecting again is two
 * taps.
 */
export async function signOut(clientId) {
  try {
    const client = await getClient(clientId, accountKind());
    const account = client.getAllAccounts()[0];
    if (account) await client.clearCache({ account });
  } catch {
    /* nothing usable to clear; the wipe below is what matters */
  } finally {
    resetConnection(clientId);
    clearSignInProblem();
  }
}

/**
 * A token for exactly what this call needs, and no more.
 *
 * Asking for the union would tie the two features together: turn on folder
 * reading, have Microsoft decline the extra permission, and sync — which needs
 * nothing but the app folder — would start failing too, for a scope it never
 * wanted.
 */
async function getToken(clientId, scopes = APP_FOLDER_SCOPES) {
  const client = await activeClient(clientId);
  const account = client.getAllAccounts()[0];

  try {
    const result = await client.acquireTokenSilent({ scopes, account });
    return result.accessToken;
  } catch (error) {
    // Consent changed or the refresh token expired. Redirecting from inside a
    // background sync would yank the page out from under someone mid-task, so
    // say what is needed and let them choose the moment.
    throw new OneDriveError(
      'Microsoft needs you to sign in again — open Settings and tap Connect OneDrive.',
      { cause: error },
    );
  }
}

/**
 * One Graph call. `fetchImpl` exists so the plumbing can be exercised against a
 * stub without a Microsoft account.
 */
async function graph(clientId, path, { method = 'GET', body, headers = {}, raw = false, fetchImpl = fetch, scopes } = {}) {
  const token = await getToken(clientId, scopes);
  const response = await fetchImpl(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new OneDriveError(describeGraphFailure(response.status, body), {
      status: response.status,
      detail: body.slice(0, 300),
    });
  }
  if (raw) return response;
  if (response.status === 204) return null;
  return response.json();
}

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

export async function readJson(clientId, path, options = {}) {
  const response = await graph(clientId, `${APP_ROOT}:/${encodePath(path)}:/content`, {
    raw: true,
    ...options,
  });
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    throw new OneDriveError(`${path} in OneDrive is not readable JSON.`);
  }
}

export async function writeJson(clientId, path, value, options = {}) {
  return graph(clientId, `${APP_ROOT}:/${encodePath(path)}:/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
    ...options,
  });
}

export async function uploadFile(clientId, path, blob, options = {}) {
  if (blob.size <= SIMPLE_UPLOAD_LIMIT) {
    return graph(clientId, `${APP_ROOT}:/${encodePath(path)}:/content`, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
      ...options,
    });
  }

  // Larger files go up in chunks against an upload session. A scanned
  // certificate can be well past the simple-upload ceiling.
  const session = await graph(clientId, `${APP_ROOT}:/${encodePath(path)}:/createUploadSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    ...options,
  });

  const chunkSize = 5 * 320 * 1024; // Graph requires a multiple of 320 KiB
  const fetchImpl = options.fetchImpl ?? fetch;
  for (let start = 0; start < blob.size; start += chunkSize) {
    const end = Math.min(start + chunkSize, blob.size);
    const response = await fetchImpl(session.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(end - start),
        'Content-Range': `bytes ${start}-${end - 1}/${blob.size}`,
      },
      body: blob.slice(start, end),
    });
    if (!response.ok && response.status !== 202) {
      throw new OneDriveError(`Upload failed at ${start} of ${blob.size} bytes.`, {
        status: response.status,
      });
    }
  }
  return null;
}

export async function downloadFile(clientId, path, options = {}) {
  const response = await graph(clientId, `${APP_ROOT}:/${encodePath(path)}:/content`, {
    raw: true,
    ...options,
  });
  return response ? response.blob() : null;
}

export async function listChildren(clientId, folder, options = {}) {
  const target = folder
    ? `${APP_ROOT}:/${encodePath(folder)}:/children`
    : `${APP_ROOT}/children`;
  const result = await graph(clientId, target, options);
  return result?.value ?? [];
}

export async function ensureFolder(clientId, name, options = {}) {
  const existing = await graph(clientId, `${APP_ROOT}:/${encodePath(name)}`, options);
  if (existing) return existing;
  return graph(clientId, `${APP_ROOT}/children`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'replace',
    }),
    ...options,
  });
}

/**
 * Reading the rest of the drive. Every call here is a GET, and every one is
 * outside the app folder, which is why they need Files.Read and why they are
 * kept together and named for what they are.
 */
const DRIVE_FIELDS = 'id,name,size,folder,file,cTag,lastModifiedDateTime';
const READ_SCOPES = [READ_SCOPE, 'User.Read', 'offline_access'];

/** One page at a time until Graph stops offering more. */
async function pagedChildren(clientId, first, options) {
  const items = [];
  let next = first;
  const withScope = { ...options, scopes: READ_SCOPES };
  // A documents folder with hundreds of files arrives in pages; without this
  // the import would quietly stop at the first two hundred.
  while (next && items.length < 5000) {
    const page = await graph(clientId, next, withScope);
    items.push(...(page?.value ?? []));
    next = page?.['@odata.nextLink'] ?? null;
  }
  return items;
}

/** What is inside a folder — the drive root when no id is given. */
export function listDriveFolder(clientId, itemId = null, options = {}) {
  const base = itemId ? `/me/drive/items/${itemId}/children` : '/me/drive/root/children';
  return pagedChildren(clientId, `${base}?$top=200&$select=${DRIVE_FIELDS}`, options);
}

/** A file's bytes. Read-only: nothing here can change what is in the drive. */
export async function downloadDriveItem(clientId, itemId, options = {}) {
  const response = await graph(clientId, `/me/drive/items/${itemId}/content`, {
    raw: true,
    ...options,
    scopes: READ_SCOPES,
  });
  return response ? response.blob() : null;
}

/** Moves a file into another folder in the app folder — Inbox to Filed. */
export async function moveItem(clientId, itemId, destinationFolder, options = {}) {
  const destination = await ensureFolder(clientId, destinationFolder, options);
  return graph(clientId, `/me/drive/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentReference: { id: destination.id } }),
    ...options,
  });
}

export function looksLikeState(value) {
  return value?.format === SYNC_FORMAT;
}
