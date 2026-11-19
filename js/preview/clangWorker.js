import { runWasiModule } from "./wasiRunner.js";

const YOWASP_CLANG_CDN_URL = "https://cdn.jsdelivr.net/npm/@yowasp/clang@22.0.0-git20542-10/gen/bundle.js";

let clangModulePromise = null;

/**
 * Carga bajo demanda el compilador LLVM/Clang compilado a WebAssembly (@yowasp/clang).
 * Nunca se descarga al arrancar el IDE; solo cuando el usuario compila C/C++ sin red o en modo WASM.
 */
async function loadClangToolchain() {
  if (!clangModulePromise) {
    clangModulePromise = import(YOWASP_CLANG_CDN_URL).catch((err) => {
      clangModulePromise = null;
      throw err;
    });
  }
  return clangModulePromise;
}

const FORBIDDEN_VIRTUAL_SEGMENTS = new Set([".", "..", "__proto__", "constructor", "prototype"]);
const MAX_COMPILER_LOG_CHARS = 512 * 1024;

/**
 * Normaliza un nombre de archivo para el sistema de archivos virtual de Clang WASI.
 * @param {string} rawPath
 * @param {string} fallback
 * @returns {string}
 */
export function sanitizeVirtualSourcePath(rawPath, fallback = "main.c") {
  let clean = String(rawPath || "")
    .replace(/[\r\n\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  const segments = clean ? clean.split("/").map((seg) => seg.trim()) : [];
  if (
    !clean ||
    segments.some((seg) => !seg || seg.includes(":") || FORBIDDEN_VIRTUAL_SEGMENTS.has(seg)) ||
    segments.join("/").toLowerCase() === "program.wasm"
  ) {
    clean = fallback;
  } else {
    clean = segments.join("/");
  }
  if (clean && (clean.startsWith("-") || clean.startsWith("@"))) {
    clean = `./${clean}`;
  }
  return clean;
}

/**
 * Inserta una entrada en el árbol virtual jerárquico esperado por `@yowasp/clang`,
 * creando subdirectorios anidados (sin prototipo y sin prefijo literal "./").
 */
function insertVirtualTreeEntry(rootTree, safePath, value) {
  const normalized = String(safePath || "").replace(/^\.\//, "");
  if (!normalized) return;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return;
  let dir = rootTree;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const seg = parts[i];
    if (FORBIDDEN_VIRTUAL_SEGMENTS.has(seg)) return;
    if (!dir[seg] || typeof dir[seg] !== "object" || dir[seg] instanceof Uint8Array) {
      dir[seg] = Object.create(null);
    }
    dir = dir[seg];
  }
  const leaf = parts[parts.length - 1];
  if (FORBIDDEN_VIRTUAL_SEGMENTS.has(leaf) || leaf.toLowerCase() === "program.wasm") return;
  dir[leaf] = value;
}

/**
 * Compila y ejecuta un proyecto C/C++ completamente en WebAssembly local.
 * @param {{
 *   isC?: boolean,
 *   mainFileName?: string,
 *   files?: Record<string, string | Uint8Array>,
 *   extraSources?: string[],
 *   stdin?: string,
 *   onPhase?: (phase: string) => void,
 *   runClangFn?: Function
 * }} params
 */
export async function compileAndRunWithClang({
  isC = false,
  mainFileName = isC ? "main.c" : "main.cpp",
  files = {},
  extraSources = [],
  stdin = "",
  onPhase = () => {},
  runClangFn = null
}) {
  let runClang = runClangFn;
  if (typeof runClang !== "function") {
    onPhase("loading-toolchain");
    const mod = await loadClangToolchain();
    runClang = mod?.runClang;
    if (typeof runClang !== "function") {
      throw new Error("No se encontró el punto de entrada runClang en @yowasp/clang.");
    }
  }

  onPhase("compiling");
  const safeMain = sanitizeVirtualSourcePath(mainFileName, isC ? "main.c" : "main.cpp");
  const safeExtras = Array.isArray(extraSources)
    ? extraSources.map((s) => sanitizeVirtualSourcePath(s, "")).filter(Boolean)
    : [];

  let virtualFs = Object.create(null);
  for (const [k, v] of Object.entries(files || {})) {
    const safeKey = sanitizeVirtualSourcePath(k, "");
    if (!safeKey) continue;
    insertVirtualTreeEntry(virtualFs, safeKey, v instanceof Uint8Array ? v : String(v ?? ""));
  }

  const decoderOut = new TextDecoder("utf-8", { fatal: false });
  const decoderErr = new TextDecoder("utf-8", { fatal: false });
  let compilerOut = "";
  let compilerErr = "";
  let compilerOutTruncated = false;
  let compilerErrTruncated = false;
  let exitStatus = 0;
  let outFiles = null;

  const appendBounded = (current, text, wasTruncated) => {
    if (wasTruncated || !text) return { text: current, truncated: wasTruncated };
    const remaining = MAX_COMPILER_LOG_CHARS - current.length;
    if (remaining <= 0) return { text: current, truncated: true };
    if (text.length > remaining) {
      return { text: `${current}${text.slice(0, remaining)}\n...[log del compilador truncado a 512 KB]`, truncated: true };
    }
    return { text: current + text, truncated: false };
  };

  const compilerCmd = isC ? "clang" : "clang++";
  const args = [
    compilerCmd,
    safeMain,
    ...safeExtras,
    "-O2",
    "-Wall",
    "-o",
    "program.wasm"
  ];

  try {
    outFiles = await runClang(args, virtualFs, {
      stdout: (chunk) => {
        const piece = chunk instanceof Uint8Array ? decoderOut.decode(chunk, { stream: true }) : (chunk != null ? String(chunk) : "");
        const next = appendBounded(compilerOut, piece, compilerOutTruncated);
        compilerOut = next.text;
        compilerOutTruncated = next.truncated;
      },
      stderr: (chunk) => {
        const piece = chunk instanceof Uint8Array ? decoderErr.decode(chunk, { stream: true }) : (chunk != null ? String(chunk) : "");
        const next = appendBounded(compilerErr, piece, compilerErrTruncated);
        compilerErr = next.text;
        compilerErrTruncated = next.truncated;
      }
    });
  } catch (err) {
    // @yowasp/clang lanza Exit con `code` cuando la compilación falla con estado != 0
    if (err && (typeof err.code === "number" || err.name === "Exit")) {
      exitStatus = Number.isFinite(err.code) ? Number(err.code) : 1;
      outFiles = err.files || null;
    } else {
      throw err;
    }
  } finally {
    const tailOut = appendBounded(compilerOut, decoderOut.decode(), compilerOutTruncated);
    compilerOut = tailOut.text;
    const tailErr = appendBounded(compilerErr, decoderErr.decode(), compilerErrTruncated);
    compilerErr = tailErr.text;
    virtualFs = null;
  }

  let wasmBinary = outFiles?.["program.wasm"] || null;
  outFiles = null;
  if (!(wasmBinary instanceof Uint8Array) || wasmBinary.byteLength === 0 || exitStatus !== 0) {
    wasmBinary = null;
    return {
      status: exitStatus || 1,
      success: false,
      stdout: "",
      stderr: "",
      compilerOut,
      compilerErr: compilerErr || "Error al enlazar el binario WASM local con Clang.",
      engine: "wasm-clang"
    };
  }

  onPhase("running");
  let runResult;
  try {
    runResult = await runWasiModule(wasmBinary, {
      stdin: String(stdin || ""),
      args: ["program.wasm"]
    });
  } finally {
    wasmBinary = null;
  }

  return {
    status: runResult.exitCode,
    success: runResult.exitCode === 0,
    stdout: runResult.stdout,
    stderr: runResult.stderr,
    compilerOut,
    compilerErr,
    engine: "wasm-clang"
  };
}

// Registrar manejador solo cuando se ejecuta como Dedicated Web Worker real
if (typeof window === "undefined" && typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.addEventListener("message", async (event) => {
    const msg = event?.data;
    if (!msg || typeof msg.id === "undefined") return;

    if (msg.action === "compileAndRun") {
      try {
        const rawPayload = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
        const result = await compileAndRunWithClang({
          isC: Boolean(rawPayload.isC),
          mainFileName: typeof rawPayload.mainFileName === "string" ? rawPayload.mainFileName : undefined,
          files: rawPayload.files && typeof rawPayload.files === "object" ? rawPayload.files : {},
          extraSources: Array.isArray(rawPayload.extraSources) ? rawPayload.extraSources : [],
          stdin: typeof rawPayload.stdin === "string" ? rawPayload.stdin : "",
          onPhase: (phase) => {
            self.postMessage({ id: msg.id, type: "phase", phase });
          }
        });
        self.postMessage({ id: msg.id, type: "result", ok: true, result });
      } catch (err) {
        self.postMessage({
          id: msg.id,
          type: "result",
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  });
}
