import { useState } from 'react';
import { DOCUMENT_TYPES } from '../lib/constants.js';
import { expiryPhrase, isValidISODate, urgencyFor } from '../lib/dates.js';
import { Banner, Field, Input, Select, Textarea, UrgencyChip } from './ui.jsx';

/**
 * The confirm/correct step. Shared by add, edit and renew so a renewal is
 * literally the same form the user already knows.
 *
 * Fields Claude was unsure about are outlined and labelled "Check this" until
 * the user touches them. That is the whole strategy for Arabic and low-quality
 * scans: never silently accept a shaky value, but never block on it either.
 */
export default function DocumentForm({
  value,
  onChange,
  members,
  extraction,
  errors = {},
  lockMember = false,
}) {
  const [touched, setTouched] = useState(() => new Set());

  // holder_name is not a field on this form — an unreadable name shows up as a
  // warning instead, so counting it here would promise a marker that isn't there.
  const needsReview = new Set(
    (extraction?.needsReview ?? []).filter((key) => key !== 'holder_name'),
  );
  const flagged = (key) => needsReview.has(key) && !touched.has(key);

  function set(key, next) {
    setTouched((prev) => new Set(prev).add(key));
    onChange({ ...value, [key]: next });
  }

  // A flagged field gets an amber outline plus a line of explanation under it.
  // Putting the marker under the control rather than beside the label keeps the
  // two-column date row from wrapping on a narrow phone.
  const reviewHint = 'Check this reading';

  const expiryUrgency = isValidISODate(value.expiry_date) ? urgencyFor(value.expiry_date) : null;

  return (
    <div className="space-y-4">
      {extraction && (extraction.warnings.length > 0 || needsReview.size > 0) ? (
        <Banner tone="warn" title="Check before saving">
          {extraction.warnings.length > 0 ? (
            <ul className="list-disc space-y-1 pl-4">
              {extraction.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
          {needsReview.size > 0 ? (
            <p className={extraction.warnings.length > 0 ? 'mt-2' : ''}>
              {needsReview.size === 1 ? 'One field is' : `${needsReview.size} fields are`} marked
              below — the photo did not read them clearly.
            </p>
          ) : null}
        </Banner>
      ) : null}

      {!lockMember && (
        <Field label="Belongs to" htmlFor="member" error={errors.member_id}>
          <Select
            id="member"
            value={value.member_id ?? ''}
            onChange={(e) => set('member_id', e.target.value ? Number(e.target.value) : '')}
            tone={errors.member_id ? 'error' : undefined}
          >
            <option value="">Select a family member…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.relation && m.relation !== 'Other' ? ` · ${m.relation}` : ''}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field
        label="Document type"
        htmlFor="type"
        error={errors.type}
        hint={flagged('type') ? reviewHint : null}
        hintTone={flagged('type') ? 'review' : undefined}
      >
        <Select
          id="type"
          value={value.type ?? 'other'}
          onChange={(e) => set('type', e.target.value)}
          tone={flagged('type') ? 'review' : undefined}
        >
          {DOCUMENT_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.icon}  {t.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Document number"
        htmlFor="number"
        hint={flagged('number') ? reviewHint : 'Emirates ID, passport, licence, policy or plate number.'}
        hintTone={flagged('number') ? 'review' : undefined}
      >
        <Input
          id="number"
          value={value.number ?? ''}
          onChange={(e) => set('number', e.target.value)}
          placeholder="784-XXXX-XXXXXXX-X"
          inputMode="text"
          autoComplete="off"
          dir="auto"
          tone={flagged('number') ? 'review' : undefined}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Issue date"
          htmlFor="issue_date"
          error={errors.issue_date}
          hint={flagged('issue_date') ? reviewHint : null}
          hintTone={flagged('issue_date') ? 'review' : undefined}
        >
          <Input
            id="issue_date"
            type="date"
            value={value.issue_date ?? ''}
            onChange={(e) => set('issue_date', e.target.value)}
            tone={errors.issue_date ? 'error' : flagged('issue_date') ? 'review' : undefined}
          />
        </Field>

        <Field
          label="Expiry date"
          htmlFor="expiry_date"
          error={errors.expiry_date}
          hint={flagged('expiry_date') ? reviewHint : null}
          hintTone={flagged('expiry_date') ? 'review' : undefined}
        >
          <Input
            id="expiry_date"
            type="date"
            value={value.expiry_date ?? ''}
            onChange={(e) => set('expiry_date', e.target.value)}
            tone={errors.expiry_date ? 'error' : flagged('expiry_date') ? 'review' : undefined}
          />
        </Field>
      </div>

      {expiryUrgency ? (
        <div className="flex items-center gap-2">
          <UrgencyChip urgency={expiryUrgency}>{expiryPhrase(value.expiry_date)}</UrgencyChip>
          {expiryUrgency.days !== null && expiryUrgency.days > 0 ? (
            <span className="text-[13px] text-slate-500 dark:text-slate-400">
              Reminders at 60, 30 and 7 days.
            </span>
          ) : null}
        </div>
      ) : null}

      <Field label="Notes" htmlFor="notes" hint="Optional. Renewal centre, reference number, anything.">
        <Textarea
          id="notes"
          value={value.notes ?? ''}
          onChange={(e) => set('notes', e.target.value)}
          dir="auto"
          rows={3}
        />
      </Field>
    </div>
  );
}

/** Shared validation so add, edit and renew reject the same things. */
export function validateDocument(value, { requireMember = true } = {}) {
  const errors = {};
  if (requireMember && !value.member_id) errors.member_id = 'Pick who this belongs to.';
  if (!value.type) errors.type = 'Pick a document type.';
  if (value.expiry_date && !isValidISODate(value.expiry_date)) {
    errors.expiry_date = 'That is not a valid date.';
  }
  if (value.issue_date && !isValidISODate(value.issue_date)) {
    errors.issue_date = 'That is not a valid date.';
  }
  if (
    isValidISODate(value.issue_date) &&
    isValidISODate(value.expiry_date) &&
    value.issue_date > value.expiry_date
  ) {
    errors.expiry_date = 'Expiry is before the issue date.';
  }
  return errors;
}
