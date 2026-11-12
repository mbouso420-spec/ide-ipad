/**
 * Configuración pura de lenguajes del editor sin dependencias del DOM.
 * Permite compartir reglas entre el editor y el formateador sin acoplar módulos.
 */

const FOUR_SPACE_LANGUAGES = new Set([
  "python",
  "cpp",
  "c",
  "sql",
  "rust",
  "go",
  "java",
  "csharp"
]);

/**
 * Devuelve la cantidad de espacios de indentación inteligente según el lenguaje:
 * 4 espacios para Python, C, C++, SQL, Rust, Go, Java y C#; 2 espacios para HTML, CSS, JS, TS y otros.
 * @param {string} lang
 * @returns {number}
 */
export function getIndentSize(lang) {
  return FOUR_SPACE_LANGUAGES.has(lang) ? 4 : 2;
}
