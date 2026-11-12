const SHELL_CACHE = "studio-ide-shell-v30";
const RUNTIME_CACHE = "studio-ide-runtime-v2";
const CORE_SHELL_URLS = new Set(["./", "./index.html", "./manifest.json", "./js/app.js"]);
const ACORN_CDN_URL = "https://esm.sh/acorn@8.14.0";
// #preview-iframe corre bajo sandbox sin allow-same-origin (origin 'null'): sus peticiones a Pyodide/WASM
// no pasan por este Service Worker y dependen de la caché HTTP del navegador; se precalienta en best-effort.
const PYODIDE_ENTRY_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.js";

const IMPORTMAP_CDN_URLS = [
  "https://esm.sh/@codemirror/state@6.4.1",
  "https://esm.sh/@codemirror/view@6.26.3?deps=@codemirror/state@6.4.1",
  "https://esm.sh/@codemirror/language@6.10.1?deps=@codemirror/state@6.4.1,@codemirror/view@6.26.3,@lezer/common@1.2.1,@lezer/highlight@1.2.0",
  "https://esm.sh/@codemirror/commands@6.5.0?deps=@codemirror/state@6.4.1,@codemirror/view@6.26.3,@codemirror/language@6.10.1",
  "https://esm.sh/@codemirror/search@6.5.6?deps=@codemirror/state@6.4.1,@codemirror/view@6.26.3",
  "https://esm.sh/@codemirror/autocomplete@6.15.0?deps=@codemirror/state@6.4.1,@codemirror/view@6.26.3,@codemirror/language@6.10.1,@lezer/common@1.2.1",
  "https://esm.sh/@codemirror/lang-cpp@6.0.2?deps=@codemirror/state@6.4.1,@codemirror/view@6.26.3,@codemirror/language@6.10.1,@lezer/common@1.2.1,@lezer/highlight@1.2.0",
  "https://esm.sh/@codemirror/lang-html@6.4.8?deps=@codemirror/state@6.4.1,@codemirror/view@6.26.3,@codemirror/language@6.10.1,@codemirror/autocomplete@6.15.0,@lezer/common@1.2.1,@lezer/highlight@1.2.0",
  "https://esm.sh/@codemirror/lang-css@6.2.1?deps=@codemirror/state@6.4.1,@codemirror/view@6.26.3,@codemirror/language@6.10.1,@codemirror/autocomplete@6.15.0,@lezer/common@1.2.1,@lezer/highlight@1.2.0",
  "https://esm.sh/@codemirror/lang-javascript@6.2.2?deps=@codemirror/state@6.4.1,@codemirror/view@6.26.3,@codemirror/language@6.10.1,@codemirror/autocomplete@6.15.0,@lezer/common@1.2.1,@lezer/highlight@1.2.0",
  "https://esm.sh/@codemirror/lang-python@6.1.6?deps=@codemirror/state@6.4.1,@codemirror/view@6.26.3,@codemirror/language@6.10.1,@codemirror/autocomplete@6.15.0,@lezer/common@1.2.1,@lezer/highlight@1.2.0",
  "https://esm.sh/@codemirror/lang-markdown@6.2.5?deps=@codemirror/state@6.4.1,@codemirror/view@6.26.3,@codemirror/language@6.10.1,@codemirror/autocomplete@6.15.0,@lezer/common@1.2.1,@lezer/highlight@1.2.0",
  "https://esm.sh/@codemirror/lang-json@6.0.1?deps=@codemirror/state@6.4.1,@codemirror/view@6.26.3,@codemirror/language@6.10.1,@lezer/common@1.2.1,@lezer/highlight@1.2.0",
  "https://esm.sh/@codemirror/lang-sql@6.6.2?deps=@codemirror/state@6.4.1,@codemirror/view@6.26.3,@codemirror/language@6.10.1,@codemirror/autocomplete@6.15.0,@lezer/common@1.2.1,@lezer/highlight@1.2.0",
  "https://esm.sh/@lezer/highlight@1.2.0?deps=@lezer/common@1.2.1",
  "https://esm.sh/@octokit/core@6.1.2"
];

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
  "./js/ui/binaryPreview.js",
  "./js/editor/editorManager.js",
  "./js/editor/minimap.js",
  "./js/editor/codeFormatter.js",
  "./js/editor/smartReplace.js",
  "./js/editor/autocompleteCatalog.js",
  "./js/editor/splitEditorController.js",
  "./js/search/projectSearch.js",
  "./js/ai/providers.js",
  "./js/ai/chatController.js",
  "./js/storage/workspaceDb.js",
  "./js/storage/emergencyBackup.js",
  "./js/storage/fileImport.js",
  "./js/storage/storageQuota.js",
  "./js/storage/zipExporter.js",
  "./js/net/networkErrors.js",
  "./js/preview/previewUtils.js",
  "./js/preview/loopGuard.js",
  "./js/preview/tsTranspiler.js",
  "./js/preview/moduleBundler.js",
  "./js/preview/markdownPreview.js",
  "./js/preview/pythonRunner.js",
  "./js/preview/htmlBundler.js",
  "./js/preview/cRunner.js",
  "./js/preview/sqlRunner.js",
  "./js/github/githubService.js",
  "./js/github/githubMerge.js",
  "./js/github/githubLocalBackupPanel.js",
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

function isEssentialShellUrl(url) {
  return CORE_SHELL_URLS.has(url) || url.endsWith(".css") || url.endsWith(".js");
}

function isCacheableResponse(response) {
  return Boolean(response && response.ok && response.type !== "opaque");
}

function safeCachePut(cache, key, response) {
  if (!isCacheableResponse(response)) {
    return Promise.resolve();
  }
  try {
    return Promise.resolve(cache.put(key, response.clone())).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

async function fetchWithTimeout(request, timeoutMs = 12000) {
  const AbortCtrl =
    typeof self !== "undefined" && typeof self.AbortController === "function"
      ? self.AbortController
      : null;
  if (!AbortCtrl) {
    return fetch(request);
  }
  const controller = new AbortCtrl();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    if (typeof clearTimeout === "function") {
      clearTimeout(timer);
    }
  }
}

async function precacheShellUrl(cache, url) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(new Request(url, { cache: "reload" }));
      if (isCacheableResponse(res)) {
        await safeCachePut(cache, url, res);
        return;
      }
      lastError = new Error(`HTTP ${res ? res.status : "sin respuesta"}`);
    } catch (err) {
      lastError = err;
    }
  }

  const existing = await cache.match(url, { ignoreSearch: true }).catch(() => undefined);
  if (existing) {
    console.warn("PWA prefetch fallback a caché existente:", url, lastError);
    return;
  }

  if (isEssentialShellUrl(url)) {
    throw new Error(`No se pudo precachear recurso crítico: ${url}`, { cause: lastError });
  }
  console.warn("PWA prefetch skip:", url, lastError);
}

async function warmExternalScriptUrl(cache, targetUrl, state, depth = 0) {
  if (!targetUrl || state.visited.has(targetUrl) || state.visited.size >= 80 || depth > 2) {
    return;
  }
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return;
  }
  if (!CACHEABLE_CDN_HOSTS.has(parsed.hostname)) {
    return;
  }
  state.visited.add(targetUrl);

  let res;
  try {
    res = await fetchWithTimeout(new Request(targetUrl, { mode: "cors" }), 12000);
  } catch {
    return;
  }
  if (!isCacheableResponse(res)) {
    return;
  }

  let cloneForFinal = null;
  let cloneForText = null;
  try {
    cloneForFinal = res.url && res.url !== targetUrl ? res.clone() : null;
    cloneForText = res.clone();
  } catch {
    return;
  }

  await safeCachePut(cache, targetUrl, res);
  if (cloneForFinal) {
    state.visited.add(res.url);
    await Promise.resolve(cache.put(res.url, cloneForFinal)).catch(() => undefined);
  }

  if (parsed.hostname !== "esm.sh" || depth >= 2) {
    return;
  }
  const ctype = (res.headers && typeof res.headers.get === "function" ? res.headers.get("content-type") || "" : "").toLowerCase();
  if (!ctype.includes("javascript") && !ctype.includes("ecmascript") && !targetUrl.endsWith(".js") && !targetUrl.endsWith(".mjs")) {
    return;
  }

  let bodyText = "";
  try {
    bodyText = await cloneForText.text();
  } catch {
    return;
  }

  const baseForRel = res.url || targetUrl;
  const specifiers = new Set();
  const reStatic = /(?:from|import)\s*["']([^"']+)["']/g;
  const reDynamic = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = reStatic.exec(bodyText)) !== null) specifiers.add(m[1]);
  while ((m = reDynamic.exec(bodyText)) !== null) specifiers.add(m[1]);

  const childTasks = [];
  for (const spec of specifiers) {
    if (state.visited.size >= 80) break;
    if (spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("https://")) {
      try {
        const resolved = new URL(spec, baseForRel).href;
        childTasks.push(warmExternalScriptUrl(cache, resolved, state, depth + 1));
      } catch {
        // Ignorar especificador malformado
      }
    }
  }
  await Promise.all(childTasks.map((p) => p.catch(() => undefined)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .open(SHELL_CACHE)
        .then((cache) => Promise.all(APP_SHELL_URLS.map((url) => precacheShellUrl(cache, url)))),
      caches
        .open(RUNTIME_CACHE)
        .then(async (cache) => {
          const state = { visited: new Set() };
          const warmTasks = [
            warmExternalScriptUrl(cache, ACORN_CDN_URL, state, 0),
            ...IMPORTMAP_CDN_URLS.map((cdnUrl) => warmExternalScriptUrl(cache, cdnUrl, state, 0)),
            // Precalentamiento best-effort para el entrypoint de Pyodide (limitado por sandbox 'null' en #preview-iframe)
            fetchWithTimeout(new Request(PYODIDE_ENTRY_URL, { mode: "cors" }), 12000)
              .then((res) => (isCacheableResponse(res) ? safeCachePut(cache, PYODIDE_ENTRY_URL, res) : undefined))
              .catch(() => undefined)
          ];
          await Promise.all(warmTasks.map((p) => p.catch(() => undefined)));
        })
        .catch(() => undefined)
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
          .then(async (response) => {
            if (isCacheableResponse(response)) {
              await safeCachePut(cache, request, response);
              return response;
            }
            if (cached && response && response.status >= 500) {
              return cached;
            }
            return response;
          })
          .catch(
            () =>
              cached ||
              new Response("Recurso CDN no disponible sin conexión.", {
                status: 503,
                statusText: "Service Unavailable",
                headers: { "Content-Type": "text/plain; charset=utf-8" }
              })
          );

        if (cached) {
          if (typeof event.waitUntil === "function") {
            event.waitUntil(networkPromise.catch(() => undefined));
          }
          return cached;
        }
        return networkPromise;
      })
    );
    return;
  }

  // Estrategia Network-First para el App Shell propio: siempre trae los últimos cambios con internet
  // y cae automáticamente a la caché local si el iPad está sin conexión.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const matchCachedShell = async () =>
          (await cache.match(request, { ignoreSearch: true })) ||
          (url.pathname.endsWith("/")
            ? (await cache.match("./index.html", { ignoreSearch: true })) ||
              (await cache.match("./", { ignoreSearch: true }))
            : undefined);

        const matchNavigateFallback = async () =>
          (await cache.match("./index.html", { ignoreSearch: true })) ||
          (await cache.match("./", { ignoreSearch: true }));

        try {
          const fresh = await fetch(request, { cache: "no-cache" });
          if (isCacheableResponse(fresh)) {
            await safeCachePut(cache, request, fresh);
            return fresh;
          }
          if (fresh && fresh.status >= 500) {
            const cachedFallback = await matchCachedShell();
            if (cachedFallback) {
              return cachedFallback;
            }
            if (request.mode === "navigate") {
              const navFallback = await matchNavigateFallback();
              if (navFallback) {
                return navFallback;
              }
            }
          }
          return fresh;
        } catch {
          const cached = await matchCachedShell();
          if (cached) {
            return cached;
          }
          if (request.mode === "navigate") {
            const shellFallback = await matchNavigateFallback();
            if (shellFallback) {
              return shellFallback;
            }
          }
          return new Response("Sin conexión y recurso no disponible en caché.", {
            status: 503,
            statusText: "Service Unavailable",
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }
      })
    );
  }
});
