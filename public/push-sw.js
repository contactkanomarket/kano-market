/* Phone notifications: loaded into the generated service worker (workbox importScripts). */
const CALL_VIBRATION = [500, 250, 500, 250, 500, 250, 500];

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Kano Kaftan";
  const isCall = data.category === "call";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: isCall ? "Tap Answer to join the call" : data.body || "",
      icon: "/pwa-192x192.png",
      badge: "/notification-badge.png",
      tag: data.tag,
      data: { url: data.url || "/", callId: data.callId || null },
      // Incoming calls stay on screen and buzz until answered or dismissed.
      requireInteraction: isCall,
      vibrate: isCall ? CALL_VIBRATION : undefined,
      renotify: isCall,
      // Buttons on the notification (Android). iPhone shows a plain notification.
      actions: isCall && data.callId
        ? [
            { action: "answer", title: "Answer" },
            { action: "decline", title: "Decline" },
          ]
        : [],
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const info = event.notification.data || {};
  // Decline: just stop the alert; the call rings out on the caller's side and is logged as missed.
  if (event.action === "decline") return;

  const url = new URL(info.url || "/", self.location.origin);
  if (info.callId) url.searchParams.set(event.action === "answer" ? "answer_call" : "ring_call", info.callId);
  const target = url.href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          return client.focus().then((focused) => (focused && "navigate" in focused ? focused.navigate(target) : focused));
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
