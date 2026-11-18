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

/**
 * Normaliza un nombre de archivo para el sistema de archivos virtual de Clang WASI.
 * @param {string} rawPath
 * @param {string} fallback
 * @returns {string}
 */
export function sanitizeVirtualSourcePath(rawPath, fallback = "main.c") {
  let clean = String(rawPath || "")
    .replace(/[\r\n\x00-\x1f\x7f]/g, "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  const segments = clean ? clean.split("/") : [];
  if (
    !clean ||
    segments.some((seg) => !seg || FORBIDDEN_VIRTUAL_SEGMENTS.has(seg))
  ) {
    clean = fallback;
  }
  if (clean.startsWith("-") || clean.startsWith("@")) {
    clean = `./${clean}`;
  }
  return clean;
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
    ? extraSources.map((s) => sanitizeVirtualSourcePath(s, "helper.c"))
    : [];

  const virtualFs = Object.create(null);
  for (const [k, v] of Object.entries(files || {})) {
    const safeKey = sanitizeVirtualSourcePath(k, "");
    if (!safeKey) continue;
    virtualFs[safeKey] = v instanceof Uint8Array ? v : String(v ?? "");
  }

  const decoderOut = new TextDecoder("utf-8", { fatal: false });
  const decoderErr = new TextDecoder("utf-8", { fatal: false });
  let compilerOut = "";
  let compilerErr = "";
  let exitStatus = 0;
  let outFiles = null;

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
        if (chunk instanceof Uint8Array) {
          compilerOut += decoderOut.decode(chunk, { stream: true });
        } else if (chunk != null) {
          compilerOut += String(chunk);
        }
      },
      stderr: (chunk) => {
        if (chunk instanceof Uint8Array) {
          compilerErr += decoderErr.decode(chunk, { stream: true });
        } else if (chunk != null) {
          compilerErr += String(chunk);
        }
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
    compilerOut += decoderOut.decode();
    compilerErr += decoderErr.decode();
  }

  const wasmBinary = outFiles?.["program.wasm"];
  if (!(wasmBinary instanceof Uint8Array) || wasmBinary.byteLength === 0 || exitStatus !== 0) {
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
  const runResult = await runWasiModule(wasmBinary, {
    stdin: String(stdin || ""),
    args: ["program.wasm"]
  });

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
        const result = await compileAndRunWithClang({
          ...(msg.payload || {}),
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
