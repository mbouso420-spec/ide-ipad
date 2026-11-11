import "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import * as acorn from "acorn";

import { transpileTypeScriptAndJsx } from "../js/preview/tsTranspiler.js";
import {
  bundleHtmlWithFolderAssets,
  buildStandaloneJsPreview,
  buildStandaloneTsPreview,
  buildStandalonePythonPreview,
  buildConsoleBridgeScript
} from "../js/preview/htmlBundler.js";
import { instrumentLoops, buildLoopGuardRuntime } from "../js/preview/loopGuard.js";

describe("Transpilador Offline TypeScript / JSX y Mini-REPL", () => {
  test("Transpila interfaces, tipos, genéricos, enums, as/satisfies, parámetros opcionales y destructuring sin romper ternarios ni objetos", () => {
    const tsCode = `
      import type { Config } from "./types";
      import { sumar, type Helper } from "./math";

      interface Usuario {
        id: number;
        nombre?: string;
      }

      type Estado =
        | "activo"
        | "pausa";

      enum Rol {
        Admin = "ADMIN",
        Dev = 2,
        Guest
      }

      class Cuenta<T> implements Usuario {
        readonly id: number;
        nombre?: string;
        constructor(public etiqueta: string, id: number) {
          this.id = id;
        }
        resumen(prefijo?: string): string {
          const obj: { a: number; label: string } = { a: 1, label: "x: number" };
          const { a: valor, label }: { a: number; label: string } = obj;
          const texto: string = valor > 0 ? "positivo:ok" : "cero:err";
          const est = "activo" as Estado;
          return (prefijo || this.etiqueta) + ":" + texto + ":" + est + ":" + Rol.Guest;
        }
      }

      const ident = <T>(x: T): T => x;
      function calcular(items: number[]): number {
        let total: number = 0;
        for (const n of items) {
          total += ident<number>(n);
        }
        return total;
      }

      const c = new Cuenta<string>("Studio", 10);
      globalThis.__tsOut = c.resumen("OK") + "|" + calcular([3, 4]) + "|" + Rol.Admin;
    `;

    // Reemplazar import de módulos ficticios para probar ejecución en VM
    const withoutFakeImports = tsCode
      .replace('import type { Config } from "./types";', "")
      .replace('import { sumar, type Helper } from "./math";', "");

    const { code, usedJsx } = transpileTypeScriptAndJsx(withoutFakeImports, { fileName: "demo.ts" });
    assert.equal(usedJsx, false);

    // Debe parsear limpiamente con Acorn (usado por loopGuard)
    assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" }));

    // Ejecutar en sandbox VM real para comprobar semántica en tiempo de ejecución
    const ctx = { globalThis: {} };
    vm.runInNewContext(code, ctx);
    assert.equal(ctx.globalThis.__tsOut, "OK:positivo:ok:activo:3|7|ADMIN");
  });

  test("Preserva import type / type inline eliminando el specifier sin dañar alias 'as'", () => {
    const src = `
      import type Foo from "./a";
      import { alpha, type Beta, gamma as g } from "./b";
      export type { Foo };
      const msg = "const x: number = 1;";
    `;
    const { code } = transpileTypeScriptAndJsx(src);
    assert.ok(!code.includes("Foo"));
    assert.ok(!code.includes("Beta"));
    assert.ok(code.includes('import { alpha,   gamma as g } from "./b";') || code.includes("gamma as g"));
    assert.ok(code.includes('const msg = "const x: number = 1;";'));
    assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" }));
  });

  test("Transpila TSX/JSX con React.createElement y fallback offline vanilla DOM/objeto", () => {
    const tsxCode = `
      interface CardProps { title: string; items: string[]; }
      const Badge = ({ label }: { label: string }) => <span className="badge">{label}</span>;
      const App = ({ title, items }: CardProps) => (
        <section id="root" data-ready>
          <h1>{title as string}</h1>
          <Badge label="v1.1" />
          <>
            {items.map((it: string) => <p>{it}</p>)}
          </>
        </section>
      );
      globalThis.__tree = App({ title: "Hola TSX", items: ["A", "B"] });
    `;

    const { code, usedJsx } = transpileTypeScriptAndJsx(tsxCode, { jsx: true, fileName: "App.tsx" });
    assert.equal(usedJsx, true);
    assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: "latest", sourceType: "script" }));

    // Instrumentación con loopGuard también debe funcionar sobre código TSX transpilado
    const guarded = instrumentLoops(code, acorn, { module: false }).code;
    const ctx = { globalThis: {}, setInterval: () => 0 };
    ctx.window = ctx;
    vm.runInNewContext(`${buildLoopGuardRuntime()}\n${guarded}`, ctx);

    assert.equal(ctx.globalThis.__tree.type, "section");
    assert.equal(ctx.globalThis.__tree.props.id, "root");
    assert.equal(ctx.globalThis.__tree.props["data-ready"], true);
    assert.equal(ctx.globalThis.__tree.children[0].children[0], "Hola TSX");
    assert.equal(ctx.globalThis.__tree.children[1].children[0], "v1.1");
  });

  test("htmlBundler transpila scripts .ts/.tsx y bloques inline type='text/tsx' / 'text/babel' antes de loopGuard", () => {
    const assetMap = new Map([
      ["web/main.tsx", { path: "web/main.tsx", content: "const saludo: string = 'TS ok'; console.log(<div>{saludo}</div>);" }]
    ]);
    const html = `<!DOCTYPE html>
<html>
<body>
  <script type="text/typescript">const num: number = 42; console.log(num);</script>
  <script src="./main.tsx"></script>
</body>
</html>`;

    const bundled = bundleHtmlWithFolderAssets(
      "web/index.html",
      html,
      assetMap,
      null,
      (js, isMod) => instrumentLoops(js, acorn, { module: isMod }).code,
      null,
      true
    );

    assert.ok(!bundled.includes("const num: number"));
    assert.ok(bundled.includes("const num = 42;"));
    assert.ok(bundled.includes("__studioJsx"));
    assert.ok(bundled.includes('d.source !== "studio-ide-repl"'));
  });

  test("buildStandaloneTsPreview y buildStandalonePythonPreview incluyen puente REPL y namespace persistente", () => {
    const tsHtml = buildStandaloneTsPreview({
      path: "src/demo.ts",
      content: "const total: number = 10 + 5; console.log(total);"
    });
    assert.ok(tsHtml.includes("const total = 10 + 5;"));
    assert.ok(!tsHtml.includes(": number"));
    assert.ok(tsHtml.includes('source !== "studio-ide-repl"'));

    const bridge = buildConsoleBridgeScript(true);
    assert.ok(bridge.includes("(0, eval)(code)"));

    const pyHtml = buildStandalonePythonPreview({
      path: "main.py",
      shortName: "main.py",
      content: "x = 7\nprint(x)"
    });
    assert.ok(pyHtml.includes("_studio_repl_ns"));
    assert.ok(pyHtml.includes('job.type === "eval"'));
    assert.ok(pyHtml.includes('source !== "studio-ide-repl"'));

    // Además comprobar que buildStandaloneJsPreview sigue intacto
    const jsHtml = buildStandaloneJsPreview({ path: "a.js", content: "console.log(1);" });
    assert.ok(jsHtml.includes("console.log(1);"));
  });

  test("initLivePreviewModal: abre .tsx offline con REPL e historial de comandos, y permite alternar a tsc", async () => {
    const { initLivePreviewModal } = await import("../js/ui/livePreviewModal.js");
    document.body.children = [];

    const dialog = document.createElement("dialog");
    dialog.id = "preview-dialog";
    dialog.open = false;
    dialog.showModal = function () { this.open = true; };
    dialog.close = function () { this.open = false; };

    const titleEl = document.createElement("h2");
    titleEl.id = "preview-dialog-title";
    const badgeEl = document.createElement("span");
    badgeEl.id = "preview-file-badge";
    const jsModeBtn = document.createElement("button");
    jsModeBtn.id = "btn-preview-js-mode";
    const iframe = document.createElement("iframe");
    iframe.id = "preview-iframe";
    const postedMessages = [];
    iframe.contentWindow = {
      postMessage(msg) {
        postedMessages.push(msg);
      }
    };
    const consolePanel = document.createElement("section");
    consolePanel.id = "preview-console-panel";
    const consoleTitle = document.createElement("span");
    consoleTitle.id = "preview-console-title";
    const consoleList = document.createElement("div");
    consoleList.id = "preview-console-list";
    const replForm = document.createElement("form");
    replForm.id = "preview-repl-form";
    const replInput = document.createElement("input");
    replInput.id = "preview-repl-input";
    const cRunnerBox = document.createElement("div");
    cRunnerBox.id = "preview-c-runner";

    replForm.appendChild(replInput);
    consolePanel.append(consoleTitle, consoleList, replForm);
    dialog.append(titleEl, badgeEl, jsModeBtn, iframe, cRunnerBox, consolePanel);
    document.body.appendChild(dialog);

    const modal = initLivePreviewModal({
      getWorkspaceSnapshot: () => ({
        projectId: "p1",
        activeFileId: "web/App.tsx",
        files: [
          { path: "web/App.tsx", shortName: "App.tsx", content: "const x: number = 9; console.log(<p>{x}</p>);" }
        ]
      })
    });

    await modal.openPreview();
    assert.equal(dialog.open, true);
    assert.match(titleEl.textContent, /TSX \(Offline\)/);
    assert.equal(replForm.hidden, false);
    assert.equal(jsModeBtn.hidden, false);
    assert.match(jsModeBtn.textContent, /compilador remoto/i);
    assert.ok(iframe.srcdoc.includes("__studioJsx"));
    assert.ok(!iframe.srcdoc.includes("const x: number"));

    // Enviar expresión al REPL y probar historial con ArrowUp
    replInput.value = "1 + 2";
    replForm.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(postedMessages.length, 1);
    assert.deepEqual(postedMessages[0], { source: "studio-ide-repl", action: "eval", code: "1 + 2" });
    assert.equal(replInput.value, "");

    replInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    assert.equal(replInput.value, "1 + 2");

    // Alternar a compilador remoto (ocultando REPL)
    jsModeBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(replForm.hidden, true);
    assert.match(titleEl.textContent, /Compilador TypeScript/);
    assert.match(jsModeBtn.textContent, /Ejecutar offline/i);

    dialog.close();
  });
});
