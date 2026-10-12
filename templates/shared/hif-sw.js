// Service worker for Market Pulse push alerts (registered by hif-push.js).
// The scan sends { title, body, url, tag }; a tap focuses an open app tab or opens url.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Market Pulse', {
    body: d.body || '',
    tag: d.tag || 'market-pulse',
    renotify: true,
    icon: '/templates/stock-news-web/assets/aa-logo.png',
    badge: '/templates/stock-news-web/assets/aa-logo.png',
    data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === target.origin && c.url.indexOf('/templates/stock-news') >= 0);
    return open ? open.focus() : self.clients.openWindow(target.href);
  }));
});
