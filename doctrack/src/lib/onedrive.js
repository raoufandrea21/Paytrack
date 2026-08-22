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

let msalPromise = null;
let clientApp = null;
let configuredClientId = null;

async function getClient(clientId) {
  if (!clientId) throw new OneDriveError('No Microsoft app ID saved yet.');
  if (clientApp && configuredClientId === clientId) return clientApp;

  if (!msalPromise) msalPromise = import('@azure/msal-browser');
  const { PublicClientApplication } = await msalPromise;

  clientApp = new PublicClientApplication({
    auth: {
      clientId,
      // "common" so a personal Microsoft account and a work or school account
      // both work — a household is likely to have one of each.
      authority: 'https://login.microsoftonline.com/common',
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: 'localStorage' },
  });
  await clientApp.initialize();
  configuredClientId = clientId;
  return clientApp;
}

export async function currentAccount(clientId) {
  try {
    const client = await getClient(clientId);
    return client.getAllAccounts()[0] ?? null;
  } catch {
    return null;
  }
}

export async function signIn(clientId) {
  const client = await getClient(clientId);
  try {
    const result = await client.loginPopup({ scopes: SCOPES, prompt: 'select_account' });
    return result.account;
  } catch (error) {
    if (error?.errorCode === 'user_cancelled') {
      throw new OneDriveError('Sign-in was cancelled.');
    }
    throw new OneDriveError(error?.message ?? 'Could not sign in to Microsoft.', { cause: error });
  }
}

export async function signOut(clientId) {
  const client = await getClient(clientId);
  const account = client.getAllAccounts()[0];
  if (account) await client.logoutPopup({ account });
  clientApp = null;
  configuredClientId = null;
}

async function getToken(clientId) {
  const client = await getClient(clientId);
  const account = client.getAllAccounts()[0];
  if (!account) throw new OneDriveError('Not signed in to Microsoft.');

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
