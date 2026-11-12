/**
 * Controlador unificado de marcadores de error por archivo y regla lateral (#editor-error-ruler).
 * Deduplica mensajes repetidos y acota el número de marcadores/archivos para evitar fugas de memoria.
 */

const DEFAULT_ERROR_KEY = "__default__";
const DEFAULT_MAX_MARKERS_PER_FILE = 50;
const DEFAULT_MAX_TRACKED_FILES = 50;

/**
 * Renderiza los marcadores de error en la regla visual global (#editor-error-ruler).
 * @param {Array<{ lineNum: number, errorMessage: string }>} markers
 * @param {number} totalLines
 * @param {(lineNum: number) => void} onJump
 */
export function renderErrorRuler(markers, totalLines, onJump) {
  const rulerEl = typeof document !== "undefined" ? document.getElementById("editor-error-ruler") : null;
  if (!rulerEl) return;
  if (!markers || markers.length === 0) {
    rulerEl.hidden = true;
    rulerEl.innerHTML = "";
    return;
  }
  rulerEl.hidden = false;
  rulerEl.innerHTML = "";
  const linesCount = Math.max(1, totalLines || 1);
  const frag = typeof document.createDocumentFragment === "function"
    ? document.createDocumentFragment()
    : null;

  for (const m of markers) {
    const pill = document.createElement("button");
    pill.type = "button";
    const isWarn = /warning/i.test(m.errorMessage || "");
    pill.className = isWarn ? "editor-error-marker-pill is-warning" : "editor-error-marker-pill";
    pill.title = `Línea ${m.lineNum}: ${m.errorMessage} (tocá para ir a la línea)`;
    pill.setAttribute("aria-label", `Línea ${m.lineNum}: ${m.errorMessage}`);
    const pct = Math.min(97, Math.max(3, (m.lineNum / linesCount) * 100));
    pill.style.top = `${pct}%`;
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      onJump?.(m.lineNum);
    });
    if (frag) {
      frag.appendChild(pill);
    } else {
      rulerEl.appendChild(pill);
    }
  }

  if (frag) {
    rulerEl.appendChild(frag);
  }
}

/**
 * Crea un gestor de marcadores por archivo compartido entre CodeMirror y el editor fallback.
 */
export function createErrorMarkersController({
  enableGlobalRuler = true,
  onJump = null,
  maxMarkersPerFile = DEFAULT_MAX_MARKERS_PER_FILE,
  maxTrackedFiles = DEFAULT_MAX_TRACKED_FILES
} = {}) {
  const markersByFile = new Map();

  function resolveKey(fileId) {
    return fileId || DEFAULT_ERROR_KEY;
  }

  function touchFileBucket(key, list) {
    if (markersByFile.has(key)) {
      markersByFile.delete(key);
    } else if (markersByFile.size >= maxTrackedFiles) {
      const oldestKey = markersByFile.keys().next().value;
      if (oldestKey !== undefined) {
        markersByFile.delete(oldestKey);
      }
    }
    markersByFile.set(key, list);
  }

  function getMarkers(fileId) {
    return [...(markersByFile.get(resolveKey(fileId)) || [])];
  }

  function addMarker(fileId, lineNum, errorMessage) {
    const num = Math.max(1, parseInt(lineNum, 10) || 1);
    const msg = String(errorMessage || "Error de compilación / sintaxis");
    const key = resolveKey(fileId);
    const existing = markersByFile.get(key) || [];
    const isDuplicate = existing.some((m) => m.lineNum === num && m.errorMessage === msg);
    const marker = { lineNum: num, errorMessage: msg };

    if (!isDuplicate) {
      existing.push(marker);
      if (existing.length > maxMarkersPerFile) {
        existing.splice(0, existing.length - maxMarkersPerFile);
      }
    }
    touchFileBucket(key, existing);

    return {
      marker,
      isFirstForFile: existing.length === 1 && !isDuplicate
    };
  }

  function clearFile(fileId) {
    markersByFile.delete(resolveKey(fileId));
  }

  function dropFile(fileId) {
    markersByFile.delete(resolveKey(fileId));
  }

  function renamePaths(oldPath, newPath, isFolder) {
    for (const [markerKey, markerList] of [...markersByFile.entries()]) {
      if (markerKey === oldPath) {
        markersByFile.delete(markerKey);
        markersByFile.set(newPath, markerList);
      } else if (isFolder && markerKey.startsWith(`${oldPath}/`)) {
        markersByFile.delete(markerKey);
        markersByFile.set(`${newPath}${markerKey.slice(oldPath.length)}`, markerList);
      }
    }
  }

  function syncRuler(fileId, totalLines = 1) {
    if (!enableGlobalRuler) return;
    const list = markersByFile.get(resolveKey(fileId)) || [];
    renderErrorRuler(list, totalLines, onJump);
  }

  function destroy() {
    markersByFile.clear();
    if (enableGlobalRuler) {
      renderErrorRuler([], 1, () => {});
    }
  }

  return {
    getMarkers,
    addMarker,
    clearFile,
    dropFile,
    renamePaths,
    syncRuler,
    destroy
  };
}
