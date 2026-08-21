import { DOCUMENT_TYPE_IDS } from '../../shared/extraction-spec.js';

export { DOCUMENT_TYPE_IDS };

export const DOCUMENT_TYPES = [
  { id: 'emirates_id', label: 'Emirates ID', icon: '🪪' },
  { id: 'driving_license', label: 'Driving Licence', icon: '🚗' },
  { id: 'passport', label: 'Passport', icon: '🛂' },
  { id: 'residency_visa', label: 'Residency Visa', icon: '📄' },
  { id: 'vehicle_registration', label: 'Vehicle Registration', icon: '🚙' },
  { id: 'car_insurance', label: 'Car Insurance', icon: '🛡️' },
  { id: 'health_insurance', label: 'Health Insurance', icon: '🏥' },
  { id: 'other', label: 'Other', icon: '📎' },
];

const TYPE_INDEX = Object.fromEntries(DOCUMENT_TYPES.map((t) => [t.id, t]));

export function documentType(id) {
  return TYPE_INDEX[id] ?? TYPE_INDEX.other;
}

export const RELATIONS = [
  'Self',
  'Spouse',
  'Son',
  'Daughter',
  'Father',
  'Mother',
  'Brother',
  'Sister',
  'Other',
];

/** Days before expiry at which a reminder fires. Ordered most urgent first. */
export const REMINDER_THRESHOLDS = [7, 30, 60];

/** Below this, a Claude-extracted field is shown as "check this" rather than accepted. */
export const LOW_CONFIDENCE = 0.7;

export const EXTRACTION_MODES = {
  PROXY: 'proxy',
  DIRECT: 'direct',
  OFF: 'off',
};
