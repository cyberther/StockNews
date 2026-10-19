// Service worker for Market Pulse push alerts (registered by hif-push.js).
// The scan sends { title, body, url, article, tag }. A tap opens the article when the alert
// is about one story; otherwise the app on the alert's stories (url …#alert=<ids>): an open
// app tab is sent there and focused, else url opens in a new one.
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
    data: { url: d.url || '/', article: d.article || '' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  if (/^https:\/\//.test(data.article || '')) { event.waitUntil(self.clients.openWindow(data.article)); return; }
  // Always this app's own host: the link's host (APP_URL) may be another address of the app,
  // where the reader is signed out; only its page and screen (#…) are kept.
  const link = new URL(data.url || '/', self.location.origin);
  const target = new URL(link.pathname + link.search + link.hash, self.location.origin);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    // The app's tab: at / (or an old /templates/... address), not the legal page or the calculator.
    const open = list.find(c => { const u = new URL(c.url);
      return u.origin === target.origin && !/(?:^\/(?:legal|calculator)|(?:legal|intelligence)(?:\.html)?)$/.test(u.pathname); });
    if (!open) return self.clients.openWindow(target.href);
    // The open app shows the alert's stories (it listens for this; see StockNewsWeb).
    if (target.hash) open.postMessage({ type: 'hif-open', hash: target.hash });
    return open.focus();
  }));
});
