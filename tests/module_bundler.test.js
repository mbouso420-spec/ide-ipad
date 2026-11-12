import "./setup.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import {
  buildExactModuleMap,
  buildVirtualModuleBundle,
  extractModuleDependencyPaths,
  formatVirtualModuleExecution,
  hasLocalModuleDependencies
} from "../js/preview/moduleBundler.js";
import {
  buildStandaloneJsPreview,
  buildStandaloneTsPreview,
  bundleHtmlWithFolderAssets
} from "../js/preview/htmlBundler.js";
import { buildLoopGuardRuntime, instrumentLoops } from "../js/preview/loopGuard.js";

const require = createRequire(import.meta.url);
const acorn = require("acorn");

function createMockDomEnv() {
  const elementsById = new Map();
  class MockNode {}
  const makeNode = (tag) => {
    const n = new MockNode();
    n.tagName = String(tag || "div").toUpperCase();
    n.className = "";
    n.attributes = {};
    n.children = [];
    n.textContent = "";
    n.innerHTML = "";
    n.style = {};
    n.setAttribute = (k, v) => {
      n.attributes[k] = String(v);
    };
    n.getAttribute = (k) => n.attributes[k] ?? null;
    n.appendChild = (child) => {
      n.children.push(child);
      return child;
    };
    return n;
  };
  const head = makeNode("head");
  const doc = {
    head,
    documentElement: head,
    createElement: (tag) => makeNode(tag),
    createTextNode: (text) => {
      const t = new MockNode();
      t.nodeType = 3;
      t.textContent = String(text);
      return t;
    },
    getElementById: (id) => elementsById.get(id) || null
  };
  return { MockNode, head, appendedToHead: head.children, elementsById, doc };
}

describe("Module Bundler Offline (ES Modules + TS/TSX + CSS + JSON)", () => {
  test("resuelve grafo multi-archivo TS/TSX/JS/CSS/JSON con named, default, alias, namespace y ../)", () => {
    const files = [
      {
        path: "src/types.ts",
        content: `
          export interface ItemConfig {
            title: string;
            count: number;
          }
          export type Mode = "prod" | "dev";
        `
      },
      {
        path: "src/utils/math.ts",
        content: `
          import type { Mode } from "../types";
          export const FACTOR: number = 10;
          export function sum(a: number, b: number): number {
            return (a + b) * FACTOR;
          }
          export function unused(mode: Mode): string {
            return mode;
          }
          export default function labelDefault(tag: string): string {
            return "[" + tag + "]";
          }
        `
      },
      {
        path: "src/data/config.json",
        content: `{"appName":"StudioIDE","version":2}`
      },
      {
        path: "src/styles/card.css",
        content: `.card { color: #38bdf8; } /* </style> fake tag */`
      },
      {
        path: "src/components/Badge.tsx",
        content: `
          import cfg from "../data/config.json";
          export const Badge = ({ title }: { title: string }) => (
            <span className="badge">{cfg.appName}:{title}</span>
          );
        `
      },
      {
        path: "src/main.ts",
        content: `
          import makeLabel, { sum as addScaled, FACTOR } from "./utils/math.js";
          import * as MathAll from "./utils/math";
          import { Badge } from "./components/Badge";
          import "./styles/card.css";

          const node = Badge({ title: makeLabel("OK") });
          globalThis.__result = {
            added: addScaled(2, 3),
            factor: FACTOR,
            nsDefault: MathAll.default("NS"),
            badgeText: node.children.map((c) => c.textContent).join("")
          };
        `
      }
    ];

    const exactMap = buildExactModuleMap(files);
    const entry = files.find((f) => f.path === "src/main.ts");
    const bundle = buildVirtualModuleBundle({
      entryPath: entry.path,
      entryCode: entry.content,
      exactMap
    });

    assert.equal(bundle.isAsync, false);
    assert.deepEqual(bundle.externalSpecifiers, []);
    const exec = formatVirtualModuleExecution(bundle);
    assert.equal(exec.isModuleTag, false);
    assert.doesNotThrow(() => acorn.parse(exec.scriptCode, { ecmaVersion: "latest", sourceType: "script" }));

    const { MockNode, doc, appendedToHead } = createMockDomEnv();
    const ctx = {
      globalThis: {},
      document: doc,
      Node: MockNode
    };
    ctx.window = ctx;
    vm.runInNewContext(exec.scriptCode, ctx);

    assert.equal(ctx.globalThis.__result.added, 50);
    assert.equal(ctx.globalThis.__result.factor, 10);
    assert.equal(ctx.globalThis.__result.nsDefault, "[NS]");
    assert.equal(ctx.globalThis.__result.badgeText, "StudioIDE:[OK]");
    assert.equal(appendedToHead.length, 1);
    assert.equal(appendedToHead[0].getAttribute("data-source"), "src/styles/card.css");
    assert.ok(appendedToHead[0].textContent.includes(".card { color: #38bdf8; }"));
  });

  test("soporta barrel re-exports (export { a as b } from, export * from) e index.ts de directorio", () => {
    const files = [
      {
        path: "app/lib/constants.ts",
        content: `export const PI = 3; export const TAU = 6;`
      },
      {
        path: "app/lib/greet.ts",
        content: `export default function hello(n: string) { return "Hola " + n; } export function bye(n: string) { return "Chau " + n; }`
      },
      {
        path: "app/lib/index.ts",
        content: `
          export { default as greet, bye as farewell } from "./greet";
          export * from "./constants";
        `
      },
      {
        path: "app/entry.ts",
        content: `
          import { greet, farewell, PI, TAU } from "./lib";
          globalThis.__barrel = { g: greet("Ana"), f: farewell("Ana"), total: PI + TAU };
        `
      }
    ];

    const exactMap = buildExactModuleMap(files);
    const bundle = buildVirtualModuleBundle({
      entryPath: "app/entry.ts",
      entryCode: files[3].content,
      exactMap
    });
    const exec = formatVirtualModuleExecution(bundle);
    assert.doesNotThrow(() => acorn.parse(exec.scriptCode, { ecmaVersion: "latest", sourceType: "script" }));

    const ctx = { globalThis: {} };
    ctx.window = ctx;
    ctx.document = createMockDomEnv().doc;
    vm.runInNewContext(exec.scriptCode, ctx);

    assert.equal(ctx.globalThis.__barrel.g, "Hola Ana");
    assert.equal(ctx.globalThis.__barrel.f, "Chau Ana");
    assert.equal(ctx.globalThis.__barrel.total, 9);
  });

  test("inmunidad léxica: no confunde imports/exports dentro de strings, template literals, regex ni comentarios", () => {
    const files = [
      {
        path: "src/helper.js",
        content: `
          export const fakeStr = "import nope from './missing_1.js'; export default 9;";
          export const fakeTpl = \`// import fake\nimport another from './missing_2.js';\${1 + 2}\`;
          export const fakeRegex = /import\\s+x\\s+from\\s+['"]\\.\\/missing_3['"]/g;
          /* export { broken } from "./missing_4.js"; */
          export function ok() { return 77; }
        `
      },
      {
        path: "src/index.js",
        content: `
          import { ok, fakeStr, fakeTpl, fakeRegex } from "./helper.js";
          globalThis.__lex = { ok: ok(), hasImp: fakeStr.includes("import nope"), fakeTpl, re: fakeRegex instanceof RegExp };
        `
      }
    ];

    const exactMap = buildExactModuleMap(files);
    const bundle = buildVirtualModuleBundle({
      entryPath: "src/index.js",
      entryCode: files[1].content,
      exactMap
    });
    const exec = formatVirtualModuleExecution(bundle);
    const ctx = { globalThis: {} };
    ctx.window = ctx;
    ctx.document = createMockDomEnv().doc;
    vm.runInNewContext(exec.scriptCode, ctx);

    assert.equal(ctx.globalThis.__lex.ok, 77);
    assert.equal(ctx.globalThis.__lex.hasImp, true);
    assert.equal(ctx.globalThis.__lex.re, true);
  });

  test("soporta dependencias cíclicas y eleva export function correctamente", () => {
    const files = [
      {
        path: "cyc/a.js",
        content: `
          import { pingB } from "./b.js";
          export function pongA(n) { return n <= 0 ? "doneA" : "A->" + pingB(n - 1); }
          globalThis.__cycResult = pongA(2);
        `
      },
      {
        path: "cyc/b.js",
        content: `
          import { pongA } from "./a.js";
          export function pingB(n) { return n <= 0 ? "doneB" : "B->" + pongA(n - 1); }
        `
      }
    ];

    const exactMap = buildExactModuleMap(files);
    const bundle = buildVirtualModuleBundle({
      entryPath: "cyc/a.js",
      entryCode: files[0].content,
      exactMap
    });
    const exec = formatVirtualModuleExecution(bundle);
    const ctx = { globalThis: {} };
    ctx.window = ctx;
    ctx.document = createMockDomEnv().doc;
    vm.runInNewContext(exec.scriptCode, ctx);

    assert.equal(ctx.globalThis.__cycResult, "A->B->doneA");
  });

  test("loopGuard protege todos los módulos compilados contra bucles infinitos", () => {
    const files = [
      {
        path: "loop/worker.ts",
        content: `export function spin(): number { while (true) {} return 1; }`
      },
      {
        path: "loop/main.ts",
        content: `import { spin } from "./worker"; spin();`
      }
    ];

    const exactMap = buildExactModuleMap(files);
    const bundle = buildVirtualModuleBundle({
      entryPath: "loop/main.ts",
      entryCode: files[1].content,
      exactMap,
      transformJs: (js, isMod) => instrumentLoops(js, acorn, { module: isMod }).code
    });
    const exec = formatVirtualModuleExecution(bundle);

    const ctx = {
      globalThis: {},
      setInterval: () => 0,
      document: createMockDomEnv().doc
    };
    ctx.window = ctx;

    assert.throws(
      () => vm.runInNewContext(`${buildLoopGuardRuntime()}\n${exec.scriptCode}`, ctx),
      /Bucle detenido/i
    );
  });

  test("top-level await, dynamic import('./mod') y preamble externo se emiten como ES module válido", () => {
    const files = [
      {
        path: "async/lazy.ts",
        content: `
          const base: number = await Promise.resolve(21);
          export function doubled(): number { return base * 2; }
        `
      },
      {
        path: "async/main.ts",
        content: `
          import dayjs from "https://esm.sh/dayjs@1.11.10";
          const m = await import("./lazy");
          console.log(typeof dayjs, m.doubled());
        `
      }
    ];

    const exactMap = buildExactModuleMap(files);
    const bundle = buildVirtualModuleBundle({
      entryPath: "async/main.ts",
      entryCode: files[1].content,
      exactMap
    });

    assert.equal(bundle.isAsync, true);
    assert.deepEqual(bundle.externalSpecifiers, ["https://esm.sh/dayjs@1.11.10"]);
    const exec = formatVirtualModuleExecution(bundle);
    assert.equal(exec.isModuleTag, true);
    assert.ok(exec.extImportPreamble.includes('from "https://esm.sh/dayjs@1.11.10"'));
    assert.doesNotThrow(() => acorn.parse(exec.scriptCode, { ecmaVersion: "latest", sourceType: "module" }));
  });

  test("bundleHtmlWithFolderAssets coloca scripts type='module' agrupados al final de <body> para disponibilidad del DOM", () => {
    const files = new Map([
      [
        "web/msg.ts",
        { path: "web/msg.ts", content: `export function renderBanner(t: string): string { return "Banner:" + t; }` }
      ],
      [
        "web/app.ts",
        {
          path: "web/app.ts",
          content: `
            import { renderBanner } from "./msg";
            const el = document.getElementById("root");
            if (el) el.textContent = renderBanner("Vivo");
          `
        }
      ],
      [
        "web/isolated.js",
        { path: "web/isolated.js", content: `export const standalone = 1;` }
      ]
    ]);

    const html = `<!DOCTYPE html>
<html>
<head>
  <script type="module" src="./app.ts"></script>
</head>
<body>
  <div id="root"></div>
</body>
</html>`;

    const bundled = bundleHtmlWithFolderAssets(
      "web/index.html",
      html,
      files,
      null,
      (js, isMod) => instrumentLoops(js, acorn, { module: isMod }).code,
      null,
      true
    );

    const rootIdx = bundled.indexOf('<div id="root">');
    const defineIdx = bundled.indexOf('__studioDefine("web/app.ts"');
    assert.ok(rootIdx !== -1 && defineIdx !== -1 && defineIdx > rootIdx, "el módulo compilado debe quedar después del DOM en <body>");
    assert.ok(!bundled.includes('src="./app.ts"'));
    assert.ok(
      !/createObjectURL\(|<script[^>]+src=["']blob:/i.test(bundled),
      "no debe depender de blob: URLs bloqueadas por la CSP"
    );

    // Módulo sin dependencias locales debe conservar <script type="module" data-source> intacto
    const singleHtml = `<!DOCTYPE html><html><body><script type="module" src="./isolated.js"></script></body></html>`;
    const bundledSingle = bundleHtmlWithFolderAssets("web/single.html", singleHtml, files, null, null, null, true);
    assert.ok(bundledSingle.includes('<script type="module" data-source="web/isolated.js">'));
    assert.equal(hasLocalModuleDependencies("export const x = 1;", "web/isolated.js", buildExactModuleMap(files)), false);
  });

  test("buildStandaloneTsPreview, buildStandaloneJsPreview y extractModuleDependencyPaths soportan proyectos multi-archivo", () => {
    const workspaceFiles = [
      { path: "shared/meta.json", content: `{"tag":"V2"}` },
      { path: "src/calc.ts", content: `import meta from "../shared/meta.json"; export const label = meta.tag;` },
      { path: "src/entry.ts", content: `import { label } from "./calc"; console.log(label);` },
      { path: "src/lazyStub.ts", content: "", contentLoaded: false },
      { path: "src/lazyEntry.js", content: `import "./lazyStub"; console.log("ok");` }
    ];
    const exactMap = buildExactModuleMap(workspaceFiles);

    const tsHtml = buildStandaloneTsPreview(
      workspaceFiles[2],
      null,
      { assetMap: exactMap }
    );
    assert.ok(tsHtml.includes('__studioDefine("src/calc.ts"'));
    assert.ok(tsHtml.includes('__studioDefine("shared/meta.json"'));
    assert.ok(!tsHtml.includes('from "./calc"'));

    const jsHtml = buildStandaloneJsPreview(
      { path: "src/run.js", content: `import { label } from "./calc"; console.log(label);` },
      null,
      { assetMap: exactMap }
    );
    assert.ok(jsHtml.includes('__studioDefine("src/calc.ts"'));

    // Descubrimiento recursivo de dependencias (incluyendo stubs lazy sin descargar)
    const deps = extractModuleDependencyPaths("src/entry.ts", workspaceFiles[2].content, workspaceFiles);
    assert.deepEqual(deps.sort(), ["shared/meta.json", "src/calc.ts"].sort());

    const lazyDeps = extractModuleDependencyPaths("src/lazyEntry.js", workspaceFiles[4].content, workspaceFiles);
    assert.deepEqual(lazyDeps, ["src/lazyStub.ts"]);
  });
});
