/**
 * Free, on-device document reading.
 *
 * Tesseract runs as WebAssembly inside the browser, so nothing leaves the phone
 * and nothing is billed. It is a text recogniser, not a model — it hands back
 * characters and has no idea what a driving licence is — so everything after the
 * OCR call is a parser tuned to how UAE documents are actually laid out.
 *
 * It deliberately produces the same JSON shape the Claude path returns, so
 * normaliseExtraction, automatic filing and the review queue all work unchanged
 * regardless of which reader produced the fields.
 *
 * English only. UAE documents are bilingual and the English side carries every
 * field we need; adding Arabic traineddata would double the download and Arabic
 * OCR of a phone photo is poor enough that the app's existing rule — leave it
 * blank and flag it — is the better answer.
 */
import { normaliseDigits, isValidISODate } from './dates.js';

// import.meta.env only exists under Vite; this module is also loaded by the
// Node test runner, where reading .BASE_URL off undefined would throw at import.
const BASE = import.meta.env?.BASE_URL ?? '/';

let workerPromise = null;

/**
 * One worker, reused. Starting it downloads ~5 MB of engine and language data
 * the first time; the browser caches it, and a batch upload would otherwise pay
 * the startup cost once per file.
 */
async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      // Served from our own origin — see scripts/vendor-ocr.mjs. Without these
      // three paths tesseract.js reaches for a CDN, which would put a third
      // party in front of every document and break offline reading.
      return createWorker('eng', 1, {
        workerPath: `${BASE}tesseract/worker.min.js`,
        corePath: `${BASE}tesseract`,
        langPath: `${BASE}tesseract`,
        logger: (m) => {
          if (m.status === 'recognizing text') onProgress?.(m.progress);
        },
      });
    })().catch((error) => {
      workerPromise = null; // let the next attempt retry rather than wedging
      throw error;
    });
  }
  return workerPromise;
}

export async function releaseReader() {
  const pending = workerPromise;
  workerPromise = null;
  try {
    (await pending)?.terminate();
  } catch {
    /* nothing useful to do if teardown fails */
  }
}

export class LocalReadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalReadError';
  }
}

/** Reads one image and returns the raw extraction shape. */
export async function readLocally(blob, { onProgress } = {}) {
  if (blob.type === 'application/pdf') {
    throw new LocalReadError(
      'On-device reading only handles photos, not PDFs. Photograph the page, or fill this one in by hand.',
    );
  }

  let result;
  try {
    const worker = await getWorker(onProgress);
    result = await worker.recognize(blob);
  } catch (error) {
    throw new LocalReadError(
      `Could not run the on-device reader: ${error?.message ?? 'unknown error'}`,
    );
  }

  return parseDocumentText(result.data.text ?? '', result.data.confidence ?? 0);
}

// ---------------------------------------------------------------- parsing

/**
 * Decisive markers, checked in this order before any counting.
 *
 * Counting keywords alone cannot separate a Cypriot passport from a Cypriot
 * identity card — both say REPUBLIC OF CYPRUS — so the word "passport" has to
 * outrank the country. Order runs most specific to least: a residence visa is
 * printed inside a passport and mentions both, and a vehicle document names its
 * insurer, so the narrower document wins first.
 */
const DECISIVE_TYPES = [
  ['vehicle_registration', ['traffic plate', 'mulkiya', 'chassis no', 'vehicle registration']],
  ['car_insurance', ['motor insurance', 'insurance policy', 'period of insurance', 'policy no', 'policy number']],
  ['health_insurance', ['health insurance', 'medical insurance', 'member id', 'payer name']],
  ['driving_license', ['driving licence', 'driving license', 'driver licence', 'driver license', 'traffic code']],
  ['residency_visa', ['entry permit', 'residence visa', 'residency permit', 'u.i.d', 'uid no']],
  ['passport', ['passport']],
  ['emirates_id', ['resident identity card', 'emirates id', 'united arab emirates identity']],
  ['cyprus_id', ['republic of cyprus', 'kypriaki', 'cypriot identity']],
];

/** Weaker signals, counted only when nothing decisive matched. */
const TYPE_KEYWORDS = [
  ['emirates_id', ['identity card', 'id number', 'united arab emirates']],
  ['cyprus_id', ['cyprus', 'cypriot', 'dimokratia']],
  ['passport', ['travel document', 'place of birth', 'date of issue']],
  ['driving_license', ['licence no', 'license no', 'permitted vehicles']],
  ['residency_visa', ['residence', 'residency', 'sponsor', 'profession']],
  ['vehicle_registration', ['reg date', 'ins exp', 'vehicle licence', 'model']],
  ['car_insurance', ['comprehensive', 'third party', 'insured']],
  ['health_insurance', ['plan name', 'network', 'policy holder']],
];

const EXPIRY_LABELS = ['expiry', 'expires', 'expiring', 'valid until', 'valid till', 'valid thru', 'date of expiry', 'exp date', 'exp.', 'to date', 'expiry date'];
/**
 * Insurance certificates rarely say "expiry" — they print a cover period as
 * "Period of Insurance: from 01/02/2026 to 31/01/2027". Both dates sit on one
 * line, and the later one is the expiry.
 */
const PERIOD_LABELS = ['period of insurance', 'period of cover', 'policy period', 'valid from', 'insurance period'];
const ISSUE_LABELS = ['issue', 'issued', 'date of issue', 'issuing date', 'issue date', 'from date', 'reg date'];
// Dates on these lines are never an expiry or an issue date.
const BIRTH_LABELS = ['birth', 'dob', 'd.o.b', 'born'];

const DATE_PATTERNS = [
  /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g,          // 2027-05-12
  /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/g,        // 12/05/2027
  /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{2,4})\b/g,   // 12 May 2027
];

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n) => String(n).padStart(2, '0');

function iso(y, m, d) {
  if (y < 100) y += y > 60 ? 1900 : 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const candidate = `${y}-${pad(m)}-${pad(d)}`;
  return isValidISODate(candidate) ? candidate : null;
}

/** Every date on a line, read DD/MM first as UAE documents print it. */
function datesIn(line) {
  const text = normaliseDigits(line);
  const found = [];

  for (const [i, pattern] of DATE_PATTERNS.entries()) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      let value = null;
      if (i === 0) {
        value = iso(+match[1], +match[2], +match[3]);
      } else if (i === 1) {
        const a = +match[1];
        const b = +match[2];
        // Prefer DD/MM; fall back to MM/DD only when the first part cannot be a day.
        value = iso(+match[3], b, a) ?? iso(+match[3], a, b);
      } else {
        const month = MONTHS[match[2].slice(0, 3).toLowerCase()];
        if (month) value = iso(+match[3], month, +match[1]);
      }
      if (value) found.push(value);
    }
  }
  return found;
}

const has = (line, labels) => labels.some((label) => line.includes(label));

const EMIRATES_ID = /\b784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d\b/;
const LABELLED_NUMBER = /(?:no|number|nbr|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\-/]{4,})/i;
const NAME_LABEL = /\bname\s*[:.\-]?\s*([A-Za-z][A-Za-z'\- ]{2,})/i;
const NATIONALITY_LABEL = /\b(?:nationality|issuing country|country code)\s*[:.\-]?\s*([A-Za-z][A-Za-z ]{2,})/i;

/**
 * Turns raw OCR text into the same object the model returns.
 *
 * Confidence is deliberately pessimistic. A field found next to its printed
 * label scores above the review threshold; a field inferred from position or
 * from "the latest date on the card" scores below it, so the review queue picks
 * it up. Over-flagging costs the user a tap; under-flagging costs a renewal.
 */
export function parseDocumentText(rawText, ocrConfidence = 0) {
  const text = normaliseDigits(rawText);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lower = text.toLowerCase();

  // A blurry scan drags every field's confidence down with it.
  const quality = Math.max(0, Math.min(1, ocrConfidence / 100));
  const scale = (n) => Math.round(Math.max(0, Math.min(1, n * (0.55 + quality * 0.45))) * 100) / 100;

  // --- type ---------------------------------------------------------------
  let type = '';
  let typeConfidence = 0;

  const decisive = DECISIVE_TYPES.find(([, markers]) => markers.some((m) => lower.includes(m)));
  if (decisive) {
    [type] = decisive;
    typeConfidence = scale(0.88);
  } else {
    let bestHits = 0;
    for (const [candidate, keywords] of TYPE_KEYWORDS) {
      const hits = keywords.filter((k) => lower.includes(k)).length;
      if (hits > bestHits) {
        bestHits = hits;
        type = candidate;
      }
    }
    typeConfidence = bestHits > 0 ? scale(bestHits >= 2 ? 0.72 : 0.55) : 0;
    if (bestHits === 0) type = '';
  }

  // --- dates --------------------------------------------------------------
  const labelledExpiry = [];
  const labelledIssue = [];
  const loose = [];

  for (const line of lines) {
    const lineLower = line.toLowerCase();
    const dates = datesIn(line);
    if (dates.length === 0) continue;
    if (has(lineLower, BIRTH_LABELS)) continue; // a date of birth is neither
    if (has(lineLower, PERIOD_LABELS) && dates.length >= 2) {
      const sorted = [...dates].sort();
      labelledIssue.push(sorted[0]);
      labelledExpiry.push(sorted.at(-1));
    } else if (has(lineLower, EXPIRY_LABELS)) labelledExpiry.push(...dates);
    else if (has(lineLower, ISSUE_LABELS)) labelledIssue.push(...dates);
    else loose.push(...dates);
  }

  const today = new Date().toISOString().slice(0, 10);
  let expiry = '';
  let expiryConfidence = 0;
  let issue = '';
  let issueConfidence = 0;

  if (labelledExpiry.length > 0) {
    // Several dates on the expiry line: the furthest out is the expiry.
    expiry = labelledExpiry.sort().at(-1);
    expiryConfidence = scale(0.85);
  } else {
    // No label found. The latest future date on the card is the usual
    // candidate, but that is an inference, so it scores below the review
    // threshold on purpose and lands in "needs checking".
    const future = [...loose, ...labelledIssue].filter((d) => d > today).sort();
    if (future.length > 0) {
      expiry = future.at(-1);
      expiryConfidence = scale(0.45);
    }
  }

  if (labelledIssue.length > 0) {
    issue = labelledIssue.sort()[0];
    issueConfidence = scale(0.8);
  } else {
    const past = loose.filter((d) => d < today && d !== expiry).sort();
    if (past.length > 0) {
      issue = past.at(-1);
      issueConfidence = scale(0.4);
    }
  }

  // --- number -------------------------------------------------------------
  let number = '';
  let numberConfidence = 0;
  const emiratesId = text.match(EMIRATES_ID);
  if (emiratesId) {
    number = emiratesId[0].replace(/\s/g, '-');
    numberConfidence = scale(0.9);
  } else {
    for (const line of lines) {
      const match = line.match(LABELLED_NUMBER);
      if (match) {
        number = match[1].trim();
        numberConfidence = scale(0.55);
        break;
      }
    }
  }

  // --- name ---------------------------------------------------------------
  let name = '';
  let nameConfidence = 0;
  for (const line of lines) {
    const match = line.match(NAME_LABEL);
    if (match) {
      const candidate = match[1].trim().replace(/\s{2,}/g, ' ');
      if (candidate.length >= 3 && candidate.split(' ').length <= 6) {
        name = candidate;
        // A name printed next to its own "Name:" label, in Latin script, is one
        // of the more reliable things OCR gets off these cards — confident
        // enough to file under, which matters because otherwise every single
        // document would land under "Unknown holder".
        nameConfidence = scale(0.78);
        break;
      }
    }
  }

  // --- label ---------------------------------------------------------------
  // Only worth guessing for the types a household tends to hold two of.
  let label = '';
  if (type === 'passport') {
    for (const line of lines) {
      const match = line.match(NATIONALITY_LABEL);
      if (match) {
        label = match[1].trim().split(/\s+/).slice(0, 2).join(' ');
        break;
      }
    }
  }

  // --- warnings -----------------------------------------------------------
  const warnings = [];
  if (!expiry) warnings.push('No expiry date could be found on this photo.');
  else if (expiryConfidence < 0.7) {
    warnings.push('The expiry date was guessed from the dates on the card — please confirm it.');
  }
  if (!type) warnings.push('Could not tell what kind of document this is.');
  if (!name) warnings.push('No name was readable — pick the right person yourself.');
  if (quality < 0.6) {
    warnings.push('The photo was hard to read. A flatter, brighter shot would help.');
  }

  const overall = [typeConfidence, expiryConfidence, numberConfidence].filter(Boolean);

  return {
    document_type: type,
    holder_name_guess: name,
    id_number_guess: number,
    label_guess: label,
    issue_date: issue,
    expiry_date: expiry,
    confidence: overall.length
      ? Math.round((overall.reduce((a, b) => a + b, 0) / overall.length) * 100) / 100
      : 0,
    field_confidence: {
      document_type: typeConfidence,
      holder_name_guess: nameConfidence,
      id_number_guess: numberConfidence,
      issue_date: issueConfidence,
      expiry_date: expiryConfidence,
    },
    warnings,
  };
}
