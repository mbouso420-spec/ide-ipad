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

/**
 * Convierte un objeto Date en la representación de fecha y hora MS-DOS usada en PKZIP.
 * @param {Date} [date=new Date()]
 * @returns {{ dosDate: number, dosTime: number }}
 */
export function getDosDateTime(date = new Date()) {
  const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);

  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  return { dosDate, dosTime };
}

/**
 * Construye un archivo .zip válido en memoria a partir de una lista de entradas de archivo.
 * @param {Array<{ path: string, content: string | Uint8Array }>} files
 * @param {{ date?: Date }} [options={}]
 * @returns {Uint8Array}
 */
export function buildZipArchive(files, options = {}) {
  const encoder = new TextEncoder();
  const { dosDate, dosTime } = getDosDateTime(options.date || new Date());

  // Preparar metadatos y convertir contenidos a Uint8Array evitando rutas duplicadas
  const MAX_ZIP_UINT16 = 0xffff;
  const MAX_ZIP_UINT32 = 0xffffffff;
  const entriesByPath = new Map();

  for (const file of files) {
    if (!file || !file.path) continue;
    const rawPath = String(file.path).trim().replace(/\\/g, "/");
    if (/[\x00-\x1f\x7f]/.test(rawPath)) {
      throw new Error(`Ruta ZIP inválida (caracteres de control no permitidos): ${file.path}`);
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
  if (
    totalLocalSize > MAX_ZIP_UINT32 ||
    totalCentralDirSize > MAX_ZIP_UINT32 ||
    totalBufferSize > MAX_ZIP_UINT32
  ) {
    throw new Error("El archivo ZIP supera el límite máximo de 4 GB para formato PKZIP 2.0.");
  }

  const buffer = new Uint8Array(totalBufferSize);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  let currentLocalOffset = 0;
  const localHeaderOffsets = [];

  // 1. Escribir Local File Headers + File Data
  for (const entry of entries) {
    localHeaderOffsets.push(currentLocalOffset);

    // Firma Local Header: 0x04034b50
    view.setUint32(currentLocalOffset + 0, 0x04034b50, true);
    // Versión necesaria para extraer: 20 (2.0)
    view.setUint16(currentLocalOffset + 4, 20, true);
    // Flags: 0x0800 (bit 11 indica nombre codificado en UTF-8)
    view.setUint16(currentLocalOffset + 6, 0x0800, true);
    // Método de compresión: 0 (STORE)
    view.setUint16(currentLocalOffset + 8, 0, true);
    // Hora y fecha MS-DOS
    view.setUint16(currentLocalOffset + 10, dosTime, true);
    view.setUint16(currentLocalOffset + 12, dosDate, true);
    // CRC-32
    view.setUint32(currentLocalOffset + 14, entry.crc, true);
    // Tamaño comprimido y sin comprimir (iguales en STORE)
    view.setUint32(currentLocalOffset + 18, entry.dataBytes.length, true);
    view.setUint32(currentLocalOffset + 22, entry.dataBytes.length, true);
    // Longitud del nombre del archivo
    view.setUint16(currentLocalOffset + 26, entry.nameBytes.length, true);
    // Longitud de campos extra: 0
    view.setUint16(currentLocalOffset + 28, 0, true);

    // Escribir nombre de archivo
    buffer.set(entry.nameBytes, currentLocalOffset + 30);
    // Escribir datos
    buffer.set(entry.dataBytes, currentLocalOffset + 30 + entry.nameBytes.length);

    currentLocalOffset += entry.localSize;
  }

  // 2. Escribir Central Directory Headers
  const centralDirStartOffset = currentLocalOffset;
  let currentCentralOffset = centralDirStartOffset;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const localOffset = localHeaderOffsets[i];

    // Firma Central Directory Header: 0x02014b50
    view.setUint32(currentCentralOffset + 0, 0x02014b50, true);
    // Versión creada por: 0x0314 (UNIX = 3, PKZIP 2.0 = 20) alineada con atributos externos POSIX
    view.setUint16(currentCentralOffset + 4, 0x0314, true);
    // Versión necesaria para extraer: 20
    view.setUint16(currentCentralOffset + 6, 20, true);
    // Flags: 0x0800 (UTF-8)
    view.setUint16(currentCentralOffset + 8, 0x0800, true);
    // Método de compresión: 0 (STORE)
    view.setUint16(currentCentralOffset + 10, 0, true);
    // Hora y fecha MS-DOS
    view.setUint16(currentCentralOffset + 12, dosTime, true);
    view.setUint16(currentCentralOffset + 14, dosDate, true);
    // CRC-32
    view.setUint32(currentCentralOffset + 16, entry.crc, true);
    // Tamaño comprimido y sin comprimir
    view.setUint32(currentCentralOffset + 20, entry.dataBytes.length, true);
    view.setUint32(currentCentralOffset + 24, entry.dataBytes.length, true);
    // Longitud del nombre
    view.setUint16(currentCentralOffset + 28, entry.nameBytes.length, true);
    // Longitud extra: 0
    view.setUint16(currentCentralOffset + 30, 0, true);
    // Longitud comentario: 0
    view.setUint16(currentCentralOffset + 32, 0, true);
    // Número de disco de inicio: 0
    view.setUint16(currentCentralOffset + 34, 0, true);
    // Atributos internos: 0
    view.setUint16(currentCentralOffset + 36, 0, true);
    // Atributos externos: 0644 (archivo regular estándar en POSIX)
    view.setUint32(currentCentralOffset + 38, 0x81a40000, true);
    // Offset relativo del Local Header
    view.setUint32(currentCentralOffset + 42, localOffset, true);

    // Escribir nombre del archivo
    buffer.set(entry.nameBytes, currentCentralOffset + 46);

    currentCentralOffset += entry.centralSize;
  }

  // 3. Escribir End of Central Directory (EOCD)
  const eocdOffset = currentCentralOffset;
  // Firma EOCD: 0x06054b50
  view.setUint32(eocdOffset + 0, 0x06054b50, true);
  // Número de disco: 0
  view.setUint16(eocdOffset + 4, 0, true);
  // Disco donde inicia Central Directory: 0
  view.setUint16(eocdOffset + 6, 0, true);
  // Total de entradas en este disco
  view.setUint16(eocdOffset + 8, entries.length, true);
  // Total de entradas en el Central Directory
  view.setUint16(eocdOffset + 10, entries.length, true);
  // Tamaño del Central Directory
  view.setUint32(eocdOffset + 12, totalCentralDirSize, true);
  // Offset donde inicia el Central Directory
  view.setUint32(eocdOffset + 16, centralDirStartOffset, true);
  // Longitud comentario: 0
  view.setUint16(eocdOffset + 20, 0, true);

  return buffer;
}

/**
 * Dispara la descarga de un buffer ZIP como archivo descargable en el navegador.
 * @param {Uint8Array} zipBytes
 * @param {string} [filename="proyecto.zip"]
 */
export function downloadZip(zipBytes, filename = "proyecto.zip") {
  const blob = new Blob([zipBytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".zip") ? filename : `${filename}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
