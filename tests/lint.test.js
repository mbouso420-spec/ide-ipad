import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ESLint } from "eslint";
import globals from "globals";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Guarda de regresión del BUG-23: una llamada a una función inexistente (ReferenceError)
// rompía el arranque completo de la app y ningún test unitario lo detectaba.
test("análisis estático: ningún identificador indefinido, variable sin usar ni error de sintaxis en js/, sw.js, scripts/ y tests/", async () => {
  const requiredRootAndModularFiles = [
    "index.html",
    "manifest.json",
    "sw.js",
    "scripts/take_real_screenshots.js",
    "js/app.js",
    "js/utils/encoding.js",
    "js/utils/dom.js",
    "js/utils/storage.js",
    "js/preview/jsTokenUtils.js",
    "js/editor/languageConfig.js",
    "js/editor/errorMarkersController.js",
    "js/editor/fallbackEditor.js",
    "js/workspace/autosaveManager.js",
    "js/workspace/tabManager.js",
    "js/workspace/githubLazySync.js",
    "js/workspace/broadcastSync.js",
    "js/ui/confirmDialog.js",
    "js/ui/statusBarController.js"
  ];
  for (const relPath of requiredRootAndModularFiles) {
    assert.ok(fs.existsSync(path.join(root, relPath)), `Falta archivo clave requerido: ${relPath}`);
  }

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
    "no-self-assign": "error",
    "no-eval": "error",
    "no-implied-eval": "error",
    "no-cond-assign": "error",
    "no-constant-condition": "error",
    "no-ex-assign": "error",
    "no-fallthrough": "error",
    "no-global-assign": "error",
    "no-useless-catch": "error"
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
          sourceType: "script",
          globals: { ...globals.serviceworker }
        },
        rules: sharedRules
      },
      {
        files: ["scripts/*.js"],
        languageOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
          globals: { ...globals.node }
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
  const lintedPaths = new Set(results.map((r) => path.relative(root, r.filePath).split(path.sep).join("/")));
  for (const modPath of requiredRootAndModularFiles.filter((p) => p.endsWith(".js"))) {
    assert.ok(lintedPaths.has(modPath), `El linter debe analizar el archivo modular ${modPath}`);
  }
  const problems = results.flatMap((r) =>
    r.messages.map((m) => `${path.relative(root, r.filePath)}:${m.line}:${m.column} ${m.ruleId || "parse"} ${m.message}`)
  );
  assert.ok(results.length >= 80, `se esperaban ≥80 archivos analizados, hubo ${results.length}`);
  assert.deepEqual(problems, []);
});
