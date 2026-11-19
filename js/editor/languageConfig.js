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

const LANGUAGE_ALIASES = {
  javascript: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  typescript: "ts",
  py: "python",
  "c++": "cpp",
  cxx: "cpp",
  cc: "cpp",
  h: "c",
  hpp: "cpp",
  "c#": "csharp",
  cs: "csharp",
  rs: "rust",
  golang: "go",
  md: "markdown",
  htm: "html",
  scss: "css",
  sqlite: "sql",
  txt: "text"
};

/**
 * Normaliza identificadores y alias frecuentes de lenguaje (`javascript`, `py`, `c++`, `cs`, etc.)
 * a las claves canónicas usadas por el editor y el formateador.
 * @param {string} lang
 * @returns {string}
 */
export function normalizeLanguageId(lang) {
  const key = String(lang || "").trim().toLowerCase();
  return LANGUAGE_ALIASES[key] || key || "text";
}

/**
 * Devuelve la cantidad de espacios de indentación inteligente según el lenguaje:
 * 4 espacios para Python, C, C++, SQL, Rust, Go, Java y C#; 2 espacios para HTML, CSS, JS, TS y otros.
 * @param {string} lang
 * @returns {number}
 */
export function getIndentSize(lang) {
  return FOUR_SPACE_LANGUAGES.has(normalizeLanguageId(lang)) ? 4 : 2;
}
