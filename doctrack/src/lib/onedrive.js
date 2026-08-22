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
export const SCOPES = ['Files.ReadWrite.AppFolder', 'User.Read', 'offline_access'];

/** Graph rejects a plain PUT above this; anything larger needs a session. */
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

export const STATE_FILE = 'doctrack.json';
export const INBOX_FOLDER = 'Inbox';
export const FILED_FOLDER = 'Filed';

export class OneDriveError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = 'OneDriveError';
    this.status = status;
    this.cause = cause;
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
 * Rather than making the user understand any of that, sign-in tries each in
 * turn and remembers the one that worked.
 */
export const AUTHORITIES = ['consumers', 'common', 'organizations'];

const authorityUrl = (name) => `https://login.microsoftonline.com/${name}`;

let msalPromise = null;
const clients = new Map();

async function getClient(clientId, authority = 'consumers') {
  if (!clientId) throw new OneDriveError('No Microsoft app ID saved yet.');

  const key = `${clientId}:${authority}`;
  if (clients.has(key)) return clients.get(key);

  if (!msalPromise) msalPromise = import('@azure/msal-browser');
  const { PublicClientApplication } = await msalPromise;

  const app = new PublicClientApplication({
    auth: {
      clientId,
      authority: authorityUrl(authority),
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: 'localStorage' },
  });
  await app.initialize();
  clients.set(key, app);
  return app;
}

/** The endpoint a previous sign-in settled on, so later calls skip the search. */
function rememberedAuthority(clientId) {
  try {
    return window.localStorage.getItem(`doctrack.authority.${clientId}`);
  } catch {
    return null;
  }
}

function rememberAuthority(clientId, authority) {
  try {
    window.localStorage.setItem(`doctrack.authority.${clientId}`, authority);
  } catch {
    /* private browsing; the search just runs again next time */
  }
}

/** Authorities to try, best guess first. */
function candidateAuthorities(clientId) {
  const known = rememberedAuthority(clientId);
  return known ? [known, ...AUTHORITIES.filter((a) => a !== known)] : AUTHORITIES;
}

export async function currentAccount(clientId) {
  for (const authority of candidateAuthorities(clientId)) {
    try {
      const client = await getClient(clientId, authority);
      const account = client.getAllAccounts()[0];
      if (account) return account;
    } catch {
      /* try the next endpoint */
    }
  }
  return null;
}

/** A rejection that means "wrong endpoint for this registration", not "no". */
function isWrongAuthority(error) {
  const text = `${error?.errorCode ?? ''} ${error?.errorMessage ?? ''} ${error?.message ?? ''}`;
  return /AADSTS50194|AADSTS500011|AADSTS700016|AADSTS90002|not configured as a multi-tenant|unauthorized_client/i.test(
    text,
  );
}

export async function signIn(clientId) {
  let lastError = null;

  for (const authority of candidateAuthorities(clientId)) {
    try {
      const client = await getClient(clientId, authority);
      const result = await client.loginPopup({ scopes: SCOPES, prompt: 'select_account' });
      rememberAuthority(clientId, authority);
      return result.account;
    } catch (error) {
      // A cancelled popup is the user's answer, not a wrong guess — stop.
      if (error?.errorCode === 'user_cancelled') {
        throw new OneDriveError('Sign-in was cancelled.');
      }
      lastError = error;
      if (!isWrongAuthority(error)) break;
    }
  }

  throw new OneDriveError(
    lastError?.errorMessage || lastError?.message || 'Could not sign in to Microsoft.',
    { cause: lastError },
  );
}

async function activeClient(clientId) {
  for (const authority of candidateAuthorities(clientId)) {
    try {
      const client = await getClient(clientId, authority);
      if (client.getAllAccounts()[0]) return client;
    } catch {
      /* try the next endpoint */
    }
  }
  throw new OneDriveError('Not signed in to Microsoft.');
}

export async function signOut(clientId) {
  try {
    const client = await activeClient(clientId);
    const account = client.getAllAccounts()[0];
    if (account) await client.logoutPopup({ account });
  } finally {
    clients.clear();
  }
}

async function getToken(clientId) {
  const client = await activeClient(clientId);
  const account = client.getAllAccounts()[0];

  try {
    const result = await client.acquireTokenSilent({ scopes: SCOPES, account });
    return result.accessToken;
  } catch {
    // The refresh token expired or consent changed — the only way back is to
    // ask, so surface it rather than failing the sync silently.
    const result = await client.acquireTokenPopup({ scopes: SCOPES, account });
    return result.accessToken;
  }
}

/**
 * One Graph call. `fetchImpl` exists so the plumbing can be exercised against a
 * stub without a Microsoft account.
 */
async function graph(clientId, path, { method = 'GET', body, headers = {}, raw = false, fetchImpl = fetch } = {}) {
  const token = await getToken(clientId);
  const response = await fetchImpl(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new OneDriveError(
      `OneDrive returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      { status: response.status },
    );
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
