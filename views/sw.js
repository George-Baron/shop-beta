// VELTO-MART service worker: shows push alerts and opens the right page when one is tapped. It does not cache anything.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'VELTO-MART', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'VELTO-MART', { body: d.body || '', tag: d.tag || undefined, data: { link: d.link || '/' }}));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => { for (const c of list) { if ('focus' in c) { c.navigate(link).catch(() => {}); return c.focus(); } } return self.clients.openWindow(link); }));
});
