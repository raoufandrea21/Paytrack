/**
 * What a file's name and its folder already tell us.
 *
 * People organise documents long before they hand them to software, and this
 * household's filing is better than anything a reader can infer from a
 * photograph: a folder per person, and the expiry year written into the
 * filename. Reading a name off a passport is the least reliable thing this app
 * does — the folder it sits in is free and exact.
 *
 * Everything here is pure string work, so it is cheap and testable, and it runs
 * before a single pixel is recognised.
 */

/** Folders that group documents by kind or state rather than by person. */
const CATEGORY_FOLDERS = new Set([
  'cyprus ids', "cyprus id's", 'golden visa files', 'other passport copied',
  'vaccine reports', 'passports', 'visas', 'insurance', 'documents',
  'scans', 'scanned', 'misc', 'other', 'photos', 'certificates',
]);

/** Folders whose children are people, with the relation that implies. */
const GROUP_FOLDERS = new Map([
  ['maids', 'Housemaid'],
  ['maid', 'Housemaid'],
  ['staff', 'Other'],
  ['drivers', 'Driver'],
  ['nannies', 'Nanny'],
  ['pets', 'Pet'],
]);

/** A folder that says these documents are done with. */
const ARCHIVE_FOLDERS = new Set(['expired', 'old', 'archive', 'archived', 'previous']);

const clean = (segment) => String(segment ?? '').trim();
const key = (segment) => clean(segment).toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');

/**
 * A file whose name says it is a portrait rather than a document. These are
 * passport photos: real files, but nothing about them expires, and each one
 * filed as a document is a junk record to delete by hand.
 */
const PHOTO_NAMES = [
  /^photo$/i,
  /personal\s*photo/i,
  /passport\s*(size\s*)?photo/i,
  /^img[_\-\s]?\d+$/i,
  /^dsc[_\-\s]?\d+$/i,
  /^(photo|picture|headshot|portrait|selfie)[_\-\s]?\d*$/i,
  /^screenshot/i,
];

export function looksLikePortrait(baseName) {
  const name = clean(baseName);
  return PHOTO_NAMES.some((pattern) => pattern.test(name));
}

/**
 * Which side of a two-sided card this is. An Emirates ID photographed front and
 * back is one document, but the back carries no expiry date, so nothing else
 * links the two files.
 */
export function readSide(baseName) {
  const match = clean(baseName).match(/\b(front|back|rear|reverse)\b/i);
  if (!match) return null;
  return /front/i.test(match[1]) ? 'front' : 'back';
}

/** The same card's two sides share everything except the side word. */
export function pairingKey(baseName) {
  return key(baseName).replace(/\b(front|back|rear|reverse)\b/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * A four-digit year in the filename. These name files by when they run out —
 * "Raouf Passport 2036" — which is the most important field in the app sitting
 * in plain text. Taken as the last plausible year in the name, since a document
 * number can contain four digits too.
 */
export function readYear(baseName, { today = new Date() } = {}) {
  const thisYear = today.getFullYear();
  const years = [...clean(baseName).matchAll(/\b(19|20)\d{2}\b/g)]
    .map((m) => Number(m[0]))
    // A document is named for when it expires, not when the holder was born.
    .filter((year) => year >= thisYear - 15 && year <= thisYear + 60);
  return years.length ? years.at(-1) : null;
}

const stripExtension = (name) => clean(name).replace(/\.[a-z0-9]{1,5}$/i, '');

/**
 * What the filename says the document is.
 *
 * People name a file after what it is — "Lily Birth Certificate Arabic",
 * "Lily Visa 2036" — and that is a far stronger signal than text recognition
 * scraping a scan. It is decisive where recognition is easily fooled: a birth
 * certificate carries the parents' passport numbers, so the word "passport"
 * appears on it, and a UAE visa page quotes an Emirates ID number.
 *
 * Order matters. The first match wins, so the specific phrases come before the
 * general ones.
 */
const TYPE_FROM_NAME = [
  // "birth cer…" rather than the whole word: real filenames carry typos
  // ("Lily Birth ceritificate English") and digits glued straight on
  // ("New Digital Birth Certificate6788098253517130371").
  ['birth_certificate', /\bbirth\s*cer/i],
  ['marriage_certificate', /\bmarriage\b/i],
  ['power_of_attorney', /\bpower\s*of\s*attorney\b|\bpoa\b|توكيل/i],
  ['education_certificate', /\buniversity\b|\bdiploma\b|\bdegree\b|\bgraduation\b|\btranscript\b|\beducation\s*cer/i],
  ['vaccination', /\bvaccin|\bimmunis|\bimmuniz/i],
  ['driving_license', /\bdriving\s*licen[cs]e\b|\bdriver'?s?\s*licen[cs]e\b/i],
  ['vehicle_registration', /\bmulkiya\b|\bvehicle\s*(registration|licen[cs]e)\b|\bcar\s*licen[cs]e\b|\btraffic\s*plate\b/i],
  ['car_insurance', /\b(car|motor|vehicle)\s*insur/i],
  ['health_insurance', /\bhealth\s*insur|\bmedical\s*insur|\binsurance\s*card\b/i],
  ['residency_visa', /\bgolden\s*visa\b|\bresidenc\w*\b|\bvisa\b|\bentry\s*permit\b/i],
  ['cyprus_id', /\bcyprus\s*id\b|\bcypriot\s*id\b/i],
  ['emirates_id', /\beid\b|\bemirates\s*id\b/i],
  ['passport', /\bpassport\b/i],
];

export function readDocumentType(baseName) {
  const name = clean(baseName);
  for (const [type, pattern] of TYPE_FROM_NAME) {
    if (pattern.test(name)) return type;
  }
  return null;
}

/**
 * Reads everything a path offers.
 *
 * `relativePath` is what the browser gives for a folder upload — the path
 * inside the chosen folder. Without one, only the filename is available.
 */
export function readPath(fullPath, { today = new Date() } = {}) {
  const segments = String(fullPath ?? '').split('/').map(clean).filter(Boolean);
  const filename = segments.pop() ?? '';
  const baseName = stripExtension(filename);

  let archived = false;
  const folders = [...segments];

  // Trailing "Expired" describes the documents, not their owner.
  while (folders.length && ARCHIVE_FOLDERS.has(key(folders.at(-1)))) {
    archived = true;
    folders.pop();
  }

  let person = null;
  let relation = null;
  let skippedCategory = false;

  for (let i = folders.length - 1; i >= 0; i -= 1) {
    const folder = folders[i];
    const folderKey = key(folder);

    if (CATEGORY_FOLDERS.has(folderKey)) {
      skippedCategory = true;
      continue; // says what, not who
    }

    // Folder 0 is the tree the user chose. It is a person only when documents
    // sit directly inside it — they picked one person's folder. Arriving here
    // by climbing past a category folder means the opposite: the root is the
    // whole collection, and "Familly Documents & ID's" is nobody.
    if (i === 0 && skippedCategory && folders.length > 1) break;

    const parentKey = key(folders[i - 1] ?? '');
    if (GROUP_FOLDERS.has(folderKey)) {
      // "Maids" itself is not a person; a folder inside it is.
      break;
    }
    if (GROUP_FOLDERS.has(parentKey)) {
      person = folder;
      relation = GROUP_FOLDERS.get(parentKey);
      break;
    }

    person = folder;
    break;
  }

  return {
    filename,
    baseName,
    person,
    relation,
    archived,
    type: readDocumentType(baseName),
    year: readYear(baseName, { today }),
    side: readSide(baseName),
    pairKey: pairingKey(baseName),
    portrait: looksLikePortrait(baseName),
  };
}

/**
 * Folds "… Front" and "… Back" into a single entry before anything is read.
 *
 * They are one card. The back carries no expiry date and often no number, so
 * nothing downstream can tell it is a second view of a document already filed —
 * it just becomes a sparse duplicate record.
 */
export function pairSides(entries) {
  const bySide = new Map();
  for (const entry of entries) {
    if (!entry.hints.side) continue;
    const key = `${entry.hints.person ?? ''}|${entry.hints.pairKey}`;
    if (!bySide.has(key)) bySide.set(key, {});
    bySide.get(key)[entry.hints.side] = entry;
  }

  const absorbed = new Set();
  for (const pair of bySide.values()) {
    if (pair.front && pair.back) absorbed.add(pair.back);
  }

  return entries
    .filter((entry) => !absorbed.has(entry))
    .map((entry) => {
      if (entry.hints.side !== 'front') return entry;
      const key = `${entry.hints.person ?? ''}|${entry.hints.pairKey}`;
      const back = bySide.get(key)?.back;
      return back ? { ...entry, backFile: back.file } : entry;
    });
}
