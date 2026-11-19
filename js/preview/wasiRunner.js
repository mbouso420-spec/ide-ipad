/**
 * Runtime minimalista y puro WASI (`wasi_snapshot_preview1`) sin dependencias externas.
 * Ejecuta binarios `.wasm` compilados con LLVM/Clang (`wasm32-wasi`) dentro del navegador
 * o Web Worker, soportando entrada estándar (`stdin`), `stdout`, `stderr` y `proc_exit`.
 */

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_FAULT = 21;
const ERRNO_INVAL = 28;
const ERRNO_NOSYS = 52;
const ERRNO_SPIPE = 70;

const MAX_IOVS = 4096;
const FILETYPE_CHARACTER_DEVICE = 2;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

export class WasiExitError extends Error {
  /**
   * @param {number} code
   */
  constructor(code) {
    super(`WASI proc_exit(${code})`);
    this.name = "WasiExitError";
    this.code = Number.isFinite(code) ? code : 1;
  }
}

/**
 * Ejecuta un módulo WebAssembly WASI preview1.
 * @param {Uint8Array | ArrayBuffer | WebAssembly.Module} wasmInput
 * @param {{
 *   stdin?: string | Uint8Array,
 *   args?: string[],
 *   env?: Record<string, string>,
 *   maxOutputBytes?: number
 * }} [options]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, truncated: boolean }>}
 */
export async function runWasiModule(wasmInput, {
  stdin = "",
  args = ["program.wasm"],
  env = {},
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
} = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const stdinBytes = stdin instanceof Uint8Array
    ? stdin
    : encoder.encode(String(stdin || ""));
  let stdinOffset = 0;

  const argBytesList = (Array.isArray(args) && args.length > 0 ? args : ["program.wasm"])
    .map((a) => encoder.encode(`${String(a).replace(/\0/g, "")}\0`));
  const envBytesList = Object.entries(env || {})
    .map(([k, v]) => encoder.encode(`${String(k).replace(/[\0=]/g, "")}=${String(v ?? "").replace(/\0/g, "")}\0`));

  const stdoutChunks = [];
  const stderrChunks = [];
  let totalOutputBytes = 0;
  let truncated = false;
  let truncatedChannel = null;
  let memory = null;
  let cachedBuffer = null;
  let cachedBytes = null;
  let cachedView = null;

  const getMemoryView = () => {
    if (!memory) {
      throw new Error("El módulo WASM no exportó memoria lineal.");
    }
    if (memory.buffer !== cachedBuffer) {
      cachedBuffer = memory.buffer;
      cachedBytes = new Uint8Array(cachedBuffer);
      cachedView = new DataView(cachedBuffer);
    }
    return {
      bytes: cachedBytes,
      view: cachedView
    };
  };

  const inBounds = (byteLen, rawPtr, rawLen) => {
    const ptr = rawPtr >>> 0;
    const len = rawLen >>> 0;
    return ptr <= byteLen && len <= byteLen - ptr;
  };

  const pushOutput = (targetChunks, chunkCopy, channel) => {
    if (truncated) return;
    if (totalOutputBytes + chunkCopy.byteLength > maxOutputBytes) {
      const remaining = Math.max(0, maxOutputBytes - totalOutputBytes);
      if (remaining > 0) {
        targetChunks.push(chunkCopy.slice(0, remaining));
        totalOutputBytes += remaining;
      }
      truncated = true;
      truncatedChannel = channel;
      return;
    }
    targetChunks.push(chunkCopy);
    totalOutputBytes += chunkCopy.byteLength;
  };

  const wasiSnapshotPreview1 = {
    args_sizes_get(argcPtr, argvBufSizePtr) {
      const { view, bytes } = getMemoryView();
      if (!inBounds(bytes.byteLength, argcPtr, 4) || !inBounds(bytes.byteLength, argvBufSizePtr, 4)) {
        return ERRNO_FAULT;
      }
      const totalBytes = argBytesList.reduce((acc, b) => acc + b.byteLength, 0);
      view.setUint32(argcPtr >>> 0, argBytesList.length, true);
      view.setUint32(argvBufSizePtr >>> 0, totalBytes, true);
      return ERRNO_SUCCESS;
    },

    args_get(argvPtr, argvBufPtr) {
      const { view, bytes } = getMemoryView();
      const totalBufBytes = argBytesList.reduce((acc, b) => acc + b.byteLength, 0);
      if (
        !inBounds(bytes.byteLength, argvPtr, argBytesList.length * 4) ||
        !inBounds(bytes.byteLength, argvBufPtr, totalBufBytes)
      ) {
        return ERRNO_FAULT;
      }
      const ptrBase = argvPtr >>> 0;
      let bufCursor = argvBufPtr >>> 0;
      for (let i = 0; i < argBytesList.length; i += 1) {
        view.setUint32(ptrBase + i * 4, bufCursor, true);
        bytes.set(argBytesList[i], bufCursor);
        bufCursor += argBytesList[i].byteLength;
      }
      return ERRNO_SUCCESS;
    },

    environ_sizes_get(countPtr, bufSizePtr) {
      const { view, bytes } = getMemoryView();
      if (!inBounds(bytes.byteLength, countPtr, 4) || !inBounds(bytes.byteLength, bufSizePtr, 4)) {
        return ERRNO_FAULT;
      }
      const totalBytes = envBytesList.reduce((acc, b) => acc + b.byteLength, 0);
      view.setUint32(countPtr >>> 0, envBytesList.length, true);
      view.setUint32(bufSizePtr >>> 0, totalBytes, true);
      return ERRNO_SUCCESS;
    },

    environ_get(environPtr, environBufPtr) {
      const { view, bytes } = getMemoryView();
      const totalBufBytes = envBytesList.reduce((acc, b) => acc + b.byteLength, 0);
      if (
        !inBounds(bytes.byteLength, environPtr, envBytesList.length * 4) ||
        !inBounds(bytes.byteLength, environBufPtr, totalBufBytes)
      ) {
        return ERRNO_FAULT;
      }
      const ptrBase = environPtr >>> 0;
      let bufCursor = environBufPtr >>> 0;
      for (let i = 0; i < envBytesList.length; i += 1) {
        view.setUint32(ptrBase + i * 4, bufCursor, true);
        bytes.set(envBytesList[i], bufCursor);
        bufCursor += envBytesList[i].byteLength;
      }
      return ERRNO_SUCCESS;
    },

    clock_res_get(_id, resPtr) {
      const { view, bytes } = getMemoryView();
      if (!inBounds(bytes.byteLength, resPtr, 8)) return ERRNO_FAULT;
      view.setBigUint64(resPtr >>> 0, 1_000_000n, true);
      return ERRNO_SUCCESS;
    },

    clock_time_get(id, _precision, timePtr) {
      const clockId = id >>> 0;
      if (clockId !== 0 && clockId !== 1) return ERRNO_INVAL;
      const { view, bytes } = getMemoryView();
      if (!inBounds(bytes.byteLength, timePtr, 8)) return ERRNO_FAULT;
      let ns = BigInt(Date.now()) * 1_000_000n;
      if (clockId === 1 && typeof performance !== "undefined" && typeof performance.now === "function") {
        const ms = performance.now();
        const wholeMs = Math.floor(ms);
        const fracNs = Math.round((ms - wholeMs) * 1_000_000);
        ns = BigInt(wholeMs) * 1_000_000n + BigInt(fracNs);
      }
      view.setBigUint64(timePtr >>> 0, ns, true);
      return ERRNO_SUCCESS;
    },

    fd_close(rawFd) {
      const fd = rawFd | 0;
      return fd >= 0 && fd <= 2 ? ERRNO_SUCCESS : ERRNO_BADF;
    },

    fd_fdstat_get(rawFd, bufPtr) {
      const fd = rawFd | 0;
      if (fd < 0 || fd > 2) return ERRNO_BADF;
      const { view, bytes } = getMemoryView();
      if (!inBounds(bytes.byteLength, bufPtr, 24)) return ERRNO_FAULT;
      const ptr = bufPtr >>> 0;
      view.setUint8(ptr, FILETYPE_CHARACTER_DEVICE);
      view.setUint16(ptr + 2, 0, true);
      view.setBigUint64(ptr + 8, 0xffffffffffffffffn, true);
      view.setBigUint64(ptr + 16, 0xffffffffffffffffn, true);
      return ERRNO_SUCCESS;
    },

    fd_fdstat_set_flags(rawFd) {
      const fd = rawFd | 0;
      return fd >= 0 && fd <= 2 ? ERRNO_SUCCESS : ERRNO_BADF;
    },

    fd_prestat_get() {
      return ERRNO_BADF;
    },

    fd_prestat_dir_name() {
      return ERRNO_BADF;
    },

    fd_read(rawFd, rawIovsPtr, rawIovsLen, rawNreadPtr) {
      const fd = rawFd | 0;
      if (fd !== 0) return ERRNO_BADF;
      const iovsPtr = rawIovsPtr >>> 0;
      const iovsLen = rawIovsLen >>> 0;
      const nreadPtr = rawNreadPtr >>> 0;
      if (iovsLen > MAX_IOVS) return ERRNO_INVAL;
      const { view, bytes } = getMemoryView();
      if (!inBounds(bytes.byteLength, iovsPtr, iovsLen * 8) || !inBounds(bytes.byteLength, nreadPtr, 4)) {
        return ERRNO_FAULT;
      }
      // Pre-validar todos los iovecs atómicamente antes de mutar memoria o stdinOffset
      for (let i = 0; i < iovsLen; i += 1) {
        const ptr = view.getUint32(iovsPtr + i * 8, true);
        const len = view.getUint32(iovsPtr + i * 8 + 4, true);
        if (!inBounds(bytes.byteLength, ptr, len)) return ERRNO_FAULT;
      }
      let totalRead = 0;
      for (let i = 0; i < iovsLen; i += 1) {
        const ptr = view.getUint32(iovsPtr + i * 8, true);
        const len = view.getUint32(iovsPtr + i * 8 + 4, true);
        if (len === 0) continue;
        const available = stdinBytes.byteLength - stdinOffset;
        if (available <= 0) break;
        const toCopy = Math.min(len, available);
        bytes.set(stdinBytes.subarray(stdinOffset, stdinOffset + toCopy), ptr);
        stdinOffset += toCopy;
        totalRead += toCopy;
        if (toCopy < len) break;
      }
      view.setUint32(nreadPtr, totalRead, true);
      return ERRNO_SUCCESS;
    },

    fd_seek(rawFd) {
      const fd = rawFd | 0;
      if (fd < 0 || fd > 2) return ERRNO_BADF;
      return ERRNO_SPIPE;
    },

    fd_tell(rawFd) {
      const fd = rawFd | 0;
      return fd >= 0 && fd <= 2 ? ERRNO_SPIPE : ERRNO_BADF;
    },

    fd_sync(rawFd) {
      const fd = rawFd | 0;
      return fd >= 0 && fd <= 2 ? ERRNO_SUCCESS : ERRNO_BADF;
    },

    fd_datasync(rawFd) {
      const fd = rawFd | 0;
      return fd >= 0 && fd <= 2 ? ERRNO_SUCCESS : ERRNO_BADF;
    },

    fd_write(rawFd, rawIovsPtr, rawIovsLen, rawNwrittenPtr) {
      const fd = rawFd | 0;
      if (fd !== 1 && fd !== 2) return ERRNO_BADF;
      const iovsPtr = rawIovsPtr >>> 0;
      const iovsLen = rawIovsLen >>> 0;
      const nwrittenPtr = rawNwrittenPtr >>> 0;
      if (iovsLen > MAX_IOVS) return ERRNO_INVAL;
      const { view, bytes } = getMemoryView();
      if (!inBounds(bytes.byteLength, iovsPtr, iovsLen * 8) || !inBounds(bytes.byteLength, nwrittenPtr, 4)) {
        return ERRNO_FAULT;
      }
      // Pre-validar todos los iovecs atómicamente antes de escribir chunks
      for (let i = 0; i < iovsLen; i += 1) {
        const ptr = view.getUint32(iovsPtr + i * 8, true);
        const len = view.getUint32(iovsPtr + i * 8 + 4, true);
        if (!inBounds(bytes.byteLength, ptr, len)) return ERRNO_FAULT;
      }
      let written = 0;
      const channel = fd === 1 ? "stdout" : "stderr";
      const target = fd === 1 ? stdoutChunks : stderrChunks;
      for (let i = 0; i < iovsLen; i += 1) {
        const ptr = view.getUint32(iovsPtr + i * 8, true);
        const len = view.getUint32(iovsPtr + i * 8 + 4, true);
        if (len > 0) {
          if (!truncated) {
            const remaining = Math.max(0, maxOutputBytes - totalOutputBytes);
            const sliceLen = Math.min(len, remaining + 1);
            pushOutput(target, bytes.slice(ptr, ptr + sliceLen), channel);
          }
          written += len;
        }
      }
      view.setUint32(nwrittenPtr, written >>> 0, true);
      return ERRNO_SUCCESS;
    },

    fd_advise(rawFd) {
      const fd = rawFd | 0;
      return fd >= 0 && fd <= 2 ? ERRNO_SUCCESS : ERRNO_BADF;
    },
    fd_allocate: () => ERRNO_NOSYS,
    fd_filestat_get: () => ERRNO_BADF,
    fd_filestat_set_size: () => ERRNO_BADF,
    fd_filestat_set_times: () => ERRNO_BADF,
    fd_pread: () => ERRNO_SPIPE,
    fd_pwrite: () => ERRNO_SPIPE,
    fd_readdir: () => ERRNO_BADF,
    fd_renumber: () => ERRNO_BADF,
    path_create_directory: () => ERRNO_NOSYS,
    path_filestat_get: () => ERRNO_NOSYS,
    path_filestat_set_times: () => ERRNO_NOSYS,
    path_link: () => ERRNO_NOSYS,
    path_open: () => ERRNO_NOSYS,
    path_readlink: () => ERRNO_NOSYS,
    path_remove_directory: () => ERRNO_NOSYS,
    path_rename: () => ERRNO_NOSYS,
    path_symlink: () => ERRNO_NOSYS,
    path_unlink_file: () => ERRNO_NOSYS,

    poll_oneoff(rawInPtr, rawOutPtr, rawNsubs, neventsPtr) {
      const nsubscriptions = rawNsubs | 0;
      if (nsubscriptions < 0 || nsubscriptions > MAX_IOVS) return ERRNO_INVAL;
      const { view, bytes } = getMemoryView();
      const inPtr = rawInPtr >>> 0;
      const outPtr = rawOutPtr >>> 0;
      if (
        !inBounds(bytes.byteLength, neventsPtr, 4) ||
        (nsubscriptions > 0 && (
          !inBounds(bytes.byteLength, inPtr, nsubscriptions * 48) ||
          !inBounds(bytes.byteLength, outPtr, nsubscriptions * 32)
        ))
      ) {
        return ERRNO_FAULT;
      }
      if (nsubscriptions > 0) {
        bytes.fill(0, outPtr, outPtr + 32);
      }
      view.setUint32(neventsPtr >>> 0, nsubscriptions > 0 ? 1 : 0, true);
      return ERRNO_SUCCESS;
    },

    proc_exit(code) {
      throw new WasiExitError(Number(code) >>> 0);
    },

    random_get(rawBufPtr, rawBufLen) {
      const { bytes } = getMemoryView();
      const bufPtr = rawBufPtr >>> 0;
      const bufLen = rawBufLen >>> 0;
      if (!inBounds(bytes.byteLength, bufPtr, bufLen)) return ERRNO_FAULT;
      const webCrypto = globalThis.crypto;
      if (!webCrypto || typeof webCrypto.getRandomValues !== "function") {
        return ERRNO_NOSYS;
      }
      const slice = bytes.subarray(bufPtr, bufPtr + bufLen);
      // getRandomValues tiene límite de 65536 bytes por llamada en la spec WebCrypto
      for (let offset = 0; offset < slice.length; offset += 65536) {
        webCrypto.getRandomValues(slice.subarray(offset, Math.min(slice.length, offset + 65536)));
      }
      return ERRNO_SUCCESS;
    },

    sched_yield() {
      return ERRNO_SUCCESS;
    }
  };

  const module = wasmInput instanceof WebAssembly.Module
    ? wasmInput
    : await WebAssembly.compile(wasmInput);

  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasiSnapshotPreview1
  });

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("El módulo WASM no exportó una instancia válida de WebAssembly.Memory.");
  }
  memory = instance.exports.memory;

  let exitCode = 0;
  try {
    try {
      if (typeof instance.exports._start === "function") {
        instance.exports._start();
      } else if (typeof instance.exports.main === "function") {
        exitCode = Number(instance.exports.main(0, 0) || 0);
      } else {
        throw new Error("El binario WASI no expone función '_start' ni 'main'.");
      }
    } catch (err) {
      if (err instanceof WasiExitError) {
        exitCode = err.code;
      } else {
        throw err;
      }
    }

    const concatChunks = (chunks) => {
      const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
      const out = new Uint8Array(total);
      let pos = 0;
      for (const c of chunks) {
        out.set(c, pos);
        pos += c.byteLength;
      }
      return decoder.decode(out);
    };

    let stdoutText = concatChunks(stdoutChunks);
    let stderrText = concatChunks(stderrChunks);
    if (truncated) {
      const limitKb = Math.max(1, Math.round(maxOutputBytes / 1024));
      const truncMsg = `\n...[salida truncada a ${limitKb} KB]`;
      if (truncatedChannel === "stderr") {
        stderrText += truncMsg;
      } else {
        stdoutText += truncMsg;
      }
    }

    return {
      exitCode,
      stdout: stdoutText,
      stderr: stderrText,
      truncated
    };
  } finally {
    memory = null;
    cachedBuffer = null;
    cachedBytes = null;
    cachedView = null;
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
  }
}
