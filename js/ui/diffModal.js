/**
 * Visor de diferencias (Diff en verde y rojo) para revisar cambios línea por línea
 * antes de aplicar reemplazos de la IA o antes de hacer Commit y Push en GitHub.
 */
export function initDiffModal() {
  const dialog = document.getElementById("diff-dialog");
  const titleEl = document.getElementById("diff-dialog-title");
  const statsEl = document.getElementById("diff-dialog-stats");
  const bodyEl = document.getElementById("diff-lines-view");
  const closeBtn = document.getElementById("btn-close-diff");
  const cancelBtn = document.getElementById("btn-diff-cancel");
  const confirmBtn = document.getElementById("btn-diff-confirm");

  const listenerController = typeof AbortController === "function" ? new AbortController() : null;
  const listenOpts = listenerController ? { signal: listenerController.signal } : undefined;
  let pendingConfirmAction = null;

  closeBtn?.addEventListener("click", () => close(), listenOpts);
  cancelBtn?.addEventListener("click", () => close(), listenOpts);
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      close();
    }
  }, listenOpts);
  dialog?.addEventListener("close", () => {
    pendingConfirmAction = null;
  }, listenOpts);

  confirmBtn?.addEventListener("click", () => {
    const action = pendingConfirmAction;
    close();
    if (typeof action === "function") {
      action();
    }
  }, listenOpts);

  function close() {
    pendingConfirmAction = null;
    dialog?.close();
  }

  function renderDiffView({ title, oldCode, newCode, confirmLabel, onConfirm }) {
    if (!dialog || !bodyEl) return;

    pendingConfirmAction = onConfirm || null;
    if (titleEl) {
      titleEl.textContent = title || "Revisar diferencias";
    }

    const { rows, addedCount, removedCount, lineEndingsOnly } = computeLineDiff(oldCode || "", newCode || "");
    if (statsEl) {
      statsEl.innerHTML = `
        <span class="diff-stat-add">+${addedCount}</span>
        <span class="diff-stat-del">-${removedCount}</span>
      `;
    }

    bodyEl.innerHTML = "";
    if (rows.length === 0 || (addedCount === 0 && removedCount === 0)) {
      const empty = document.createElement("div");
      empty.className = "diff-empty-note";
      empty.textContent = lineEndingsOnly
        ? "Los archivos solo difieren en el formato de fin de línea (CRLF de Windows vs LF de Unix)."
        : "El contenido nuevo es idéntico al actual (sin diferencias).";
      bodyEl.appendChild(empty);
    } else {
      const frag = document.createDocumentFragment();
      for (const row of rows) {
        if (row.type === "skip") {
          const skipEl = document.createElement("div");
          skipEl.className = "diff-row diff-row-skip";
          skipEl.textContent = `… ${row.count} líneas sin cambios …`;
          frag.appendChild(skipEl);
          continue;
        }

        const rowEl = document.createElement("div");
        rowEl.className =
          row.type === "add"
            ? "diff-row diff-row-add"
            : row.type === "del"
              ? "diff-row diff-row-del"
              : "diff-row";

        const numEl = document.createElement("span");
        numEl.className = "diff-line-num";
        numEl.textContent = String(row.lineNo ?? "");

        const signEl = document.createElement("span");
        signEl.className = "diff-line-sign";
        signEl.textContent = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";

        const textEl = document.createElement("span");
        textEl.className = "diff-line-code";
        textEl.textContent = row.text;

        rowEl.append(numEl, signEl, textEl);
        frag.appendChild(rowEl);
      }
      bodyEl.appendChild(frag);
    }

    if (confirmBtn && cancelBtn) {
      if (onConfirm) {
        confirmBtn.hidden = false;
        confirmBtn.textContent = confirmLabel || "Confirmar y aplicar";
        cancelBtn.textContent = "Cancelar";
      } else {
        confirmBtn.hidden = true;
        cancelBtn.textContent = "Cerrar";
      }
    }

    if (!dialog.open) {
      dialog.showModal();
    }
  }

  return {
    openConfirmApplyDiff({ fileName, oldCode, newCode, onConfirm }) {
      renderDiffView({
        title: `Aplicar cambios en ${fileName}`,
        oldCode,
        newCode,
        confirmLabel: "Confirmar y aplicar",
        onConfirm
      });
    },
    openReadOnlyDiff({ title, oldCode, newCode }) {
      renderDiffView({
        title,
        oldCode,
        newCode,
        onConfirm: null
      });
    },
    destroy() {
      pendingConfirmAction = null;
      listenerController?.abort();
    }
  };
}

export function computeLineDiff(oldStr, newStr) {
  const lineEndingsOnly =
    oldStr !== newStr &&
    oldStr.replace(/\r\n/g, "\n") === newStr.replace(/\r\n/g, "\n");

  const a = oldStr === "" ? [] : oldStr.replace(/\r\n/g, "\n").split("\n");
  const b = newStr === "" ? [] : newStr.replace(/\r\n/g, "\n").split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  const n = midA.length;
  const m = midB.length;

  // Zona central: LCS exacto si es chica; Myers (mínimo, O((N+M)·D)) si es grande;
  // y solo si ni eso entra en el presupuesto, marcar la zona central como reemplazada.
  let midOps = null;
  if (n * m <= 900000) {
    midOps = lcsMiddleOps(midA, midB, start);
  } else {
    midOps = myersMiddleOps(midA, midB, start, Math.max(64, Math.floor(20000000 / (n + m))));
    if (!midOps) {
      midOps = replaceMiddleOps(midA, midB, start);
    }
  }

  const rawOps = [];
  for (let k = 0; k < start; k += 1) {
    rawOps.push({ type: "eq", lineNo: k + 1, text: a[k] });
  }
  for (const op of midOps) {
    rawOps.push(op);
  }
  const tailCount = a.length - 1 - endA;
  for (let k = 0; k < tailCount; k += 1) {
    rawOps.push({ type: "eq", lineNo: endB + 2 + k, text: a[endA + 1 + k] });
  }

  let addedCount = 0;
  let removedCount = 0;
  for (const op of rawOps) {
    if (op.type === "add") addedCount += 1;
    if (op.type === "del") removedCount += 1;
  }

  // Colapsar bloques largos de líneas iguales dejando 3 líneas de contexto
  const CONTEXT = 3;
  const keep = new Array(rawOps.length).fill(false);
  for (let i = 0; i < rawOps.length; i += 1) {
    if (rawOps[i].type !== "eq") {
      const segStart = Math.max(0, i - CONTEXT);
      const segEnd = Math.min(rawOps.length - 1, i + CONTEXT);
      for (let k = segStart; k <= segEnd; k += 1) {
        keep[k] = true;
      }
    }
  }

  const rows = [];
  let skipped = 0;
  for (let i = 0; i < rawOps.length; i += 1) {
    if (keep[i]) {
      if (skipped > 0) {
        rows.push({ type: "skip", count: skipped });
        skipped = 0;
      }
      rows.push(rawOps[i]);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    rows.push({ type: "skip", count: skipped });
  }

  return { rows, addedCount, removedCount, lineEndingsOnly };
}

function lcsMiddleOps(midA, midB, start) {
  const n = midA.length;
  const m = midB.length;

  const ArrType = Math.max(n, m) >= 65535 ? Uint32Array : Uint16Array;
  const dp = Array.from({ length: n + 1 }, () => new ArrType(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (midA[i] === midB[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      ops.push({ type: "eq", lineNo: start + j + 1, text: midB[j] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", lineNo: start + i + 1, text: midA[i] });
      i += 1;
    } else {
      ops.push({ type: "add", lineNo: start + j + 1, text: midB[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "del", lineNo: start + i + 1, text: midA[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "add", lineNo: start + j + 1, text: midB[j] });
    j += 1;
  }
  return ops;
}

/**
 * Diff de Myers (script de edición mínimo) para zonas grandes con pocos cambios.
 * Devuelve null si la cantidad de ediciones supera maxD (para acotar tiempo y memoria).
 */
function myersMiddleOps(midA, midB, start, maxD) {
  const n = midA.length;
  const m = midB.length;
  const max = n + m;
  const limit = Math.min(max, maxD);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  /** @type {Int32Array[]} */
  const trace = [];

  let found = -1;
  for (let d = 0; d <= limit; d += 1) {
    const snapshot = new Int32Array(2 * d + 3);
    for (let k = -d - 1; k <= d + 1; k += 1) {
      snapshot[k + d + 1] = v[k + offset];
    }
    trace.push(snapshot);

    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && midA[x] === midB[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found !== -1) break;
  }

  if (found === -1) {
    return null;
  }

  const reversed = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d];
    const getPrev = (k) => prev[k + d + 1];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && getPrev(k - 1) < getPrev(k + 1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = getPrev(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      reversed.push({ type: "eq", lineNo: start + y + 1, text: midB[y] });
    }
    if (x === prevX) {
      y -= 1;
      reversed.push({ type: "add", lineNo: start + y + 1, text: midB[y] });
    } else {
      x -= 1;
      reversed.push({ type: "del", lineNo: start + x + 1, text: midA[x] });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    reversed.push({ type: "eq", lineNo: start + y + 1, text: midB[y] });
  }
  reversed.reverse();

  // Presentación estilo unificado: dentro de cada bloque de cambios, primero las líneas borradas.
  const ops = [];
  let pendingAdds = [];
  for (const op of reversed) {
    if (op.type === "add") {
      pendingAdds.push(op);
    } else if (op.type === "del") {
      ops.push(op);
    } else {
      ops.push(...pendingAdds, op);
      pendingAdds = [];
    }
  }
  ops.push(...pendingAdds);
  return ops;
}

function replaceMiddleOps(midA, midB, start) {
  const ops = [];
  for (let i = 0; i < midA.length; i += 1) {
    ops.push({ type: "del", lineNo: start + i + 1, text: midA[i] });
  }
  for (let j = 0; j < midB.length; j += 1) {
    ops.push({ type: "add", lineNo: start + j + 1, text: midB[j] });
  }
  return ops;
}
