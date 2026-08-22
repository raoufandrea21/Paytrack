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
import {
  db, addDocument, findOrCreateMember, matchMemberByName, renewDocument, updateDocument,
} from '../db.js';
import { LOW_CONFIDENCE, documentLabel, typeIsPermanent } from './constants.js';
import { isValidISODate } from './dates.js';

export const UNKNOWN_HOLDER = 'Unknown holder';

const nameWords = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z\u00c0-\u024f\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * Which person on file, if any, is named inside a filename.
 *
 * Only people who already exist are candidates, and the match has to be their
 * whole name appearing as consecutive words — "Andreas Charalambous Passport"
 * finds Andreas, "Passport 2035" finds nobody. The longest match wins, so a
 * household with both "Andreas" and "Andreas Charalambous" resolves to the one
 * the filename actually spells out; a genuine tie is left unanswered rather
 * than guessed.
 */
export function memberNamedIn(baseName, members = []) {
  const words = nameWords(baseName);
  if (words.length === 0) return null;

  let best = null;
  let bestLength = 0;
  let tied = false;

  for (const member of members) {
    const target = nameWords(member.name);
    if (target.length === 0) continue;
    // A one-word name has to be a real word, not an initial that could fall
    // anywhere: "A Passport.jpg" must not become person "A".
    if (target.length === 1 && target[0].length < 3) continue;

    const found = words.some((_, i) => target.every((word, j) => words[i + j] === word));
    if (!found) continue;

    if (target.length > bestLength) {
      best = member;
      bestLength = target.length;
      tied = false;
    } else if (target.length === bestLength && best?.id !== member.id) {
      tied = true;
    }
  }

  return tied ? null : best;
}

/**
 * Works out which family member a document belongs to.
 *
 *   - a folder named after someone            → that person
 *   - a filename that names someone on file    → that person
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

  // "Raouf Andrea Driving Licence 2035.jpg", dropped straight into the watched
  // folder rather than into a per-person one. Only names of people already on
  // file count: matching loose words against nobody would invent a person out
  // of a document type. Typed by hand, so it still beats reading the photo.
  const named = memberNamedIn(hints.baseName ?? '', members);
  if (named) return { member: named, created: false, uncertain: false, fromFilename: true };

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

  // Last resort before a nameless bucket: the filename, with the document type
  // and the year taken out of it. A guess, so it is flagged — but a flagged
  // "Raouf Andrea" is something the user recognises and can confirm in a tap,
  // where "Unknown holder" is a pile they have to open one by one.
  if (hints.personGuess) {
    const { member, created } = await findOrCreateMember(hints.personGuess);
    return { member, created, uncertain: true, fromFilename: true };
  }

  const { member, created } = await findOrCreateMember(UNKNOWN_HOLDER);
  return { member, created, uncertain: true };
}

/**
 * Plain-language reasons this document should be looked at. An empty list means
 * it filed itself cleanly and nobody needs to see it again.
 */
export function reviewReasons(
  extraction,
  { holderUncertain = false, type, filenameYear, typeReadAs = null } = {},
) {
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

  if (!f.type.value && !type) reasons.push('The document type was not obvious.');
  if (typeReadAs) {
    reasons.push(
      `Filed by its filename. The document itself reads more like a ${documentLabel({ type: typeReadAs })} — worth a glance.`,
    );
  }
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

export async function findDuplicate({ memberId, type, label, number, expiryDate, filenameYear }) {
  const candidates = await siblings({ memberId, type, label });
  const yearOf = (iso) => (iso ? Number(iso.slice(0, 4)) : null);

  return (
    candidates.find(
      (d) =>
        (number && d.number && d.number === number) ||
        (expiryDate && d.expiry_date && d.expiry_date === expiryDate) ||
        // The same document saved twice in different formats — a photo of an ID
        // and a PDF of the same ID. The two read differently: one may give up
        // the number, the other only a date. Same person, same kind, same year
        // is the signal that survives both.
        (filenameYear && yearOf(d.expiry_date) === filenameYear) ||
        (filenameYear && expiryDate && yearOf(expiryDate) === filenameYear
          && yearOf(d.expiry_date) === filenameYear),
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

  // The filename usually states the document's kind, and states it better than
  // recognition can: a birth certificate quotes the parents' passport numbers,
  // a visa page quotes an Emirates ID. Where the two disagree, the name a person
  // typed wins, and the disagreement is worth surfacing.
  const readType = f.type.value;
  const namedType = hints.type ?? null;
  const type = namedType ?? readType ?? 'other';
  const typeDisagrees = Boolean(namedType && readType && namedType !== readType);
  const label = f.label?.value ?? '';
  const number = f.number.value ?? '';
  const expiry = isValidISODate(f.expiry_date.value) ? f.expiry_date.value : '';
  const describe = { type, label };

  // A file that was read before and has since changed in OneDrive. We know
  // exactly which record came out of it, so duplicate detection has nothing to
  // decide: this *is* that document, freshly photographed. Guessing from the
  // number or the year instead is how a replaced file gets waved away as a
  // duplicate of the record it is supposed to be replacing.
  const replaces =
    hints.replaces == null ? null : await db.documents.get(hints.replaces);

  const duplicate = replaces
    ? null
    : await findDuplicate({
        memberId: member.id,
        type,
        label,
        number,
        expiryDate: expiry,
        filenameYear: hints.year ?? null,
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
    typeReadAs: typeDisagrees ? readType : null,
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

  // A replaced file whose date has moved on is a renewal like any other; one
  // whose date has not is the same document rephotographed, so it is written
  // over in place rather than filed a second time.
  if (replaces && replaces.status === 'active') {
    const laterThanBefore = expiry && replaces.expiry_date && expiry > replaces.expiry_date;
    if (!laterThanBefore) {
      await updateDocument(replaces.id, record);
      return {
        outcome: 'updated',
        member,
        memberCreated: created,
        documentId: replaces.id,
        ...describe,
        reasons,
      };
    }
  }

  // An upload that runs later than the copy on file is that document renewed.
  // renewDocument archives the old row, links the new one to it, and clears the
  // old reminders so the milestones re-arm against the new expiry date.
  const renewing = replaces?.status === 'active'
    ? replaces
    : await findRenewalTarget({ memberId: member.id, type, label, expiryDate: expiry });
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
    case 'updated':
      return `${label} for ${result.member.name} updated from the newer file`;
    case 'duplicate':
      return `${label} for ${result.member.name} is already on file`;
    default:
      return label;
  }
}
