/**
 * What a document has to have before it can be saved.
 *
 * Its own module, free of JSX, so the rules can be tested directly — they are
 * the difference between a document that reminds you and one that quietly sits
 * there doing nothing, which is too important to only be exercised through a
 * browser.
 */
import { isValidISODate } from './dates.js';

export function validateDocument(value, { requireMember = true, requireRemindable = false } = {}) {
  const errors = {};
  if (requireMember && !value.member_id) errors.member_id = 'Pick who this belongs to.';
  if (!value.type) errors.type = 'Pick a document type.';
  if (value.type === 'other' && !String(value.label ?? '').trim()) {
    errors.label = 'Say what kind of document this is.';
  }
  /**
   * Only when working through the "needs checking" pile.
   *
   * A document with no date and no "never expires" cannot remind anyone, so
   * saving it puts it straight back in the pile — which from the outside looks
   * like pressing "Looks right" did nothing, forever. Better to say what is
   * missing than to let somebody confirm the same document forty times.
   */
  if (requireRemindable && !value.no_expiry && !value.expiry_date) {
    errors.expiry_date =
      'Add the expiry date, or tick "does not expire" — otherwise nothing can remind you about it.';
  }
  if (value.no_expiry) return errors; // nothing else to check on a filed document
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
