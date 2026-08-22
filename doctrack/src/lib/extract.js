import {
  buildExtractionRequest,
  parseExtractionResponse,
  EXTRACTION_MODEL,
} from '../../shared/extraction-spec.js';
import {
  DEFAULT_EXTRACTION_MODE,
  DOCUMENT_TYPE_IDS,
  EXTRACTION_MODES,
  LOW_CONFIDENCE,
} from './constants.js';
import { LocalReadError, readLocally } from './localread.js';
import { MAX_UPLOAD_BYTES, blobToBase64, mediaTypeSupported } from './files.js';
import { isValidISODate, normaliseDigits, parseLooseDate } from './dates.js';

/**
 * Four ways to read a document, and the app is fully usable with all of them
 * switched off and every field typed by hand.
 *
 *   local  (default)  OCR in the browser via WebAssembly. Free, no account, no
 *                     key, works offline, and nothing ever leaves the device.
 *                     Less accurate than Claude, so more documents land in the
 *                     review queue — which is exactly what that queue is for.
 *   proxy             POST to a same-origin endpoint that holds the API key
 *                     server-side. `npm run dev` provides this from .env.local;
 *                     api/extract.js provides it in a deployment.
 *   direct            Call api.anthropic.com straight from the browser with a
 *                     key stored in IndexedDB. No server at all, but the key
 *                     lives on the device and is visible to page scripts.
 *   off               Type everything yourself.
 */

export class ExtractionError extends Error {
  constructor(message, { cause, retryable = false } = {}) {
    super(message);
    this.name = 'ExtractionError';
    this.cause = cause;
    this.retryable = retryable;
  }
}

export function extractionMode(settings) {
  return settings?.extraction_mode ?? DEFAULT_EXTRACTION_MODE;
}

export function extractionAvailable(settings) {
  const mode = extractionMode(settings);
  if (mode === EXTRACTION_MODES.OFF) return false;
  if (mode === EXTRACTION_MODES.DIRECT) return Boolean(settings?.anthropic_api_key);
  return true;
}

/**
 * Reads a document photo and returns normalised, UI-ready fields.
 * Throws ExtractionError — the caller always has the manual form to fall back on.
 */
export async function extractDocument(blob, settings = {}, { onProgress } = {}) {
  const mode = extractionMode(settings);
  if (mode === EXTRACTION_MODES.OFF) {
    throw new ExtractionError('Auto-fill is switched off in Settings.');
  }

  if (mode === EXTRACTION_MODES.LOCAL) {
    try {
      return normaliseExtraction(await readLocally(blob, { onProgress }), {
        reader: 'the on-device reader',
      });
    } catch (error) {
      if (error instanceof LocalReadError) throw new ExtractionError(error.message);
      throw error;
    }
  }

  const mediaType = blob.type || 'image/jpeg';
  if (!mediaTypeSupported(mediaType)) {
    throw new ExtractionError(`${mediaType} files cannot be read automatically.`);
  }
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new ExtractionError(
      'That file is too big to send to the API. Switch to on-device reading, or use a smaller copy.',
    );
  }
  const imageBase64 = await blobToBase64(blob);

  const raw =
    mode === EXTRACTION_MODES.DIRECT
      ? await callDirect({ imageBase64, mediaType }, settings)
      : await callProxy({ imageBase64, mediaType }, settings);

  return normaliseExtraction(raw, { reader: EXTRACTION_MODEL });
}

async function callProxy({ imageBase64, mediaType }, settings) {
  const endpoint = settings.proxy_endpoint || '/api/extract';
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, mediaType }),
    });
  } catch (cause) {
    throw new ExtractionError(
      'Could not reach the extraction endpoint. Are you offline?',
      { cause, retryable: true },
    );
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ExtractionError(
      body.error || `Extraction endpoint returned ${response.status}.`,
      { retryable: response.status >= 500 || response.status === 429 },
    );
  }
  return body;
}

async function callDirect({ imageBase64, mediaType }, settings) {
  const apiKey = settings.anthropic_api_key;
  if (!apiKey) {
    throw new ExtractionError('No API key saved. Add one in Settings, or switch to proxy mode.');
  }

  // Loaded on demand so proxy-mode users never download the SDK at all — it is
  // by far the largest thing in the bundle and most installs never need it.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');

  // dangerouslyAllowBrowser is the honest name for what this is: the key is on
  // the device and any script on the page can read it. Documented in the README.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  try {
    const message = await client.messages.create(
      buildExtractionRequest({ imageBase64, mediaType }),
    );
    return parseExtractionResponse(message);
  } catch (cause) {
    const status = cause?.status;
    if (status === 401) throw new ExtractionError('That API key was rejected.', { cause });
    if (status === 429) {
      throw new ExtractionError('Rate limited by the API. Try again in a moment.', {
        cause, retryable: true,
      });
    }
    if (status >= 500) {
      throw new ExtractionError('The API is having trouble. Try again.', { cause, retryable: true });
    }
    throw new ExtractionError(cause?.message || 'Extraction failed.', { cause });
  }
}

const clamp01 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const blankToNull = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

/**
 * Turns the model's response into what the confirm form needs, and — importantly
 * — decides which fields the user must look at before saving.
 */
export function normaliseExtraction(raw, { reader = EXTRACTION_MODEL } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new ExtractionError('Extraction returned an unreadable response.');
  }

  const confidences = raw.field_confidence ?? {};
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((w) => typeof w === 'string') : [];

  const typeValue = blankToNull(raw.document_type);
  const type = DOCUMENT_TYPE_IDS.includes(typeValue) ? typeValue : null;

  const issue = readDate(raw.issue_date, 'Issue date', warnings);
  const expiry = readDate(raw.expiry_date, 'Expiry date', warnings);

  const fields = {
    type: { value: type, confidence: clamp01(confidences.document_type) },
    holder_name: {
      value: blankToNull(raw.holder_name_guess),
      confidence: clamp01(confidences.holder_name_guess),
    },
    number: {
      // The prompt asks for Western numerals; normalising again here means a
      // model that forgets still can't leave ٠١٢ in a field people search on.
      value: blankToNull(normaliseDigits(raw.id_number_guess ?? '')),
      confidence: clamp01(confidences.id_number_guess),
    },
    // A hint, never a gate: a missing label costs nothing, so it is not in
    // needsReview and never sends a document to the review queue.
    label: { value: blankToNull(raw.label_guess ?? ''), confidence: 1 },
    issue_date: {
      value: issue.iso,
      confidence: issue.ambiguous ? Math.min(clamp01(confidences.issue_date), 0.5)
        : clamp01(confidences.issue_date),
    },
    expiry_date: {
      value: expiry.iso,
      confidence: expiry.ambiguous ? Math.min(clamp01(confidences.expiry_date), 0.5)
        : clamp01(confidences.expiry_date),
    },
  };

  // A field needs review if the model was unsure OR it came back empty. Both
  // mean the same thing to the person at the form: look at this one.
  const needsReview = Object.entries(fields)
    .filter(([key]) => key !== 'label')
    .filter(([, f]) => f.value === null || f.confidence < LOW_CONFIDENCE)
    .map(([key]) => key);

  return {
    fields,
    warnings,
    needsReview,
    confidence: clamp01(raw.confidence),
    // Which reader produced this, so the record does not claim Claude read a
    // document that never left the device.
    model: reader,
    extracted_at: new Date().toISOString(),
  };
}

/** Accepts an already-ISO date, otherwise re-parses whatever the model printed. */
function readDate(value, label, warnings) {
  const text = blankToNull(value);
  if (!text) return { iso: null, ambiguous: false };
  if (isValidISODate(text)) return { iso: text, ambiguous: false };

  const parsed = parseLooseDate(text);
  if (!parsed.iso) {
    warnings.push(`${label} came back as "${text}" — could not read it, please enter it by hand.`);
    return { iso: null, ambiguous: false };
  }
  if (parsed.ambiguous) {
    warnings.push(`${label} "${text}" was read as day/month — check the order.`);
  }
  return parsed;
}
