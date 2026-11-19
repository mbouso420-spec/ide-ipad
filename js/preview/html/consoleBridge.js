/**
 * Script puente inyectado dentro de `<iframe srcdoc>` para consola JS, LoopGuard, mini-REPL e interceptor de navegación.
 */

import { buildLoopGuardRuntime } from "../loopGuard.js";

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "throw", "case", "in", "of", "typeof", "void", "delete", "await", "yield", "else", "do"
]);
const DECL_KEYWORDS = new Set(["var", "let", "const", "function", "class", "catch"]);

function isIdentStart(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$";
}

function isIdentPart(ch) {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

function skipWs(src, idx) {
  while (idx < src.length && /\s/.test(src[idx])) idx++;
  return idx;
}

function scanQuotedString(src, start, quote) {
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return src.length;
}

function scanRegexLiteral(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      return i;
    } else if (ch === "\n" || ch === "\r") {
      return start + 1;
    }
    i++;
  }
  return start + 1;
}

function canPrecedeRegex(prevChar, prevWord, prevPrevChar) {
  if (!prevChar) return true;
  if ((prevChar === "+" && prevPrevChar === "+") || (prevChar === "-" && prevPrevChar === "-")) {
    return false;
  }
  if ("([\{,;=:?!&|^~+-*%<>".includes(prevChar)) return true;
  return Boolean(prevWord && REGEX_PRECEDING_KEYWORDS.has(prevWord));
}

function scanRhsExpressionEnd(src, start) {
  let i = start;
  let lastSigEnd = start;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let ternaryDepth = 0;
  let prevChar = "=";
  let prevPrevChar = "";
  let prevWord = "";
  const tplStack = [];

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (tplStack.length > 0 && tplStack[tplStack.length - 1] === brace) {
      if (ch === "\\") { i += 2; lastSigEnd = Math.min(src.length, i); continue; }
      if (ch === "`") { tplStack.pop(); i++; lastSigEnd = i; prevPrevChar = prevChar; prevChar = "`"; prevWord = ""; continue; }
      if (ch === "$" && next === "{") { i += 2; lastSigEnd = i; brace++; continue; }
      i++;
      lastSigEnd = i;
      continue;
    }

    if (ch === "'" || ch === "\"") {
      i = scanQuotedString(src, i, ch);
      lastSigEnd = i;
      prevPrevChar = prevChar;
      prevChar = ch;
      prevWord = "";
      continue;
    }
    if (ch === "`") {
      tplStack.push(brace);
      i++;
      lastSigEnd = i;
      continue;
    }
    if (ch === "/" && next === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === "/" && canPrecedeRegex(prevChar, prevWord, prevPrevChar)) {
      i = scanRegexLiteral(src, i);
      lastSigEnd = i;
      prevPrevChar = prevChar;
      prevChar = "/";
      prevWord = "";
      continue;
    }

    if (ch === "(") paren++;
    else if (ch === ")") {
      if (paren === 0 && bracket === 0 && brace === 0) break;
      paren--;
    } else if (ch === "[") bracket++;
    else if (ch === "]") {
      if (bracket === 0 && paren === 0 && brace === 0) break;
      bracket--;
    } else if (ch === "{") brace++;
    else if (ch === "}") {
      if (brace === 0 && paren === 0 && bracket === 0) break;
      brace--;
      if (tplStack.length > 0 && tplStack[tplStack.length - 1] === brace) {
        i++;
        lastSigEnd = i;
        continue;
      }
    } else if (paren === 0 && bracket === 0 && brace === 0) {
      if (ch === ";" || ch === ",") break;
      if (ch === "?" && next !== "." && next !== "?") {
        ternaryDepth++;
      } else if (ch === ":") {
        if (ternaryDepth === 0) break;
        ternaryDepth--;
      } else if (ch === "\n" || ch === "\r") {
        const afterWs = skipWs(src, i);
        const nextTok = src[afterWs] || "";
        const nextNextTok = src[afterWs + 1] || "";
        const continues =
          nextTok === "." ||
          nextTok === "?" ||
          nextTok === ":" ||
          nextTok === "+" ||
          (nextTok === "|" && nextNextTok === "|") ||
          (nextTok === "&" && nextNextTok === "&") ||
          "+?:=,&|".includes(prevChar);
        if (!continues) break;
        i = afterWs;
        continue;
      }
    }

    if (!/\s/.test(ch)) {
      if (isIdentStart(ch)) {
        let j = i + 1;
        while (j < src.length && isIdentPart(src[j])) j++;
        prevWord = src.slice(i, j);
        prevPrevChar = "";
        prevChar = src[j - 1];
        i = j;
        lastSigEnd = i;
        continue;
      }
      prevPrevChar = prevChar;
      prevChar = ch;
      prevWord = "";
      lastSigEnd = i + 1;
    }
    i++;
  }
  return lastSigEnd;
}

/**
 * Reescribe asignaciones y llamadas a `location` (`location.href = ...`, `location.assign(...)`,
 * `location.replace(...)`, `location.reload()`, `window.location = ...`) hacia `window.__ideNavigate(...)` /
 * `window.__ideReload(...)` para evitar que `<iframe srcdoc>` navegue fuera del sandbox hacia el IDE padre.
 */
export function rewriteProgrammaticNavigation(code) {
  const src = String(code || "");
  if (!src.includes("location")) return src;

  let out = "";
  let i = 0;
  let lastCopied = 0;
  let prevChar = "";
  let prevPrevChar = "";
  let prevWord = "";
  let braceDepth = 0;
  const tplStack = [];
  const braceKindStack = [];

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (tplStack.length > 0 && tplStack[tplStack.length - 1] === braceDepth) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") { tplStack.pop(); i++; prevPrevChar = prevChar; prevChar = "`"; prevWord = ""; continue; }
      if (ch === "$" && next === "{") {
        i += 2;
        braceDepth++;
        braceKindStack.push("tpl");
        continue;
      }
      i++;
      continue;
    }

    if (ch === "'" || ch === "\"") {
      i = scanQuotedString(src, i, ch);
      prevPrevChar = prevChar;
      prevChar = ch;
      prevWord = "";
      continue;
    }
    if (ch === "`") {
      tplStack.push(braceDepth);
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === "/" && canPrecedeRegex(prevChar, prevWord, prevPrevChar)) {
      i = scanRegexLiteral(src, i);
      prevPrevChar = prevChar;
      prevChar = "/";
      prevWord = "";
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < src.length && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);

      const isRootObj = word === "window" || word === "self" || word === "globalThis" || word === "document";
      const isBareLoc = word === "location" && prevChar !== "." && !DECL_KEYWORDS.has(prevWord);

      let locEnd = -1;
      if (isBareLoc) {
        locEnd = j;
      } else if (isRootObj && prevChar !== "." && !DECL_KEYWORDS.has(prevWord)) {
        let p = skipWs(src, j);
        if (src[p] === ".") {
          p = skipWs(src, p + 1);
          if (src.slice(p, p + 8) === "location" && !isIdentPart(src[p + 8] || "")) {
            locEnd = p + 8;
          }
        }
      }

      if (locEnd !== -1) {
        let k = skipWs(src, locEnd);
        if (src[k] === ".") {
          const propStart = skipWs(src, k + 1);
          let propEnd = propStart;
          while (propEnd < src.length && isIdentPart(src[propEnd])) propEnd++;
          const prop = src.slice(propStart, propEnd);
          const afterProp = skipWs(src, propEnd);
          if ((prop === "assign" || prop === "replace") && src[afterProp] === "(") {
            out += src.slice(lastCopied, i) + "window.__ideNavigate(";
            i = afterProp + 1;
            lastCopied = i;
            prevPrevChar = prevChar;
            prevChar = "(";
            prevWord = "";
            continue;
          }
          if (prop === "reload" && src[afterProp] === "(") {
            out += src.slice(lastCopied, i) + "window.__ideReload(";
            i = afterProp + 1;
            lastCopied = i;
            prevPrevChar = prevChar;
            prevChar = "(";
            prevWord = "";
            continue;
          }
          if (prop === "href" && src[afterProp] === "=" && src[afterProp + 1] !== "=" && src[afterProp + 1] !== ">") {
            const rhsStart = skipWs(src, afterProp + 1);
            const rhsEnd = scanRhsExpressionEnd(src, rhsStart);
            const rhsExpr = src.slice(rhsStart, rhsEnd).trim();
            if (rhsExpr) {
              out += src.slice(lastCopied, i) + `window.__ideNavigate(${rhsExpr})`;
              i = rhsEnd;
              lastCopied = i;
              prevPrevChar = prevChar;
              prevChar = ")";
              prevWord = "";
              continue;
            }
          }
        } else if (src[k] === "=" && src[k + 1] !== "=" && src[k + 1] !== ">") {
          const currentBraceKind = braceKindStack.length > 0 ? braceKindStack[braceKindStack.length - 1] : "block";
          const inClassMemberScope = currentBraceKind === "class";
          const inDestructuringPattern = isBareLoc && (prevChar === "{" || prevChar === ",") && currentBraceKind !== "block";
          const allowedBareBoundary =
            !isBareLoc ||
            (!inClassMemberScope &&
              !inDestructuringPattern &&
              (!prevChar ||
                ";{})".includes(prevChar) ||
                (prevPrevChar === "=" && prevChar === ">") ||
                prevWord === "else" ||
                prevWord === "return"));
          if (allowedBareBoundary) {
            const rhsStart = skipWs(src, k + 1);
            const rhsEnd = scanRhsExpressionEnd(src, rhsStart);
            const rhsExpr = src.slice(rhsStart, rhsEnd).trim();
            if (rhsExpr) {
              out += src.slice(lastCopied, i) + `window.__ideNavigate(${rhsExpr})`;
              i = rhsEnd;
              lastCopied = i;
              prevPrevChar = prevChar;
              prevChar = ")";
              prevWord = "";
              continue;
            }
          }
        }
      }

      prevWord = word;
      prevPrevChar = "";
      prevChar = src[j - 1];
      i = j;
      continue;
    }

    if (ch === "{") {
      braceDepth++;
      let kind = "block";
      const lookback = src.slice(Math.max(0, i - 180), i);
      if (/\bclass\b[^{};]*$/.test(lookback)) {
        kind = "class";
      } else if (prevChar === ")" || prevWord === "else" || prevWord === "try" || prevWord === "finally" || prevWord === "do" || !prevChar || prevChar === ";") {
        kind = "block";
      } else if (DECL_KEYWORDS.has(prevWord) || "=([,:?".includes(prevChar)) {
        kind = "expr";
      }
      braceKindStack.push(kind);
    } else if (ch === "}") {
      if (braceDepth > 0) braceDepth--;
      if (braceKindStack.length > 0) braceKindStack.pop();
    }

    if (!/\s/.test(ch)) {
      prevPrevChar = prevChar;
      prevChar = ch;
      prevWord = "";
    }
    i++;
  }

  return lastCopied === 0 ? src : out + src.slice(lastCopied);
}

export function buildConsoleBridgeScript(mirrorOnScreen) {
  return `<script>
${buildLoopGuardRuntime()}
(function () {
  var mirror = ${mirrorOnScreen ? "true" : "false"};
  var MAX_LOG_CHARS = 16384;
  function formatArgs(args) {
    var out = Array.prototype.slice.call(args).map(function (item) {
      if (typeof item === "string") return item;
      if (item === undefined) return "undefined";
      if (item === null) return "null";
      if (typeof item === "bigint") return item.toString() + "n";
      if (typeof item === "symbol") return String(item);
      if (typeof item === "function") return "[Function " + (item.name || "anon") + "]";
      if (item instanceof Error) {
        var header = (item.name || "Error") + ": " + (item.message || "");
        return item.stack ? header + "\\n" + item.stack : header;
      }
      try {
        return JSON.stringify(item, null, 2);
      } catch (_) {
        return String(item);
      }
    }).join(" ");
    if (out.length > MAX_LOG_CHARS) {
      return out.slice(0, MAX_LOG_CHARS) + "… [truncado]";
    }
    return out;
  }
  function send(level, args) {
    try {
      var msg = formatArgs(args);
      parent.postMessage({ source: "studio-ide-preview", level: level, text: msg }, "*");
      if (mirror) {
        var box = document.getElementById("__js_screen_log");
        if (box) {
          while (box.children.length >= 500 && box.firstChild) {
            box.removeChild(box.firstChild);
          }
          var row = document.createElement("div");
          row.className = level === "error" ? "js-line js-line-error" : level === "warn" ? "js-line js-line-warn" : "js-line";
          row.textContent = msg;
          box.appendChild(row);
        }
      }
    } catch (_) {
      /* omitir error de mirror en consola */
    }
  }
  var origLog = console.log, origWarn = console.warn, origErr = console.error;
  console.log = function () { send("log", arguments); origLog.apply(console, arguments); };
  console.warn = function () { send("warn", arguments); origWarn.apply(console, arguments); };
  console.error = function () { send("error", arguments); origErr.apply(console, arguments); };
  window.addEventListener("error", function (e) {
    var stErr = document.getElementById("__js_status");
    if (stErr) {
      stErr.dataset.failed = "1";
      stErr.style.color = "var(--err)";
      stErr.textContent = "Error en ejecución";
    }
    var fromLoopGuard = /Bucle detenido en la línea/.test(e.message || "");
    send("error", [e.message + (e.lineno && !fromLoopGuard ? " (línea " + e.lineno + ")" : "")]);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var stErr = document.getElementById("__js_status");
    if (stErr) {
      stErr.dataset.failed = "1";
      stErr.style.color = "var(--err)";
      stErr.textContent = "Error en ejecución";
    }
    var reasonText = "Promesa rechazada desconocida";
    try {
      reasonText = e.reason && e.reason.message ? e.reason.message : String(e.reason);
    } catch (_) {
      reasonText = "[objeto de rechazo no serializable]";
    }
    send("error", ["Promesa rechazada: " + reasonText]);
  });
  // Shim seguro en memoria para localStorage/sessionStorage/history dentro de iframe sandbox (origin 'null')
  (function () {
    function createMemoryStorage() {
      var store = Object.create(null);
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, String(k)) ? store[String(k)] : null; },
        setItem: function (k, v) { store[String(k)] = String(v); },
        removeItem: function (k) { delete store[String(k)]; },
        clear: function () { store = Object.create(null); },
        key: function (i) { var keys = Object.keys(store); return i >= 0 && i < keys.length ? keys[i] : null; },
        get length() { return Object.keys(store).length; }
      };
    }
    ["localStorage", "sessionStorage"].forEach(function (prop) {
      try {
        var testStorage = window[prop];
        void testStorage.length;
      } catch (_) {
        try {
          var mem = createMemoryStorage();
          Object.defineProperty(window, prop, { configurable: true, get: function () { return mem; } });
        } catch (_2) {}
      }
    });
    try {
      void document.cookie;
    } catch (_) {
      try {
        var memCookies = Object.create(null);
        Object.defineProperty(document, "cookie", {
          configurable: true,
          get: function () {
            return Object.keys(memCookies).map(function (k) { return k + "=" + memCookies[k]; }).join("; ");
          },
          set: function (val) {
            var str = String(val || "");
            var eqIdx = str.indexOf("=");
            if (eqIdx === -1) return;
            var name = str.slice(0, eqIdx).trim();
            var rest = str.slice(eqIdx + 1).split(";")[0].trim();
            if (name) memCookies[name] = rest;
          }
        });
      } catch (_3) {}
    }
    try {
      if (window.history) {
        var origPush = window.history.pushState;
        var origReplace = window.history.replaceState;
        window.history.pushState = function () {
          try { return origPush.apply(window.history, arguments); } catch (_) { return undefined; }
        };
        window.history.replaceState = function () {
          try { return origReplace.apply(window.history, arguments); } catch (_) { return undefined; }
        };
        window.history.back = function () {
          parent.postMessage({ source: "studio-ide-preview", action: "history", delta: -1 }, "*");
        };
        window.history.forward = function () {
          parent.postMessage({ source: "studio-ide-preview", action: "history", delta: 1 }, "*");
        };
        window.history.go = function (delta) {
          var n = typeof delta === "number" ? delta : Number(delta || 0);
          if (!n) {
            parent.postMessage({ source: "studio-ide-preview", action: "reload" }, "*");
          } else {
            parent.postMessage({ source: "studio-ide-preview", action: "history", delta: n }, "*");
          }
        };
      }
    } catch (_) {}
  })();
  // Mini-REPL interactivo conectado al panel Consola JS de Studio IDE
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.source !== "studio-ide-repl" || d.action !== "eval") return;
    if (ev.source !== window.parent) return;
    var code = String(d.code || "").trim();
    if (!code) return;
    send("log", ["> " + code]);
    try {
      var res = (0, eval)(code);
      if (res !== undefined) {
        send("log", [res]);
      }
    } catch (err) {
      send("error", [err && err.message ? err.message : String(err)]);
    }
  });
  function normalizeNavRef(ref) {
    return String(ref == null ? "" : ref).replace(/[\\u0000-\\u001f\\u007f]+/g, "").trim().toLowerCase();
  }
  function isBlockedNavScheme(normRef) {
    return /^(javascript:|vbscript:|data:|file:|filesystem:)/.test(normRef);
  }
  function isExternalNavRef(normRef) {
    return normRef.indexOf("//") === 0 || /^(https?:|mailto:|tel:|blob:)/.test(normRef);
  }
  function findClickedAnchor(e) {
    if (typeof e.composedPath === "function") {
      var path = e.composedPath();
      for (var p = 0; p < path.length; p++) {
        var node = path[p];
        if (!node || !node.tagName || typeof node.getAttribute !== "function") continue;
        var tag = String(node.tagName).toLowerCase();
        if (tag === "a" || tag === "area") return node;
      }
    }
    var rawTarget = e.target && e.target.nodeType === 3 ? (e.target.parentElement || e.target.parentNode) : e.target;
    return rawTarget && rawTarget.closest ? rawTarget.closest("a, area") : null;
  }
  function readAnchorHref(a) {
    if (!a || typeof a.getAttribute !== "function") return null;
    var h = a.getAttribute("href");
    if (h != null) return h;
    h = a.getAttribute("xlink:href");
    if (h != null) return h;
    if (typeof a.getAttributeNS === "function") {
      h = a.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      if (h != null) return h;
    }
    return null;
  }
  // Fase de captura: bloqueo estricto de esquemas peligrosos (sin romper tabs SPA con click en burbuja)
  document.addEventListener("click", function (e) {
    var a = findClickedAnchor(e);
    if (!a) return;
    var href = readAnchorHref(a);
    if (href == null) return;
    var normHref = normalizeNavRef(href);
    if (isBlockedNavScheme(normHref)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  // Fase de burbuja en window: permite que SPAs/tabs usen e.preventDefault() y evita escapes nativos de srcdoc
  window.addEventListener("click", function (e) {
    if (e.defaultPrevented) return;
    var a = findClickedAnchor(e);
    if (!a) return;
    var href = readAnchorHref(a);
    if (href == null) return;
    var normHref = normalizeNavRef(href);
    if (isBlockedNavScheme(normHref)) {
      e.preventDefault();
      return;
    }
    if (!normHref) {
      e.preventDefault();
      parent.postMessage({ source: "studio-ide-preview", action: "navigate", href: "./" }, "*");
      return;
    }
    if (normHref.startsWith("#")) return;
    if (isExternalNavRef(normHref)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      return;
    }
    e.preventDefault();
    parent.postMessage({
      source: "studio-ide-preview",
      action: "navigate",
      href: href
    }, "*");
  }, false);

  // Interceptor de envíos de formularios: bloqueo estricto de esquemas peligrosos en captura
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.getAttribute) return;
    var submitter = e.submitter;
    var action = (submitter && submitter.getAttribute && submitter.getAttribute("formaction")) || form.getAttribute("action");
    if (!action) return;
    var normAction = normalizeNavRef(action);
    if (isBlockedNavScheme(normAction)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  // Navegación local de formularios en fase de burbuja (respeta e.preventDefault() de SPAs/React)
  window.addEventListener("submit", function (e) {
    if (e.defaultPrevented) return;
    var form = e.target;
    if (!form || !form.getAttribute) return;
    var submitter = e.submitter;
    var action = (submitter && submitter.getAttribute && submitter.getAttribute("formaction")) || form.getAttribute("action");
    if (!action) {
      e.preventDefault();
      return;
    }
    var normAction = normalizeNavRef(action);
    if (isBlockedNavScheme(normAction)) {
      e.preventDefault();
      return;
    }
    if (normAction.startsWith("#") || isExternalNavRef(normAction)) return;
    e.preventDefault();
    parent.postMessage({
      source: "studio-ide-preview",
      action: "navigate",
      href: action
    }, "*");
  }, false);

  // Interceptor de llamadas programáticas de navegación (incluyendo rewrite de location.*)
  var origOpen = typeof window.open === "function" ? window.open.bind(window) : null;
  var triggerNav = function (targetUrl) {
    if (targetUrl == null) return;
    var rawTarget = typeof targetUrl === "string" ? targetUrl : String(targetUrl);
    var normTarget = normalizeNavRef(rawTarget);
    if (!normTarget) normTarget = "/";
    if (isBlockedNavScheme(normTarget)) return;
    if (normTarget.startsWith("#")) {
      window.location.hash = rawTarget;
      return;
    }
    if (isExternalNavRef(normTarget)) {
      if (origOpen) origOpen(rawTarget, "_blank", "noopener,noreferrer");
      return;
    }
    parent.postMessage({
      source: "studio-ide-preview",
      action: "navigate",
      href: rawTarget || "/"
    }, "*");
  };
  var triggerReload = function () {
    parent.postMessage({ source: "studio-ide-preview", action: "reload" }, "*");
  };
  try {
    Object.defineProperty(window, "__ideNavigate", {
      value: triggerNav,
      configurable: true,
      writable: true,
      enumerable: false
    });
    Object.defineProperty(window, "__ideReload", {
      value: triggerReload,
      configurable: true,
      writable: true,
      enumerable: false
    });
  } catch (_) {
    window.__ideNavigate = triggerNav;
    window.__ideReload = triggerReload;
  }
  try {
    if (origOpen) {
      window.open = function (url, target, features) {
        var raw = url == null ? "" : String(url);
        var norm = normalizeNavRef(raw);
        if (raw && !isExternalNavRef(norm)) {
          triggerNav(raw);
          return null;
        }
        return origOpen(url, target, features);
      };
    }
  } catch (_) {}
  try {
    window.navigate = triggerNav;
    if (window.location) {
      window.location.assign = triggerNav;
      window.location.replace = triggerNav;
    }
  } catch (_) {
    /* location no redefinible en este entorno */
  }
})();
</script>`;
}
