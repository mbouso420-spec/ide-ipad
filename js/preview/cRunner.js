/**
 * Compilador y ejecutor interactivo de C y C++ para la Vista Previa.
 * Conecta con la API pública de Wandbox (GCC C17 y GCC C++20) con soporte multi-archivo
 * para proyectos universitarios y profesionales con headers (.h/.hpp) y módulos (.c/.cpp).
 */

export const C_SOURCE_EXTENSIONS = new Set(["c"]);
export const C_HEADER_EXTENSIONS = new Set(["h"]);
export const CPP_SOURCE_EXTENSIONS = new Set(["cpp", "cxx", "cc"]);
export const CPP_HEADER_EXTENSIONS = new Set(["hpp", "hxx", "hh"]);
export const RUST_SOURCE_EXTENSIONS = new Set(["rs"]);
export const GO_SOURCE_EXTENSIONS = new Set(["go"]);
export const JAVA_SOURCE_EXTENSIONS = new Set(["java"]);
export const CSHARP_SOURCE_EXTENSIONS = new Set(["cs"]);
export const TS_SOURCE_EXTENSIONS = new Set(["ts", "tsx"]);

export const ALL_HEADER_EXTENSIONS = new Set(["h", "hpp", "hxx", "hh"]);
export const ALL_C_EXTENSIONS = new Set(["c", "h"]);
export const ALL_CPP_EXTENSIONS = new Set(["cpp", "cxx", "cc", "hpp", "hxx", "hh"]);

/**
 * Detecta si un código fuente en C, C++, Rust, Go, Java o C# define la función de punto de entrada main / Main.
 * Descarta comentarios de bloque y de línea para prevenir falsos positivos.
 * @param {string} code
 * @returns {boolean}
 */
export function hasMainFunction(code) {
  if (!code || typeof code !== "string") return false;
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\r\n]*/g, " ");
  return /\b(?:int|void|auto|signed|fn|func|public\s+static\s+void|static\s+void)?\s*[mM]ain\s*(?:\([^)]*\)|!\s*\(|\(\s*\))\s*(?:->\s*[a-zA-Z0-9_:<>]+\s*)?\{/m.test(stripped);
}

/**
 * Detecta y trunca repeticiones masivas de texto causadas por bucles interactivos
 * que llegan a EOF antes de que el usuario envíe su entrada.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeLoopOutput(text) {
  if (!text || typeof text !== "string") return "";
  const lines = text.split("\n");
  if (lines.length > 20) {
    for (let p = 1; p <= 8; p++) {
      let consecutiveMatches = 0;
      for (let i = 0; i + p < lines.length; i++) {
        if (lines[i].trim() && lines[i] === lines[i + p]) {
          consecutiveMatches++;
          if (consecutiveMatches >= p * 3) {
            const trimmed = lines.slice(0, Math.min(12, p * 2)).join("\n");
            return `${trimmed}\n\n💡 (El programa espera tu respuesta en la barra inferior para continuar)`;
          }
        } else {
          consecutiveMatches = 0;
        }
      }
    }
  }
  return text;
}

/**
 * Extrae la nueva porción de salida generada en el paso actual frente a la salida previa.
 * @param {string} prev
 * @param {string} next
 * @returns {string}
 */
export function extractNewOutputDelta(prev, next) {
  if (!next) return "";
  if (!prev) return next;
  if (next.startsWith(prev)) {
    return next.slice(prev.length);
  }
  let commonLen = 0;
  const maxCheck = Math.min(prev.length, next.length);
  while (commonLen < maxCheck && prev[commonLen] === next[commonLen]) {
    commonLen++;
  }
  return next.slice(commonLen);
}

/**
 * Trunca repeticiones masivas de un menú inicial cuando un bucle no comprueba EOF en el paso 0.
 * @param {string} output
 * @returns {string}
 */
export function trimInitialMenuOutput(output) {
  if (!output || typeof output !== "string") return "";
  const lines = output.split("\n");
  if (lines.length > 8) {
    const firstSig = lines.find((l) => l.trim().length >= 4);
    if (firstSig) {
      const firstIdx = lines.indexOf(firstSig);
      const secondIdx = lines.indexOf(firstSig, firstIdx + 1);
      if (secondIdx > firstIdx) {
        return lines.slice(0, secondIdx).join("\n").trimEnd();
      }
    }
  }
  return output;
}

/**
 * Suprime la reaparición prematura del menú cuando un paso interactivo llega a un scanf
 * subsiguiente que aún no tiene datos y hace rebotar el bucle a mostrar el menú.
 * @param {string} newChunk
 * @param {string} initialOutput
 * @returns {string}
 */
export function trimPrematureMenuRepeat(newChunk, initialOutput) {
  if (!newChunk || !initialOutput || typeof newChunk !== "string") return newChunk;

  const initialLines = initialOutput.split("\n").map((l) => l.trim()).filter((l) => l.length >= 4);
  if (initialLines.length === 0) return newChunk;
  const menuSignature = initialLines[0];

  const sigIndex = newChunk.indexOf(menuSignature);
  if (sigIndex > 0) {
    const beforeSig = newChunk.slice(0, sigIndex);
    // Si la porción antes del menú termina con un prompt de pregunta o dos puntos (: o ?)
    if (/[:?]\s*$/m.test(beforeSig.trim())) {
      return beforeSig.trimEnd() + " ";
    }
  }

  return newChunk;
}

/**
 * Gestor del historial de comandos interactivos con soporte de flechas Arriba/Abajo.
 * Permite recordar entradas anteriores de la sesión y preservar borradores en edición.
 */
export function createTerminalHistory() {
  const history = [];
  let index = -1;
  let draft = "";

  return {
    push(cmd) {
      if (!cmd || typeof cmd !== "string") return;
      const trimmed = cmd.trim();
      if (!trimmed) return;
      if (history.length === 0 || history[history.length - 1] !== trimmed) {
        history.push(trimmed);
      }
      index = -1;
      draft = "";
    },
    navigateUp(currentValue = "") {
      if (history.length === 0) return currentValue;
      if (index === -1) {
        draft = currentValue;
        index = history.length - 1;
      } else if (index > 0) {
        index -= 1;
      }
      return history[index];
    },
    navigateDown() {
      if (index === -1) return draft;
      if (index < history.length - 1) {
        index += 1;
        return history[index];
      }
      index = -1;
      const saved = draft;
      draft = "";
      return saved;
    },
    clear() {
      history.length = 0;
      index = -1;
      draft = "";
    },
    getEntries() {
      return [...history];
    },
    getIndex() {
      return index;
    }
  };
}

/**
 * Genera el payload de compilación para la API de Wandbox con soporte multi-archivo.
 * Reglas de aislamiento estricto:
 * 1. Si el archivo activo es C (.c): JAMÁS incluye archivos C++ (.cpp, .hpp) para no romper el compilador gcc de C.
 * 2. Si un archivo compañero define su propia función main(), se EXCLUYE del enlace para evitar "multiple definition of `main`".
 * 3. Las cabeceras (.h/.hpp) se cargan en `codes` para #include pero NUNCA se pasan como unidades de compilación al linker.
 * @param {{
 *   activeFile: { path: string, shortName?: string, content: string },
 *   companionFiles?: Array<{ path: string, shortName?: string, content: string }>,
 *   stdin?: string
 * }} options
 * @returns {{
 *   compiler: string,
 *   code: string,
 *   codes: Array<{ file: string, code: string }>,
 *   options: string,
 *   stdin: string,
 *   "compiler-option-raw": string
 * }}
 */
export const WAIT_INPUT_MARKER = "\x1e__STUDIO_WAIT_INPUT__";

/**
 * Inyecta un guardián ligero en código C/C++ interactivo para que cuando `scanf`,
 * `getchar` o `fgets` alcancen EOF por falta de más líneas en `stdin` (ejecución paso a paso),
 * el programa vuelque `stdout`, emita `WAIT_INPUT_MARKER` y termine limpiamente con `_Exit(0)`
 * en lugar de seguir ejecutando con variables sin inicializar.
 * Usa `#line 1` para preservar intacta la numeración de líneas en errores y warnings de GCC.
 * @param {string} code
 * @param {string} [filePath="main.c"]
 * @param {boolean} [isC=true]
 * @returns {string}
 */
export function injectInteractiveInputGuard(code, filePath = "main.c", isC = true) {
  const src = String(code || "");
  if (!isC) {
    return src;
  }
  const hasScanf = /(?:^|[^.\w>])\bscanf\s*\(/.test(src);
  const hasGetchar = /(?:^|[^.\w>])\bgetchar\s*\(/.test(src);
  const hasFgets = /(?:^|[^.\w>])\bfgets\s*\(/.test(src);

  if (!hasScanf && !hasGetchar && !hasFgets) {
    return src;
  }

  const safeFile = String(filePath || "main.c").replace(/\\/g, "/").replace(/"/g, "");
  const lines = [
    '#pragma GCC diagnostic push',
    '#pragma GCC diagnostic ignored "-Wunused-function"',
    '#pragma GCC diagnostic ignored "-Wunused-macros"',
    '#include <stdio.h>',
    '#include <stdlib.h>'
  ];

  if (hasScanf) {
    lines.push(
      '#include <stdarg.h>',
      'static inline int __attribute__((unused)) __studio_scanf(const char *fmt, ...) {',
      '  va_list args;',
      '  va_start(args, fmt);',
      '  int r = vscanf(fmt, args);',
      '  va_end(args);',
      '  if (r == EOF) {',
      '    fflush(stdout);',
      '    fputs("\\x1e__STUDIO_WAIT_INPUT__", stdout);',
      '    fflush(stdout);',
      '    _Exit(0);',
      '  }',
      '  return r;',
      '}',
      '#define scanf __studio_scanf'
    );
  }

  if (hasGetchar) {
    lines.push(
      'static inline int __attribute__((unused)) __studio_getchar(void) {',
      '  int r = getchar();',
      '  if (r == EOF) {',
      '    fflush(stdout);',
      '    fputs("\\x1e__STUDIO_WAIT_INPUT__", stdout);',
      '    fflush(stdout);',
      '    _Exit(0);',
      '  }',
      '  return r;',
      '}',
      '#define getchar __studio_getchar'
    );
  }

  if (hasFgets) {
    lines.push(
      'static inline char* __attribute__((unused)) __studio_fgets(char *s, int n, FILE *stream) {',
      '  char *r = fgets(s, n, stream);',
      '  if (!r && stream == stdin) {',
      '    fflush(stdout);',
      '    fputs("\\x1e__STUDIO_WAIT_INPUT__", stdout);',
      '    fflush(stdout);',
      '    _Exit(0);',
      '  }',
      '  return r;',
      '}',
      '#define fgets __studio_fgets'
    );
  }

  lines.push(
    '#pragma GCC diagnostic pop',
    `#line 1 "${safeFile}"`
  );

  return `${lines.join("\n")}\n${src}`;
}

export function buildWandboxPayload({ activeFile, companionFiles = [], stdin = "" }) {
  const ext = getFileExtension(activeFile.path);
  const isRust = RUST_SOURCE_EXTENSIONS.has(ext);
  const isGo = GO_SOURCE_EXTENSIONS.has(ext);
  const isJava = JAVA_SOURCE_EXTENSIONS.has(ext);
  const isCSharp = CSHARP_SOURCE_EXTENSIONS.has(ext);
  const isTypeScript = TS_SOURCE_EXTENSIONS.has(ext);
  const isCSource = C_SOURCE_EXTENSIONS.has(ext);
  const isCHeader = C_HEADER_EXTENSIONS.has(ext);
  const isC = isCSource || (isCHeader && !companionFiles.some((f) => CPP_SOURCE_EXTENSIONS.has(getFileExtension(f?.path || ""))));
  const isCppFamily = !isRust && !isGo && !isJava && !isCSharp && !isTypeScript;

  let compiler = "gcc-head";
  let options = "c++20,warning";

  if (isRust) {
    compiler = "rust-head";
    options = "";
  } else if (isGo) {
    compiler = "go-head";
    options = "";
  } else if (isJava) {
    compiler = "openjdk-head";
    options = "";
  } else if (isCSharp) {
    compiler = "dotnetcore-head";
    options = "";
  } else if (isTypeScript) {
    compiler = "typescript-head";
    options = "";
  } else if (isC) {
    compiler = "gcc-head-c";
    options = "c17,warning";
  }

  // Si el archivo activo es un header (.h/.hpp) o un módulo auxiliar sin `main()`,
  // buscar si entre los archivos compañeros compatibles existe el punto de entrada con `main()`.
  let effectiveMainFile = activeFile;
  let effectiveCompanions = companionFiles;
  const activeIsHeader = ALL_HEADER_EXTENSIONS.has(ext);
  const activeHasMain = !activeIsHeader && hasMainFunction(activeFile.content || "");

  if (!activeHasMain && Array.isArray(companionFiles) && companionFiles.length > 0) {
    const mainCompanion = companionFiles.find((comp) => {
      if (!comp || !comp.path) return false;
      const compExt = getFileExtension(comp.path);
      if (ALL_HEADER_EXTENSIONS.has(compExt)) return false;
      if (isRust && !RUST_SOURCE_EXTENSIONS.has(compExt)) return false;
      if (isGo && !GO_SOURCE_EXTENSIONS.has(compExt)) return false;
      if (isJava && !JAVA_SOURCE_EXTENSIONS.has(compExt)) return false;
      if (isCSharp && !CSHARP_SOURCE_EXTENSIONS.has(compExt)) return false;
      if (isTypeScript && !TS_SOURCE_EXTENSIONS.has(compExt)) return false;
      if (isC && !C_SOURCE_EXTENSIONS.has(compExt)) return false;
      if (isCppFamily && !isC && !ALL_CPP_EXTENSIONS.has(compExt) && !ALL_C_EXTENSIONS.has(compExt)) return false;
      return hasMainFunction(comp.content || "");
    });

    if (mainCompanion) {
      effectiveMainFile = mainCompanion;
      effectiveCompanions = [
        activeFile,
        ...companionFiles.filter((c) => c && normalizePath(c.path) !== normalizePath(mainCompanion.path))
      ];
    }
  }

  const cleanActivePath = normalizePath(effectiveMainFile.path);
  const activeBaseDir = getParentFolder(cleanActivePath);
  const prefix = activeBaseDir ? `${activeBaseDir}/` : "";

  const codes = [];
  const extraSourceFiles = [];

  for (const comp of effectiveCompanions) {
    if (!comp || !comp.path) continue;
    const compClean = normalizePath(comp.path);
    if (compClean === cleanActivePath) continue;

    const compExt = getFileExtension(comp.path);

    // 1. REGLA ESTRICTA DE LENGUAJE:
    if (isRust) {
      if (!RUST_SOURCE_EXTENSIONS.has(compExt)) continue;
    } else if (isGo) {
      if (!GO_SOURCE_EXTENSIONS.has(compExt)) continue;
    } else if (isJava) {
      if (!JAVA_SOURCE_EXTENSIONS.has(compExt)) continue;
    } else if (isCSharp) {
      if (!CSHARP_SOURCE_EXTENSIONS.has(compExt)) continue;
    } else if (isTypeScript) {
      if (!TS_SOURCE_EXTENSIONS.has(compExt)) continue;
    } else if (isC) {
      if (!C_SOURCE_EXTENSIONS.has(compExt) && !C_HEADER_EXTENSIONS.has(compExt)) {
        continue;
      }
    } else {
      // Si estamos compilando C++ (gcc-head / g++):
      if (!ALL_CPP_EXTENSIONS.has(compExt) && !ALL_C_EXTENSIONS.has(compExt)) {
        continue;
      }
    }

    // Obtener ruta relativa respecto al archivo principal
    const relName = prefix && compClean.startsWith(prefix)
      ? compClean.slice(prefix.length)
      : comp.shortName || compClean.split("/").pop();

    const isHeader = ALL_HEADER_EXTENSIONS.has(compExt);
    const compContent = String(comp.content || "");

    // 2. CABECERAS (.h, .hpp, etc.):
    // Se agregan al disco virtual de Wandbox (`codes`) para que puedan ser importadas con `#include "..."`.
    // NUNCA se agregan como fuentes a compilar directamente en `extraSourceFiles` / `compiler-option-raw`.
    if (isHeader) {
      codes.push({
        file: relName,
        code: compContent
      });
      continue;
    }

    // 3. ARCHIVOS DE CÓDIGO FUENTE (.c, .cpp, .cxx, .cc):
    // Verificar si el archivo compañero define su propia función `main()`.
    const compHasMain = hasMainFunction(compContent);

    // Si el archivo compañero define `main()`, es un programa INDEPENDIENTE
    // (ej: otro ejercicio o programa separado en la misma carpeta).
    // Si lo vinculáramos a la compilación de `activeFile`, el linker fallará con:
    // `multiple definition of 'main'`.
    // Por ende, NUNCA se debe compilar ni enlazar como módulo adicional.
    if (compHasMain) {
      continue;
    }

    // Si NO define `main()`, es un módulo auxiliar (ej: utils.c, calculos.cpp).
    // Se incluye en `codes` y se pasa al compilador para enlace.
    codes.push({
      file: relName,
      code: compContent
    });
    extraSourceFiles.push(relName);
  }

  const rawOptions = isCppFamily ? ["-O2", "-Wall", "-lm"] : [];
  if (extraSourceFiles.length > 0) {
    rawOptions.unshift(...extraSourceFiles);
  }

  return {
    compiler,
    code: effectiveMainFile.content || "",
    codes,
    options,
    stdin: String(stdin || ""),
    "compiler-option-raw": rawOptions.join("\n")
  };
}

/**
 * Envía el código a la API de Wandbox para su compilación y ejecución.
 * @param {object} payload
 * @param {typeof fetch} [fetchFn=fetch]
 * @returns {Promise<{
 *   status: number,
 *   success: boolean,
 *   stdout: string,
 *   stderr: string,
 *   compilerOut: string,
 *   compilerErr: string
 * }>}
 */
export async function compileAndRunWandbox(
  payload,
  fetchFn = (typeof window !== "undefined" ? window.fetch : fetch),
  timeoutMs = 25000,
  externalSignal = null
) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timedOut = false;
  let onExternalAbort = null;
  if (controller && externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else if (typeof externalSignal.addEventListener === "function") {
      onExternalAbort = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  const timer =
    controller && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

  let data;
  try {
    if (externalSignal?.aborted) {
      const abortErr = new Error("Compilación cancelada.");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    const fetchOpts = {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    };
    if (controller) {
      fetchOpts.signal = controller.signal;
    }
    const res = await fetchFn("https://wandbox.org/api/compile.json", fetchOpts);
    if (!res.ok) {
      throw new Error(`Error en servidor de compilación (HTTP ${res.status}): ${res.statusText}`);
    }
    const jsonPromise = res.json();
    if (controller && controller.signal) {
      let onRaceAbort = null;
      try {
        data = await Promise.race([
          jsonPromise,
          new Promise((_, reject) => {
            if (controller.signal.aborted) {
              const abortErr = new Error("Aborted");
              abortErr.name = "AbortError";
              reject(abortErr);
              return;
            }
            onRaceAbort = () => {
              const abortErr = new Error("Aborted");
              abortErr.name = "AbortError";
              reject(abortErr);
            };
            controller.signal.addEventListener("abort", onRaceAbort, { once: true });
          })
        ]);
      } finally {
        if (onRaceAbort && typeof controller.signal.removeEventListener === "function") {
          controller.signal.removeEventListener("abort", onRaceAbort);
        }
      }
    } else {
      data = await jsonPromise;
    }
  } catch (err) {
    if (timedOut) {
      throw new Error("Tiempo de espera agotado al conectar con el compilador remoto (Wandbox).");
    }
    if (externalSignal?.aborted) {
      if (err && err.name === "AbortError") throw err;
      const abortErr = new Error("Compilación cancelada.");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    if (controller?.signal?.aborted) {
      throw new Error("Tiempo de espera agotado al conectar con el compilador remoto (Wandbox).");
    }
    throw err;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (externalSignal && onExternalAbort && typeof externalSignal.removeEventListener === "function") {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  const rawCompilerErr = String(data.compiler_error || "");
  const hasRealCompileError = /(?:^|:|\s)(?:fatal error|error(?:\s*\[[^\]]+\]|\s+[A-Z]{1,6}\d{1,6})?):/i.test(rawCompilerErr);
  const statusCode = Number(data.status ?? (hasRealCompileError ? 1 : 0));

  return {
    status: statusCode,
    success: statusCode === 0 && !hasRealCompileError,
    stdout: data.program_output || "",
    stderr: data.program_error || "",
    compilerOut: data.compiler_output || "",
    compilerErr: rawCompilerErr
  };
}

/**
 * Parsea errores y advertencias de compilación devueltos por GCC / Clang / Rust / Go / TypeScript / C#.
 * @param {string} output
 * @returns {Array<{ line: number, column: number, severity: string, message: string, raw: string }>}
 */
export function parseGccErrors(output) {
  if (!output || typeof output !== "string") return [];
  const errors = [];
  const seen = new Set();
  const pushIssue = (issue) => {
    const key = `${issue.line}:${issue.column}:${issue.severity}:${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push(issue);
  };

  // GCC / Clang / Go / TypeScript pretty (`file:line:col - error TSxxxx: msg`)
  const regex = /(?:^|\n)(?:[^\s:(]+):(\d+)(?::(\d+))?(?::\s*|\s+-\s+)(?:(fatal error|error|warning)(?:\s+([A-Z]{1,6}\d{1,6}))?:\s*)?([^\r\n]+)/gi;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const line = parseInt(match[1], 10);
    const column = match[2] ? parseInt(match[2], 10) : 1;
    const severity = (match[3] || "error").toLowerCase();
    const diagCode = match[4] ? `${match[4]}: ` : "";
    const rawMessage = `${diagCode}${match[5].trim()}`
      .replace(/__studio_scanf\b/g, "scanf")
      .replace(/__studio_getchar\b/g, "getchar")
      .replace(/__studio_fgets\b/g, "fgets");
    if (rawMessage.includes("__studio_")) continue;
    if (!isNaN(line)) {
      pushIssue({
        line,
        column,
        severity,
        message: rawMessage,
        raw: match[0].trim()
      });
    }
  }

  // TypeScript (tsc) & C# (csc / Roslyn / MSBuild): `archivo(linea,columna): error TSxxxx/CSxxxx: mensaje`
  const parenRegex = /(?:^|\n)[^\r\n(\n]{0,260}\((\d+)(?:,\s*(\d+))?\)\s*:\s*(fatal error|error|warning)(?:\s+([A-Z]{1,6}\d{1,6}))?:\s*([^\r\n]+)/gi;
  while ((match = parenRegex.exec(output)) !== null) {
    const line = parseInt(match[1], 10);
    const column = match[2] ? parseInt(match[2], 10) : 1;
    const severity = (match[3] || "error").toLowerCase();
    const diagCode = match[4] ? `${match[4]}: ` : "";
    const rawMessage = `${diagCode}${match[5].trim()}`;
    if (!isNaN(line)) {
      pushIssue({
        line,
        column,
        severity,
        message: rawMessage,
        raw: match[0].trim()
      });
    }
  }

  // Soporte para formato de error de Rust: error[E...]: mensaje \n  --> archivo:linea:columna
  const rustRegex = /(?:^|\n)(error(?:\[[^\]]+\])?|warning(?:\[[^\]]+\])?):\s*([^\r\n]+)\s*\n\s*-->\s*(?:[^\s:]+):(\d+):(\d+)/gi;
  while ((match = rustRegex.exec(output)) !== null) {
    const severity = match[1].toLowerCase().startsWith("warning") ? "warning" : "error";
    const rawMessage = match[2].trim();
    const line = parseInt(match[3], 10);
    const column = parseInt(match[4], 10);
    if (!isNaN(line)) {
      pushIssue({
        line,
        column,
        severity,
        message: rawMessage,
        raw: match[0].trim()
      });
    }
  }

  return errors;
}

/**
 * Monta la interfaz interactiva nativa del Runner C/C++ directamente en el DOM del modal
 * evitando el uso de iframes sandboxeados para una conectividad sin trabas con Wandbox y CodeMirror.
 * @param {HTMLElement} containerEl
 * @param {{
 *   activeFile: { path: string, shortName?: string, content: string },
 *   companionFiles?: Array<{ path: string, shortName?: string, content: string }>,
 *   onCompilerResult?: (res: { success: boolean, errors: Array<{ line: number, column: number, severity: string, message: string }> }) => void,
 *   onGoToLine?: (lineNum: number) => void,
 *   fetchFn?: typeof fetch
 * }} options
 * @returns {{ destroy: () => void, run: () => Promise<void> }}
 */
export function mountCRunnerView(containerEl, {
  activeFile,
  companionFiles = [],
  onCompilerResult = () => {},
  onGoToLine = () => {},
  fetchFn = (typeof window !== "undefined" ? window.fetch : fetch)
}) {
  if (!containerEl) return { destroy: () => {}, run: async () => {} };
  containerEl.innerHTML = "";

  const ext = getFileExtension(activeFile.path);
  const isRust = RUST_SOURCE_EXTENSIONS.has(ext);
  const isGo = GO_SOURCE_EXTENSIONS.has(ext);
  const isJava = JAVA_SOURCE_EXTENSIONS.has(ext);
  const isCSharp = CSHARP_SOURCE_EXTENSIONS.has(ext);
  const isTypeScript = TS_SOURCE_EXTENSIONS.has(ext);
  const isCSource = C_SOURCE_EXTENSIONS.has(ext);
  const isCHeader = C_HEADER_EXTENSIONS.has(ext);
  const isHeader = ALL_HEADER_EXTENSIONS.has(ext);
  const isC = isCSource || (isCHeader && !companionFiles.some((f) => CPP_SOURCE_EXTENSIONS.has(getFileExtension(f?.path || ""))));
  const isCppFamily = !isRust && !isGo && !isJava && !isCSharp && !isTypeScript;
  const langLabel = isRust
    ? "Rust (Wandbox / rustc)"
    : isGo
    ? "Go (Wandbox / golang)"
    : isJava
    ? "Java (OpenJDK)"
    : isCSharp
    ? "C# (.NET)"
    : isTypeScript
    ? "TypeScript"
    : isHeader
    ? (isC ? "C Header (.h)" : "C++ Header (.hpp)")
    : (isC ? "C (GCC 14 / C17)" : "C++ (GCC 14 / C++20)");
  const initialPayload = buildWandboxPayload({ activeFile, companionFiles, stdin: "" });
  const companionCount = initialPayload.codes.length;
  const companionLabel = companionCount > 0
    ? `+ ${companionCount} archivo(s) vinculado(s): ${initialPayload.codes.map((c) => c.file).join(", ")}`
    : "Archivo único";

  const shell = document.createElement("div");
  shell.className = "c-runner-shell";

  // 1. Cabecera con metadatos y botón de compilación
  const header = document.createElement("div");
  header.className = "c-runner-header";

  const meta = document.createElement("div");
  meta.className = "c-runner-meta";
  const title = document.createElement("span");
  title.className = "c-runner-title";
  title.textContent = activeFile.shortName || activeFile.path;
  const badge = document.createElement("span");
  badge.className = "c-runner-badge";
  badge.textContent = langLabel;
  const companionBadge = document.createElement("span");
  companionBadge.className = "c-runner-companion-badge";
  companionBadge.textContent = companionLabel;
  meta.append(title, badge, companionBadge);

  const btnCompile = document.createElement("button");
  btnCompile.type = "button";
  btnCompile.className = "btn btn-primary btn-sm btn-c-compile";
  btnCompile.innerHTML = '<span data-icon="play"></span><span>Compilar y Ejecutar</span> <span class="c-key-hint" style="opacity:0.75;font-size:11px;">(Ctrl+Enter)</span>';

  header.append(meta, btnCompile);

  // 2. Modo avanzado: Tarjeta stdin colapsable para lote
  const hasInteractiveInput = /\b(scanf|cin|getline|getchar|fgets|gets)\b/.test(activeFile.content || "");
  const stdinDetails = document.createElement("details");
  stdinDetails.className = "c-stdin-details";
  const stdinSummary = document.createElement("summary");
  stdinSummary.className = "c-section-label c-stdin-summary";
  stdinSummary.textContent = "Entrada estándar por lotes (avanzado / batch stdin)";
  stdinDetails.appendChild(stdinSummary);

  const stdinCard = document.createElement("div");
  stdinCard.className = "c-stdin-card";

  const stdinHeader = document.createElement("div");
  stdinHeader.className = "c-stdin-header";
  const stdinLabel = document.createElement("label");
  stdinLabel.className = "c-section-label";
  stdinLabel.textContent = "Entrada estándar preconfigurada (lote completo):";
  const stdinHelp = document.createElement("span");
  stdinHelp.className = "c-stdin-help";
  stdinHelp.textContent = "Para enviar todas las entradas de antemano";
  stdinHeader.append(stdinLabel, stdinHelp);

  const stdinTextarea = document.createElement("textarea");
  stdinTextarea.className = "c-stdin-textarea code-font";
  stdinTextarea.placeholder = hasInteractiveInput
    ? "Opcional: Si querés enviar todo junto de una sola vez (ej: 1\\n10 20\\n5)..."
    : "Escribí aquí los datos de entrada por lotes...";
  stdinTextarea.spellcheck = false;
  stdinTextarea.setAttribute("autocorrect", "off");
  stdinTextarea.setAttribute("autocapitalize", "off");
  stdinTextarea.setAttribute("writingsuggestions", "false");
  if (typeof document !== "undefined" && document.body?.dataset?.hardwareKeyboard === "true") {
    stdinTextarea.setAttribute("inputmode", "none");
  }

  const stdinFooter = document.createElement("div");
  stdinFooter.className = "c-stdin-footer";

  const btnClearStdin = document.createElement("button");
  btnClearStdin.type = "button";
  btnClearStdin.className = "btn btn-subtle btn-sm btn-c-clear-stdin";
  btnClearStdin.textContent = "Limpiar";

  const btnSendStdin = document.createElement("button");
  btnSendStdin.type = "button";
  btnSendStdin.className = "btn btn-primary btn-sm btn-c-send-stdin";
  btnSendStdin.innerHTML = '<span data-icon="play"></span><span>Ejecutar por lotes</span>';

  stdinFooter.append(btnClearStdin, btnSendStdin);
  stdinCard.append(stdinHeader, stdinTextarea, stdinFooter);
  stdinDetails.appendChild(stdinCard);

  // 3. Tarjeta Terminal Interactiva (Paso a Paso)
  const termCard = document.createElement("div");
  termCard.className = "c-terminal-card";
  const termHeader = document.createElement("div");
  termHeader.className = "c-terminal-header";
  const termTitle = document.createElement("span");
  termTitle.className = "c-section-label";
  termTitle.textContent = "Terminal Interactiva";
  const termStatus = document.createElement("span");
  termStatus.className = "c-term-status is-idle";
  termStatus.textContent = "Listo para compilar";
  termHeader.append(termTitle, termStatus);

  const termBody = document.createElement("div");
  termBody.className = "c-terminal-body code-font";
  termBody.textContent = "Iniciando compilador en Wandbox...";

  // 4. Barra de Entrada Interactiva (Paso a Paso)
  const termInputBar = document.createElement("div");
  termInputBar.className = "c-terminal-input-bar";

  const termPrompt = document.createElement("span");
  termPrompt.className = "c-terminal-prompt-sym";
  termPrompt.textContent = ">";

  const termInput = document.createElement("input");
  termInput.type = "text";
  termInput.className = "c-terminal-input code-font";
  termInput.placeholder = hasInteractiveInput
    ? "Escribí tu respuesta aquí y presioná Enter..."
    : "Escribí un comando o datos y presioná Enter...";
  termInput.autocomplete = "off";
  termInput.spellcheck = false;
  termInput.setAttribute("autocorrect", "off");
  termInput.setAttribute("autocapitalize", "off");
  termInput.setAttribute("writingsuggestions", "false");
  if (typeof document !== "undefined" && document.body?.dataset?.hardwareKeyboard === "true") {
    termInput.setAttribute("inputmode", "none");
  }

  const btnSendStep = document.createElement("button");
  btnSendStep.type = "button";
  btnSendStep.className = "btn btn-primary btn-sm btn-c-send-step";
  btnSendStep.innerHTML = '<span data-icon="play"></span><span>Enviar</span>';

  const btnReset = document.createElement("button");
  btnReset.type = "button";
  btnReset.className = "btn btn-subtle btn-sm btn-c-reset-step";
  btnReset.title = "Reiniciar la terminal interactiva desde el principio";
  btnReset.textContent = "Reiniciar";

  termInputBar.append(termPrompt, termInput, btnSendStep, btnReset);
  termCard.append(termHeader, termBody, termInputBar);

  shell.append(header, termCard, stdinDetails);
  containerEl.appendChild(shell);

  const terminalHistory = createTerminalHistory();
  let sessionInputs = [];
  let lastRawStdout = "";
  let initialMenuSnapshot = "";
  let isCompiling = false;
  let isDestroyed = false;
  let activeRequestController = null;

  async function executeStep(userInput = null) {
    if (isCompiling) return;

    if (userInput !== null && String(userInput).trim() !== "") {
      sessionInputs.push(String(userInput).trim());
    }

    isCompiling = true;
    activeRequestController = typeof AbortController !== "undefined" ? new AbortController() : null;
    btnCompile.disabled = true;
    btnSendStdin.disabled = true;
    btnSendStep.disabled = true;
    termInput.disabled = true;
    termStatus.className = "c-term-status is-running";
    termStatus.textContent = sessionInputs.length === 0 ? "Compilando en Wandbox..." : "Ejecutando paso...";

    const batchValue = (stdinTextarea.value || "").trim();
    let effectiveStdin = "";
    if (sessionInputs.length > 0) {
      effectiveStdin = sessionInputs.join("\n") + "\n";
    } else if (batchValue) {
      effectiveStdin = batchValue + "\n";
    }

    const payload = buildWandboxPayload({
      activeFile,
      companionFiles,
      stdin: effectiveStdin
    });

    if (isCppFamily && !batchValue) {
      payload.code = injectInteractiveInputGuard(
        payload.code,
        activeFile.shortName || activeFile.path,
        isC
      );
    }

    const t0 = performance.now();
    try {
      const res = await compileAndRunWandbox(payload, fetchFn, 25000, activeRequestController?.signal || null);
      if (isDestroyed) return;
      const ms = Math.round(performance.now() - t0);
      const rawStdoutWithMarker = String(res.stdout || "");
      const waitingForInput = rawStdoutWithMarker.includes(WAIT_INPUT_MARKER);
      const cleanResStdout = waitingForInput
        ? rawStdoutWithMarker.split(WAIT_INPUT_MARKER).join("")
        : rawStdoutWithMarker;

      const compilerErrors = parseGccErrors(`${res.compilerErr}\n${res.compilerOut}\n${res.stderr}`);
      const blockingErrors = compilerErrors.filter((e) => e.severity !== "warning");

      if (blockingErrors.length > 0 || !res.success) {
        termStatus.className = "c-term-status is-err";
        termStatus.textContent = `Falló compilación / ejecución (código ${res.status}) — ${ms} ms`;
        termBody.innerHTML = "";
        const compBlock = document.createElement("div");
        compBlock.className = "c-term-comp-err";

        const rawErrText = (res.compilerErr || res.compilerOut || res.stderr || "").trim();

        if (compilerErrors.length > 0) {
          const banner = document.createElement("div");
          banner.className = "c-term-err-banner";
          banner.textContent = `⚠ Se detectaron ${compilerErrors.length} fallo(s) de compilación. Hacé clic en cualquier línea señalada para saltar al editor:`;
          compBlock.appendChild(banner);

          const errLines = rawErrText ? rawErrText.split("\n") : [];
          for (const lineText of errLines) {
            const trimmed = lineText.trim();
            const matched = compilerErrors.find((e) => {
              if (!e || !(e.line > 0)) return false;
              const hasLoc = trimmed.includes(`:${e.line}:`) || trimmed.includes(`(${e.line},`);
              if (!hasLoc) return false;
              return (
                /(error|warning|fatal error)(?:\s*\[[^\]]+\]|\s+[A-Z]{1,6}\d{1,6})?:/i.test(trimmed) ||
                /^\s*-->/.test(trimmed) ||
                /-\s*(error|warning)\s+[A-Z]{1,6}\d{1,6}:/i.test(trimmed)
              );
            });
            if (matched) {
              const errLineEl = document.createElement("div");
              errLineEl.className = "c-term-err-line";
              errLineEl.setAttribute("role", "button");
              errLineEl.setAttribute("tabindex", "0");
              errLineEl.title = `Saltar a línea ${matched.line} en el editor`;
              errLineEl.textContent = lineText;
              const jump = (evt) => {
                evt.stopPropagation();
                onGoToLine(matched.line);
              };
              errLineEl.addEventListener("click", jump);
              errLineEl.addEventListener("keydown", (evt) => {
                if (evt.key === "Enter" || evt.key === " ") {
                  evt.preventDefault();
                  jump(evt);
                }
              });
              compBlock.appendChild(errLineEl);
            } else {
              const normalLine = document.createElement("div");
              normalLine.className = "c-term-err-raw-line";
              normalLine.textContent = lineText;
              compBlock.appendChild(normalLine);
            }
          }
        } else {
          compBlock.textContent = rawErrText || "Error de compilación desconocido";
        }

        termBody.appendChild(compBlock);
        onCompilerResult({ success: false, errors: compilerErrors });
        return;
      }

      onCompilerResult({ success: true, errors: [] });

      // PASO 0: Primer arranque
      if (sessionInputs.length === 0) {
        termBody.innerHTML = "";
        lastRawStdout = cleanResStdout;
        const cleanStdout = trimInitialMenuOutput(sanitizeLoopOutput(lastRawStdout));
        initialMenuSnapshot = cleanStdout;

        if (cleanStdout) {
          const outDiv = document.createElement("div");
          outDiv.className = "c-term-stdout";
          outDiv.textContent = cleanStdout;
          termBody.appendChild(outDiv);
        } else if (waitingForInput) {
          const waitDiv = document.createElement("div");
          waitDiv.className = "c-term-hint";
          waitDiv.textContent = "(El programa espera que ingreses un valor abajo...)";
          termBody.appendChild(waitDiv);
        } else {
          const emptyDiv = document.createElement("div");
          emptyDiv.className = "c-term-hint";
          emptyDiv.textContent = "(El programa terminó sin producir salida en stdout ni stderr).";
          termBody.appendChild(emptyDiv);
        }

        if (res.stderr) {
          const errDiv = document.createElement("div");
          errDiv.className = "c-term-stderr";
          errDiv.textContent = res.stderr;
          termBody.appendChild(errDiv);
        }
      } else {
        // PASO N: Interacción del usuario
        const userLine = document.createElement("div");
        userLine.className = "c-term-user-line";
        userLine.innerHTML = `<span class="c-term-user-prompt">&gt;</span> <span class="c-term-user-text">${escapeHtml(userInput)}</span>`;
        termBody.appendChild(userLine);

        const fullStdout = cleanResStdout;
        let newChunk = "";
        if (fullStdout.startsWith(lastRawStdout)) {
          newChunk = fullStdout.slice(lastRawStdout.length);
        } else {
          newChunk = extractNewOutputDelta(lastRawStdout, fullStdout);
        }
        lastRawStdout = fullStdout;

        // Truncar reaparición prematura del menú si el programa llegó a un scanf que aún no tiene datos
        const trimmedChunk = trimPrematureMenuRepeat(newChunk, initialMenuSnapshot);
        const cleanNewChunk = sanitizeLoopOutput(trimmedChunk);

        if (cleanNewChunk) {
          const outDiv = document.createElement("div");
          outDiv.className = "c-term-stdout";
          outDiv.textContent = cleanNewChunk;
          termBody.appendChild(outDiv);
        }

        if (res.stderr) {
          const errDiv = document.createElement("div");
          errDiv.className = "c-term-stderr";
          errDiv.textContent = res.stderr;
          termBody.appendChild(errDiv);
        }
      }

      termBody.scrollTop = termBody.scrollHeight;

      if (waitingForInput) {
        termStatus.className = "c-term-status is-running";
        termStatus.textContent = sessionInputs.length === 0
          ? `Esperando dato en consola (${ms} ms)`
          : `Paso ${sessionInputs.length} — Esperando dato (${ms} ms)`;
        termInput.placeholder = "Escribí el dato solicitado y presioná Enter...";
        setTimeout(() => termInput.focus(), 60);
      } else if (res.status === 0 && !hasInteractiveInput) {
        termStatus.className = "c-term-status is-ok";
        termStatus.textContent = `Código de salida: 0 (Éxito) — ${ms} ms`;
        termInput.placeholder = "Programa finalizado. Tocá 'Reiniciar' para volver a ejecutar.";
      } else {
        termStatus.className = "c-term-status is-ok";
        termStatus.textContent = `Paso ${sessionInputs.length} — Finalizado (${ms} ms)`;
        termInput.placeholder = "Programa finalizado. Tocá 'Reiniciar' para volver a ejecutar.";
        setTimeout(() => termInput.focus(), 60);
      }
    } catch (err) {
      if (isDestroyed) return;
      termStatus.className = "c-term-status is-err";
      termStatus.textContent = "Error de red / API";
      const errDiv = document.createElement("div");
      errDiv.className = "c-term-stderr";
      errDiv.textContent = `Error al conectar con la API de compilación: ${err.message}`;
      termBody.appendChild(errDiv);
      onCompilerResult({ success: false, errors: [] });
    } finally {
      activeRequestController = null;
      isCompiling = false;
      btnCompile.disabled = false;
      btnSendStdin.disabled = false;
      btnSendStep.disabled = false;
      termInput.disabled = false;
    }
  }

  function triggerFreshRun(resetTerminal = false) {
    if (isCompiling) return false;
    sessionInputs = [];
    lastRawStdout = "";
    initialMenuSnapshot = "";
    if (resetTerminal) {
      terminalHistory.clear();
      termInput.value = "";
      termBody.innerHTML = '<span class="c-term-hint">Reiniciando consola...</span>';
    }
    executeStep(null);
    return true;
  }

  btnCompile.addEventListener("click", () => {
    triggerFreshRun(false);
  });

  btnSendStdin.addEventListener("click", () => {
    triggerFreshRun(false);
  });

  btnReset.addEventListener("click", () => {
    triggerFreshRun(true);
  });

  function handleSendInteractiveInput() {
    if (isCompiling) return;
    const text = termInput.value.trim();
    if (!text) return;
    terminalHistory.push(text);
    termInput.value = "";
    executeStep(text);
  }

  btnSendStep.addEventListener("click", handleSendInteractiveInput);

  termInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSendInteractiveInput();
    } else if (e.key === "ArrowUp") {
      if (terminalHistory.getEntries().length > 0) {
        e.preventDefault();
        termInput.value = terminalHistory.navigateUp(termInput.value);
        try {
          const pos = termInput.value.length;
          termInput.setSelectionRange(pos, pos);
        } catch (_) {}
      }
    } else if (e.key === "ArrowDown") {
      if (terminalHistory.getIndex() !== -1) {
        e.preventDefault();
        termInput.value = terminalHistory.navigateDown();
        try {
          const pos = termInput.value.length;
          termInput.setSelectionRange(pos, pos);
        } catch (_) {}
      }
    }
  });

  btnClearStdin.addEventListener("click", () => {
    stdinTextarea.value = "";
    stdinTextarea.focus();
  });

  stdinTextarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      triggerFreshRun(false);
    }
  });

  function handleKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      triggerFreshRun(false);
    }
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("keydown", handleKeydown);
  }

  // Ejecución inicial automática al montar
  executeStep(null);

  return {
    destroy() {
      isDestroyed = true;
      try { activeRequestController?.abort(); } catch (_) {}
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("keydown", handleKeydown);
      }
    },
    run: () => executeStep(null)
  };
}

function getFileExtension(path) {
  const base = String(path || "").split("/").pop() || "";
  if (!base.includes(".")) return "";
  return base.split(".").pop().toLowerCase();
}

function getParentFolder(path) {
  const clean = normalizePath(path);
  return clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
}

function normalizePath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Construye el documento HTML completo del Runner de C y C++ para el iframe.
 * @param {{ path: string, shortName: string, content: string }} activeFile
 * @param {Array<{ path: string, shortName: string, content: string }>} [companionFiles=[]]
 * @returns {string}
 */
export function buildCRunnerPreview(activeFile, companionFiles = []) {
  const ext = getFileExtension(activeFile.path);
  const isRust = RUST_SOURCE_EXTENSIONS.has(ext);
  const isGo = GO_SOURCE_EXTENSIONS.has(ext);
  const isJava = JAVA_SOURCE_EXTENSIONS.has(ext);
  const isCSharp = CSHARP_SOURCE_EXTENSIONS.has(ext);
  const isTypeScript = TS_SOURCE_EXTENSIONS.has(ext);
  const isCSource = C_SOURCE_EXTENSIONS.has(ext);
  const isCHeader = C_HEADER_EXTENSIONS.has(ext);
  const isHeader = ALL_HEADER_EXTENSIONS.has(ext);
  const isC = isCSource || (isCHeader && !companionFiles.some((f) => CPP_SOURCE_EXTENSIONS.has(getFileExtension(f?.path || ""))));
  const langLabel = isRust
    ? "Rust (Wandbox / rustc)"
    : isGo
    ? "Go (Wandbox / golang)"
    : isJava
    ? "Java (OpenJDK)"
    : isCSharp
    ? "C# (.NET)"
    : isTypeScript
    ? "TypeScript"
    : isHeader
    ? (isC ? "C Header (.h)" : "C++ Header (.hpp)")
    : (isC ? "C (GCC 14 / C17)" : "C++ (GCC 14 / C++20)");
  const safeTitle = escapeHtml(activeFile.shortName || activeFile.path);

  const initialPayload = buildWandboxPayload({ activeFile, companionFiles, stdin: "" });
  const safePayloadJson = JSON.stringify(initialPayload).replace(/</g, "\\u003c");

  const companionCount = initialPayload.codes.length;
  const companionLabel = companionCount > 0
    ? `+ ${companionCount} archivo(s) vinculado(s): ${initialPayload.codes.map((c) => c.file).join(", ")}`
    : "Archivo único";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle} — ${langLabel}</title>
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
      --warn-soft: oklch(74% 0.14 75 / 0.18);
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
    .c-shell {
      max-width: 1000px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .c-header {
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
    .c-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .c-title {
      font-weight: 600;
      font-size: 14px;
    }
    .c-badge {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--card-alt);
      border: 1px solid var(--border);
      color: var(--accent);
    }
    .c-companion-badge {
      font-size: 11px;
      color: var(--muted);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
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
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .c-stdin-box {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .c-stdin-label {
      font-size: 12px;
      color: var(--muted);
      font-weight: 500;
    }
    .c-stdin-input {
      width: 100%;
      height: 54px;
      padding: 6px 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--ink);
      font-family: var(--font-mono);
      font-size: 12px;
      resize: vertical;
    }
    .c-stdin-input:focus {
      outline: 2px solid var(--border-focus);
      outline-offset: -1px;
    }
    .terminal-card {
      background: oklch(11% 0.008 255);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .terminal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      background: oklch(14% 0.01 255);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }
    .terminal-title {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
    }
    .terminal-status {
      font-size: 11px;
      font-family: var(--font-mono);
    }
    .terminal-status.is-ok { color: var(--ok); }
    .terminal-status.is-err { color: var(--err); }
    .terminal-status.is-running { color: var(--warn); }
    .terminal-body {
      padding: 14px;
      min-height: 220px;
      max-height: 480px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .out-stdout { color: var(--ink); }
    .out-stderr { color: var(--err); }
    .out-comp-warn { color: var(--warn); }
    .out-comp-err { color: var(--err); font-weight: 600; }
    .out-hint { color: var(--muted); font-style: italic; }
  </style>
</head>
<body>
  <div class="c-shell">
    <div class="c-header">
      <div class="c-meta">
        <span class="c-title">${langLabel}</span>
        <span class="c-badge">${safeTitle}</span>
        <span class="c-companion-badge">${escapeHtml(companionLabel)}</span>
      </div>
      <div>
        <button type="button" id="btn-compile" class="btn btn-primary" title="Compilar y ejecutar en Wandbox (Ctrl+Enter)">
          <span>Compilar y Ejecutar</span>
        </button>
      </div>
    </div>

    <div class="c-stdin-box">
      <label for="stdin-val" class="c-stdin-label">Datos de entrada estándar (stdin para cin / scanf):</label>
      <textarea id="stdin-val" class="c-stdin-input" placeholder="Valores de entrada separados por espacio o saltos de línea (opcional)..." spellcheck="false"></textarea>
    </div>

    <div class="terminal-card">
      <div class="terminal-head">
        <span class="terminal-title">Terminal de salida (stdout / stderr)</span>
        <span id="term-status" class="terminal-status">Listo para compilar</span>
      </div>
      <div id="terminal-body" class="terminal-body">
        <span class="out-hint">Presioná "Compilar y Ejecutar" o Ctrl + Enter para compilar con GCC...</span>
      </div>
    </div>
  </div>

  <script>
    (function () {
      var basePayload = ${safePayloadJson};
      var btnCompile = document.getElementById("btn-compile");
      var stdinInput = document.getElementById("stdin-val");
      var termStatus = document.getElementById("term-status");
      var termBody = document.getElementById("terminal-body");

      function sendLog(level, text) {
        try {
          parent.postMessage({
            source: "studio-ide-preview",
            level: level,
            text: text
          }, "*");
        } catch (_) {}
      }

      async function runCompile() {
        btnCompile.disabled = true;
        termStatus.className = "terminal-status is-running";
        termStatus.textContent = "Compilando con GCC en Wandbox...";
        termBody.innerHTML = '<span class="out-hint">[Compilando con GCC...]</span>\\n';
        sendLog("log", "[C/C++] Iniciando compilación en Wandbox...");

        var payload = Object.assign({}, basePayload, {
          stdin: stdinInput.value || ""
        });

        var t0 = performance.now();
        try {
          var res = await fetch("https://wandbox.org/api/compile.json", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

          if (!res.ok) {
            throw new Error("HTTP " + res.status + " " + res.statusText);
          }

          var data = await res.json();
          var ms = Math.round(performance.now() - t0);
          renderOutput(data, ms);
        } catch (err) {
          termStatus.className = "terminal-status is-err";
          termStatus.textContent = "Error de red / API";
          termBody.innerHTML = "";
          var errSpan = document.createElement("span");
          errSpan.className = "out-stderr";
          errSpan.textContent = "Error al conectar con la API de compilación: " + err.message;
          termBody.appendChild(errSpan);
          sendLog("error", "[C/C++] Error de conexión: " + err.message);
        } finally {
          btnCompile.disabled = false;
        }
      }

      function renderOutput(data, ms) {
        termBody.innerHTML = "";
        var statusCode = Number(data.status ?? (data.compiler_error || data.compiler_output ? 1 : 0));
        var isSuccess = statusCode === 0 && !data.compiler_error;

        termStatus.className = isSuccess ? "terminal-status is-ok" : "terminal-status is-err";
        termStatus.textContent = (isSuccess ? "Código de salida: 0 (Éxito)" : "Falló (código " + statusCode + ")") + " — " + ms + " ms";

        if (data.compiler_output || data.compiler_error) {
          var compDiv = document.createElement("div");
          compDiv.className = data.compiler_error ? "out-comp-err" : "out-comp-warn";
          compDiv.textContent = data.compiler_error || data.compiler_output;
          termBody.appendChild(compDiv);
        }

        if (data.program_output) {
          var outDiv = document.createElement("div");
          outDiv.className = "out-stdout";
          outDiv.textContent = data.program_output;
          termBody.appendChild(outDiv);
          sendLog("log", data.program_output.trim());
        }

        if (data.program_error) {
          var errDiv = document.createElement("div");
          errDiv.className = "out-stderr";
          errDiv.textContent = data.program_error;
          termBody.appendChild(errDiv);
          sendLog("error", data.program_error.trim());
        }

        if (!data.program_output && !data.program_error && !data.compiler_output && !data.compiler_error) {
          var emptyDiv = document.createElement("div");
          emptyDiv.className = "out-hint";
          emptyDiv.textContent = "(El programa terminó sin producir salida en stdout ni stderr).";
          termBody.appendChild(emptyDiv);
        }
      }

      btnCompile.addEventListener("click", runCompile);
      window.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          runCompile();
        }
      });

      // Compilar automáticamente al abrir la vista previa
      runCompile();
    })();
  </script>
</body>
</html>`;
}
