/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { runReminderCheck } from './lib/reminders.js';
import { PERIODIC_SYNC_TAG } from './lib/notifications.js';

// Injected at build time by vite-plugin-pwa (injectManifest strategy).
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// The whole app is one hashed bundle, so any navigation can be served from the
// precached shell. That is what makes it work with no connection at all.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), {
  denylist: [/^\/api\//],
}));

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CHECK_REMINDERS') {
    event.waitUntil(runReminderCheck({ registration: self.registration }));
  }
});

// Chrome on Android, installed PWA only. Everywhere else the app-open check in
// src/App.jsx is the reminder trigger.
self.addEventListener('periodicsync', (event) => {
  if (event.tag === PERIODIC_SYNC_TAG) {
    event.waitUntil(runReminderCheck({ registration: self.registration }));
  }
});

// One-shot sync, used as a fallback wake-up on browsers without periodicsync.
self.addEventListener('sync', (event) => {
  if (event.tag === PERIODIC_SYNC_TAG) {
    event.waitUntil(runReminderCheck({ registration: self.registration }));
  }
});

// Tapping a reminder should land on that document, reusing an open tab if there
// is one rather than stacking up windows.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/';
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
