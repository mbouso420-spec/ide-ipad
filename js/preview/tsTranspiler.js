/**
 * Transpilador ligero 100% offline de TypeScript y JSX a JavaScript ejecutable en navegador.
 * Usa un tokenizador léxico para evitar dañar literales de texto, template strings,
 * expresiones regulares, comentarios u objetos literales.
 */

import { tokenize, tokenizeJsWithOffsets } from "./ts/tsTokenizer.js";
import { JSX_RUNTIME_HELPER, expandJsxInSource } from "./ts/jsxExpander.js";
import { stripTypeScriptFromTokens } from "./ts/typeStripper.js";

const SIMPLE_JS_EXPR_RE = /^[A-Za-z0-9_$.\s()[\],'"`+\-*/%&|^~?]+$/;

function transpileCore(source, jsx, fileName) {
  let working = String(source ?? "");
  let usedJsx = false;
  if (jsx) {
    const jsxRes = expandJsxInSource(working, fileName, (expr, fn) => transpileCore(expr, false, fn));
    working = jsxRes.code;
    usedJsx = jsxRes.usedJsx;
  } else if (SIMPLE_JS_EXPR_RE.test(working) && !/\b(?:as|satisfies)\b/.test(working)) {
    return { code: working, usedJsx: false };
  }
  const tokens = tokenize(working);
  const stripped = stripTypeScriptFromTokens(tokens);
  return { code: stripped, usedJsx };
}

/**
 * Transpila código fuente TypeScript y/o JSX a JavaScript estándar ejecutable
 * directamente por navegadores modernos sin servidor ni bundler externo.
 *
 * @param {string} source
 * @param {{ jsx?: boolean, fileName?: string }} [options]
 * @returns {{ code: string, usedJsx: boolean }}
 */
export function transpileTypeScriptAndJsx(source, options = {}) {
  const fileName = String(options.fileName || "app.ts");
  const enableJsx =
    options.jsx !== undefined
      ? Boolean(options.jsx)
      : /\.(tsx|jsx)$/i.test(fileName);

  const result = transpileCore(source, enableJsx, fileName);
  const finalCode = result.usedJsx ? `${JSX_RUNTIME_HELPER}${result.code}` : result.code;
  return {
    code: finalCode,
    usedJsx: result.usedJsx
  };
}

export { tokenizeJsWithOffsets };
