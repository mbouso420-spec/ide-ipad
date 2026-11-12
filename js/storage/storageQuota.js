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
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
  if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.estimate === "function") {
    try {
      const estimate = await navigator.storage.estimate();
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
        percentage: quota > 0 ? Math.round((usage / quota) * 100) : 0
      };
    } catch {
      // Entornos donde estimate() esté restringido por permisos de iframe/sandbox
    }
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
