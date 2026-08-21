/**
 * Reminder engine. Deliberately free of DOM and React imports: this module runs
 * both on the page (on every app load) and inside the service worker (periodic
 * background sync), and IndexedDB is available in both.
 */
import { db, markReminded, wasReminded } from '../db.js';
import { REMINDER_THRESHOLDS, documentType } from './constants.js';
import { daysUntil, expiryPhrase, formatDate } from './dates.js';

export const REMINDER_TAG_PREFIX = 'doctrack-expiry';

/**
 * Every (document, threshold) pair that is now due and has not been announced.
 * Thresholds are checked most-urgent-first so a document that jumps straight
 * past 60 and 30 days (e.g. added late) still only produces one notification.
 */
export async function dueReminders({ today = new Date() } = {}) {
  const documents = await db.documents.where('status').equals('active').toArray();
  const members = await db.members.toArray();
  const memberName = new Map(members.map((m) => [m.id, m.name]));

  const due = [];
  for (const doc of documents) {
    const days = daysUntil(doc.expiry_date, { today });
    if (days === null) continue;

    for (const threshold of REMINDER_THRESHOLDS) {
      if (days > threshold) continue;
      if (await wasReminded(doc.id, threshold)) break; // already told them, and anything
      due.push({                                      // less urgent was told earlier
        document: doc,
        threshold,
        days,
        holder: memberName.get(doc.member_id) ?? 'Unknown',
      });
      break;
    }
  }

  return due.sort((a, b) => a.days - b.days);
}

/**
 * Finds what is due, shows one notification per document, records that it was
 * shown. Safe to call repeatedly — the reminders table makes it idempotent.
 */
export async function runReminderCheck({ registration = null, today = new Date() } = {}) {
  if (!canNotify()) return { shown: 0, due: await dueReminders({ today }) };

  const due = await dueReminders({ today });
  let shown = 0;

  for (const item of due) {
    const shownOk = await showReminder(item, registration);
    // Only mark it sent if it actually reached the user. A failed notification
    // that gets marked would silently disappear forever.
    if (shownOk) {
      await markReminded(item.document.id, item.threshold);
      shown += 1;
    }
  }

  return { shown, due };
}

/**
 * Notification.permission is specified on Window; inside a service worker it is
 * either absent or a getter that throws, and in that context permission was
 * already granted for the registration to be woken at all.
 */
function canNotify() {
  if (typeof Notification === 'undefined') return true;
  try {
    return Notification.permission === undefined || Notification.permission === 'granted';
  } catch {
    return true;
  }
}

async function showReminder({ document: doc, holder, days }, registration) {
  const type = documentType(doc.type);
  const title = `${type.icon} ${holder}'s ${type.label}`;
  const body =
    days < 0
      ? `Expired on ${formatDate(doc.expiry_date)}. Renew it.`
      : `${expiryPhrase(doc.expiry_date)} — expires ${formatDate(doc.expiry_date)}.`;

  const options = {
    body,
    tag: `${REMINDER_TAG_PREFIX}-${doc.id}`,
    renotify: true,
    requireInteraction: days <= 7,
    data: { documentId: doc.id, url: `/#/documents/${doc.id}` },
    badge: '/icons/badge-72.png',
    icon: '/icons/icon-192.png',
  };

  try {
    const reg = registration ?? (await currentRegistration());
    if (reg) {
      await reg.showNotification(title, options);
      return true;
    }
    if (typeof Notification !== 'undefined') {
      new Notification(title, options);
      return true;
    }
  } catch (error) {
    console.warn('[doctrack] could not show reminder', error);
  }
  return false;
}

async function currentRegistration() {
  if (typeof self !== 'undefined' && self.registration) return self.registration;
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    return navigator.serviceWorker.ready.catch(() => null);
  }
  return null;
}
