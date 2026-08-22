/**
 * Page-side glue for reminders: permission, the on-load check, and asking the
 * browser for periodic background sync where it exists (Chrome on Android, for
 * an installed PWA — everywhere else this is a no-op and the on-load check is
 * what keeps things current).
 */
import { runReminderCheck } from './reminders.js';

export const PERIODIC_SYNC_TAG = 'doctrack-reminders';
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

export function notificationsSupported() {
  return typeof Notification !== 'undefined';
}

export function notificationPermission() {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

/** Runs on every app load. Returns what was due, whether or not it could notify. */
export async function checkRemindersNow() {
  try {
    const registration = await activeRegistration();
    return await runReminderCheck({ registration });
  } catch (error) {
    console.warn('[doctrack] reminder check failed', error);
    return { shown: 0, due: [] };
  }
}

/**
 * Best-effort background wake-up. Requires an installed PWA and granted
 * permission; silently unavailable in every other browser, which is fine —
 * checkRemindersNow() covers the common case of opening the app.
 */
export async function enableBackgroundSync() {
  const registration = await activeRegistration();
  if (!registration?.periodicSync) return { enabled: false, reason: 'unsupported' };

  try {
    const status = await navigator.permissions?.query({ name: 'periodic-background-sync' });
    if (status && status.state !== 'granted') {
      return { enabled: false, reason: 'not-permitted' };
    }
    const tags = await registration.periodicSync.getTags();
    if (!tags.includes(PERIODIC_SYNC_TAG)) {
      await registration.periodicSync.register(PERIODIC_SYNC_TAG, { minInterval: TWELVE_HOURS });
    }
    return { enabled: true };
  } catch (error) {
    return { enabled: false, reason: error?.message ?? 'unavailable' };
  }
}

async function activeRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.getRegistration().catch(() => null);
}
