// Service worker for NammaBLR push notifications.
// This runs separately from the page — it can receive pushes even if the
// browser tab isn't open, as long as the browser itself is running.

self.addEventListener('push', (event) => {
  let data = { title: 'NammaBLR', body: 'New story available', url: '/' };
  try { data = event.data.json(); } catch (e) { /* fall back to default above */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.png',
      badge: '/icon.png',
      data: { url: data.url || '/' }
    })
  );
});

// Clicking the notification opens (or focuses) the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === targetUrl && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
