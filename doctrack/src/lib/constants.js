import { DOCUMENT_TYPE_IDS } from '../../shared/extraction-spec.js';

export { DOCUMENT_TYPE_IDS };

export const DOCUMENT_TYPES = [
  { id: 'emirates_id', label: 'Emirates ID', icon: '🪪' },
  { id: 'cyprus_id', label: 'Cyprus ID', icon: '🆔' },
  { id: 'driving_license', label: 'Driving Licence', icon: '🚗' },
  { id: 'passport', label: 'Passport', icon: '🛂' },
  { id: 'residency_visa', label: 'Residency Visa', icon: '📄' },
  { id: 'vehicle_registration', label: 'Vehicle Registration', icon: '🚙' },
  { id: 'car_insurance', label: 'Car Insurance', icon: '🛡️' },
  { id: 'health_insurance', label: 'Health Insurance', icon: '🏥' },
  { id: 'vaccination', label: 'Vaccination Record', icon: '💉' },
  { id: 'birth_certificate', label: 'Birth Certificate', icon: '👶', permanent: true },
  { id: 'marriage_certificate', label: 'Marriage Certificate', icon: '💍', permanent: true },
  { id: 'power_of_attorney', label: 'Power of Attorney', icon: '⚖️' },
  { id: 'education_certificate', label: 'Education Certificate', icon: '🎓', permanent: true },
  { id: 'other', label: 'Other', icon: '📎' },
];

const TYPE_INDEX = Object.fromEntries(DOCUMENT_TYPES.map((t) => [t.id, t]));

export function documentType(id) {
  return TYPE_INDEX[id] ?? TYPE_INDEX.other;
}

/**
 * What to call a document on screen.
 *
 * `label` does two jobs. On "Other" it *is* the type — a tenancy contract, a
 * trade licence, whatever the built-in list does not cover. On any other type it
 * is a qualifier, which is what makes two passports for the same person
 * distinguishable: "Passport · Cypriot" and "Passport · Lebanese".
 */
export function documentLabel(doc) {
  const base = documentType(doc?.type).label;
  const extra = String(doc?.label ?? '').trim();
  if (!extra) return base;
  return doc.type === 'other' ? extra : `${base} · ${extra}`;
}

/** Labels used before, newest first, offered back as suggestions. */
export function previousLabels(documents = []) {
  const seen = new Map();
  for (const doc of documents) {
    const label = String(doc.label ?? '').trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (!seen.has(key)) seen.set(key, { label, at: doc.created_at ?? '' });
  }
  return [...seen.values()]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .map((entry) => entry.label);
}

export const RELATIONS = [
  'Me',
  'Spouse',
  'Son',
  'Daughter',
  'Father',
  'Mother',
  'Brother',
  'Sister',
  // A UAE household usually sponsors staff, whose visas and Emirates IDs expire
  // on the same schedule as everyone else's and are the sponsor's problem.
  'Housemaid',
  'Nanny',
  'Driver',
  // Vaccination records expire, and a boarding kennel will ask for them.
  'Pet',
  'Other',
];

/** Days before expiry at which a reminder fires. Ordered most urgent first. */
export const REMINDER_THRESHOLDS = [7, 30, 60];

/**
 * Kinds of document that have no expiry date by nature. A birth certificate is
 * filed, not tracked — treating its missing date as a problem would park it in
 * the review queue forever, complaining about something that does not exist.
 */
export function typeIsPermanent(id) {
  return Boolean(TYPE_INDEX[id]?.permanent);
}

/** Below this, a Claude-extracted field is shown as "check this" rather than accepted. */
export const LOW_CONFIDENCE = 0.7;

export const EXTRACTION_MODES = {
  /** Free. OCR runs in the browser; nothing leaves the device and nothing is billed. */
  LOCAL: 'local',
  /** Claude, with the API key held by a server endpoint. */
  PROXY: 'proxy',
  /** Claude, called straight from the page with a key stored on the device. */
  DIRECT: 'direct',
  OFF: 'off',
};

/** What a fresh install uses: the one that costs nothing and needs no account. */
export const DEFAULT_EXTRACTION_MODE = EXTRACTION_MODES.LOCAL;
