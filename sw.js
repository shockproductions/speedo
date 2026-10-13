const CACHE_NAME = "telemetry-tracker-v8";
const APP_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./assets/icon.svg",
  "./src/storage.js",
  "./src/analysis.js",
  "./src/audio.js",
  "./src/drift.js",
  "./src/exporters.js",
  "./src/geo.js",
  "./src/laptiming.js",
  "./src/analysisview.js",
  "./src/dragtimer.js",
  "./src/driveview.js",
  "./src/ekf.js",
  "./src/graphbuilder.js",
  "./src/map3d.js",
  "./src/replay.js",
  "./src/trackeditor.js",
  "./src/transfer.js",
  "./src/settings.js",
  "./src/charts.js",
  "./src/filters.js",
  "./src/imuview.js",
  "./src/mapview.js",
  "./src/orientation.js",
  "./src/recorder.js",
  "./src/sensors.js",
  "./src/ui.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_ASSETS)).catch(() => Promise.resolve()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request)
          .then((response) => {
            if (event.request.method !== "GET") {
              return response;
            }
            // Runtime-cache charts, maps, and tiles after first load to keep the PWA lightweight.
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            return response;
          })
          .catch(() => caches.match("./index.html")),
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow("./");
      }

      return Promise.resolve();
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
