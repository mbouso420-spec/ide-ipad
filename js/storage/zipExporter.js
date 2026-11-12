/**
 * Exportador puro de proyectos a archivos .zip estándar (PKZIP 2.0).
 * 100% Offline, sin dependencias externas ni CDNs (cumple estrictamente con la CSP).
 * Utiliza compresión STORE (método 0) y cálculo de CRC-32 estándar vía Uint8Array y DataView.
 */

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

/**
 * Calcula el CRC-32 estándar de un arreglo de bytes.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function computeCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export const MAX_SAFE_ZIP_BYTES = 250 * 1024 * 1024; // 250 MB para prevenir picos OOM en el navegador

/**
 * Convierte un objeto Date en la representación de fecha y hora MS-DOS usada en PKZIP.
 * @param {Date} [date=new Date()]
 * @returns {{ dosDate: number, dosTime: number }}
 */
export function getDosDateTime(date = new Date()) {
  const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
  // El formato MS-DOS almacena (año - 1980) en 7 bits (0..127 -> 1980..2107).
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);

  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  return { dosDate, dosTime };
}

function sanitizeZipDownloadFilename(filename) {
  const clean = String(filename || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const base = clean || "proyecto.zip";
  return base.toLowerCase().endsWith(".zip") ? base : `${base}.zip`;
}

function buildZipParts(files, options = {}) {
  const encoder = new TextEncoder();
  const { dosDate, dosTime } = getDosDateTime(options.date || new Date());

  const MAX_ZIP_UINT16 = 0xffff;
  const MAX_ZIP_UINT32 = 0xffffffff;
  const entriesByPath = new Map();

  for (const file of files || []) {
    if (!file || file.isFolder || !file.path) continue;
    const rawPath = String(file.path).trim().replace(/\\/g, "/");
    if (/[\x00-\x1f\x7f]/.test(rawPath) || rawPath.includes(":")) {
      throw new Error(`Ruta ZIP inválida (caracteres no permitidos): ${file.path}`);
    }
    const cleanSegments = [];
    for (const seg of rawPath.replace(/^\/+/, "").split("/")) {
      const part = seg.trim();
      if (!part || part === ".") continue;
      if (part === "..") {
        throw new Error(`Ruta ZIP inválida (traversal '..' no permitido): ${file.path}`);
      }
      cleanSegments.push(part);
    }
    const cleanPath = cleanSegments.join("/");
    if (!cleanPath) continue;

    const nameBytes = encoder.encode(cleanPath);
    if (nameBytes.length > MAX_ZIP_UINT16) {
      throw new Error(`Ruta ZIP demasiado larga (> 65535 bytes): ${cleanPath}`);
    }

    let dataBytes;
    if (file.content instanceof Uint8Array) {
      dataBytes = file.content;
    } else if (typeof file.content === "string") {
      dataBytes = encoder.encode(file.content);
    } else {
      dataBytes = new Uint8Array(0);
    }
    if (dataBytes.length > MAX_ZIP_UINT32) {
      throw new Error(`Archivo demasiado grande para PKZIP (> 4 GB): ${cleanPath}`);
    }

    const crc = computeCrc32(dataBytes);
    const localSize = 30 + nameBytes.length + dataBytes.length;
    const centralSize = 46 + nameBytes.length;

    entriesByPath.set(cleanPath, {
      nameBytes,
      dataBytes,
      crc,
      localSize,
      centralSize
    });
  }

  const entries = Array.from(entriesByPath.values());
  if (entries.length > MAX_ZIP_UINT16) {
    throw new Error("El archivo ZIP supera el límite máximo de 65535 entradas.");
  }

  let totalLocalSize = 0;
  let totalCentralDirSize = 0;
  for (const entry of entries) {
    totalLocalSize += entry.localSize;
    totalCentralDirSize += entry.centralSize;
  }

  const eocdSize = 22;
  const totalBufferSize = totalLocalSize + totalCentralDirSize + eocdSize;
  if (totalBufferSize > MAX_SAFE_ZIP_BYTES) {
    throw new Error("El archivo ZIP supera el límite seguro de 250 MB en memoria.");
  }
  if (
    totalLocalSize > MAX_ZIP_UINT32 ||
    totalCentralDirSize > MAX_ZIP_UINT32 ||
    totalBufferSize > MAX_ZIP_UINT32
  ) {
    throw new Error("El archivo ZIP supera el límite máximo de 4 GB para formato PKZIP 2.0.");
  }

  const parts = [];
  let currentLocalOffset = 0;
  const localHeaderOffsets = [];

  // 1. Emitir Local File Headers + File Data como fragmentos independientes (evita doble copia contigua al generar Blob).
  for (const entry of entries) {
    localHeaderOffsets.push(currentLocalOffset);
    const localHeader = new Uint8Array(30);
    const view = new DataView(localHeader.buffer);

    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.dataBytes.length, true);
    view.setUint32(22, entry.dataBytes.length, true);
    view.setUint16(26, entry.nameBytes.length, true);
    view.setUint16(28, 0, true);

    parts.push(localHeader, entry.nameBytes);
    if (entry.dataBytes.length > 0) {
      parts.push(entry.dataBytes);
    }

    currentLocalOffset += entry.localSize;
  }

  // 2. Escribir Central Directory Headers + EOCD en un único buffer de metadatos.
  const centralDirStartOffset = currentLocalOffset;
  const tailBuffer = new Uint8Array(totalCentralDirSize + eocdSize);
  const tailView = new DataView(tailBuffer.buffer);
  let currentCentralOffset = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const localOffset = localHeaderOffsets[i];

    tailView.setUint32(currentCentralOffset + 0, 0x02014b50, true);
    tailView.setUint16(currentCentralOffset + 4, 0x0314, true);
    tailView.setUint16(currentCentralOffset + 6, 20, true);
    tailView.setUint16(currentCentralOffset + 8, 0x0800, true);
    tailView.setUint16(currentCentralOffset + 10, 0, true);
    tailView.setUint16(currentCentralOffset + 12, dosTime, true);
    tailView.setUint16(currentCentralOffset + 14, dosDate, true);
    tailView.setUint32(currentCentralOffset + 16, entry.crc, true);
    tailView.setUint32(currentCentralOffset + 20, entry.dataBytes.length, true);
    tailView.setUint32(currentCentralOffset + 24, entry.dataBytes.length, true);
    tailView.setUint16(currentCentralOffset + 28, entry.nameBytes.length, true);
    tailView.setUint16(currentCentralOffset + 30, 0, true);
    tailView.setUint16(currentCentralOffset + 32, 0, true);
    tailView.setUint16(currentCentralOffset + 34, 0, true);
    tailView.setUint16(currentCentralOffset + 36, 0, true);
    tailView.setUint32(currentCentralOffset + 38, 0x81a40000, true);
    tailView.setUint32(currentCentralOffset + 42, localOffset, true);

    tailBuffer.set(entry.nameBytes, currentCentralOffset + 46);
    currentCentralOffset += entry.centralSize;
  }

  // 3. Escribir End of Central Directory (EOCD)
  const eocdOffset = currentCentralOffset;
  tailView.setUint32(eocdOffset + 0, 0x06054b50, true);
  tailView.setUint16(eocdOffset + 4, 0, true);
  tailView.setUint16(eocdOffset + 6, 0, true);
  tailView.setUint16(eocdOffset + 8, entries.length, true);
  tailView.setUint16(eocdOffset + 10, entries.length, true);
  tailView.setUint32(eocdOffset + 12, totalCentralDirSize, true);
  tailView.setUint32(eocdOffset + 16, centralDirStartOffset, true);
  tailView.setUint16(eocdOffset + 20, 0, true);

  parts.push(tailBuffer);
  return { parts, totalBufferSize };
}

/**
 * Construye un Blob .zip ensamblado por partes para evitar la doble copia contigua en RAM.
 * @param {Array<{ path: string, content: string | Uint8Array, isFolder?: boolean }>} files
 * @param {{ date?: Date }} [options={}]
 * @returns {Blob}
 */
export function buildZipBlob(files, options = {}) {
  const { parts } = buildZipParts(files, options);
  return new Blob(parts, { type: "application/zip" });
}

/**
 * Construye un archivo .zip válido en memoria a partir de una lista de entradas de archivo.
 * @param {Array<{ path: string, content: string | Uint8Array, isFolder?: boolean }>} files
 * @param {{ date?: Date }} [options={}]
 * @returns {Uint8Array}
 */
export function buildZipArchive(files, options = {}) {
  const { parts, totalBufferSize } = buildZipParts(files, options);
  const buffer = new Uint8Array(totalBufferSize);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }
  return buffer;
}

/**
 * Dispara la descarga de un buffer o Blob ZIP como archivo descargable en el navegador.
 * @param {Uint8Array | Blob} zipBytesOrBlob
 * @param {string} [filename="proyecto.zip"]
 */
export function downloadZip(zipBytesOrBlob, filename = "proyecto.zip") {
  const blob =
    typeof Blob !== "undefined" && zipBytesOrBlob instanceof Blob
      ? zipBytesOrBlob
      : new Blob([zipBytesOrBlob], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeZipDownloadFilename(filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
