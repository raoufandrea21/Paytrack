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
import { db, addDocument, findOrCreateMember, matchMemberByName, renewDocument } from '../db.js';
import { LOW_CONFIDENCE, documentLabel, typeIsPermanent } from './constants.js';
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
export async function resolveMember(extraction, hints = {}) {
  // A folder name beats a name read off a photograph every time: it was typed
  // by a person who knew whose document it was, and it cannot be misread.
  if (hints.person) {
    const { member, created } = await findOrCreateMember(hints.person, {
      relation: hints.relation ?? 'Other',
    });
    return { member, created, uncertain: false, fromFolder: true };
  }

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

  // A shaky name that matches nobody still beats a nameless bucket: the user
  // sees something they can recognise and rename. It is flagged either way.
  if (name) {
    const { member, created } = await findOrCreateMember(name);
    return { member, created, uncertain: true };
  }

  const { member, created } = await findOrCreateMember(UNKNOWN_HOLDER);
  return { member, created, uncertain: true };
}

/**
 * Plain-language reasons this document should be looked at. An empty list means
 * it filed itself cleanly and nobody needs to see it again.
 */
export function reviewReasons(extraction, { holderUncertain = false, type, filenameYear } = {}) {
  const reasons = [];
  const f = extraction.fields;
  const expiry = f.expiry_date.value;
  const permanent = typeIsPermanent(type ?? f.type.value);

  if (permanent) {
    // A birth certificate has no expiry date. Asking for one forever is noise.
  } else if (!isValidISODate(expiry)) {
    if (filenameYear) {
      reasons.push(
        `No expiry date was found on the document, but the filename says ${filenameYear} — set the exact date so reminders can fire.`,
      );
    } else {
      reasons.push('No expiry date could be read — reminders will not fire until you add one.');
    }
  } else if (f.expiry_date.confidence < LOW_CONFIDENCE) {
    reasons.push('The expiry date was hard to read.');
  } else if (filenameYear && Number(expiry.slice(0, 4)) !== filenameYear) {
    // Two independent statements of the same fact disagreeing is worth more
    // attention than either being merely unclear.
    reasons.push(
      `The document reads ${expiry.slice(0, 4)} but the filename says ${filenameYear} — one of them is wrong.`,
    );
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
const sameLabel = (a, b) =>
  String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * Documents of the same kind already on file for this person. Label is part of
 * the identity: two passports for one person are two different documents, not
 * two copies of one, once they are labelled "Cypriot" and "Lebanese".
 */
async function siblings({ memberId, type, label }) {
  return db.documents
    .where('member_id')
    .equals(memberId)
    .filter((d) => d.status === 'active' && d.type === type && sameLabel(d.label, label))
    .toArray();
}

export async function findDuplicate({ memberId, type, label, number, expiryDate }) {
  const candidates = await siblings({ memberId, type, label });
  return (
    candidates.find(
      (d) =>
        (number && d.number && d.number === number) ||
        (expiryDate && d.expiry_date && d.expiry_date === expiryDate),
    ) ?? null
  );
}

/**
 * The same document, renewed. Same person, same kind, same label, but running
 * later than the copy on file — so the old record should be archived and linked
 * rather than left sitting alongside the new one with stale reminders.
 *
 * Only fires when there is exactly one candidate. Two existing passports and an
 * unlabelled upload is a question, not an answer, so that case just files
 * normally and the review queue picks it up.
 */
export async function findRenewalTarget({ memberId, type, label, expiryDate }) {
  if (!expiryDate) return null;
  const candidates = (await siblings({ memberId, type, label })).filter(
    (d) => d.expiry_date && d.expiry_date < expiryDate,
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * The whole automatic path for one file: decide the holder, check it is not
 * already on file, save it, and report what happened in words the user can read.
 */
export async function fileDocument({ prepared, extraction, hints = {} }) {
  const { member, created, uncertain } = await resolveMember(extraction, hints);
  const f = extraction.fields;

  const type = f.type.value ?? 'other';
  const label = f.label?.value ?? '';
  const number = f.number.value ?? '';
  const expiry = isValidISODate(f.expiry_date.value) ? f.expiry_date.value : '';
  const describe = { type, label };

  const duplicate = await findDuplicate({
    memberId: member.id,
    type,
    label,
    number,
    expiryDate: expiry,
  });
  if (duplicate) {
    return {
      outcome: 'duplicate',
      member,
      memberCreated: created,
      documentId: duplicate.id,
      ...describe,
      reasons: [],
    };
  }

  const reasons = reviewReasons(extraction, {
    holderUncertain: uncertain,
    type,
    filenameYear: hints.year ?? null,
  });

  const record = {
    member_id: member.id,
    type,
    label,
    number,
    issue_date: isValidISODate(f.issue_date.value) ? f.issue_date.value : '',
    expiry_date: expiry,
    no_expiry: typeIsPermanent(type) ? 1 : 0,
    // A document filed under "Expired" is history the moment it arrives.
    status: hints.archived ? 'archived' : 'active',
    notes: '',
    photo: prepared.blob,
    photo_back: prepared.back ?? null,
    photo_type: prepared.mediaType,
    file_kind: prepared.kind,
    review_needed: reasons.length > 0 && !hints.archived ? 1 : 0,
    extraction: {
      confidence: extraction.confidence,
      model: extraction.model,
      extracted_at: extraction.extracted_at,
      warnings: extraction.warnings,
      needsReview: extraction.needsReview,
    },
  };

  // An upload that runs later than the copy on file is that document renewed.
  // renewDocument archives the old row, links the new one to it, and clears the
  // old reminders so the milestones re-arm against the new expiry date.
  const renewing = await findRenewalTarget({ memberId: member.id, type, label, expiryDate: expiry });
  if (renewing) {
    const documentId = await renewDocument(renewing.id, record);
    return {
      outcome: 'renewed',
      member,
      memberCreated: created,
      documentId,
      replacedId: renewing.id,
      previousExpiry: renewing.expiry_date,
      ...describe,
      reasons,
    };
  }

  const documentId = await addDocument(record);

  return {
    outcome: hints.archived ? 'archived' : reasons.length > 0 ? 'needs_review' : 'filed',
    member,
    memberCreated: created,
    documentId,
    ...describe,
    reasons,
  };
}

/** One-line summary of a filing result, for the upload queue. */
export function describeResult(result) {
  const label = documentLabel(result);
  switch (result.outcome) {
    case 'filed':
      return `${label} filed under ${result.member.name}`;
    case 'archived':
      return `${label} filed as expired for ${result.member.name}`;
    case 'portrait':
      return `${result.filename} looks like a personal photo — skipped`;
    case 'needs_review':
      return `${label} saved for ${result.member.name} — needs checking`;
    case 'renewed':
      return `${label} renewed for ${result.member.name} — the old one is archived`;
    case 'duplicate':
      return `${label} for ${result.member.name} is already on file`;
    default:
      return label;
  }
}
