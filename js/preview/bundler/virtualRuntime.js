/**
 * Runtime virtual de módulos CommonJS/ESM 100% offline para `<iframe srcdoc>` compatible con CSP.
 */

import { normalizePath } from "../../storage/workspaceDb.js";
import { transpileTypeScriptAndJsx } from "../tsTranspiler.js";
import {
  TS_EXTENSIONS,
  escapeCloseScript,
  getFileExtension,
  getParentFolder,
  resolveRelativePath
} from "../previewUtils.js";
import {
  CODE_SOURCE_EXTS,
  isRelativeModuleSpecifier,
  resolveLocalModuleEntry
} from "./modulePathResolver.js";
import { inspectModuleUsage } from "./moduleAstScanner.js";
import { rewriteEsModuleToRegistry } from "./liveBindingsRewriter.js";

/**
 * Runtime compartida idempotente para ejecutar módulos CommonJS/ESM locales dentro de `<iframe srcdoc>`.
 * @returns {string}
 */
function buildVirtualModuleRuntimeScript() {
  return `(function () {
  if (window.__studioRuntimeInit) return;
  window.__studioRuntimeInit = true;
  window.__studioModules = window.__studioModules || Object.create(null);
  window.__studioCache = window.__studioCache || Object.create(null);
  window.__studioPending = window.__studioPending || Object.create(null);
  window.__studioExt = window.__studioExt || Object.create(null);
  var liveWatchers = typeof WeakMap === "function" ? new WeakMap() : null;
  var activeNotifying = typeof WeakSet === "function" ? new WeakSet() : null;
  function notifyModule(exports) {
    if (!exports || !liveWatchers) return;
    if (activeNotifying && activeNotifying.has(exports)) return;
    var list = liveWatchers.get(exports);
    if (!list) return;
    if (activeNotifying) activeNotifying.add(exports);
    try {
      for (var i = 0; i < list.length; i += 1) {
        try { list[i](); } catch (_) {}
      }
    } finally {
      if (activeNotifying) activeNotifying.delete(exports);
    }
  }
  function subscribeModule(mod, fn) {
    if (!mod || typeof mod !== "object" || !liveWatchers) return;
    var list = liveWatchers.get(mod);
    if (!list) {
      list = [];
      liveWatchers.set(mod, list);
    }
    list.push(fn);
  }
  window.__studioNotify = notifyModule;
  window.__studioBind = function (mod, key, setter) {
    var push = function () {
      if (!mod || (typeof mod !== "object" && typeof mod !== "function")) return;
      var val;
      try {
        val = key === "__default_interop__" ? window.__studioInteropDefault(mod) : mod[key];
      } catch (_) {
        return;
      }
      try { setter(val); } catch (_) {}
    };
    push();
    subscribeModule(mod, push);
  };
  window.__studioBindReexport = function (exports, srcMod) {
    subscribeModule(srcMod, function () { notifyModule(exports); });
  };
  window.__studioExport = function (exports, name, getter) {
    Object.defineProperty(exports, name, { enumerable: true, configurable: true, get: getter });
  };
  window.__studioExportStar = function (exports, mod) {
    if (!mod || typeof mod !== "object") return;
    function syncKeys() {
      Object.keys(mod).forEach(function (k) {
        if (k === "default" || k === "__esModule") return;
        if (!Object.prototype.hasOwnProperty.call(exports, k)) {
          Object.defineProperty(exports, k, {
            enumerable: true,
            configurable: true,
            get: function () { return mod[k]; }
          });
        }
      });
    }
    syncKeys();
    subscribeModule(mod, function () {
      syncKeys();
      notifyModule(exports);
    });
  };
  window.__studioInteropDefault = function (mod) {
    if (!mod || (typeof mod !== "object" && typeof mod !== "function")) return mod;
    if (mod.__esModule) return Object.prototype.hasOwnProperty.call(mod, "default") ? mod.default : mod;
    if (typeof Symbol !== "undefined" && mod[Symbol.toStringTag] === "Module" && "default" in mod) {
      return mod.default;
    }
    return mod;
  };
  window.__studioDefine = function (id, factory) {
    window.__studioModules[id] = factory;
  };
  window.__studioRequire = function (id) {
    if (Object.prototype.hasOwnProperty.call(window.__studioCache, id)) {
      return window.__studioCache[id].exports;
    }
    var factory = window.__studioModules[id];
    if (!factory) {
      throw new Error("Módulo no encontrado en vista previa: " + id);
    }
    var module = { exports: Object.create(null) };
    module.exports.__esModule = true;
    window.__studioCache[id] = module;
    try {
      factory(window.__studioRequire, module, module.exports);
    } catch (err) {
      delete window.__studioCache[id];
      throw err;
    }
    notifyModule(module.exports);
    return module.exports;
  };
  window.__studioRequireAsync = async function (id, ancestors) {
    var chain = ancestors || Object.create(null);
    if (Object.prototype.hasOwnProperty.call(window.__studioPending, id)) {
      if (chain[id] && Object.prototype.hasOwnProperty.call(window.__studioCache, id)) {
        return window.__studioCache[id].exports;
      }
      return await window.__studioPending[id];
    }
    if (Object.prototype.hasOwnProperty.call(window.__studioCache, id)) {
      return window.__studioCache[id].exports;
    }
    var factory = window.__studioModules[id];
    if (!factory) {
      throw new Error("Módulo no encontrado en vista previa: " + id);
    }
    var module = { exports: Object.create(null) };
    module.exports.__esModule = true;
    window.__studioCache[id] = module;
    var nextChain = Object.create(null);
    Object.keys(chain).forEach(function (k) { nextChain[k] = true; });
    nextChain[id] = true;
    var scopedRequire = function (depId) {
      return window.__studioRequireAsync(depId, nextChain);
    };
    var resolvePending, rejectPending;
    var initPromise = new Promise(function (res, rej) {
      resolvePending = res;
      rejectPending = rej;
    });
    window.__studioPending[id] = initPromise;
    (async function () {
      try {
        await factory(scopedRequire, module, module.exports, scopedRequire);
        notifyModule(module.exports);
        resolvePending(module.exports);
      } catch (err) {
        delete window.__studioCache[id];
        rejectPending(err);
      } finally {
        delete window.__studioPending[id];
      }
    })();
    return await initPromise;
  };
})();`;
}

/**
 * Compila recursivamente un módulo de entrada y todas sus dependencias locales (`.js`, `.mjs`, `.ts`, `.tsx`, `.jsx`,
 * `.json`, `.css`) en código JS ejecutable dentro del registro virtual, aplicando `transformJs` por módulo.
 *
 * @param {{
 *   entryPath: string,
 *   entryCode: string,
 *   exactMap: Map<string, object>,
 *   transformJs?: (code: string, isModule?: boolean) => string,
 *   transformCss?: (cssContent: string, cssPath: string) => string,
 *   allowParentTraversal?: boolean
 * }} params
 * @returns {{
 *   entryId: string,
 *   modulesCode: string,
 *   externalSpecifiers: string[],
 *   isAsync: boolean
 * }}
 */
export function buildVirtualModuleBundle({
  entryPath,
  entryCode,
  exactMap,
  transformJs = (c) => c,
  transformCss = (css) => css,
  allowParentTraversal = true,
  precompiledEntryCode = null,
  precomputedEntryUsage = null
}) {
  const safeTransformJs = typeof transformJs === "function" ? transformJs : (c) => c;
  const safeTransformCss = typeof transformCss === "function" ? transformCss : (css) => css;
  const entryId = normalizePath(entryPath);
  const compiledModules = [];
  const externalSet = new Set();
  const visited = new Set();
  const queue = [{ id: entryId, content: String(entryCode ?? ""), ext: getFileExtension(entryId), isEntry: true }];

  // Paso 1: descubrir el grafo completo y detectar si algún módulo tiene top-level await o imports externos
  const graphNodes = [];
  let anyTopLevelAwait = false;
  let head = 0;

  while (head < queue.length) {
    const node = queue[head];
    head += 1;
    if (visited.has(node.id)) continue;
    visited.add(node.id);

    if (node.ext === "css") {
      graphNodes.push({ ...node, kind: "css" });
      continue;
    }
    if (node.ext === "json") {
      graphNodes.push({ ...node, kind: "json" });
      continue;
    }

    if (node.ext && !CODE_SOURCE_EXTS.has(node.ext)) {
      graphNodes.push({ ...node, kind: "text" });
      continue;
    }

    let jsCode = node.content;
    if (node.isEntry && typeof precompiledEntryCode === "string") {
      jsCode = precompiledEntryCode;
    } else if (TS_EXTENSIONS.has(node.ext) || node.ext === "jsx") {
      jsCode = transpileTypeScriptAndJsx(jsCode, {
        jsx: node.ext === "tsx" || node.ext === "jsx",
        fileName: node.id
      }).code;
    }

    const usage =
      node.isEntry && precomputedEntryUsage ? precomputedEntryUsage : inspectModuleUsage(jsCode);
    if (usage.hasTopLevelAwait) {
      anyTopLevelAwait = true;
    }

    for (const spec of usage.staticImports) {
      if (isRelativeModuleSpecifier(spec)) {
        const target = resolveLocalModuleEntry(spec, node.id, exactMap, { allowParentTraversal });
        if (target) {
          const targetId = normalizePath(target.path);
          if (!visited.has(targetId)) {
            queue.push({ id: targetId, content: target.content, ext: getFileExtension(targetId) });
          }
        }
      } else if (/^(?:https?:|data:|blob:)/i.test(spec)) {
        externalSet.add(spec);
      }
    }
    for (const spec of usage.dynamicLocalImports) {
      if (isRelativeModuleSpecifier(spec)) {
        const target = resolveLocalModuleEntry(spec, node.id, exactMap, { allowParentTraversal });
        if (target) {
          const targetId = normalizePath(target.path);
          if (!visited.has(targetId)) {
            queue.push({ id: targetId, content: target.content, ext: getFileExtension(targetId) });
          }
        }
      }
    }

    graphNodes.push({ ...node, kind: "js", jsCode });
  }

  // Paso 2: emitir cada módulo con su propio ámbito aislado y loopGuard aplicado
  for (const node of graphNodes) {
    const idLit = JSON.stringify(node.id);

    if (node.kind === "css") {
      const processedCss = safeTransformCss(node.content, node.id);
      const cssLit = JSON.stringify(processedCss).replace(/</g, "\\u003c");
      compiledModules.push(
        `__studioDefine(${idLit}, function (__studioRequire, module, exports) {\n` +
          `  var __st = document.createElement("style");\n` +
          `  __st.setAttribute("data-source", ${idLit});\n` +
          `  __st.textContent = ${cssLit};\n` +
          `  (document.head || document.documentElement).appendChild(__st);\n` +
          `  exports.default = "";\n` +
          `});`
      );
      continue;
    }

    if (node.kind === "text") {
      const textLit = JSON.stringify(String(node.content ?? "")).replace(/</g, "\\u003c");
      compiledModules.push(
        `__studioDefine(${idLit}, function (__studioRequire, module, exports) {\n` +
          `  exports.default = ${textLit};\n` +
          `});`
      );
      continue;
    }

    if (node.kind === "json") {
      let jsonLiteral = "null";
      try {
        const cleanJson = String(node.content || "").replace(/^\uFEFF/, "");
        jsonLiteral = JSON.stringify(JSON.parse(cleanJson)).replace(/</g, "\\u003c");
      } catch {
        jsonLiteral = JSON.stringify(node.content).replace(/</g, "\\u003c");
      }
      compiledModules.push(
        `__studioDefine(${idLit}, function (__studioRequire, module, exports) {\n` +
          `  var __data = ${jsonLiteral};\n` +
          `  module.exports = __data;\n` +
          `});`
      );
      continue;
    }

    const resolveDep = (spec) => {
      if (isRelativeModuleSpecifier(spec)) {
        const target = resolveLocalModuleEntry(spec, node.id, exactMap, { allowParentTraversal });
        if (target) {
          return { kind: "local", id: normalizePath(target.path), specifier: spec };
        }
        return {
          kind: "local",
          id: resolveRelativePath(getParentFolder(node.id), spec.split("?")[0].split("#")[0]),
          specifier: spec
        };
      }
      return { kind: "external", specifier: spec };
    };

    const rewritten = rewriteEsModuleToRegistry(node.jsCode, resolveDep, {
      useAsyncRequire: anyTopLevelAwait,
      moduleId: node.id
    });
    const safeBody = escapeCloseScript(safeTransformJs(rewritten.code, false));
    const fnHeader = anyTopLevelAwait
      ? `async function (__studioRequire, module, exports, __studioRequireAsync)`
      : `function (__studioRequire, module, exports)`;
    compiledModules.push(`__studioDefine(${idLit}, ${fnHeader} {\n${safeBody}\n});`);
  }

  return {
    entryId,
    modulesCode: compiledModules.join("\n"),
    externalSpecifiers: Array.from(externalSet),
    isAsync: anyTopLevelAwait
  };
}

/**
 * Formatea un bundle generado por `buildVirtualModuleBundle` como bloque JavaScript listo para
 * inyectar en `<script>` o `<script type="module">`.
 * @param {ReturnType<typeof buildVirtualModuleBundle>} bundle
 * @returns {{ isModuleTag: boolean, scriptCode: string }}
 */
export function formatVirtualModuleExecution(bundle) {
  const needsModuleTag = (bundle.externalSpecifiers && bundle.externalSpecifiers.length > 0) || Boolean(bundle.isAsync);
  const extParts = [];
  const parts = [];

  if (bundle.externalSpecifiers && bundle.externalSpecifiers.length > 0) {
    const extLines = bundle.externalSpecifiers.map((url, idx) => {
      const lit = JSON.stringify(url).replace(/</g, "\\u003c");
      return `import * as __studio_ext_${idx} from ${lit};\n(window.__studioExt = window.__studioExt || Object.create(null))[${lit}] = __studio_ext_${idx};`;
    });
    extParts.push(extLines.join("\n"));
  }

  parts.push(buildVirtualModuleRuntimeScript());
  if (bundle.modulesCode) {
    parts.push(bundle.modulesCode);
  }
  const execCall = bundle.isAsync
    ? `await __studioRequireAsync(${JSON.stringify(bundle.entryId)});`
    : `__studioRequire(${JSON.stringify(bundle.entryId)});`;
  parts.push(execCall);

  const extImportPreamble = escapeCloseScript(extParts.join("\n"));
  const bodyCode = escapeCloseScript(parts.join("\n"));

  return {
    isModuleTag: needsModuleTag,
    extImportPreamble,
    scriptBodyCode: bodyCode,
    scriptCode: extImportPreamble ? `${extImportPreamble}\n${bodyCode}` : bodyCode
  };
}
