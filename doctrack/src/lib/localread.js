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
import { readMrz, reconcileName } from './mrz.js';
import { extractPdfText, hasUsefulText, renderPdfPages } from './pdf.js';

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

/**
 * Renders an image for OCR.
 *
 * Bigger than the copy we store, and greyscale with the contrast pushed: an MRZ
 * line is 44 characters across the page, so at the 1600px we keep for display
 * each glyph is only a dozen pixels wide and Tesseract starts inventing
 * characters. `cropTop` isolates the MRZ strip at the foot of the document.
 */
async function renderForOcr(blob, { maxEdge = 2400, cropTop = 0 } = {}) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const sourceY = Math.floor(bitmap.height * cropTop);
    const sourceHeight = bitmap.height - sourceY;
    const scale = Math.min(2, maxEdge / Math.max(bitmap.width, sourceHeight));

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(
      bitmap, 0, sourceY, bitmap.width, sourceHeight,
      0, 0, canvas.width, canvas.height,
    );

    // Greyscale, then a contrast stretch around mid-grey. Passport pages are
    // pale security patterns behind dark text; flattening the colour and
    // pushing them apart is most of what a scanner app does.
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = image.data;
    for (let i = 0; i < px.length; i += 4) {
      const grey = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      const boosted = Math.max(0, Math.min(255, (grey - 128) * 1.6 + 128));
      px[i] = boosted;
      px[i + 1] = boosted;
      px[i + 2] = boosted;
    }
    ctx.putImageData(image, 0, 0);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (out) => (out ? resolve(out) : reject(new Error('Could not prepare the image.'))),
        'image/png',
      );
    });
  } finally {
    bitmap.close?.();
  }
}

const MRZ_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';

/**
 * Reads one document — photo or PDF — and returns the raw extraction shape.
 *
 * A PDF is tried three ways, cheapest and most accurate first: its text layer,
 * then its pages rendered and run through OCR, and only then given up on. Most
 * documents that arrive by email have a text layer, which means the characters
 * come out exactly as they were written rather than as a machine's best guess.
 */
export async function readLocally(blob, { onProgress } = {}) {
  if (blob.type === 'application/pdf') return readPdf(blob, { onProgress });
  return readImage(blob, { onProgress });
}

async function readPdf(blob, { onProgress }) {
  let text = '';
  let pages = 1;
  try {
    ({ text, pages } = await extractPdfText(blob));
  } catch (error) {
    throw new LocalReadError(`Could not open that PDF: ${error?.message ?? 'unknown error'}`);
  }

  if (hasUsefulText(text)) {
    // A real text layer: exact characters, so confidence is capped only by how
    // well the parser understands the layout, not by character recognition.
    const parsed = parseDocumentText(text, 95, readMrz(text));
    if (pages > 5) {
      parsed.warnings.push(`Only the first 5 of ${pages} pages were read.`);
    }
    return parsed;
  }

  // No text layer — it is a scan wrapped in a PDF, so treat the pages as photos.
  let images;
  try {
    images = await renderPdfPages(blob, { pages: 2 });
  } catch (error) {
    throw new LocalReadError(`Could not render that PDF: ${error?.message ?? 'unknown error'}`);
  }
  if (images.length === 0) throw new LocalReadError('That PDF has no pages to read.');

  const worker = await startWorker(onProgress);
  const reads = [];
  for (const image of images) {
    const result = await worker.recognize(image);
    reads.push(result.data);
  }
  const combined = reads.map((d) => d.text ?? '').join('\n');
  const confidence = reads.reduce((sum, d) => sum + (d.confidence ?? 0), 0) / reads.length;
  return parseDocumentText(combined, confidence, readMrz(combined));
}

async function startWorker(onProgress) {
  try {
    return await getWorker(onProgress);
  } catch (error) {
    throw new LocalReadError(
      `Could not start the on-device reader: ${error?.message ?? 'unknown error'}`,
    );
  }
}

async function readImage(blob, { onProgress }) {
  const worker = await startWorker(onProgress);

  let text = '';
  let confidence = 0;
  try {
    const page = await renderForOcr(blob);
    const result = await worker.recognize(page);
    text = result.data.text ?? '';
    confidence = result.data.confidence ?? 0;
  } catch (error) {
    throw new LocalReadError(`Could not read the photo: ${error?.message ?? 'unknown error'}`);
  }

  let mrz = readMrz(text);

  // The MRZ is the most valuable thing on a passport and the hardest to catch
  // in a whole-page pass, so if the first read missed it, try again on just the
  // bottom third with the character set locked to what an MRZ can contain.
  if (!mrz) {
    try {
      const strip = await renderForOcr(blob, { maxEdge: 2600, cropTop: 0.66 });
      await worker.setParameters({ tessedit_char_whitelist: MRZ_WHITELIST });
      const result = await worker.recognize(strip);
      mrz = readMrz(result.data.text ?? '');
    } catch {
      /* the whole-page read still stands on its own */
    } finally {
      await worker.setParameters({ tessedit_char_whitelist: '' }).catch(() => {});
    }
  }

  return parseDocumentText(text, confidence, mrz);
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
const NAME_LABEL = /\b(?:sur)?names?\s*(?:\(\d\))?\s*[:.\-]?\s*(.*)$/i;

/**
 * Whether a scrap of OCR output could plausibly be somebody's name. Bilingual
 * documents stack three languages of label above each value, and without this
 * the reader happily files a passport under
 * "Taadigivennameszhuepcevvdateofbirth7".
 */
function looksLikeName(candidate) {
  const value = String(candidate ?? '').trim().replace(/\s{2,}/g, ' ');
  if (value.length < 3 || value.length > 40) return false;
  if (/[0-9]/.test(value)) return false;
  const words = value.split(' ');
  if (words.length > 4) return false;
  if (!words.every((w) => /^[A-Za-z][A-Za-z'-]{1,19}$/.test(w))) return false;
  // Label words that survive into the captured value.
  return !/\b(?:surname|given|adi|soyadi|type|code|nationality|sex|birth|issue|expiry|authority|holder|signature)\b/i.test(value);
}
const NATIONALITY_LABEL = /\b(?:nationality|issuing country|country code)\s*[:.\-]?\s*([A-Za-z][A-Za-z ]{2,})/i;

/**
 * Turns raw OCR text into the same object the model returns.
 *
 * Confidence is deliberately pessimistic. A field found next to its printed
 * label scores above the review threshold; a field inferred from position or
 * from "the latest date on the card" scores below it, so the review queue picks
 * it up. Over-flagging costs the user a tap; under-flagging costs a renewal.
 */
export function parseDocumentText(rawText, ocrConfidence = 0, mrz = null) {
  const text = normaliseDigits(rawText);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lower = text.toLowerCase();

  // Words from the laid-out side of the page, used to corroborate the MRZ name.
  // MRZ lines are excluded so a misread cannot confirm itself.
  const pageWords = lines
    .filter((line) => !/[<«»]/.test(line) && !/^[A-Z0-9]{20,}$/.test(line.replace(/\s/g, '')))
    .flatMap((line) => line.toUpperCase().match(/[A-Z]{3,}/g) ?? []);

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

  for (const [index, line] of lines.entries()) {
    const lineLower = line.toLowerCase();
    let dates = datesIn(line);

    // Passports and ID cards print labels in one column and values in another,
    // so OCR emits "Expires on (8)" and "13/01/2036" as separate lines. When a
    // label line carries no date of its own, take the next line's.
    let borrowed = false;
    if (dates.length === 0) {
      const labelled =
        has(lineLower, EXPIRY_LABELS) || has(lineLower, ISSUE_LABELS) || has(lineLower, BIRTH_LABELS);
      if (!labelled) continue;
      const next = lines[index + 1];
      if (!next || has(next.toLowerCase(), [...EXPIRY_LABELS, ...ISSUE_LABELS, ...BIRTH_LABELS])) {
        continue;
      }
      dates = datesIn(next);
      if (dates.length === 0) continue;
      borrowed = true;
    }

    if (has(lineLower, BIRTH_LABELS)) continue; // a date of birth is neither
    if (has(lineLower, PERIOD_LABELS) && dates.length >= 2) {
      const sorted = [...dates].sort();
      labelledIssue.push(sorted[0]);
      labelledExpiry.push(sorted.at(-1));
    } else if (has(lineLower, EXPIRY_LABELS)) labelledExpiry.push(...dates);
    else if (has(lineLower, ISSUE_LABELS)) labelledIssue.push(...dates);
    else if (!borrowed) loose.push(...dates);
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
    // A document number is mostly digits. Without this, OCR noise off a
    // decorative line ("18AYVEIAT") gets filed as a passport number.
    const plausible = (value) => /^[A-Z0-9][A-Z0-9\-/]{4,19}$/.test(value) && (value.match(/\d/g) ?? []).length >= 3;
    for (const [index, line] of lines.entries()) {
      const match = line.match(LABELLED_NUMBER);
      if (match && plausible(match[1].trim().toUpperCase())) {
        number = match[1].trim();
        // A number sitting immediately after its own printed label is a good
        // structural match. scale() still knocks it below the review threshold
        // when the characters themselves were read badly — which is the right
        // split: trust the position, doubt the glyphs.
        numberConfidence = scale(0.74);
        break;
      }
      // Label on one line, value on the next — the same column layout again.
      if (/\b(?:passport|licence|license|policy|document|id)\s*(?:no|number)\b/i.test(line)) {
        const next = (lines[index + 1] ?? '').trim().toUpperCase();
        if (plausible(next)) {
          number = next;
          numberConfidence = scale(0.62);
          break;
        }
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

  // Anything the MRZ provides wins. It is printed flat in OCR-B to be machine
  // read and every field carries a check digit, so a verified value is worth
  // more than the best guess off the decorated side of the same document.
  if (mrz) {
    if (mrz.isPassport) {
      type = 'passport';
      typeConfidence = 0.97;
    } else if (!type) {
      type = 'other';
      typeConfidence = 0.5;
    }
    if (mrz.nationality) label = mrz.nationality;
    if (mrz.name) {
      // The MRZ name is the one field down there with no check digit behind it.
      // The visual zone prints the same name in much larger type, so use that
      // second read to correct it — and when it cannot be corroborated, score it
      // below the review threshold rather than filing a stranger.
      const reconciled = reconcileName(mrz.name, pageWords);
      name = reconciled.name;
      nameConfidence = reconciled.corroborated ? 0.92 : 0.6;
      if (!reconciled.corroborated) {
        warnings.push(`Read the name as "${name}" — worth checking the spelling.`);
      }
    }
    if (mrz.number) {
      number = mrz.number;
      numberConfidence = mrz.checks.number ? 0.97 : 0.6;
    }
    if (mrz.expiryDate) {
      expiry = mrz.expiryDate;
      expiryConfidence = mrz.checks.expiryDate ? 0.97 : 0.55;
    }
    // An issue date is not in the MRZ, so a same-day-looking "issue" that
    // actually matches the date of birth has to be dropped.
    if (issue && issue === mrz.dateOfBirth) {
      issue = '';
      issueConfidence = 0;
    }
    if (!mrz.checks.expiryDate && mrz.expiryDate) {
      warnings.push('The expiry date came from a smudged machine-readable line — please confirm it.');
    }
  }

  if (!expiry) warnings.push('No expiry date could be found on this photo.');
  else if (expiryConfidence < 0.7) {
    warnings.push('The expiry date was guessed from the dates on the card — please confirm it.');
  }
  if (!type) warnings.push('Could not tell what kind of document this is.');
  if (!name) warnings.push('No name was readable — pick the right person yourself.');
  if (quality < 0.5 && !mrz) {
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
