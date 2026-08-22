/**
 * Automatic filing.
 *
 * A document that reads cleanly is saved without asking anything: the type, the
 * holder, the number, the dates and the reminders all get set from the photo.
 * Anything the reader was unsure about is still saved — losing an upload would
 * be worse — but flagged so the dashboard can ask about it later.
 *
 * The one field that always earns a flag when it is shaky is the expiry date.
 * Everything else in this app is decoration around getting that date right.
 */
import { db, addDocument, findOrCreateMember, matchMemberByName } from '../db.js';
import { LOW_CONFIDENCE, documentType } from './constants.js';
import { isValidISODate } from './dates.js';

export const UNKNOWN_HOLDER = 'Unknown holder';

/**
 * Works out which family member a document belongs to.
 *
 *   - a confident name that matches someone   → that person
 *   - a confident name that matches nobody    → create them
 *   - no readable name, and only one person on file → that person
 *   - no readable name, and several           → a holding record, flagged
 */
export async function resolveMember(extraction) {
  const name = extraction.fields.holder_name.value;
  const confident = name && extraction.fields.holder_name.confidence >= LOW_CONFIDENCE;
  const members = await db.members.toArray();

  if (confident) {
    const { member, created } = await findOrCreateMember(name);
    return { member, created, uncertain: false };
  }

  // A name read with low confidence is still worth matching against people
  // already on file — a shaky read of a name we know is better than a new record.
  if (name) {
    const guess = matchMemberByName(name, members);
    if (guess) return { member: guess, created: false, uncertain: false };
  }

  if (members.length === 1) {
    return { member: members[0], created: false, uncertain: false };
  }

  const { member, created } = await findOrCreateMember(UNKNOWN_HOLDER);
  return { member, created, uncertain: true };
}

/**
 * Plain-language reasons this document should be looked at. An empty list means
 * it filed itself cleanly and nobody needs to see it again.
 */
export function reviewReasons(extraction, { holderUncertain = false } = {}) {
  const reasons = [];
  const f = extraction.fields;

  if (!isValidISODate(f.expiry_date.value)) {
    reasons.push('No expiry date could be read — reminders will not fire until you add one.');
  } else if (f.expiry_date.confidence < LOW_CONFIDENCE) {
    reasons.push('The expiry date was hard to read.');
  }

  if (!f.type.value) reasons.push('The document type was not obvious.');
  if (holderUncertain) reasons.push('Could not tell whose document this is.');
  if (f.number.value && f.number.confidence < LOW_CONFIDENCE) {
    reasons.push('The document number may be wrong.');
  }

  return reasons.concat(extraction.warnings);
}

/**
 * An upload of something already on file. Same person, same type, and either
 * the same number or the same expiry date — a genuine renewal changes both, so
 * this does not swallow one.
 */
export async function findDuplicate({ memberId, type, number, expiryDate }) {
  const candidates = await db.documents
    .where('member_id')
    .equals(memberId)
    .filter((d) => d.status === 'active' && d.type === type)
    .toArray();

  return (
    candidates.find(
      (d) =>
        (number && d.number && d.number === number) ||
        (expiryDate && d.expiry_date && d.expiry_date === expiryDate),
    ) ?? null
  );
}

/**
 * The whole automatic path for one file: decide the holder, check it is not
 * already on file, save it, and report what happened in words the user can read.
 */
export async function fileDocument({ prepared, extraction }) {
  const { member, created, uncertain } = await resolveMember(extraction);
  const f = extraction.fields;

  const type = f.type.value ?? 'other';
  const number = f.number.value ?? '';
  const expiry = isValidISODate(f.expiry_date.value) ? f.expiry_date.value : '';

  const duplicate = await findDuplicate({
    memberId: member.id,
    type,
    number,
    expiryDate: expiry,
  });
  if (duplicate) {
    return {
      outcome: 'duplicate',
      member,
      memberCreated: created,
      documentId: duplicate.id,
      type,
      reasons: [],
    };
  }

  const reasons = reviewReasons(extraction, { holderUncertain: uncertain });

  const documentId = await addDocument({
    member_id: member.id,
    type,
    number,
    issue_date: isValidISODate(f.issue_date.value) ? f.issue_date.value : '',
    expiry_date: expiry,
    notes: '',
    photo: prepared.blob,
    photo_type: prepared.mediaType,
    file_kind: prepared.kind,
    review_needed: reasons.length > 0 ? 1 : 0,
    extraction: {
      confidence: extraction.confidence,
      model: extraction.model,
      extracted_at: extraction.extracted_at,
      warnings: extraction.warnings,
      needsReview: extraction.needsReview,
    },
  });

  return {
    outcome: reasons.length > 0 ? 'needs_review' : 'filed',
    member,
    memberCreated: created,
    documentId,
    type,
    reasons,
  };
}

/** One-line summary of a filing result, for the upload queue. */
export function describeResult(result) {
  const label = documentType(result.type).label;
  switch (result.outcome) {
    case 'filed':
      return `${label} filed under ${result.member.name}`;
    case 'needs_review':
      return `${label} saved for ${result.member.name} — needs checking`;
    case 'duplicate':
      return `${label} for ${result.member.name} is already on file`;
    default:
      return label;
  }
}
