/**
 * Generador de vista previa HTML interactiva para scripts Python 3 reales usando Pyodide WebAssembly,
 * con soporte para módulos locales vecinos, entrada `input()` asíncrona sin bloqueos y Mini-REPL.
 */

import { normalizePath } from "../storage/workspaceDb.js";
import { getFileExtension, escapeHtmlText, PYTHON_EXTENSIONS } from "./previewUtils.js";

export function buildStandalonePythonPreview(pyFile, sameFolderFiles = [], baseFolder = "") {
  const prefix = baseFolder ? `${baseFolder}/` : "";
  const modules = [];
  const modPrefixes = new Set();
  const TEXT_OR_DATA_EXTENSIONS = new Set([
    "json", "txt", "csv", "tsv", "sql", "xml", "yaml", "yml", "md"
  ]);

  for (const candidate of sameFolderFiles) {
    const ext = getFileExtension(candidate.path);
    const isPy = PYTHON_EXTENSIONS.has(ext);
    const isData = TEXT_OR_DATA_EXTENSIONS.has(ext);
    if (!isPy && !isData) continue;
    const cleanPath = normalizePath(candidate.path);
    if (cleanPath === normalizePath(pyFile.path)) continue;
    const relPath = prefix && cleanPath.startsWith(prefix) ? cleanPath.slice(prefix.length) : cleanPath;
    if (relPath && !relPath.startsWith("..")) {
      modules.push({ path: relPath, content: candidate.content });
      if (isPy) {
        const topMod = relPath.split("/")[0].replace(/\.(py|pyw)$/i, "");
        if (topMod) modPrefixes.add(topMod);
      }
    }
  }

  const pythonBootstrap = [
    "import builtins, json, random, sys, traceback",
    "if '.' not in sys.path:",
    "    sys.path.insert(0, '.')",
    "class _StudioPauseForInput(BaseException):",
    "    def __init__(self, prompt_text):",
    "        self.prompt_text = prompt_text",
    "for _mod_prefix in json.loads(__studio_mod_prefixes_json):",
    "    for _loaded in list(sys.modules.keys()):",
    "        if _loaded == _mod_prefix or _loaded.startswith(_mod_prefix + '.'):",
    "            sys.modules.pop(_loaded, None)",
    "random.seed(int(__studio_seed))",
    "_inputs = json.loads(__studio_inputs_json)",
    "_idx = 0",
    "def __studio_input(prompt=''):",
    "    global _idx",
    "    texto = str(prompt) if prompt is not None else ''",
    "    if _idx < len(_inputs):",
    "        item = _inputs[_idx]",
    "        _idx += 1",
    "        if item.get('cancelled'):",
    "            print(f'{texto}(cancelado)')",
    "            raise EOFError('Entrada cancelada por el usuario.')",
    "        val = str(item.get('value', ''))",
    "        print(f'{texto}{val}')",
    "        return val",
    "    raise _StudioPauseForInput(texto)",
    "builtins.input = __studio_input",
    "_result = {'status': 'ok'}",
    "global _studio_repl_ns",
    "_studio_repl_ns = {'__name__': '__main__', '__file__': __studio_entry_name}",
    "try:",
    "    exec(compile(__studio_entry_code, __studio_entry_name, 'exec'), _studio_repl_ns)",
    "except _StudioPauseForInput as _pause:",
    "    _result = {'status': 'need_input', 'prompt': _pause.prompt_text}",
    "except SystemExit:",
    "    pass",
    "except Exception as _exc:",
    "    _result = {'status': 'error'}",
    "    _tb = traceback.extract_tb(_exc.__traceback__)",
    "    _clean = [f for f in _tb if f.filename == __studio_entry_name or not f.filename.startswith('<')]",
    "    _lines = ['Traceback (most recent call last):']",
    "    for _f in _clean:",
    "        _lines.append(f'  Archivo \"{_f.filename}\", línea {_f.lineno}, en {_f.name}')",
    "    _lines.extend([l.rstrip('\\n') for l in traceback.format_exception_only(type(_exc), _exc)])",
    "    print('\\n'.join(_lines), file=sys.stderr)",
    "finally:",
    "    sys.stdout.flush()",
    "    sys.stderr.flush()",
    "json.dumps(_result)"
  ].join("\n");

  const payloadJson = JSON.stringify({
    entryName: pyFile.shortName,
    entryPath: pyFile.path,
    code: pyFile.content,
    modules,
    modPrefixes: [...modPrefixes],
    bootstrap: pythonBootstrap
  }).replace(/</g, "\\u003c");

  const safePathLabel = escapeHtmlText(pyFile.path);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <style>
    :root {
      --bg: oklch(15% 0.011 255);
      --card: oklch(20.5% 0.014 255);
      --surface-input: oklch(16.5% 0.012 255);
      --border: oklch(33% 0.016 255 / 0.65);
      --ink: oklch(94.5% 0.007 255);
      --muted: oklch(67% 0.014 255);
      --accent: oklch(74% 0.13 252);
      --accent-solid: oklch(52% 0.165 252);
      --accent-ink: oklch(98% 0.005 252);
      --ok: oklch(66% 0.14 152);
      --warn: oklch(74% 0.14 75);
      --err: oklch(62% 0.18 25);
      --font-ui: system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--font-ui);
    }
    .py-runner-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      overflow: hidden;
    }
    .py-runner-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .py-runner-file {
      font-family: var(--font-mono);
      color: var(--accent);
      font-weight: 500;
    }
    .py-runner-status {
      color: var(--warn);
      font-size: 12px;
    }
    .py-runner-output {
      padding: 12px 14px;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.6;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .py-line {
      white-space: pre-wrap;
      word-break: break-word;
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--surface-input);
    }
    .py-line-error { color: var(--err); }
    .py-empty { color: var(--muted); font-style: italic; }
    .py-input-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-top: 1px solid var(--border);
      background: var(--surface-input);
    }
    .py-input-bar[hidden] { display: none; }
    .py-input-prompt {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--accent);
      font-weight: 500;
    }
    .py-input-field {
      flex: 1;
      min-width: 160px;
      min-height: 36px;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--ink);
      font-family: var(--font-mono);
      font-size: 16px;
    }
    .py-input-field:focus {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .py-btn {
      min-height: 36px;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--ink);
      font-family: var(--font-ui);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .py-btn-primary {
      background: var(--accent-solid);
      border-color: var(--accent-solid);
      color: var(--accent-ink);
    }
    .py-runner-controls {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    .py-btn-stop {
      min-height: 30px;
      padding: 4px 12px;
      border-color: var(--err);
      color: var(--err);
    }
    .py-btn-stop[hidden] { display: none; }
  </style>
</head>
<body>
  <section class="py-runner-card">
    <div class="py-runner-head">
      <span class="py-runner-file">${safePathLabel}</span>
      <span class="py-runner-controls">
        <span id="__py_status" class="py-runner-status">Iniciando motor Python 3 (WebAssembly)…</span>
        <button type="button" id="__py_stop" class="py-btn py-btn-stop" hidden>Detener</button>
      </span>
    </div>
    <div id="__py_screen_log" class="py-runner-output"></div>
    <form id="__py_input_form" class="py-input-bar" hidden>
      <label id="__py_input_prompt" for="__py_input_field" class="py-input-prompt">input():</label>
      <input id="__py_input_field" type="text" class="py-input-field" autocomplete="off" spellcheck="false" placeholder="Escribí un valor y tocá Enviar…">
      <button type="submit" class="py-btn py-btn-primary">Enviar</button>
      <button type="button" id="__py_input_cancel" class="py-btn">Cancelar</button>
    </form>
  </section>

  <script id="__py_payload" type="application/json">${payloadJson}</script>
  <script id="__py_runner_src" type="text/plain">
    var PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.3/full/";
    var pyodide = null;
    var loading = null;
    function send(msg) { self.postMessage(msg); }
    function ensurePyodide() {
      if (pyodide) return Promise.resolve(pyodide);
      if (!loading) {
        send({ type: "status", text: "loading" });
        loading = (async function () {
          await __loadScript(PYODIDE_URL + "pyodide.js");
          var py = await loadPyodide({ indexURL: PYODIDE_URL });
          py.setStdout({ batched: function (line) { send({ type: "out", level: "log", text: line }); } });
          py.setStderr({ batched: function (line) { send({ type: "out", level: "error", text: line }); } });
          pyodide = py;
          return py;
        })();
      }
      return loading;
    }
    function ensureParentDirs(FS, filePath) {
      var parts = filePath.split("/");
      var current = "";
      for (var i = 0; i < parts.length - 1; i += 1) {
        current = current ? current + "/" + parts[i] : parts[i];
        try { FS.mkdir(current); } catch (_) {}
      }
    }
    function writeFiles(py, job) {
      ensureParentDirs(py.FS, job.entryName);
      try { py.FS.writeFile(job.entryName, job.code, { encoding: "utf8" }); } catch (_) {}
      if (job.entryPath && job.entryPath !== job.entryName) {
        ensureParentDirs(py.FS, job.entryPath);
        try { py.FS.writeFile(job.entryPath, job.code, { encoding: "utf8" }); } catch (_) {}
      }
      for (var i = 0; i < job.modules.length; i += 1) {
        var mod = job.modules[i];
        ensureParentDirs(py.FS, mod.path);
        py.FS.writeFile(mod.path, mod.content, { encoding: "utf8" });
      }
    }
    self.onmessage = async function (event) {
      var job = event.data;
      if (!job) return;
      if (job.type === "eval") {
        try {
          var pyEval = await ensurePyodide();
          pyEval.globals.set("__studio_eval_code", String(job.code || ""));
          var evalScript = [
            "import json, sys, traceback",
            "_er = {'status': 'ok'}",
            "try:",
            "    _v = eval(compile(__studio_eval_code, '<repl>', 'eval'), _studio_repl_ns)",
            "    if _v is not None:",
            "        print(repr(_v))",
            "except SyntaxError:",
            "    try:",
            "        exec(compile(__studio_eval_code, '<repl>', 'exec'), _studio_repl_ns)",
            "    except Exception as _ex:",
            "        _er = {'status': 'error'}",
            "        print(''.join(traceback.format_exception_only(type(_ex), _ex)).rstrip(), file=sys.stderr)",
            "except Exception as _ex:",
            "    _er = {'status': 'error'}",
            "    print(''.join(traceback.format_exception_only(type(_ex), _ex)).rstrip(), file=sys.stderr)",
            "sys.stdout.flush()",
            "sys.stderr.flush()",
            "json.dumps(_er)"
          ].join("\\n");
          var evalRaw = await pyEval.runPythonAsync(evalScript);
          send({ type: "eval_done", outcome: JSON.parse(String(evalRaw || '{"status":"ok"}')) });
        } catch (err) {
          send({ type: "out", level: "error", text: err && err.message ? String(err.message) : String(err) });
          send({ type: "eval_done", outcome: { status: "error" } });
        }
        return;
      }
      if (job.type !== "run") return;
      try {
        var py = await ensurePyodide();
        send({ type: "status", text: "running" });
        writeFiles(py, job);
        py.globals.set("__studio_entry_name", job.entryName);
        py.globals.set("__studio_entry_code", job.code);
        py.globals.set("__studio_seed", job.seed);
        py.globals.set("__studio_inputs_json", JSON.stringify(job.inputs));
        py.globals.set("__studio_mod_prefixes_json", JSON.stringify(job.modPrefixes));
        var raw = await py.runPythonAsync(job.bootstrap);
        send({ type: "result", outcome: JSON.parse(String(raw || '{"status":"ok"}')) });
      } catch (err) {
        send({ type: "fatal", message: err && err.message ? String(err.message) : String(err) });
      }
    };
  </script>
  <script>
    (function () {
      var statusEl = document.getElementById("__py_status");
      var stopBtn = document.getElementById("__py_stop");
      var screenBox = document.getElementById("__py_screen_log");
      var inputForm = document.getElementById("__py_input_form");
      var inputPromptEl = document.getElementById("__py_input_prompt");
      var inputField = document.getElementById("__py_input_field");
      var cancelBtn = document.getElementById("__py_input_cancel");
      var payload = JSON.parse(document.getElementById("__py_payload").textContent);
      var runnerSrc = document.getElementById("__py_runner_src").textContent;

      var sessionSeed = Math.floor(Math.random() * 1000000000);
      var submittedInputs = [];
      var MAX_INPUT_STEPS = 200;
      var runner = null;
      var running = false;
      var runStartedAt = 0;
      var ticker = 0;
      var sawWorkerMessage = false;

      function clearOutputs() {
        if (screenBox) screenBox.innerHTML = "";
        try {
          parent.postMessage({ source: "studio-ide-preview", action: "clear" }, "*");
        } catch (_) {}
      }

      function emit(level, text) {
        var msg = String(text == null ? "" : text);
        try {
          parent.postMessage({ source: "studio-ide-preview", level: level, text: msg }, "*");
        } catch (_) {}
        if (screenBox) {
          var row = document.createElement("div");
          row.className = level === "error" ? "py-line py-line-error" : "py-line";
          row.textContent = msg;
          screenBox.appendChild(row);
        }
      }

      function setStatus(label, colorVar) {
        if (!statusEl) return;
        statusEl.textContent = label;
        statusEl.style.color = colorVar;
      }

      function setRunning(next) {
        running = next;
        window.clearInterval(ticker);
        if (stopBtn) stopBtn.hidden = !(next && runner && runner.canStop);
        if (next) {
          runStartedAt = Date.now();
          ticker = window.setInterval(function () {
            var secs = Math.floor((Date.now() - runStartedAt) / 1000);
            if (secs >= 1) {
              setStatus(
                secs >= 5
                  ? "Ejecutando… " + secs + " s (¿bucle infinito? Tocá Detener)"
                  : "Ejecutando… " + secs + " s",
                secs >= 5 ? "var(--warn)" : "var(--accent)"
              );
            }
          }, 1000);
        }
      }

      function loadScriptTag(url) {
        return new Promise(function (resolve, reject) {
          var s = document.createElement("script");
          s.src = url;
          s.onload = function () { resolve(); };
          s.onerror = function () { reject(new Error("No se pudo descargar el motor Python 3 (Pyodide). Conectate a internet al menos una vez para almacenarlo en caché.")); };
          document.head.appendChild(s);
        });
      }

      function createMainThreadRunner() {
        var fakeSelf = {
          postMessage: function (msg) { window.setTimeout(function () { handle(msg); }, 0); },
          onmessage: null
        };
        new Function("self", "__loadScript", runnerSrc)(fakeSelf, loadScriptTag);
        return {
          canStop: false,
          post: function (msg) { fakeSelf.onmessage({ data: msg }); },
          stop: function () {}
        };
      }

      function createRunner() {
        try {
          var prefix = "var __loadScript = function (url) { importScripts(url); return Promise.resolve(); };\\n";
          var blobUrl = URL.createObjectURL(new Blob([prefix + runnerSrc], { type: "text/javascript" }));
          var worker = new Worker(blobUrl);
          var revoked = false;
          function revokeBlobUrl() {
            if (!revoked) {
              revoked = true;
              try { URL.revokeObjectURL(blobUrl); } catch (_) {}
            }
          }
          var r = {
            canStop: true,
            post: function (msg) { worker.postMessage(msg); },
            stop: function () {
              window.removeEventListener("pagehide", onPageHide);
              revokeBlobUrl();
              worker.terminate();
            }
          };
          function onPageHide() {
            r.stop();
          }
          worker.onmessage = function (event) {
            sawWorkerMessage = true;
            revokeBlobUrl();
            handle(event.data);
          };
          worker.onerror = function (event) {
            if (event && event.preventDefault) event.preventDefault();
            if (!sawWorkerMessage && runner === r) {
              r.stop();
              runner = createMainThreadRunner();
              executePass();
              return;
            }
            handle({ type: "fatal", message: event && event.message ? event.message : "Error en el motor Python." });
          };
          window.addEventListener("pagehide", onPageHide, { once: true });
          return r;
        } catch (_) {
          return createMainThreadRunner();
        }
      }

      function handle(msg) {
        if (!msg) return;
        if (msg.type === "out") {
          emit(msg.level, msg.text);
          return;
        }
        if (msg.type === "status") {
          if (msg.text === "loading") setStatus("Iniciando motor Python 3 (WebAssembly)…", "var(--warn)");
          if (msg.text === "running") setStatus("Ejecutando script…", "var(--accent)");
          return;
        }
        if (msg.type === "fatal") {
          setRunning(false);
          setStatus("Error al iniciar Python", "var(--err)");
          emit("error", msg.message);
          return;
        }
        if (msg.type === "eval_done") {
          return;
        }
        if (msg.type === "result") {
          setRunning(false);
          var outcome = msg.outcome || { status: "ok" };
          if (outcome.status === "need_input") {
            setStatus("Esperando entrada en consola…", "var(--warn)");
            if (inputPromptEl) inputPromptEl.textContent = outcome.prompt || "Entrada (input):";
            if (inputForm && inputField) {
              inputField.value = "";
              inputForm.hidden = false;
              inputField.focus();
            }
            return;
          }
          if (outcome.status === "error") {
            setStatus("Error en ejecución", "var(--err)");
          } else {
            setStatus("Ejecutado correctamente", "var(--ok)");
            if (screenBox && screenBox.children.length === 0) {
              var note = document.createElement("div");
              note.className = "py-empty";
              note.textContent = "El script Python finalizó sin errores. Usá print(...) para mostrar resultados acá.";
              screenBox.appendChild(note);
            }
          }
        }
      }

      function executePass() {
        if (inputForm) inputForm.hidden = true;
        if (submittedInputs.length > MAX_INPUT_STEPS) {
          emit("error", "Se superó el límite de 200 lecturas input() consecutivas.");
          setStatus("Detenido por límite de entradas", "var(--err)");
          return;
        }
        if (!runner) runner = createRunner();
        clearOutputs();
        setRunning(true);
        runner.post({
          type: "run",
          entryName: payload.entryName,
          entryPath: payload.entryPath,
          code: payload.code,
          modules: payload.modules,
          modPrefixes: payload.modPrefixes,
          bootstrap: payload.bootstrap,
          inputs: submittedInputs,
          seed: sessionSeed
        });
      }

      if (stopBtn) {
        stopBtn.addEventListener("click", function () {
          if (!running || !runner || !runner.canStop) return;
          runner.stop();
          runner = null;
          setRunning(false);
          if (inputForm) inputForm.hidden = true;
          setStatus("Ejecución detenida", "var(--err)");
          emit("error", "Ejecución detenida por el usuario. Tocá Recargar para volver a ejecutar.");
        });
      }

      if (inputForm) {
        inputForm.addEventListener("submit", function (ev) {
          ev.preventDefault();
          submittedInputs.push({ value: inputField ? inputField.value : "" });
          executePass();
        });
      }

      if (cancelBtn) {
        cancelBtn.addEventListener("click", function () {
          submittedInputs.push({ cancelled: true });
          executePass();
        });
      }

      window.addEventListener("message", function (ev) {
        var d = ev.data;
        if (!d || d.source !== "studio-ide-repl" || d.action !== "eval") return;
        if (ev.source !== window.parent) return;
        var code = String(d.code || "").trim();
        if (!code) return;
        emit("log", ">>> " + code);
        if (running) {
          emit("error", "Esperá a que termine la ejecución actual antes de evaluar en el REPL.");
          return;
        }
        if (!runner) runner = createRunner();
        runner.post({ type: "eval", code: code });
      });

      executePass();
    })();
  </script>
</body>
</html>`;
}
