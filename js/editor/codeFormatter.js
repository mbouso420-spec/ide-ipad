import { getIndentSize } from "./languageConfig.js";

const VOID_HTML_TAGS = new Set([
  "!doctype",
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

const RAW_HTML_TAGS = new Set(["pre", "textarea", "script", "style"]);
const RAW_HTML_CLOSE_REGEXES = new Map(
  Array.from(RAW_HTML_TAGS, (tag) => [tag, new RegExp(`</${tag}\\s*>`, "i")])
);

const BRACE_LANGUAGES = new Set([
  "js",
  "ts",
  "tsx",
  "c",
  "cpp",
  "java",
  "csharp",
  "rust",
  "go"
]);

const SQL_KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "AS",
  "ON",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "OUTER",
  "CROSS",
  "GROUP",
  "BY",
  "HAVING",
  "ORDER",
  "ASC",
  "DESC",
  "LIMIT",
  "OFFSET",
  "DISTINCT",
  "UNION",
  "ALL",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "CREATE",
  "TABLE",
  "IF",
  "EXISTS",
  "PRIMARY",
  "KEY",
  "AUTOINCREMENT",
  "DEFAULT",
  "UNIQUE",
  "FOREIGN",
  "REFERENCES",
  "DROP",
  "ALTER",
  "ADD",
  "INDEX",
  "VIEW",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "INTEGER",
  "TEXT",
  "REAL",
  "BLOB",
  "BOOLEAN",
  "TIMESTAMP",
  "PRAGMA"
]);

function normalizeLineEndings(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

function finalizeOutput(lines, rawLineIndices = null) {
  const out = [];
  let consecutiveBlanks = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (rawLineIndices?.has(i)) {
      consecutiveBlanks = 0;
      out.push(line);
    } else if (line === "") {
      consecutiveBlanks += 1;
      if (consecutiveBlanks <= 1) {
        out.push("");
      }
    } else {
      consecutiveBlanks = 0;
      out.push(line);
    }
  }
  while (out.length > 0 && out[0] === "") out.shift();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  if (out.length === 0) return "";
  return `${out.join("\n")}\n`;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "await",
  "typeof",
  "void",
  "delete",
  "in",
  "instanceof",
  "new",
  "yield",
  "else",
  "do",
  "of",
  "default"
]);

function canStartRegexLiteral(prevNonSpace, prevWord = "") {
  return (
    prevNonSpace === "" ||
    "=([,:;!&|?~^+-*/%<>{\n".includes(prevNonSpace) ||
    REGEX_PREFIX_KEYWORDS.has(prevWord)
  );
}

function formatBraceCode(code, lang, indentSize) {
  const unit = " ".repeat(indentSize);
  const rawLines = normalizeLineEndings(code).split("\n");
  const isPreprocessorLang = lang === "c" || lang === "cpp" || lang === "csharp";
  const hasRegexLiterals = lang === "js" || lang === "ts" || lang === "tsx";

  const out = [];
  const rawLineIndices = new Set();
  let braceDepth = 0;
  const caseStack = [];
  let inBlockComment = false;
  let templateStack = [];

  for (const rawLine of rawLines) {
    const insideLiteralTemplate =
      templateStack.length > 0 &&
      templateStack[templateStack.length - 1].exprDepth === 0;

    if (insideLiteralTemplate) {
      rawLineIndices.add(out.length);
      out.push(rawLine);
    } else if (inBlockComment) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        out.push("");
      } else {
        const extraCase = caseStack.filter(Boolean).length;
        const pad = unit.repeat(Math.max(0, braceDepth + extraCase));
        out.push(trimmed.startsWith("*") ? `${pad} ${trimmed}` : `${pad}${trimmed}`);
      }
    } else {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        out.push("");
      } else if (isPreprocessorLang && trimmed.startsWith("#")) {
        out.push(trimmed);
      } else {
        // Deducción previa de llaves de cierre al inicio de la línea
        let leadingCloseCount = 0;
        let idx = 0;
        while (idx < trimmed.length) {
          const ch = trimmed[idx];
          if (ch === "}") {
            leadingCloseCount += 1;
            idx += 1;
          } else if (ch === " " || ch === "\t") {
            idx += 1;
          } else {
            break;
          }
        }

        const isCaseLabel =
          braceDepth > 0 &&
          (/^case\b[\s\S]*:/.test(trimmed) || /^default\s*:/.test(trimmed));

        let displayDepth = braceDepth - leadingCloseCount;
        if (displayDepth < 0) displayDepth = 0;

        let activeCasesBeforeLine = caseStack.filter(Boolean).length;
        if (leadingCloseCount > 0) {
          for (let k = 0; k < leadingCloseCount && k < caseStack.length; k += 1) {
            if (caseStack[caseStack.length - 1 - k]) {
              activeCasesBeforeLine -= 1;
            }
          }
        } else if (isCaseLabel && caseStack.length > 0 && caseStack[caseStack.length - 1]) {
          activeCasesBeforeLine -= 1;
        }

        const totalIndent = Math.max(0, displayDepth + Math.max(0, activeCasesBeforeLine));
        out.push(`${unit.repeat(totalIndent)}${trimmed}`);
      }
    }

    const braceDepthBeforeLine = braceDepth;
    const caseTopIdxBeforeLine = caseStack.length - 1;
    // Avanzar el escáner léxico sobre la línea cruda para actualizar estado hacia la siguiente línea
    let quote = "";
    let prevNonSpace = "";
    let prevWord = "";
    const trimmedForCase = rawLine.trim();
    const startsCase =
      !inBlockComment &&
      !(templateStack.length > 0 && templateStack[templateStack.length - 1].exprDepth === 0) &&
      braceDepth > 0 &&
      (/^case\b[\s\S]*:/.test(trimmedForCase) || /^default\s*:/.test(trimmedForCase));

    for (let i = 0; i < rawLine.length; i += 1) {
      const ch = rawLine[i];
      const next = rawLine[i + 1] || "";

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }

      if (
        templateStack.length > 0 &&
        templateStack[templateStack.length - 1].exprDepth === 0
      ) {
        if (ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === "`") {
          templateStack.pop();
          prevNonSpace = ")";
          prevWord = "";
          continue;
        }
        if (ch === "$" && next === "{") {
          templateStack[templateStack.length - 1].exprDepth = 1;
          braceDepth += 1;
          caseStack.push(false);
          i += 1;
          prevNonSpace = "{";
          prevWord = "";
          continue;
        }
        continue;
      }

      if (quote) {
        if (ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === quote) {
          quote = "";
          prevNonSpace = ")";
          prevWord = "";
        }
        continue;
      }

      if (ch === "/" && next === "/") {
        break;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        prevWord = "";
        continue;
      }
      if (ch === "`" && hasRegexLiterals) {
        templateStack.push({ exprDepth: 0 });
        prevWord = "";
        continue;
      }
      if (ch === "/" && hasRegexLiterals && canStartRegexLiteral(prevNonSpace, prevWord)) {
        // Consumir regex literal hasta / sin escapar
        let inRegexClass = false;
        let j = i + 1;
        let closed = false;
        while (j < rawLine.length) {
          const rc = rawLine[j];
          if (rc === "\\") {
            j += 2;
            continue;
          }
          if (rc === "[") inRegexClass = true;
          else if (rc === "]" && inRegexClass) inRegexClass = false;
          else if (rc === "/" && !inRegexClass) {
            closed = true;
            break;
          }
          j += 1;
        }
        if (closed) {
          i = j;
          prevNonSpace = ")";
          prevWord = "";
          continue;
        }
      }

      if (
        templateStack.length > 0 &&
        templateStack[templateStack.length - 1].exprDepth > 0
      ) {
        if (ch === "{") {
          templateStack[templateStack.length - 1].exprDepth += 1;
        } else if (ch === "}") {
          templateStack[templateStack.length - 1].exprDepth -= 1;
          if (templateStack[templateStack.length - 1].exprDepth === 0) {
            if (braceDepth > 0) braceDepth -= 1;
            if (caseStack.length > 0) caseStack.pop();
            prevNonSpace = "";
            prevWord = "";
            continue;
          }
        }
      }

      if (/[A-Za-z_$]/.test(ch)) {
        let j = i + 1;
        while (j < rawLine.length && /[A-Za-z0-9_$]/.test(rawLine[j])) {
          j += 1;
        }
        const word = rawLine.slice(i, j);
        prevWord = prevNonSpace === "." ? "" : word;
        prevNonSpace = word[word.length - 1];
        i = j - 1;
        continue;
      }

      if (ch === "{") {
        braceDepth += 1;
        caseStack.push(false);
      } else if (ch === "}") {
        if (braceDepth > 0) braceDepth -= 1;
        if (caseStack.length > 0) caseStack.pop();
      }

      if (!/\s/.test(ch)) {
        prevWord = "";
        prevNonSpace = ch;
      }
    }

    if (startsCase && caseTopIdxBeforeLine >= 0 && caseTopIdxBeforeLine < caseStack.length) {
      caseStack[caseTopIdxBeforeLine] = braceDepth <= braceDepthBeforeLine;
    }
  }

  return finalizeOutput(out, rawLineIndices);
}

function formatCss(code, indentSize) {
  const unit = " ".repeat(indentSize);
  const src = normalizeLineEndings(code);

  // Fase 1: expandir reglas de una sola línea fuera de strings, comentarios y paréntesis url(...)
  let expanded = "";
  let inComment = false;
  let quote = "";
  let parenDepth = 0;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1] || "";

    if (inComment) {
      expanded += ch;
      if (ch === "*" && next === "/") {
        expanded += "/";
        inComment = false;
        i += 1;
        expanded += "\n";
        while (i + 1 < src.length && /[ \t\n]/.test(src[i + 1])) i += 1;
      }
      continue;
    }

    if (quote) {
      expanded += ch;
      if (ch === "\\") {
        if (i + 1 < src.length) {
          i += 1;
          expanded += src[i];
        }
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }

    if (ch === "/" && next === "*") {
      inComment = true;
      expanded += "/*";
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      expanded += ch;
      continue;
    }

    if (ch === "(") parenDepth += 1;
    else if (ch === ")" && parenDepth > 0) parenDepth -= 1;

    if (parenDepth === 0) {
      if (ch === "{") {
        expanded = expanded.replace(/[ \t]+$/, "");
        if (expanded.length > 0 && !expanded.endsWith("\n")) {
          expanded += " ";
        }
        expanded += "{\n";
        while (i + 1 < src.length && /[ \t\n]/.test(src[i + 1])) i += 1;
        continue;
      }
      if (ch === "}") {
        expanded = expanded.replace(/[ \t]+$/, "");
        if (expanded.length > 0 && !expanded.endsWith("\n")) {
          expanded += "\n";
        }
        expanded += "}\n";
        while (i + 1 < src.length && /[ \t\n]/.test(src[i + 1])) i += 1;
        continue;
      }
      if (ch === ";") {
        expanded += ";\n";
        while (i + 1 < src.length && /[ \t\n]/.test(src[i + 1])) i += 1;
        continue;
      }
    }

    expanded += ch;
  }

  // Fase 2: indentar por profundidad de llaves respetando comentarios
  const lines = expanded.split("\n");
  const out = [];
  let depth = 0;
  let commentLine = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      out.push("");
      continue;
    }

    if (commentLine) {
      out.push(`${unit.repeat(depth)} ${trimmed}`);
      if (trimmed.includes("*/")) commentLine = false;
      continue;
    }

    let leadingCloses = 0;
    while (leadingCloses < trimmed.length && trimmed[leadingCloses] === "}") {
      leadingCloses += 1;
    }
    const printDepth = Math.max(0, depth - leadingCloses);
    out.push(`${unit.repeat(printDepth)}${trimmed}`);
    if (printDepth === 0 && trimmed === "}") {
      out.push("");
    }

    // Actualizar depth fuera de strings/comentarios
    let q = "";
    for (let i = 0; i < trimmed.length; i += 1) {
      const c = trimmed[i];
      const n = trimmed[i + 1] || "";
      if (q) {
        if (c === "\\") i += 1;
        else if (c === q) q = "";
        continue;
      }
      if (c === "/" && n === "*") {
        const endIdx = trimmed.indexOf("*/", i + 2);
        if (endIdx === -1) {
          commentLine = true;
          break;
        }
        i = endIdx + 1;
        continue;
      }
      if (c === "'" || c === '"') {
        q = c;
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}" && depth > 0) depth -= 1;
    }
  }

  return finalizeOutput(out);
}

function scanHtmlTagsInLine(trimmed, startIdx = 0) {
  let delta = 0;
  let inComment = false;
  let rawTag = null;

  for (let i = startIdx; i < trimmed.length; i += 1) {
    if (inComment) {
      if (trimmed.startsWith("-->", i)) {
        inComment = false;
        i += 2;
      }
      continue;
    }
    if (trimmed.startsWith("<!--", i)) {
      inComment = true;
      i += 3;
      continue;
    }
    if (trimmed[i] !== "<") continue;

    const headMatch = trimmed.slice(i).match(/^<(\/?)([!a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!headMatch) continue;

    const isClosing = Boolean(headMatch[1]);
    const tagName = headMatch[2].toLowerCase();
    let j = i + headMatch[0].length;
    let attrQuote = "";

    while (j < trimmed.length) {
      const ch = trimmed[j];
      if (attrQuote) {
        if (ch === attrQuote) attrQuote = "";
      } else if (ch === '"' || ch === "'") {
        attrQuote = ch;
      } else if (ch === ">") {
        break;
      }
      j += 1;
    }

    if (j >= trimmed.length) break;

    const attrs = trimmed.slice(i + headMatch[0].length, j);
    if (isClosing) {
      delta -= 1;
      i = j;
      continue;
    }
    if (VOID_HTML_TAGS.has(tagName) || /\/\s*$/.test(attrs.trim())) {
      i = j;
      continue;
    }

    delta += 1;
    if (RAW_HTML_TAGS.has(tagName)) {
      const closeRe = RAW_HTML_CLOSE_REGEXES.get(tagName);
      const closeMatch = closeRe ? closeRe.exec(trimmed.slice(j + 1)) : null;
      if (closeMatch) {
        delta -= 1;
        i = j + 1 + closeMatch.index + closeMatch[0].length - 1;
        continue;
      }
      rawTag = tagName;
      break;
    }
    i = j;
  }

  return { delta, inComment, rawTag };
}

function formatHtml(code, indentSize) {
  const unit = " ".repeat(indentSize);
  const lines = normalizeLineEndings(code).split("\n");
  const out = [];
  const rawLineIndices = new Set();
  let depth = 0;
  let inComment = false;
  let rawTag = null;

  for (const rawLine of lines) {
    if (rawTag) {
      const closeRe = RAW_HTML_CLOSE_REGEXES.get(rawTag);
      if (closeRe && closeRe.test(rawLine)) {
        rawTag = null;
        if (depth > 0) depth -= 1;
        out.push(rawLine.trim().startsWith("</") ? `${unit.repeat(depth)}${rawLine.trim()}` : rawLine);
      } else {
        if (rawTag === "pre" || rawTag === "textarea") {
          rawLineIndices.add(out.length);
        }
        out.push(rawLine);
      }
      continue;
    }

    if (inComment) {
      const trimmed = rawLine.trim();
      out.push(trimmed ? `${unit.repeat(depth)}${trimmed}` : "");
      const endIdx = trimmed.indexOf("-->");
      if (endIdx !== -1) {
        inComment = false;
        const scannedAfter = scanHtmlTagsInLine(trimmed, endIdx + 3);
        depth = Math.max(0, depth + scannedAfter.delta);
        inComment = scannedAfter.inComment;
        rawTag = scannedAfter.rawTag;
      }
      continue;
    }

    const trimmed = rawLine.trim();
    if (!trimmed) {
      out.push("");
      continue;
    }

    if (trimmed.startsWith("<!--")) {
      out.push(`${unit.repeat(depth)}${trimmed}`);
      const endIdx = trimmed.indexOf("-->");
      if (endIdx === -1) {
        inComment = true;
      } else {
        const scannedAfter = scanHtmlTagsInLine(trimmed, endIdx + 3);
        depth = Math.max(0, depth + scannedAfter.delta);
        inComment = scannedAfter.inComment;
        rawTag = scannedAfter.rawTag;
      }
      continue;
    }

    let leadingCloses = 0;
    const leadingCloseMatch = trimmed.match(/^(<\/[a-zA-Z0-9:-]+\s*>)+/);
    if (leadingCloseMatch) {
      leadingCloses = (leadingCloseMatch[0].match(/<\//g) || []).length;
    }
    const lineDepth = Math.max(0, depth - leadingCloses);
    out.push(`${unit.repeat(lineDepth)}${trimmed}`);

    const scanned = scanHtmlTagsInLine(trimmed, 0);
    inComment = scanned.inComment;
    rawTag = scanned.rawTag;
    depth = Math.max(0, depth + scanned.delta);
  }

  return finalizeOutput(out, rawLineIndices);
}

function formatSql(code) {
  const src = normalizeLineEndings(code);
  let out = "";
  let quote = "";
  let inBlockComment = false;
  let inLineComment = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1] || "";

    if (inLineComment) {
      out += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      out += ch;
      if (ch === "*" && next === "/") {
        out += "/";
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < src.length) {
        i += 1;
        out += src[i];
      } else if (ch === quote) {
        if (next === quote) {
          out += next;
          i += 1;
        } else {
          quote = "";
        }
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      out += "--";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      out += "/*";
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) {
        j += 1;
      }
      const word = src.slice(i, j);
      const upper = word.toUpperCase();
      const prevChar = i > 0 ? src[i - 1] : "";
      out += prevChar !== "." && SQL_KEYWORDS.has(upper) ? upper : word;
      i = j - 1;
      continue;
    }

    out += ch;
  }

  return finalizeOutput(out.split("\n").map((line) => line.replace(/[ \t]+$/, "")));
}

function formatPythonSafe(code) {
  const rawLines = normalizeLineEndings(code).split("\n");
  const lines = rawLines.map((line) => {
    const leadingMatch = line.match(/^[ \t]*/);
    const leading = (leadingMatch ? leadingMatch[0] : "").replace(/\t/g, "    ");
    const rest = line.slice(leadingMatch ? leadingMatch[0].length : 0).replace(/[ \t]+$/, "");
    return rest === "" ? "" : `${leading}${rest}`;
  });
  const out = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === "") {
      blanks += 1;
      if (blanks <= 2) out.push("");
    } else {
      blanks = 0;
      out.push(line);
    }
  }
  while (out.length > 0 && out[0] === "") out.shift();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

function formatMarkdownOrText(code, preserveMarkdownBreaks = false) {
  const rawLines = normalizeLineEndings(code).split("\n");
  const lines = rawLines.map((line) => {
    const isHeading = /^#{1,6}\s/.test(line.trimStart());
    if (preserveMarkdownBreaks && !isHeading && line.trim().length > 0 && / {2,}$/.test(line)) {
      return `${line.replace(/[ \t]+$/, "")}  `;
    }
    return line.replace(/[ \t]+$/, "");
  });
  return finalizeOutput(lines);
}

/**
 * Formatea el código fuente de manera determinista e idempotente 100% offline.
 * Nunca destruye archivos inválidos en JSON ni modifica contenido de strings o bloques raw.
 *
 * @param {string} code
 * @param {string} lang
 * @param {{ indentSize?: number }} [options]
 * @returns {{ ok: true, formatted: string, changed: boolean } | { ok: false, formatted: string, error: string }}
 */
export function formatCode(code, lang = "text", options = {}) {
  const original = String(code ?? "");
  const cleanLang = String(lang || "text").toLowerCase();
  const indentSize = Math.max(2, Math.min(8, Number(options.indentSize || getIndentSize(cleanLang))));

  if (!original.trim()) {
    return {
      ok: true,
      formatted: "",
      changed: original !== ""
    };
  }

  if (cleanLang === "json") {
    try {
      const parsed = JSON.parse(normalizeLineEndings(original));
      const formatted = `${JSON.stringify(parsed, null, indentSize)}\n`;
      return {
        ok: true,
        formatted,
        changed: formatted !== original
      };
    } catch {
      return {
        ok: false,
        formatted: original,
        error: "JSON con errores de sintaxis: corregí comas o comillas antes de formatear."
      };
    }
  }

  let formatted;
  if (cleanLang === "css") {
    formatted = formatCss(original, indentSize);
  } else if (cleanLang === "html") {
    formatted = formatHtml(original, indentSize);
  } else if (cleanLang === "sql") {
    formatted = formatSql(original);
  } else if (cleanLang === "python") {
    formatted = formatPythonSafe(original);
  } else if (BRACE_LANGUAGES.has(cleanLang)) {
    formatted = formatBraceCode(original, cleanLang, indentSize);
  } else {
    formatted = formatMarkdownOrText(original, cleanLang === "markdown");
  }

  return {
    ok: true,
    formatted,
    changed: formatted !== original
  };
}
