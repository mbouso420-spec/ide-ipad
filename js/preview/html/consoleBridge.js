/**
 * Script puente inyectado dentro de `<iframe srcdoc>` para consola JS, LoopGuard, mini-REPL e interceptor de navegación.
 */

import { buildLoopGuardRuntime } from "../loopGuard.js";

export function buildConsoleBridgeScript(mirrorOnScreen) {
  return `<script>
${buildLoopGuardRuntime()}
(function () {
  var mirror = ${mirrorOnScreen ? "true" : "false"};
  function formatArgs(args) {
    return Array.prototype.slice.call(args).map(function (item) {
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
  // Interceptor total de navegación local en enlaces
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href], area[href], a[xlink\\:href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || a.getAttribute("xlink:href") || "";
    if (!href) return;
    var normHref = normalizeNavRef(href);
    if (isBlockedNavScheme(normHref)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (normHref.startsWith("#")) return;
    if (/^(https?:|mailto:|tel:|blob:)/.test(normHref)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({
      source: "studio-ide-preview",
      action: "navigate",
      href: href
    }, "*");
  }, true);

  // Interceptor de envíos de formularios locales
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
      return;
    }
    if (normAction.startsWith("#") || /^(https?:|mailto:|tel:)/.test(normAction)) return;
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({
      source: "studio-ide-preview",
      action: "navigate",
      href: action
    }, "*");
  }, true);

  // Interceptor de llamadas programáticas de navegación
  try {
    var triggerNav = function (targetUrl) {
      if (!targetUrl || typeof targetUrl !== "string") return;
      var normTarget = normalizeNavRef(targetUrl);
      if (!normTarget || isBlockedNavScheme(normTarget)) return;
      if (normTarget.startsWith("#")) {
        window.location.hash = targetUrl;
        return;
      }
      if (/^(https?:|mailto:|tel:)/.test(normTarget)) {
        window.open(targetUrl, "_blank", "noopener,noreferrer");
        return;
      }
      parent.postMessage({
        source: "studio-ide-preview",
        action: "navigate",
        href: targetUrl
      }, "*");
    };
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
