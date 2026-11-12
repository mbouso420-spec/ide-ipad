/**
 * Protección contra bucles infinitos en la vista previa de JS/HTML.
 *
 * Safari en iPadOS ejecuta el iframe de la vista previa en el mismo hilo que el IDE: un `while (true) {}`
 * congelaría toda la app. Para evitarlo se inserta una llamada a `__studioLoopGuard(línea)` al comienzo del
 * cuerpo de cada bucle. El guardián mide cuánto tiempo seguido estuvo bloqueada la página (sin que el
 * navegador pudiera atender otras tareas) y, si supera el límite, corta la ejecución con un error claro.
 */
export const LOOP_GUARD_LIMIT_MS = 2500;

const LOOP_TYPES = new Set([
  "WhileStatement",
  "DoWhileStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement"
]);

/**
 * Inserta el guardián en cada bucle del código. Si el código no se puede analizar, se devuelve intacto
 * (el navegador mostrará su propio error de sintaxis).
 * @param {string} code
 * @param {{ parse: Function }} acorn módulo acorn (se inyecta para poder probarlo en Node)
 * @param {{ module?: boolean }} [options]
 * @returns {{ code: string, loops: number, instrumented: boolean }}
 */
export function instrumentLoops(code, acorn, { module = false } = {}) {
  const source = String(code ?? "");
  if (!acorn || typeof acorn.parse !== "function" || !/\b(for|while|do)\b/.test(source)) {
    return { code: source, loops: 0, instrumented: false };
  }

  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: module ? "module" : "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
      locations: true
    });
  } catch {
    return { code: source, loops: 0, instrumented: false };
  }

  /** @type {Array<{ line: number, body: any }>} */
  const loopsList = [];
  let hasShadowRisk = Boolean(module);
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "WithStatement" || (node.type === "Identifier" && node.name === "__studioLoopGuard")) {
      hasShadowRisk = true;
    }
    if (LOOP_TYPES.has(node.type) && node.body) {
      loopsList.push({
        line: node.loc?.start?.line ?? 0,
        body: node.body
      });
    }
    for (const key of Object.keys(node)) {
      if (key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value.type === "string") {
        visit(value);
      }
    }
  };
  visit(ast);

  if (loopsList.length === 0) {
    return { code: source, loops: 0, instrumented: false };
  }

  const guardCallee = hasShadowRisk ? "globalThis.__studioLoopGuard" : "__studioLoopGuard";
  /** @type {Array<{ pos: number, text: string }>} */
  const edits = [];
  for (const item of loopsList) {
    const call = `${guardCallee}(${item.line});`;
    if (item.body.type === "BlockStatement") {
      edits.push({ pos: item.body.start + 1, text: call });
    } else {
      edits.push({ pos: item.body.start, text: `{${call}` });
      edits.push({ pos: item.body.end, text: "}" });
    }
  }

  // Aplicar de atrás hacia adelante para no desplazar posiciones pendientes
  edits.sort((a, b) => b.pos - a.pos);
  let out = source;
  for (const edit of edits) {
    out = out.slice(0, edit.pos) + edit.text + out.slice(edit.pos);
  }
  return { code: out, loops: loopsList.length, instrumented: true };
}

/**
 * Código del guardián que se inyecta en la página de la vista previa (antes de cualquier script del usuario).
 * Mide el tiempo bloqueado con un temporizador protegido contra clearInterval/redeclaración.
 */
export function buildLoopGuardRuntime(limitMs = LOOP_GUARD_LIMIT_MS) {
  const numericLimit = Number(limitMs) || 2500;
  const formattedSeconds = (numericLimit / 1000).toLocaleString("es-AR");
  return `(function () {
  var _Date = Date;
  var _DateNow = typeof _Date.now === "function" ? _Date.now : null;
  var _Error = Error;
  var _setInterval = typeof setInterval === "function" ? setInterval : null;
  var _clearInterval = typeof clearInterval === "function" ? clearInterval : null;
  var _clearTimeout = typeof clearTimeout === "function" ? clearTimeout : null;
  var _console = typeof console !== "undefined" ? console : null;
  var _now = function () { return _DateNow ? _DateNow.call(_Date) : +new _Date(); };
  var limit = ${numericLimit};
  var lastFree = _now();
  var tripped = false;
  var guardTimerId = _setInterval ? _setInterval(function () {
    lastFree = _now();
    tripped = false;
  }, 100) : null;
  if (_clearInterval) {
    var safeClearInterval = function (id) {
      if (guardTimerId !== null && guardTimerId !== undefined && id === guardTimerId) return;
      return _clearInterval(id);
    };
    try { window.clearInterval = safeClearInterval; } catch (_) {}
    if (typeof globalThis !== "undefined" && globalThis !== window) {
      try { globalThis.clearInterval = safeClearInterval; } catch (_) {}
    }
  }
  if (_clearTimeout) {
    var safeClearTimeout = function (id) {
      if (guardTimerId !== null && guardTimerId !== undefined && id === guardTimerId) return;
      return _clearTimeout(id);
    };
    try { window.clearTimeout = safeClearTimeout; } catch (_) {}
    if (typeof globalThis !== "undefined" && globalThis !== window) {
      try { globalThis.clearTimeout = safeClearTimeout; } catch (_) {}
    }
  }
  // El tiempo con un alert/confirm/prompt abierto no cuenta como bloqueo
  ["alert", "confirm", "prompt"].forEach(function (name) {
    var original = window[name];
    if (typeof original !== "function") return;
    window[name] = function () {
      try { return original.apply(window, arguments); } finally { lastFree = _now(); tripped = false; }
    };
  });
  var __guardFn = function (line) {
    if (tripped || _now() - lastFree > limit) {
      var msg = "Bucle detenido en la línea " + line + ": la página quedó bloqueada más de ${formattedSeconds} s (posible bucle infinito). Se cortó para que el iPad no se congele.";
      if (!tripped) {
        tripped = true;
        if (_console && typeof _console.error === "function") {
          try { _console.error("[LoopGuard]", msg); } catch (_) {}
        }
      }
      var err = new _Error(msg);
      try { err.isLoopGuardError = true; } catch (_) {}
      throw err;
    }
  };
  var __root = typeof globalThis !== "undefined" ? globalThis : window;
  try {
    Object.defineProperty(__root, "__studioLoopGuard", {
      value: __guardFn,
      writable: false,
      configurable: false,
      enumerable: false
    });
    if (typeof window !== "undefined" && window !== __root) {
      Object.defineProperty(window, "__studioLoopGuard", {
        value: __guardFn,
        writable: false,
        configurable: false,
        enumerable: false
      });
    }
  } catch (_) {}
  if (typeof window !== "undefined" && !window.__studioLoopGuard) {
    window.__studioLoopGuard = function (line) {
      return __guardFn(line);
    };
  }
})();`;
}
