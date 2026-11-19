/**
 * Diagnóstico / linting en vivo bajo demanda (debounce 500 ms) para JavaScript (Acorn lazy),
 * JSON (`JSON.parse` + localizador de línea/columna) y HTML (escáner estructural puro).
 */

export const LIVE_LINT_DEBOUNCE_MS = 500;
export const ACORN_CDN_URL = "https://esm.sh/acorn@8.14.0";
const MAX_LIVE_DIAGNOSTICS = 25;
const ACORN_LOAD_TIMEOUT_MS = 4000;
const ACORN_RETRY_COOLDOWN_MS = 60_000;

const LIVE_LINT_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "json",
  "html",
  "htm"
]);

const HTML_VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"
]);
const JSON_NUM_STICKY_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HTML_TAG_NAME_RE = /^([a-zA-Z][a-zA-Z0-9:-]*)/;
const HTML_CLOSE_TAG_RE = {
  script: /<\/script\s*>/gi,
  style: /<\/style\s*>/gi
};

let lazyAcornModulePromise = null;
let lastAcornFailureAt = 0;

/**
 * Carga diferida y compartida de Acorn desde CDN con timeout acotado y cooldown ante fallos
 * para evitar tormentas de red offline o sesiones colgadas en iPadOS.
 */
export async function loadAcornModule() {
  if (lazyAcornModulePromise) return lazyAcornModulePromise;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return null;
  }
  if (lastAcornFailureAt && (Date.now() - lastAcornFailureAt) < ACORN_RETRY_COOLDOWN_MS) {
    return null;
  }

  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Acorn load timeout")), ACORN_LOAD_TIMEOUT_MS);
    if (typeof timeoutId?.unref === "function") timeoutId.unref();
  });

  lazyAcornModulePromise = Promise.race([import(ACORN_CDN_URL), timeoutPromise])
    .then((mod) => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (mod && typeof mod.parse === "function") {
        lastAcornFailureAt = 0;
        return mod;
      }
      lazyAcornModulePromise = null;
      lastAcornFailureAt = Date.now();
      return null;
    })
    .catch(() => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      lazyAcornModulePromise = null;
      lastAcornFailureAt = Date.now();
      return null;
    });

  return lazyAcornModulePromise;
}

async function getLazyAcornParse() {
  const mod = await loadAcornModule();
  return typeof mod?.parse === "function" ? mod.parse : null;
}

function extractHtmlIdValues(rawTag, startOffset) {
  const ids = [];
  const len = rawTag.length;
  let pos = startOffset;
  while (pos < len) {
    while (pos < len && (rawTag.charCodeAt(pos) <= 32 || rawTag[pos] === "/")) pos += 1;
    if (pos >= len) break;
    const attrStart = pos;
    while (pos < len) {
      const ch = rawTag[pos];
      if (ch <= " " || ch === "=" || ch === "/") break;
      pos += 1;
    }
    const attrName = rawTag.slice(attrStart, pos).toLowerCase();
    while (pos < len && rawTag.charCodeAt(pos) <= 32) pos += 1;
    let attrVal = "";
    if (pos < len && rawTag[pos] === "=") {
      pos += 1;
      while (pos < len && rawTag.charCodeAt(pos) <= 32) pos += 1;
      if (pos < len && (rawTag[pos] === '"' || rawTag[pos] === "'")) {
        const quote = rawTag[pos];
        pos += 1;
        const valStart = pos;
        while (pos < len && rawTag[pos] !== quote) pos += 1;
        attrVal = rawTag.slice(valStart, pos);
        if (pos < len) pos += 1;
      } else {
        const valStart = pos;
        while (pos < len && rawTag.charCodeAt(pos) > 32 && rawTag[pos] !== "/") pos += 1;
        attrVal = rawTag.slice(valStart, pos);
      }
    }
    if (attrName === "id" && attrVal) {
      ids.push(attrVal);
    }
  }
  return ids;
}

/**
 * Extrae extensión normalizada en minúsculas sin punto.
 * @param {string} filePath
 * @returns {string}
 */
function getExtension(filePath) {
  const clean = String(filePath || "").split(/[?#]/)[0].trim().toLowerCase();
  const dot = clean.lastIndexOf(".");
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (dot <= slash || dot === clean.length - 1) return "";
  return clean.slice(dot + 1);
}

/**
 * Indica si un archivo participa en el diagnóstico en vivo del editor.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isLiveLintablePath(filePath) {
  return LIVE_LINT_EXTENSIONS.has(getExtension(filePath));
}

/**
 * Convierte un índice de carácter 0-based en `{ line, column }` 1-based.
 * @param {string} text
 * @param {number} index
 */
function indexToLineCol(text, index) {
  const safeIdx = Math.max(0, Math.min(text.length, Number(index) || 0));
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < safeIdx; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastNl = i;
    }
  }
  return { line, column: safeIdx - lastNl };
}

/**
 * Escáner JSON ligero para obtener línea/columna cuando el motor JS (p. ej. WebKit/V8 moderno)
 * omite el índice exacto en `SyntaxError.message`.
 */
function locateJsonSyntaxFallback(text) {
  const len = text.length;
  let i = 0;

  const skipWs = () => {
    while (i < len) {
      const code = text.charCodeAt(i);
      if (code === 32 || code === 9 || code === 10 || code === 13) {
        i += 1;
      } else {
        break;
      }
    }
  };

  const fail = (msg, idx = i) => {
    const loc = indexToLineCol(text, idx);
    return { line: loc.line, column: loc.column, message: msg };
  };

  const parseString = () => {
    const start = i;
    i += 1; // '"'
    while (i < len) {
      const ch = text[i];
      if (ch === '"') {
        i += 1;
        return null;
      }
      if (ch === "\\") {
        i += 1;
        if (i >= len) return fail("Secuencia de escape JSON incompleta", start);
        const esc = text[i];
        if (!'"\\/bfnrtu'.includes(esc)) {
          return fail(`Escape JSON inválido "\\${esc}"`, i);
        }
        if (esc === "u") {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            return fail("Escape Unicode \\uXXXX inválido en JSON", i);
          }
          i += 4;
        }
        i += 1;
        continue;
      }
      if (text.charCodeAt(i) < 0x20) {
        return fail("Carácter de control sin escapar dentro de cadena JSON", i);
      }
      i += 1;
    }
    return fail("Cadena JSON sin comilla de cierre", start);
  };

  const parseValue = (depth = 0) => {
    if (depth > 256) return fail("Anidamiento JSON excesivo");
    skipWs();
    if (i >= len) return fail("Se esperaba un valor JSON antes del fin de archivo", Math.max(0, len - 1));
    const ch = text[i];

    if (ch === '"') return parseString();

    if (ch === "{") {
      i += 1;
      skipWs();
      if (i < len && text[i] === "}") {
        i += 1;
        return null;
      }
      while (i < len) {
        skipWs();
        if (text[i] !== '"') {
          if (text[i] === "}") return fail("Coma final no permitida antes de '}' en JSON");
          return fail("Las claves de un objeto JSON deben ir entre comillas dobles");
        }
        const keyErr = parseString();
        if (keyErr) return keyErr;
        skipWs();
        if (text[i] !== ":") {
          return fail("Se esperaba ':' después de la clave JSON");
        }
        i += 1;
        const valErr = parseValue(depth + 1);
        if (valErr) return valErr;
        skipWs();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return null;
        }
        return fail("Se esperaba ',' o '}' en objeto JSON");
      }
      return fail("Objeto JSON '{' sin cerrar");
    }

    if (ch === "[") {
      i += 1;
      skipWs();
      if (i < len && text[i] === "]") {
        i += 1;
        return null;
      }
      while (i < len) {
        skipWs();
        if (text[i] === "]") return fail("Coma final no permitida antes de ']' en JSON");
        const elemErr = parseValue(depth + 1);
        if (elemErr) return elemErr;
        skipWs();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return null;
        }
        return fail("Se esperaba ',' o ']' en arreglo JSON");
      }
      return fail("Arreglo JSON '[' sin cerrar");
    }

    if (ch === "t" && text.startsWith("true", i)) { i += 4; return null; }
    if (ch === "f" && text.startsWith("false", i)) { i += 5; return null; }
    if (ch === "n" && text.startsWith("null", i)) { i += 4; return null; }

    JSON_NUM_STICKY_RE.lastIndex = i;
    const numMatch = JSON_NUM_STICKY_RE.exec(text);
    if (numMatch) {
      i += numMatch[0].length;
      return null;
    }

    return fail(`Token JSON inesperado '${ch}'`);
  };

  const err = parseValue(0);
  if (err) return err;
  skipWs();
  if (i < len) {
    return fail(`Contenido inesperado después del JSON raíz ('${text[i]}')`);
  }
  return { line: 1, column: 1, message: "JSON inválido" };
}

/**
 * Valida un documento JSON sin dependencias externas.
 * @param {string} code
 */
export function lintJson(code) {
  const src = String(code ?? "");
  if (!src.trim()) return [];
  try {
    JSON.parse(src);
    return [];
  } catch (err) {
    const rawMsg = err?.message || "JSON inválido";
    const lineColMatch = /line\s+(\d+)\s+column\s+(\d+)/i.exec(rawMsg);
    if (lineColMatch) {
      return [{
        line: Number(lineColMatch[1]) || 1,
        column: Number(lineColMatch[2]) || 1,
        severity: "error",
        message: `[JSON] ${rawMsg}`
      }];
    }
    const posMatch = /(?:at position|at column)\s+(\d+)/i.exec(rawMsg);
    if (posMatch && /position/i.test(posMatch[0])) {
      const loc = indexToLineCol(src, Number(posMatch[1]));
      return [{
        line: loc.line,
        column: loc.column,
        severity: "error",
        message: `[JSON] ${rawMsg}`
      }];
    }
    const located = locateJsonSyntaxFallback(src);
    return [{
      line: located.line,
      column: located.column,
      severity: "error",
      message: `[JSON] ${located.message}`
    }];
  }
}

/**
 * Valida estructura básica HTML (etiquetas sin cerrar, cierres huérfanos, comentarios abiertos e IDs duplicados).
 * @param {string} code
 */
export function lintHtml(code) {
  const src = String(code ?? "");
  if (!src.trim()) return [];

  const issues = [];
  const stack = [];
  const seenIds = new Set();
  const len = src.length;
  let i = 0;

  const pushIssue = (index, severity, message) => {
    if (issues.length >= MAX_LIVE_DIAGNOSTICS) return;
    const { line, column } = indexToLineCol(src, index);
    issues.push({ line, column, severity, message });
  };

  while (i < len && issues.length < MAX_LIVE_DIAGNOSTICS) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;

    // Comentario HTML
    if (src.startsWith("<!--", lt)) {
      const endComment = src.indexOf("-->", lt + 4);
      if (endComment === -1) {
        pushIssue(lt, "error", "[HTML] Comentario '<!--' sin cerrar con '-->'.");
        break;
      }
      i = endComment + 3;
      continue;
    }

    // Declaración <!DOCTYPE ...> o CDATA
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const gt = src.indexOf(">", lt + 2);
      if (gt === -1) {
        pushIssue(lt, "error", "[HTML] Declaración '<' sin cerrar con '>'.");
        break;
      }
      i = gt + 1;
      continue;
    }

    // Escanear hasta '>' respetando comillas de atributos
    let cursor = lt + 1;
    let quote = "";
    while (cursor < len) {
      const ch = src[cursor];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      } else if (ch === "<") {
        // Nuevo '<' antes de cerrar etiqueta actual
        break;
      }
      cursor += 1;
    }

    if (cursor >= len || src[cursor] !== ">") {
      pushIssue(lt, "error", "[HTML] Etiqueta abierta '<' sin carácter de cierre '>'.");
      if (cursor >= len) break;
      i = Math.max(lt + 1, cursor);
      continue;
    }

    const rawTag = src.slice(lt + 1, cursor).trim();
    i = cursor + 1;
    if (!rawTag) continue;

    if (rawTag.startsWith("/")) {
      const closeName = rawTag.slice(1).trim().split(/\s+/)[0].toLowerCase();
      if (!closeName || HTML_VOID_TAGS.has(closeName)) continue;

      let foundAt = -1;
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stack[s].name === closeName) {
          foundAt = s;
          break;
        }
      }
      if (foundAt === -1) {
        pushIssue(lt, "error", `[HTML] Etiqueta de cierre inesperada </${closeName}> sin apertura.`);
      } else {
        while (stack.length - 1 > foundAt) {
          const unclosed = stack.pop();
          pushIssue(unclosed.index, "error", `[HTML] La etiqueta <${unclosed.name}> quedó abierta antes de </${closeName}>.`);
        }
        stack.pop();
      }
      continue;
    }

    const selfClosing = rawTag.endsWith("/");
    const nameMatch = HTML_TAG_NAME_RE.exec(rawTag);
    if (!nameMatch) continue;
    const tagName = nameMatch[1].toLowerCase();

    // Detectar IDs duplicados como advertencia (ignorando atributos prefijados como data-id y valores entrecomillados)
    const idValues = extractHtmlIdValues(rawTag, nameMatch[0].length);
    for (const idVal of idValues) {
      if (seenIds.has(idVal)) {
        pushIssue(lt, "warning", `[HTML warning] Atributo id="${idVal}" duplicado en el documento.`);
      } else {
        seenIds.add(idVal);
      }
    }

    // Saltar contenido crudo de <script> y <style> para evitar falsos positivos en JS/CSS embebido
    if ((tagName === "script" || tagName === "style") && !selfClosing) {
      const closeRe = HTML_CLOSE_TAG_RE[tagName];
      closeRe.lastIndex = i;
      const closeHit = closeRe.exec(src);
      if (!closeHit) {
        pushIssue(lt, "error", `[HTML] Etiqueta <${tagName}> sin cierre </${tagName}>.`);
        break;
      }
      i = closeHit.index + closeHit[0].length;
      continue;
    }

    if (!selfClosing && !HTML_VOID_TAGS.has(tagName)) {
      stack.push({ name: tagName, index: lt });
    }
  }

  for (const unclosed of stack) {
    pushIssue(unclosed.index, "error", `[HTML] Etiqueta <${unclosed.name}> sin cerrar.`);
  }

  return issues.slice(0, MAX_LIVE_DIAGNOSTICS);
}

const REGEX_PREFIX_KEYWORDS = new Set([
  "return", "case", "throw", "yield", "await", "typeof", "void",
  "delete", "in", "of", "instanceof", "new", "else", "do"
]);

/**
 * Respaldo offline sin CDN para detectar cadenas, comentarios y delimitadores sin cerrar en JS.
 */
function fallbackLintJsDelimiters(code) {
  const stack = [];
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const closeToOpen = { ")": "(", "]": "[", "}": "{" };
  const len = code.length;
  let i = 0;
  let expectRegex = true;

  const scanTemplateFrom = (contentStart, openTickIndex) => {
    i = contentStart;
    while (i < len) {
      if (code[i] === "\\") {
        i += 2;
        continue;
      }
      if (code[i] === "`") {
        i += 1;
        expectRegex = false;
        return null;
      }
      if (code[i] === "$" && code[i + 1] === "{") {
        stack.push({ ch: "{", index: i + 1, isTemplateExpr: true, templateOpenIndex: openTickIndex });
        i += 2;
        expectRegex = true;
        return "expr";
      }
      i += 1;
    }
    const loc = indexToLineCol(code, openTickIndex);
    return [{ line: loc.line, column: loc.column, severity: "error", message: "[JS] Literal ` sin cerrar." }];
  };

  while (i < len) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch <= " ") {
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      const nl = code.indexOf("\n", i + 2);
      i = nl === -1 ? len : nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end === -1) {
        const loc = indexToLineCol(code, i);
        return [{ line: loc.line, column: loc.column, severity: "error", message: "[JS] Comentario '/*' sin cerrar." }];
      }
      i = end + 2;
      continue;
    }
    if (ch === "/" && expectRegex) {
      const rStart = i;
      i += 1;
      let inClass = false;
      let rClosed = false;
      while (i < len) {
        const rc = code[i];
        if (rc === "\\") {
          i += 2;
          continue;
        }
        if (rc === "\n" || rc === "\r") break;
        if (rc === "[") {
          inClass = true;
        } else if (rc === "]" && inClass) {
          inClass = false;
        } else if (rc === "/" && !inClass) {
          rClosed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (rClosed) {
        while (i < len && /[a-zA-Z]/.test(code[i])) i += 1;
        expectRegex = false;
        continue;
      }
      i = rStart + 1;
      expectRegex = true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      let closed = false;
      i += 1;
      while (i < len) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === "\n" || code[i] === "\r") {
          const loc = indexToLineCol(code, start);
          return [{ line: loc.line, column: loc.column, severity: "error", message: `[JS] Cadena ${quote}...${quote} sin cerrar.` }];
        }
        if (code[i] === quote) {
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) {
        const loc = indexToLineCol(code, start);
        return [{ line: loc.line, column: loc.column, severity: "error", message: `[JS] Literal ${quote} sin cerrar.` }];
      }
      expectRegex = false;
      continue;
    }

    if (ch === "`") {
      const tplRes = scanTemplateFrom(i + 1, i);
      if (Array.isArray(tplRes)) return tplRes;
      continue;
    }

    if (pairs[ch]) {
      stack.push({ ch, index: i });
      expectRegex = true;
      i += 1;
      continue;
    }

    if (closeToOpen[ch]) {
      if (stack.length === 0 || stack[stack.length - 1].ch !== closeToOpen[ch]) {
        const loc = indexToLineCol(code, i);
        return [{ line: loc.line, column: loc.column, severity: "error", message: `[JS] Delimitador inesperado '${ch}'.` }];
      }
      const popped = stack.pop();
      if (popped.isTemplateExpr) {
        const tplRes = scanTemplateFrom(i + 1, popped.templateOpenIndex);
        if (Array.isArray(tplRes)) return tplRes;
        continue;
      }
      expectRegex = ch === "}";
      i += 1;
      continue;
    }

    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$") {
      const idStart = i;
      i += 1;
      while (i < len) {
        const c = code[i];
        if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "$") {
          i += 1;
        } else {
          break;
        }
      }
      expectRegex = REGEX_PREFIX_KEYWORDS.has(code.slice(idStart, i));
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      while (i < len && ((code[i] >= "0" && code[i] <= "9") || code[i] === "." || code[i] === "_" || code[i] === "x" || code[i] === "X")) {
        i += 1;
      }
      expectRegex = false;
      continue;
    }

    expectRegex = true;
    i += 1;
  }

  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.isTemplateExpr) {
      const loc = indexToLineCol(code, top.templateOpenIndex);
      return [{ line: loc.line, column: loc.column, severity: "error", message: "[JS] Literal ` sin cerrar." }];
    }
    const loc = indexToLineCol(code, top.index);
    return [{ line: loc.line, column: loc.column, severity: "error", message: `[JS] Falta cerrar '${pairs[top.ch]}' abierto aquí.` }];
  }
  return [];
}

/**
 * Valida sintaxis JavaScript usando Acorn (cargado lazy desde esm.sh) con fallback léxico offline.
 * @param {string} code
 * @param {string} [ext="js"]
 * @param {{ parseFn?: Function }} [options]
 */
export async function lintJavaScript(code, ext = "js", { parseFn = null } = {}) {
  const src = String(code ?? "");
  if (!src.trim()) return [];

  const acornParse = typeof parseFn === "function" ? parseFn : await getLazyAcornParse();
  if (!acornParse) {
    return fallbackLintJsDelimiters(src);
  }

  const sourceType = ext === "cjs" ? "script" : "module";
  try {
    acornParse(src, {
      ecmaVersion: "latest",
      sourceType,
      allowHashBang: true,
      locations: true
    });
    return [];
  } catch (err) {
    // Si falló con script estricto dentro de .js sin import/export por `with` o similar, no ocultar error real
    const loc = err?.loc || (typeof err?.pos === "number" ? indexToLineCol(src, err.pos) : { line: 1, column: 1 });
    const cleanMsg = String(err?.message || "Error de sintaxis JavaScript")
      .replace(/\s*\(\d+:\d+\)\s*$/, "")
      .trim();
    return [{
      line: Number(loc.line) || 1,
      column: Number(loc.column ?? 0) + (err?.loc ? 1 : 0),
      severity: "error",
      message: `[JS] ${cleanMsg}`
    }];
  }
}

/**
 * Ejecuta diagnóstico en vivo sobre el archivo indicado si su extensión está soportada.
 * @param {string} filePath
 * @param {string} content
 * @param {{ parseJsFn?: Function }} [options]
 * @returns {Promise<Array<{ line: number, column: number, severity: "error" | "warning", message: string }>>}
 */
export async function lintDocument(filePath, content, { parseJsFn = null } = {}) {
  const ext = getExtension(filePath);
  if (!LIVE_LINT_EXTENSIONS.has(ext)) return [];

  if (ext === "json") {
    return lintJson(content);
  }
  if (ext === "html" || ext === "htm") {
    return lintHtml(content);
  }
  return lintJavaScript(content, ext, { parseFn: parseJsFn });
}
