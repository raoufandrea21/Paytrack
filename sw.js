const CACHE = 'paytrack-v1';
const ASSETS = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE).map(k => caches.delete(k))
  )));
  self.clients.claim();
});
// Network-first for the app itself (always fresh when online), cache fallback offline
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch (err) { data = { title: 'PayTrack', body: e.data ? e.data.text() : 'Payment reminder' }; }
  const title = data.title || 'PayTrack reminder';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: data.tag || 'paytrack-reminder',
    data: { url: data.url || '/', accId: data.accId, payIdx: data.payIdx },
    actions: [
      { action: 'paid',    title: '✓ Paid' },
      { action: 'snooze1', title: '⏰ 1 hour' },
      { action: 'open',    title: '✎ Open' }
    ]
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  let target = '/';
  if (e.action === 'paid')    target = '/?confirm=' + (d.accId||'') + ':' + (d.payIdx||'') + ':paid';
  else if (e.action === 'snooze1') {
    // re-show in 1 hour (best-effort while SW alive; server cron re-sends anyway)
    e.waitUntil(new Promise(res => setTimeout(() => {
      self.registration.showNotification(e.notification.title, {
        body: e.notification.body, icon: '/icon-192.png', tag: 'paytrack-snooze',
        data: d, actions: [{action:'paid',title:'✓ Paid'},{action:'open',title:'✎ Open'}]
      }); res();
    }, 60*60*1000)));
    return;
  }
  else target = '/?open=' + (d.accId||'');
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(target); return c.focus(); } }
    return clients.openWindow(target);
  }));
});
