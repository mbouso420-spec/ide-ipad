const SHELL_CACHE = "studio-ide-shell-v28";
const RUNTIME_CACHE = "studio-ide-runtime-v1";
const ACORN_CDN_URL = "https://esm.sh/acorn@8.14.0";
const PYODIDE_ENTRY_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.js";

const APP_SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./assets/icon.svg",
  "./assets/apple-touch-icon.png",
  "./assets/icon-512.png",
  "./css/tokens.css",
  "./css/base.css",
  "./css/layout.css",
  "./css/editor.css",
  "./css/chat.css",
  "./css/workspace.css",
  "./css/app.css",
  "./js/app.js",
  "./js/ui/icons.js",
  "./js/ui/layout.js",
  "./js/ui/symbolBar.js",
  "./js/ui/explorerController.js",
  "./js/ui/quickOpenModal.js",
  "./js/ui/globalSearchModal.js",
  "./js/ui/settingsModal.js",
  "./js/ui/keyboardRouter.js",
  "./js/ui/diffModal.js",
  "./js/ui/livePreviewModal.js",
  "./js/editor/editorManager.js",
  "./js/editor/minimap.js",
  "./js/editor/codeFormatter.js",
  "./js/search/projectSearch.js",
  "./js/ai/providers.js",
  "./js/ai/chatController.js",
  "./js/storage/workspaceDb.js",
  "./js/storage/emergencyBackup.js",
  "./js/storage/fileImport.js",
  "./js/storage/storageQuota.js",
  "./js/storage/zipExporter.js",
  "./js/net/networkErrors.js",
  "./js/preview/loopGuard.js",
  "./js/preview/tsTranspiler.js",
  "./js/preview/htmlBundler.js",
  "./js/preview/cRunner.js",
  "./js/preview/sqlRunner.js",
  "./js/github/githubService.js",
  "./js/github/githubMerge.js",
  "./js/github/githubController.js",
  "./js/security/credentialGuard.js",
  "./js/security/keyVaultCrypto.js"
];

const CACHEABLE_CDN_HOSTS = new Set([
  "esm.sh",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com"
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .open(SHELL_CACHE)
        .then((cache) =>
          Promise.all(
            APP_SHELL_URLS.map((url) =>
              fetch(new Request(url, { cache: "reload" }))
                .then((res) => {
                  if (res && res.ok) {
                    return cache.put(url, res);
                  }
                  return undefined;
                })
                .catch((err) => {
                  console.warn("PWA prefetch skip:", url, err);
                  return undefined;
                })
            )
          )
        ),
      caches.open(RUNTIME_CACHE).then((cache) =>
        Promise.all([
          fetch(new Request(ACORN_CDN_URL, { mode: "cors" }))
            .then((res) => {
              if (res && res.ok) {
                return cache.put(ACORN_CDN_URL, res);
              }
              return undefined;
            })
            .catch(() => undefined),
          fetch(new Request(PYODIDE_ENTRY_URL, { mode: "cors" }))
            .then((res) => {
              if (res && res.ok) {
                return cache.put(PYODIDE_ENTRY_URL, res);
              }
              return undefined;
            })
            .catch(() => undefined)
        ])
      )
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const staleKeys = keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE);
      await Promise.all(staleKeys.map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // Cachear módulos ESM (CodeMirror 6, Octokit) y tipografías para uso rápido y offline en el iPad
  if (CACHEABLE_CDN_HOSTS.has(url.hostname)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const networkPromise = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => cached);

        return cached || networkPromise;
      })
    );
    return;
  }

  // Estrategia Network-First para el App Shell propio: siempre trae los últimos cambios con internet
  // y cae automáticamente a la caché local si el iPad está sin conexión.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        try {
          const fresh = await fetch(request, { cache: "no-cache" });
          if (fresh && fresh.ok) {
            cache.put(request, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await cache.match(request);
          if (cached) {
            return cached;
          }
          throw new Error("Sin conexión y recurso no disponible en caché.");
        }
      })
    );
  }
});
