self.addEventListener("push", (e) => {
  const d = e.data ? e.data.json() : { title: "비서실", body: "" };
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window" }).then((ws) => (ws[0] ? ws[0].focus() : clients.openWindow("/"))));
});
