/**
 * Empaquetador ligero de módulos ES/TypeScript/JSX/CSS/JSON relativos 100% offline.
 * Resuelve dependencias locales (`./`, `../`, `/`) dentro del proyecto en IndexedDB y compila
 * el grafo en un registro virtual sincrónico compatible con `<iframe srcdoc>` y la CSP estricta
 * del IDE (sin necesidad de servidores locales ni URLs `blob:` bloqueadas en `script-src`).
 */

export {
  buildExactModuleMap,
  isRelativeModuleSpecifier,
  resolveLocalModuleEntry
} from "./bundler/modulePathResolver.js";

export {
  inspectModuleUsage,
  hasRelativeDepsInUsage,
  hasLocalModuleDependencies,
  extractModuleDependencyPaths
} from "./bundler/moduleAstScanner.js";

export {
  rewriteEsModuleToRegistry
} from "./bundler/liveBindingsRewriter.js";

export {
  buildVirtualModuleBundle,
  formatVirtualModuleExecution
} from "./bundler/virtualRuntime.js";
