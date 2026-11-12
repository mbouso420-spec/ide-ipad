import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ESLint } from "eslint";
import globals from "globals";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Guarda de regresión del BUG-23: una llamada a una función inexistente (ReferenceError)
// rompía el arranque completo de la app y ningún test unitario lo detectaba.
test("análisis estático: ningún identificador indefinido, variable sin usar ni error de sintaxis en js/, sw.js y tests/", async () => {
  const sharedRules = {
    "no-undef": "error",
    "no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_"
      }
    ],
    "no-unreachable": "error",
    "no-dupe-keys": "error",
    "no-redeclare": "error",
    "no-const-assign": "error",
    "no-import-assign": "error",
    "no-func-assign": "error",
    "use-isnan": "error",
    "valid-typeof": "error",
    "no-unsafe-finally": "error",
    "no-dupe-else-if": "error",
    "no-self-assign": "error"
  };

  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["js/**/*.js"],
        languageOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
          globals: { ...globals.browser }
        },
        rules: sharedRules
      },
      {
        files: ["sw.js"],
        languageOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
          globals: { ...globals.serviceworker }
        },
        rules: sharedRules
      },
      {
        files: ["scripts/*.js"],
        languageOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
          globals: { ...globals.node, ...globals.browser }
        },
        rules: sharedRules
      },
      {
        files: ["tests/*.js", "tests/*.mjs"],
        languageOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
          globals: { ...globals.node, ...globals.browser }
        },
        rules: sharedRules
      }
    ]
  });
  const results = await eslint.lintFiles(["js/**/*.js", "sw.js", "scripts/*.js", "tests/*.js", "tests/*.mjs"]);
  const problems = results.flatMap((r) =>
    r.messages.map((m) => `${path.relative(root, r.filePath)}:${m.line}:${m.column} ${m.ruleId || "parse"} ${m.message}`)
  );
  assert.ok(results.length >= 60, `se esperaban ≥60 archivos analizados, hubo ${results.length}`);
  assert.deepEqual(problems, []);
});
