/**
 * Motor interactivo de SQLite en memoria para archivos .sql en la Vista Previa.
 * Utiliza sql.js (compilado a WebAssembly) cargado desde CDN autorizado por CSP.
 * Permite ejecutar DDL/DML, tablas formateadas para SELECT, consultas interactivas y exportación a CSV/JSON.
 */

import { escapeHtml } from "./previewUtils.js";

/**
 * Convierte un conjunto de resultados de sql.js a formato CSV estándar.
 * @param {Array<{ columns: string[], values: any[][] }>} results
 * @param {number} [maxRows] Límite de filas a serializar para prevenir desbordes de memoria.
 * @returns {string}
 */
export function convertResultsToCsv(results, maxRows = Infinity) {
  if (!Array.isArray(results) || results.length === 0) {
    return "";
  }

  const sections = [];
  const limit = Number.isFinite(maxRows) && maxRows > 0 ? maxRows : Infinity;

  for (const res of results) {
    if (!res || !Array.isArray(res.columns)) continue;
    const lines = [];

    // Cabeceras
    lines.push(res.columns.map(escapeCsvField).join(","));

    // Filas con protección de volumen
    if (Array.isArray(res.values)) {
      const rowLimit = Math.min(res.values.length, limit);
      for (let i = 0; i < rowLimit; i++) {
        const row = res.values[i];
        if (!Array.isArray(row)) continue;
        lines.push(row.map(escapeCsvField).join(","));
      }
    }

    sections.push(lines.join("\r\n"));
  }

  return sections.join("\r\n\r\n");
}

function escapeCsvField(val) {
  if (val === null || val === undefined) return "";
  let str = String(val);
  const needsFormulaNeutralization =
    typeof val !== "number" &&
    str.length > 0 &&
    (/^[=+\t\r@]/.test(str) || (/^-/.test(str) && !/^-\d+(?:\.\d+)?$/.test(str)));
  if (needsFormulaNeutralization) {
    str = `'${str}`;
  }
  if (needsFormulaNeutralization || str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Elimina comentarios SQL (-- y /* * /) respetando literales entre comillas simples, dobles o backticks.
 * @param {string} sql
 * @returns {string}
 */
function stripSqlCommentsSafe(sql) {
  const src = String(sql || "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1] || "";
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch;
      out += ch;
      i += 1;
      while (i < src.length) {
        out += src[i];
        if (src[i] === q) {
          if (src[i + 1] === q) {
            out += src[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function hasMultipleSqlStatements(sql) {
  const src = stripSqlCommentsSafe(sql);
  let i = 0;
  let seenSemicolon = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch;
      i += 1;
      while (i < src.length) {
        if (src[i] === q) {
          if (src[i + 1] === q) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === ";") {
      seenSemicolon = true;
    } else if (seenSemicolon && !/\s/.test(ch)) {
      return true;
    }
    i += 1;
  }
  return false;
}

/**
 * Convierte los resultados de sql.js a una estructura JSON limpia con nombres de columna como claves.
 * @param {Array<{ columns: string[], values: any[][] }>} results
 * @param {number} [maxRows] Límite de filas a serializar.
 * @returns {Array<Record<string, any>>}
 */
export function convertResultsToJson(results, maxRows = Infinity) {
  if (!Array.isArray(results) || results.length === 0) {
    return [];
  }

  const out = [];
  const limit = Number.isFinite(maxRows) && maxRows > 0 ? maxRows : Infinity;

  for (const res of results) {
    if (!res || !Array.isArray(res.columns) || !Array.isArray(res.values)) continue;
    const cols = res.columns;
    const rowLimit = Math.min(res.values.length, limit);
    for (let rowIndex = 0; rowIndex < rowLimit; rowIndex++) {
      const row = res.values[rowIndex];
      if (!Array.isArray(row)) continue;
      const obj = {};
      for (let i = 0; i < cols.length; i += 1) {
        Object.defineProperty(obj, cols[i], {
          value: row[i] !== undefined ? row[i] : null,
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
      out.push(obj);
    }
  }

  return out;
}

/**
 * Determina si una consulta SQL corresponde a una sentencia de selección (SELECT o WITH ... SELECT).
 * @param {string} sql
 * @returns {boolean}
 */
export function isSelectQuery(sql) {
  if (!sql || typeof sql !== "string") return false;
  if (hasMultipleSqlStatements(sql)) return false;
  const stripped = stripSqlCommentsSafe(sql).trim();
  return /^(WITH\s+[\s\S]+?SELECT|SELECT\b)/i.test(stripped);
}

/**
 * Comprueba si la consulta ya contiene una cláusula LIMIT explícita a nivel externo
 * (ignorando comentarios, cadenas de texto y subconsultas/CTEs).
 * @param {string} sql
 * @param {(s: string) => string} [stripComments]
 * @returns {boolean}
 */
export function hasLimitClause(sql, stripComments = stripSqlCommentsSafe) {
  if (!sql || typeof sql !== "string") return false;
  const src = stripComments(sql);
  const backtick = String.fromCharCode(96);
  const NON_CLAUSE_PREV_WORDS = new Set([
    "SELECT", "AS", "AND", "OR", "NOT", "WHERE", "ON",
    "WHEN", "THEN", "ELSE", "CASE", "FROM", "JOIN", "SET", "INTO", "VALUES"
  ]);
  const NON_CLAUSE_PREV_CHARS = new Set([",", ".", "(", "=", "<", ">", "!", "+", "-", "*", "/", "%", "|"]);
  let i = 0;
  let depth = 0;
  let prevNonWs = "";
  let prevWord = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === backtick) {
      const q = ch;
      i += 1;
      while (i < src.length) {
        if (src[i] === q) {
          if (src[i + 1] === q) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      prevNonWs = q;
      prevWord = "";
      continue;
    }
    if (ch === "[") {
      const closeBracket = src.indexOf("]", i + 1);
      i = closeBracket === -1 ? src.length : closeBracket + 1;
      prevNonWs = "]";
      prevWord = "";
      continue;
    }
    if (ch === "(") {
      depth += 1;
      prevNonWs = "(";
      prevWord = "";
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth -= 1;
      prevNonWs = ")";
      prevWord = "";
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < src.length && /[A-Za-z0-9_$]/.test(src[end])) end += 1;
      const word = src.slice(i, end);
      const upper = word.toUpperCase();
      if (
        depth === 0 &&
        upper === "LIMIT" &&
        !NON_CLAUSE_PREV_CHARS.has(prevNonWs) &&
        !NON_CLAUSE_PREV_WORDS.has(prevWord)
      ) {
        let j = end;
        while (j < src.length && /\s/.test(src[j])) j += 1;
        const tail = src.slice(j);
        if (/^(?:\(|\d|[+-]\s*\d|\?|[:@$][A-Za-z0-9_]*)/.test(tail)) {
          return true;
        }
      }
      prevNonWs = "id";
      prevWord = upper;
      i = end;
      continue;
    }
    if (!/\s/.test(ch)) {
      prevNonWs = ch;
      prevWord = "";
    }
    i += 1;
  }
  return false;
}

/**
 * Aplica paginación real a nivel de motor SQL mediante cláusulas LIMIT y OFFSET,
 * evitando materializar en la memoria de WebAssembly/JavaScript conjuntos masivos de filas.
 * @param {string} query Consulta SQL cruda
 * @param {number} [limit=50] Tamaño de página
 * @param {number} [offset=0] Desplazamiento inicial
 * @returns {string} Consulta SQL paginada
 */
export function applySqlPagination(query, limit = 50, offset = 0) {
  if (!query || typeof query !== "string") return "";
  const cleaned = stripSqlCommentsSafe(query).trim().replace(/;+\s*$/, "");
  if (!cleaned) return "";
  if (!isSelectQuery(cleaned) || hasLimitClause(cleaned)) {
    return cleaned + ";";
  }
  const safeLimit = Math.max(1, parseInt(limit, 10) || 50);
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
  return `${cleaned} LIMIT ${safeLimit} OFFSET ${safeOffset};`;
}

/**
 * Genera una consulta de conteo para determinar el total de filas de un SELECT.
 * @param {string} query
 * @returns {string}
 */
export function buildCountQuery(query) {
  if (!query || typeof query !== "string") return "";
  const cleaned = stripSqlCommentsSafe(query).trim().replace(/;+\s*$/, "");
  if (!isSelectQuery(cleaned)) return "";
  return `SELECT COUNT(*) AS total_rows FROM (${cleaned});`;
}

/**
 * Construye el documento HTML completo del visor SQL interactivo para el iframe.
 * @param {{ path: string, shortName: string, content: string }} sqlFile
 * @returns {string}
 */
export function buildSqlRunnerPreview(sqlFile) {
  const safeTitle = escapeHtml(sqlFile.shortName || "consulta.sql");
  const safeContent = JSON.stringify(sqlFile.content || "").replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle} — SQLite en Vivo</title>
  <style>
    :root {
      --bg: oklch(15% 0.011 255);
      --card: oklch(20.5% 0.014 255);
      --card-alt: oklch(17.5% 0.012 255);
      --border: oklch(33% 0.016 255 / 0.65);
      --border-focus: oklch(72% 0.145 252);
      --ink: oklch(94.5% 0.007 255);
      --ink-dim: oklch(81% 0.012 255);
      --muted: oklch(67% 0.014 255);
      --accent: oklch(74% 0.13 252);
      --accent-solid: oklch(52% 0.165 252);
      --accent-hover: oklch(57% 0.165 252);
      --accent-ink: oklch(98% 0.005 252);
      --ok: oklch(66% 0.14 152);
      --ok-soft: oklch(66% 0.14 152 / 0.18);
      --warn: oklch(74% 0.14 75);
      --err: oklch(62% 0.18 25);
      --err-soft: oklch(62% 0.18 25 / 0.18);
      --font-body: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--font-body);
      font-size: 13px;
      line-height: 1.5;
    }
    .sql-shell {
      max-width: 1000px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .sql-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      padding: 12px 16px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .sql-title-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .sql-title {
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .sql-badge {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--card-alt);
      border: 1px solid var(--border);
      color: var(--accent);
    }
    .sql-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 6px;
      font-family: var(--font-body);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--card-alt);
      color: var(--ink);
      transition: background 120ms ease;
    }
    .btn:hover { background: oklch(24% 0.015 255); }
    .btn-primary {
      background: var(--accent-solid);
      color: var(--accent-ink);
      border-color: transparent;
    }
    .btn-primary:hover { background: var(--accent-hover); }
    .sql-query-box {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .sql-query-label {
      font-size: 12px;
      color: var(--muted);
      font-weight: 500;
    }
    .sql-textarea {
      width: 100%;
      height: 72px;
      padding: 8px 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--ink);
      font-family: var(--font-mono);
      font-size: 12px;
      resize: vertical;
      line-height: 1.4;
    }
    .sql-textarea:focus {
      outline: 2px solid var(--border-focus);
      outline-offset: -1px;
    }
    .sql-query-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .sql-hint {
      font-size: 11px;
      color: var(--muted);
    }
    .sql-results-container {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .sql-result-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    .sql-card-head {
      padding: 8px 14px;
      background: var(--card-alt);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
    }
    .sql-card-query {
      font-family: var(--font-mono);
      color: var(--ink-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 75%;
    }
    .sql-card-count {
      color: var(--muted);
      font-size: 11px;
    }
    .sql-table-wrap {
      overflow-x: auto;
      max-height: 380px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 12px;
      font-family: var(--font-mono);
    }
    th {
      background: oklch(18% 0.013 255);
      color: var(--accent);
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      font-weight: 600;
      white-space: nowrap;
    }
    td {
      padding: 7px 12px;
      border-bottom: 1px solid oklch(27% 0.015 255 / 0.5);
      color: var(--ink);
      white-space: nowrap;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: oklch(22% 0.014 255); }
    .status-banner {
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-ok {
      background: var(--ok-soft);
      border: 1px solid var(--ok);
      color: var(--ok);
    }
    .status-err {
      background: var(--err-soft);
      border: 1px solid var(--err);
      color: var(--err);
      font-family: var(--font-mono);
      white-space: pre-wrap;
    }
    .status-loading {
      color: var(--warn);
    }
    .sql-pagination-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      padding: 8px 14px;
      background: var(--card-alt);
      border-top: 1px solid var(--border);
      font-size: 11px;
      color: var(--muted);
    }
    .sql-pagination-info {
      font-variant-numeric: tabular-nums;
      color: var(--ink);
    }
    .sql-pagination-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .sql-pagination-actions .btn {
      padding: 4px 10px;
      font-size: 11px;
    }
    .sql-pagination-actions .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/sql-wasm.js"></script>
</head>
<body>
  <div class="sql-shell">
    <div class="sql-header">
      <div class="sql-title-group">
        <span class="sql-title">SQLite 3 (En Vivo)</span>
        <span class="sql-badge">${safeTitle}</span>
        <span id="engine-status" class="sql-hint status-loading">Iniciando motor SQLite...</span>
      </div>
      <div class="sql-actions">
        <button type="button" id="btn-export-csv" class="btn" title="Descargar todos los resultados de la consulta en CSV">Exportar CSV</button>
        <button type="button" id="btn-export-json" class="btn" title="Descargar todos los resultados de la consulta en JSON">Exportar JSON</button>
        <button type="button" id="btn-reset-db" class="btn" title="Reiniciar base de datos">Reiniciar DB</button>
      </div>
    </div>

    <div class="sql-query-box">
      <label for="interactive-sql" class="sql-query-label">Consulta SQL adicional sobre la base de datos en memoria:</label>
      <textarea id="interactive-sql" class="sql-textarea" placeholder="SELECT * FROM tabla WHERE ...;" spellcheck="false"></textarea>
      <div class="sql-query-footer">
        <span class="sql-hint">Presioná Ctrl + Enter para ejecutar la consulta</span>
        <button type="button" id="btn-run-query" class="btn btn-primary">Ejecutar consulta</button>
      </div>
    </div>

    <div id="results-area" class="sql-results-container"></div>
  </div>

  <script>
    (function () {
      var initialScript = ${safeContent};
      var db = null;
      var sqlEngine = null;
      var lastResults = [];
      var lastFullQuery = null;
      var isPaginatedQuery = false;
      var resultsArea = document.getElementById("results-area");
      var statusEl = document.getElementById("engine-status");
      var queryInput = document.getElementById("interactive-sql");
      var btnRun = document.getElementById("btn-run-query");
      var btnReset = document.getElementById("btn-reset-db");
      var btnCsv = document.getElementById("btn-export-csv");
      var btnJson = document.getElementById("btn-export-json");

      function sendLog(level, text) {
        try {
          parent.postMessage({
            source: "studio-ide-preview",
            level: level,
            text: text
          }, "*");
        } catch (_) {}
      }

      function initDatabase() {
        if (!window.initSqlJs) {
          statusEl.textContent = "Error: no se pudo cargar sql.js desde CDN.";
          statusEl.style.color = "var(--err)";
          return;
        }

        statusEl.textContent = "Cargando WebAssembly...";
        window.initSqlJs({
          locateFile: function (file) {
            return "https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/" + file;
          }
        }).then(function (SQL) {
          sqlEngine = SQL;
          window.SQL = SQL;
          db = new SQL.Database();
          statusEl.textContent = "Listo para consultas";
          statusEl.style.color = "var(--ok)";
          runFullScript(initialScript);
        }).catch(function (err) {
          statusEl.textContent = "Error al iniciar SQLite: " + err.message;
          statusEl.style.color = "var(--err)";
          sendLog("error", "Error SQLite: " + err.message);
        });
      }

      function renderResults(results, queryContext, meta) {
        if (!results || results.length === 0) {
          var note = document.createElement("div");
          note.className = "status-banner status-ok";
          note.textContent = "✓ Sentencia ejecutada con éxito (sin filas devueltas).";
          resultsArea.appendChild(note);
          return;
        }

        var MAX_SQL_DISPLAY_ROWS = 5000;
        results.forEach(function (res, idx) {
          var originalRowCount = res.values ? res.values.length : 0;
          var isTruncated = !meta && originalRowCount > MAX_SQL_DISPLAY_ROWS;
          var activeValues = isTruncated ? res.values.slice(0, MAX_SQL_DISPLAY_ROWS) : res.values;

          var card = document.createElement("div");
          card.className = "sql-result-card";

          var head = document.createElement("div");
          head.className = "sql-card-head";

          var querySpan = document.createElement("span");
          querySpan.className = "sql-card-query";
          querySpan.textContent = queryContext || ("Resultado #" + (idx + 1));

          var countSpan = document.createElement("span");
          countSpan.className = "sql-card-count";
          if (meta && meta.totalRows !== null && meta.totalRows !== undefined) {
            countSpan.textContent = meta.totalRows + " fila(s) totales / " + res.columns.length + " columna(s)";
          } else if (isTruncated) {
            countSpan.textContent = MAX_SQL_DISPLAY_ROWS + " de " + originalRowCount + " filas (límite de memoria) / " + res.columns.length + " cols";
            countSpan.title = "La consulta superó el lote de 5.000 filas. Se muestran las primeras 5.000 para optimizar el DOM y la memoria de WebKit.";
          } else {
            countSpan.textContent = res.values.length + " fila(s) / " + res.columns.length + " columna(s)";
          }

          head.appendChild(querySpan);
          head.appendChild(countSpan);
          card.appendChild(head);

          if (isTruncated) {
            var warnBanner = document.createElement("div");
            warnBanner.className = "sql-hint";
            warnBanner.style.padding = "6px 12px";
            warnBanner.style.color = "var(--warn)";
            warnBanner.textContent = "⚠️ La consulta devolvió " + originalRowCount + " filas. Se muestran las primeras " + MAX_SQL_DISPLAY_ROWS + " para prevenir saturación de memoria. Usá LIMIT y OFFSET para paginar consultas masivas.";
            card.appendChild(warnBanner);
          }

          var tableWrap = document.createElement("div");
          tableWrap.className = "sql-table-wrap";

          var table = document.createElement("table");
          var thead = document.createElement("thead");
          var headerRow = document.createElement("tr");

          res.columns.forEach(function (col) {
            var th = document.createElement("th");
            th.textContent = col;
            headerRow.appendChild(th);
          });
          thead.appendChild(headerRow);
          table.appendChild(thead);

          var tbody = document.createElement("tbody");
          table.appendChild(tbody);
          tableWrap.appendChild(table);
          card.appendChild(tableWrap);

          var PAGE_SIZE = 50;

          if (meta && meta.isRealPagination) {
            // Paginación real en el motor SQLite (LIMIT y OFFSET)
            var pagBar = document.createElement("div");
            pagBar.className = "sql-pagination-bar";

            var pageInfo = document.createElement("span");
            pageInfo.className = "sql-pagination-info";
            var startIdx = (meta.currentPage - 1) * meta.pageSize + 1;
            var endIdx = meta.totalRows !== null ? Math.min(meta.totalRows, meta.currentPage * meta.pageSize) : (startIdx + res.values.length - 1);
            pageInfo.textContent = "Página " + meta.currentPage + " de " + meta.totalPages + (meta.totalRows !== null ? " (filas " + startIdx + " a " + endIdx + " de " + meta.totalRows + ")" : "") + " [Paginación SQL: LIMIT " + meta.pageSize + "]";

            var btnPrev = document.createElement("button");
            btnPrev.type = "button";
            btnPrev.className = "btn";
            btnPrev.textContent = "‹ Anterior";
            btnPrev.disabled = meta.currentPage <= 1;

            var btnNext = document.createElement("button");
            btnNext.type = "button";
            btnNext.className = "btn";
            btnNext.textContent = "Siguiente ›";
            btnNext.disabled = meta.currentPage >= meta.totalPages || res.values.length < meta.pageSize;

            btnPrev.addEventListener("click", function () {
              if (meta.currentPage > 1) meta.onPageChange(meta.currentPage - 1);
            });
            btnNext.addEventListener("click", function () {
              if (meta.currentPage < meta.totalPages) meta.onPageChange(meta.currentPage + 1);
            });

            var actionsWrap = document.createElement("div");
            actionsWrap.className = "sql-pagination-actions";
            actionsWrap.appendChild(btnPrev);
            actionsWrap.appendChild(btnNext);

            var btnPageCsv = document.createElement("button");
            btnPageCsv.type = "button";
            btnPageCsv.className = "btn";
            btnPageCsv.title = "Descargar únicamente las filas mostradas en esta página (" + res.values.length + " filas)";
            btnPageCsv.textContent = "CSV (Esta página)";
            btnPageCsv.addEventListener("click", function () {
              var lines = [res.columns.map(safeCsvCell).join(",")];
              res.values.forEach(function (row) {
                lines.push(row.map(safeCsvCell).join(","));
              });
              downloadBlob("resultados_sql_pagina_" + meta.currentPage + ".csv", lines.join("\\r\\n"), "text/csv;charset=utf-8");
              sendLog("log", "Exportada página " + meta.currentPage + " en CSV (" + res.values.length + " filas)");
            });
            actionsWrap.appendChild(btnPageCsv);

            pagBar.appendChild(pageInfo);
            pagBar.appendChild(actionsWrap);
            card.appendChild(pagBar);

            res.values.forEach(function (row) {
              var tr = document.createElement("tr");
              row.forEach(function (cell) {
                var td = document.createElement("td");
                td.textContent = cell !== null && cell !== undefined ? cell : "NULL";
                tr.appendChild(td);
              });
              tbody.appendChild(tr);
            });
          } else if (activeValues.length > PAGE_SIZE) {
            var currentPage = 1;
            var totalPages = Math.ceil(activeValues.length / PAGE_SIZE);

            var pagBar = document.createElement("div");
            pagBar.className = "sql-pagination-bar";

            var pageInfo = document.createElement("span");
            pageInfo.className = "sql-pagination-info";

            var btnPrev = document.createElement("button");
            btnPrev.type = "button";
            btnPrev.className = "btn";
            btnPrev.textContent = "‹ Anterior";

            var btnNext = document.createElement("button");
            btnNext.type = "button";
            btnNext.className = "btn";
            btnNext.textContent = "Siguiente ›";

            function renderPage(page) {
              currentPage = Math.max(1, Math.min(page, totalPages));
              tbody.innerHTML = "";
              var startIdx = (currentPage - 1) * PAGE_SIZE;
              var endIdx = Math.min(activeValues.length, startIdx + PAGE_SIZE);
              pageInfo.textContent = "Página " + currentPage + " de " + totalPages + " (filas " + (startIdx + 1) + " a " + endIdx + " de " + activeValues.length + ")" + (isTruncated ? " [primeras " + MAX_SQL_DISPLAY_ROWS + "]" : "");
              btnPrev.disabled = currentPage === 1;
              btnNext.disabled = currentPage === totalPages;

              for (var i = startIdx; i < endIdx; i++) {
                var row = activeValues[i];
                var tr = document.createElement("tr");
                row.forEach(function (cell) {
                  var td = document.createElement("td");
                  td.textContent = cell !== null && cell !== undefined ? cell : "NULL";
                  tr.appendChild(td);
                });
                tbody.appendChild(tr);
              }
            }

            btnPrev.addEventListener("click", function () { renderPage(currentPage - 1); });
            btnNext.addEventListener("click", function () { renderPage(currentPage + 1); });

            var actionsWrap = document.createElement("div");
            actionsWrap.className = "sql-pagination-actions";
            actionsWrap.appendChild(btnPrev);
            actionsWrap.appendChild(btnNext);

            pagBar.appendChild(pageInfo);
            pagBar.appendChild(actionsWrap);
            card.appendChild(pagBar);

            renderPage(1);
          } else {
            activeValues.forEach(function (row) {
              var tr = document.createElement("tr");
              row.forEach(function (cell) {
                var td = document.createElement("td");
                td.textContent = cell !== null && cell !== undefined ? cell : "NULL";
                tr.appendChild(td);
              });
              tbody.appendChild(tr);
            });
          }

          resultsArea.appendChild(card);
        });
      }

      function runFullScript(code) {
        if (!db) return;
        resultsArea.innerHTML = "";
        try {
          var res = db.exec(code);
          lastResults = res;
          lastFullQuery = code;
          isPaginatedQuery = false;
          renderResults(res, "Script inicial (" + ${JSON.stringify(safeTitle)} + ")");
          sendLog("log", "SQL ejecutado: " + (res.length > 0 ? res.length + " consulta(s) con datos" : "Sentencias DDL/DML exitosas"));
        } catch (e) {
          var errDiv = document.createElement("div");
          errDiv.className = "status-banner status-err";
          errDiv.textContent = "Error de SQLite: " + e.message;
          resultsArea.appendChild(errDiv);
          sendLog("error", "Error SQLite: " + e.message);
        }
      }

      var safeCsvCell = ${escapeCsvField.toString()};
      var stripSqlCommentsSafe = ${stripSqlCommentsSafe.toString()};
      var stripSqlCommentsClient = stripSqlCommentsSafe;
      var hasMultipleStatementsClient = ${hasMultipleSqlStatements.toString()};
      var hasLimitClauseClient = ${hasLimitClause.toString()};

      function runCustomQuery() {
        var query = (queryInput.value || "").trim();
        if (!query || !db) return;

        var clean = stripSqlCommentsClient(query).trim().replace(/;+\\s*$/, "");
        var isSingle = !hasMultipleStatementsClient(query);
        var isSelect = isSingle && /^(WITH\\s+[\\s\\S]+?SELECT|SELECT\\b)/i.test(clean);
        var hasLimit = hasLimitClauseClient(clean, stripSqlCommentsClient);

        if (isSelect && !hasLimit) {
          lastFullQuery = clean;
          isPaginatedQuery = true;
          // Paginación real de memoria en SQLite con LIMIT y OFFSET
          var PAGE_SIZE = 50;
          var totalRows = null;
          try {
            var countSql = "SELECT COUNT(*) AS total_rows FROM (" + clean + ");";
            var countRes = db.exec(countSql);
            if (countRes && countRes[0] && countRes[0].values && countRes[0].values[0]) {
              totalRows = countRes[0].values[0][0];
            }
          } catch (_) {}

          var totalPages = totalRows !== null ? Math.max(1, Math.ceil(totalRows / PAGE_SIZE)) : 1;

          function executePage(page) {
            resultsArea.innerHTML = "";
            var offset = (page - 1) * PAGE_SIZE;
            var paginatedSql = clean + " LIMIT " + PAGE_SIZE + " OFFSET " + offset + ";";
            try {
              var res = db.exec(paginatedSql);
              if (res && res.length > 0) {
                lastResults = res;
              }
              renderResults(res, query, {
                isRealPagination: true,
                currentPage: page,
                pageSize: PAGE_SIZE,
                totalRows: totalRows,
                totalPages: totalPages,
                onPageChange: executePage
              });
              sendLog("log", "Consulta SQL paginada (pág " + page + "): " + paginatedSql);
            } catch (e) {
              var errDiv = document.createElement("div");
              errDiv.className = "status-banner status-err";
              errDiv.textContent = "Error en consulta paginada: " + e.message;
              resultsArea.appendChild(errDiv);
              sendLog("error", "Error SQL: " + e.message);
            }
          }

          executePage(1);
          queryInput.value = "";
          return;
        }

        resultsArea.innerHTML = "";
        try {
          var res = db.exec(query);
          if (res && res.length > 0) {
            lastResults = res;
            lastFullQuery = query;
            isPaginatedQuery = false;
          }
          renderResults(res, query);
          sendLog("log", "Consulta SQL: " + query + " (" + (res && res[0] ? res[0].values.length : 0) + " filas)");
          queryInput.value = "";
        } catch (e) {
          var errDiv = document.createElement("div");
          errDiv.className = "status-banner status-err";
          errDiv.textContent = "Error en consulta: " + e.message;
          resultsArea.appendChild(errDiv);
          sendLog("error", "Error SQL: " + e.message);
        }
      }

      function downloadBlob(filename, text, mime) {
        var blob = new Blob([text], { type: mime });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.setTimeout(function () {
          try { URL.revokeObjectURL(url); } catch (_) {}
        }, 1500);
      }

      btnRun.addEventListener("click", runCustomQuery);
      queryInput.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          runCustomQuery();
        }
      });

      btnReset.addEventListener("click", function () {
        var Engine = sqlEngine || window.SQL;
        if (Engine && Engine.Database) {
          if (db && typeof db.close === "function") {
            try { db.close(); } catch (_) {}
          }
          db = new Engine.Database();
          runFullScript(initialScript);
        }
      });

      var EXPORT_MAX_ROWS = 10000;
      function getExportDataset() {
        if (isPaginatedQuery && lastFullQuery && db) {
          try {
            var baseQuery = stripSqlCommentsClient(lastFullQuery).trim().replace(/;+\\s*$/, "");
            var boundedSql = baseQuery + " LIMIT " + (EXPORT_MAX_ROWS + 1) + ";";
            var fullRes = db.exec(boundedSql);
            if (fullRes && fullRes.length > 0) {
              var truncated = false;
              var limitedRes = fullRes.map(function (r) {
                if (r && Array.isArray(r.values) && r.values.length > EXPORT_MAX_ROWS) {
                  truncated = true;
                  return { columns: r.columns, values: r.values.slice(0, EXPORT_MAX_ROWS) };
                }
                return r;
              });
              if (truncated) {
                sendLog("warn", "Exportación limitada a " + EXPORT_MAX_ROWS + " filas para proteger la memoria del navegador.");
              }
              return { results: limitedRes, isFull: !truncated, truncated: truncated };
            }
          } catch (_) {}
        }
        return { results: lastResults, isFull: !isPaginatedQuery, truncated: false };
      }

      btnCsv.addEventListener("click", function () {
        var dataset = getExportDataset();
        var exportRes = dataset.results;
        if (!exportRes || exportRes.length === 0) {
          alert("No hay resultados de consultas SELECT para exportar.");
          return;
        }
        var lines = [];
        var totalRows = 0;
        exportRes.forEach(function (res) {
          lines.push(res.columns.map(safeCsvCell).join(","));
          res.values.forEach(function (row) {
            totalRows++;
            lines.push(row.map(safeCsvCell).join(","));
          });
        });
        var filename = dataset.isFull ? "resultados_sql_completos.csv" : "resultados_sql.csv";
        downloadBlob(filename, lines.join("\\r\\n"), "text/csv;charset=utf-8");
        sendLog("log", "Exportado CSV " + (dataset.isFull ? "completo (" : "(") + totalRows + " filas): " + filename);
      });

      btnJson.addEventListener("click", function () {
        var dataset = getExportDataset();
        var exportRes = dataset.results;
        if (!exportRes || exportRes.length === 0) {
          alert("No hay resultados de consultas SELECT para exportar.");
          return;
        }
        var out = [];
        exportRes.forEach(function (res) {
          res.values.forEach(function (row) {
            var obj = {};
            res.columns.forEach(function (col, i) {
              Object.defineProperty(obj, col, {
                value: row[i],
                enumerable: true,
                writable: true,
                configurable: true
              });
            });
            out.push(obj);
          });
        });
        var filename = dataset.isFull ? "resultados_sql_completos.json" : "resultados_sql.json";
        downloadBlob(filename, JSON.stringify(out, null, 2), "application/json;charset=utf-8");
        sendLog("log", "Exportado JSON " + (dataset.isFull ? "completo (" : "(") + out.length + " filas): " + filename);
      });

      window.addEventListener("pagehide", function () {
        if (db && typeof db.close === "function") {
          try {
            db.close();
          } catch (_) {}
          db = null;
        }
      });

      initDatabase();
    })();
  </script>
</body>
</html>`;
}
