/**
 * Visor de diferencias (Diff en verde y rojo) para revisar cambios línea por línea
 * en un archivo único o en lotes multi-archivo (IA con selección por archivo y revisión pre-commit).
 */
export function initDiffModal() {
  const dialog = document.getElementById("diff-dialog");
  const titleEl = document.getElementById("diff-dialog-title");
  const statsEl = document.getElementById("diff-dialog-stats");
  const bodyEl = document.getElementById("diff-lines-view");
  const multiBarEl = document.getElementById("diff-multi-bar");
  const closeBtn = document.getElementById("btn-close-diff");
  const cancelBtn = document.getElementById("btn-diff-cancel");
  const confirmBtn = document.getElementById("btn-diff-confirm");

  const listenerController = typeof AbortController === "function" ? new AbortController() : null;
  const listenOpts = listenerController ? { signal: listenerController.signal } : undefined;
  let pendingConfirmAction = null;
  let pendingCancelAction = null;
  let multiState = null;

  closeBtn?.addEventListener("click", () => close(true), listenOpts);
  cancelBtn?.addEventListener("click", () => close(true), listenOpts);
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      close(true);
    }
  }, listenOpts);
  dialog?.addEventListener("close", () => {
    if (dialog.open) return;
    const cancelCb = pendingCancelAction;
    pendingConfirmAction = null;
    pendingCancelAction = null;
    multiState = null;
    if (multiBarEl) {
      multiBarEl.hidden = true;
      multiBarEl.innerHTML = "";
    }
    if (bodyEl) {
      bodyEl.innerHTML = "";
    }
    if (typeof cancelCb === "function") {
      cancelCb();
    }
  }, listenOpts);

  confirmBtn?.addEventListener("click", () => {
    const action = pendingConfirmAction;
    const snapshotMulti = multiState;
    pendingCancelAction = null;
    close(false);
    if (typeof action === "function") {
      if (snapshotMulti?.selectable) {
        const selectedItems = snapshotMulti.items.filter((it) => it.checked);
        action(selectedItems);
      } else {
        action();
      }
    }
  }, listenOpts);

  function close(invokeCancel = false) {
    const cancelCb = invokeCancel ? pendingCancelAction : null;
    pendingConfirmAction = null;
    pendingCancelAction = null;
    multiState = null;
    if (multiBarEl) {
      multiBarEl.hidden = true;
      multiBarEl.innerHTML = "";
    }
    if (bodyEl) {
      bodyEl.innerHTML = "";
    }
    dialog?.close();
    if (typeof cancelCb === "function") {
      cancelCb();
    }
  }

  const INITIAL_DIFF_ROW_CHUNK = 1500;

  function buildDiffRowNode(row) {
    if (row.type === "skip") {
      const skipEl = document.createElement("div");
      skipEl.className = "diff-row diff-row-skip";
      skipEl.textContent = `… ${row.count} líneas sin cambios …`;
      return skipEl;
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
    return rowEl;
  }

  function renderLinesDiff(oldCode, newCode) {
    if (!bodyEl) return;
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
      return;
    }

    let renderedCount = 0;
    const appendChunk = (existingLoadMoreEl = null) => {
      const nextEnd = Math.min(rows.length, renderedCount + INITIAL_DIFF_ROW_CHUNK);
      const target = typeof document.createDocumentFragment === "function" ? document.createDocumentFragment() : bodyEl;
      for (; renderedCount < nextEnd; renderedCount += 1) {
        target.appendChild(buildDiffRowNode(rows[renderedCount]));
      }
      if (existingLoadMoreEl) {
        existingLoadMoreEl.remove();
      }
      if (renderedCount < rows.length) {
        const remaining = rows.length - renderedCount;
        const loadMoreBtn = document.createElement("button");
        loadMoreBtn.type = "button";
        loadMoreBtn.className = "btn btn-ghost btn-sm diff-load-more-btn";
        loadMoreBtn.textContent = `Mostrar ${Math.min(remaining, INITIAL_DIFF_ROW_CHUNK)} líneas más (${remaining} restantes)`;
        loadMoreBtn.addEventListener("click", () => appendChunk(loadMoreBtn));
        target.appendChild(loadMoreBtn);
      }
      if (target !== bodyEl) {
        bodyEl.appendChild(target);
      }
    };

    appendChunk(null);
  }

  function renderMultiBar() {
    if (!multiBarEl || !multiState) return;
    const { items, activeIndex, selectable } = multiState;
    multiBarEl.hidden = false;
    multiBarEl.innerHTML = "";

    const navRow = document.createElement("div");
    navRow.className = "diff-multi-nav";

    const btnPrev = document.createElement("button");
    btnPrev.type = "button";
    btnPrev.className = "btn btn-ghost btn-sm";
    btnPrev.id = "btn-diff-prev";
    btnPrev.textContent = "← Anterior";
    btnPrev.disabled = activeIndex <= 0;
    btnPrev.addEventListener("click", () => {
      if (multiState && multiState.activeIndex > 0) {
        multiState.activeIndex -= 1;
        syncActiveMultiItem();
      }
    });

    const counter = document.createElement("span");
    counter.className = "diff-multi-counter code-font";
    counter.textContent = `Archivo ${activeIndex + 1} de ${items.length}`;

    const btnNext = document.createElement("button");
    btnNext.type = "button";
    btnNext.className = "btn btn-ghost btn-sm";
    btnNext.id = "btn-diff-next";
    btnNext.textContent = "Siguiente →";
    btnNext.disabled = activeIndex >= items.length - 1;
    btnNext.addEventListener("click", () => {
      if (multiState && multiState.activeIndex < multiState.items.length - 1) {
        multiState.activeIndex += 1;
        syncActiveMultiItem();
      }
    });

    navRow.append(btnPrev, counter, btnNext);

    const chipsList = document.createElement("div");
    chipsList.className = "diff-multi-files";

    items.forEach((item, idx) => {
      const wrap = document.createElement("div");
      wrap.className = `diff-multi-file-pill${idx === activeIndex ? " is-active" : ""}`;

      if (selectable) {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = Boolean(item.checked);
        cb.setAttribute("aria-label", `Incluir ${item.path}`);
        cb.addEventListener("change", () => {
          item.checked = cb.checked;
          syncConfirmMultiButton();
        });
        wrap.appendChild(cb);
      }

      const fileBtn = document.createElement("button");
      fileBtn.type = "button";
      fileBtn.className = "diff-multi-file-btn code-font";
      const tag = item.badge || (item.isNew ? "Nuevo" : "Editado");
      fileBtn.textContent = `${item.path} (${tag})`;
      fileBtn.addEventListener("click", () => {
        if (!multiState) return;
        multiState.activeIndex = idx;
        syncActiveMultiItem();
      });

      wrap.appendChild(fileBtn);
      chipsList.appendChild(wrap);
    });

    multiBarEl.append(navRow, chipsList);
  }

  function syncConfirmMultiButton() {
    if (!confirmBtn || !multiState?.selectable) return;
    const selectedCount = multiState.items.filter((it) => it.checked).length;
    confirmBtn.disabled = selectedCount === 0;
    confirmBtn.textContent = `Aplicar seleccionados (${selectedCount})`;
  }

  function syncActiveMultiItem() {
    if (!multiState || multiState.items.length === 0) return;
    const current = multiState.items[multiState.activeIndex];
    if (titleEl) {
      titleEl.textContent = current.title || `${multiState.baseTitle}: ${current.path}`;
    }
    renderLinesDiff(current.oldCode || "", current.newCode || "");
    renderMultiBar();
    syncConfirmMultiButton();
  }

  function renderDiffView({ title, oldCode, newCode, confirmLabel, onConfirm }) {
    if (!dialog || !bodyEl) return;

    multiState = null;
    if (multiBarEl) {
      multiBarEl.hidden = true;
      multiBarEl.innerHTML = "";
    }
    pendingConfirmAction = onConfirm || null;
    pendingCancelAction = null;
    if (titleEl) {
      titleEl.textContent = title || "Revisar diferencias";
    }

    renderLinesDiff(oldCode || "", newCode || "");

    if (confirmBtn && cancelBtn) {
      confirmBtn.disabled = false;
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

  function openMultiFileDiff({ title = "Revisar lote multi-archivo", items = [], initialIndex = 0, selectable = false, onConfirm = null, onCancel = null }) {
    if (!dialog || !bodyEl || !Array.isArray(items) || items.length === 0) {
      onCancel?.();
      return;
    }

    const safeIdx = Math.max(0, Math.min(items.length - 1, Number(initialIndex) || 0));
    multiState = {
      baseTitle: title,
      selectable: Boolean(selectable),
      activeIndex: safeIdx,
      items: items.map((it) => ({
        ...it,
        checked: it.checked !== false
      }))
    };

    pendingConfirmAction = selectable ? onConfirm : null;
    pendingCancelAction = onCancel;

    if (confirmBtn && cancelBtn) {
      if (selectable && typeof onConfirm === "function") {
        confirmBtn.hidden = false;
        cancelBtn.textContent = "Cancelar";
      } else {
        confirmBtn.hidden = true;
        confirmBtn.disabled = false;
        cancelBtn.textContent = "Cerrar";
      }
    }

    syncActiveMultiItem();
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
    openMultiFileApplyDiff({ files, onConfirm, onCancel }) {
      openMultiFileDiff({
        title: "Aplicar lote IA",
        items: files,
        initialIndex: 0,
        selectable: true,
        onConfirm,
        onCancel
      });
    },
    openMultiFileReadOnlyDiff({ title = "Cambios pendientes", items, initialIndex = 0 }) {
      openMultiFileDiff({
        title,
        items,
        initialIndex,
        selectable: false,
        onConfirm: null,
        onCancel: null
      });
    },
    destroy() {
      pendingConfirmAction = null;
      pendingCancelAction = null;
      multiState = null;
      if (multiBarEl) {
        multiBarEl.hidden = true;
        multiBarEl.innerHTML = "";
      }
      if (bodyEl) {
        bodyEl.innerHTML = "";
      }
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

function myersMiddleOps(midA, midB, start, maxD) {
  const n = midA.length;
  const m = midB.length;
  const max = n + m;
  const limit = Math.min(max, maxD);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
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
