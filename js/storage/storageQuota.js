/**
 * Consulta de almacenamiento persistente y estimación de cuota en el navegador
 * mediante navigator.storage.estimate(), con fallback resiliente.
 */

/**
 * Formatea un tamaño en bytes a una representación legible (B, KB, MB, GB).
 * @param {number} bytes
 * @returns {string}
 */
export function formatStorageBytes(bytes) {
  const num = Number(bytes);
  const n = Number.isFinite(num) ? Math.max(0, num) : 0;
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 1023.95) return `${kb.toFixed(1)} KB`;
  const mb = n / (1024 * 1024);
  if (mb < 1023.95) return `${mb.toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Consulta de forma segura la cuota y uso actual de almacenamiento en el origen.
 * @returns {Promise<{
 *   supported: boolean,
 *   usageBytes: number,
 *   quotaBytes: number,
 *   usageFormatted: string,
 *   quotaFormatted: string,
 *   percentage: number
 * }>}
 */
export async function getStorageQuotaEstimate() {
  try {
    const storageApi = typeof navigator !== "undefined" ? navigator.storage : null;
    if (storageApi && typeof storageApi.estimate === "function") {
      const estimate = await storageApi.estimate();
      const rawUsage = Number(estimate?.usage);
      const rawQuota = Number(estimate?.quota);
      const usage = Number.isFinite(rawUsage) ? Math.max(0, rawUsage) : 0;
      const quota = Number.isFinite(rawQuota) ? Math.max(0, rawQuota) : 0;
      return {
        supported: true,
        usageBytes: usage,
        quotaBytes: quota,
        usageFormatted: formatStorageBytes(usage),
        quotaFormatted: formatStorageBytes(quota),
        percentage: quota > 0 ? Math.min(100, Math.round((usage / quota) * 100)) : 0
      };
    }
  } catch {
    // Entornos donde navigator.storage o estimate() estén restringidos por permisos de iframe/sandbox
  }

  return {
    supported: false,
    usageBytes: 0,
    quotaBytes: 0,
    usageFormatted: "—",
    quotaFormatted: "—",
    percentage: 0
  };
}
