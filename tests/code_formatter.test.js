import "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { formatCode } from "../js/editor/codeFormatter.js";
import { createEditorManager } from "../js/editor/editorManager.js";

describe("Formateador Offline de Código (codeFormatter)", () => {
  test("JSON: indenta a 2 espacios y rechaza sin dañar cuando hay error de sintaxis", () => {
    const valid = formatCode('{"nombre":"Studio","items":[1,2,3]}', "json");
    assert.equal(valid.ok, true);
    assert.equal(valid.changed, true);
    assert.equal(
      valid.formatted,
      '{\n  "nombre": "Studio",\n  "items": [\n    1,\n    2,\n    3\n  ]\n}\n'
    );
    assert.equal(formatCode(valid.formatted, "json").changed, false);

    const broken = formatCode('{"nombre": "Studio",}', "json");
    assert.equal(broken.ok, false);
    assert.equal(broken.formatted, '{"nombre": "Studio",}');
    assert.match(broken.error, /sintaxis/i);
  });

  test("JS/TS: respeta regex con llaves, template literals multilínea y bloques switch/case", () => {
    const messyJs = [
      "function demo(x) {",
      "const re = /a{2,5}/;",
      "const html = `",
      "    <div>literal</div>",
      "`;",
      "switch (x) {",
      "case 1:",
      "console.log(re);",
      "break;",
      "default:",
      "return html;",
      "}",
      "}"
    ].join("\n");

    const res = formatCode(messyJs, "js");
    assert.equal(res.ok, true);
    assert.equal(
      res.formatted,
      [
        "function demo(x) {",
        "  const re = /a{2,5}/;",
        "  const html = `",
        "    <div>literal</div>",
        "`;",
        "  switch (x) {",
        "    case 1:",
        "      console.log(re);",
        "      break;",
        "    default:",
        "      return html;",
        "  }",
        "}",
        ""
      ].join("\n")
    );
    assert.equal(formatCode(res.formatted, "js").changed, false);
  });

  test("C/C++: usa 4 espacios, mantiene directivas # en columna 0 e indenta llaves", () => {
    const messyC = [
      "  #include <stdio.h>",
      "    #define MAX 10",
      "int main(void) {",
      "int a = 1;",
      "if (a > 0) {",
      'printf("{no cuenta como llave}");',
      "}",
      "return 0;",
      "}"
    ].join("\n");

    const res = formatCode(messyC, "c");
    assert.equal(res.ok, true);
    assert.equal(
      res.formatted,
      [
        "#include <stdio.h>",
        "#define MAX 10",
        "int main(void) {",
        "    int a = 1;",
        "    if (a > 0) {",
        '        printf("{no cuenta como llave}");',
        "    }",
        "    return 0;",
        "}",
        ""
      ].join("\n")
    );
    assert.equal(formatCode(res.formatted, "c").changed, false);
  });

  test("CSS: expande bloques minificados sin romper url(data:...;base64,...)", () => {
    const minCss =
      "body{margin:0;background:url(data:image/svg+xml;utf8,<svg/>);color:red;} /* c */ .a{padding:4px;}";
    const res = formatCode(minCss, "css");
    assert.equal(res.ok, true);
    assert.ok(res.formatted.includes("background:url(data:image/svg+xml;utf8,<svg/>);"));
    assert.ok(res.formatted.includes("  color:red;"));
    assert.equal(formatCode(res.formatted, "css").changed, false);
  });

  test("HTML: indenta etiquetas respetando void tags, <pre> y comparaciones < > en <script>", () => {
    const messyHtml = [
      "<!DOCTYPE html>",
      "<html>",
      "<head>",
      '<meta charset="UTF-8">',
      "<title>Demo</title>",
      "</head>",
      "<body>",
      "<main>",
      "<h1>Hola</h1>",
      "<pre>",
      "  conservar   espacios",
      "</pre>",
      "<script>",
      "if (a < b && c > 0) {",
      "  console.log(1);",
      "}",
      "</script>",
      "<p>Despues</p>",
      "</main>",
      "</body>",
      "</html>"
    ].join("\n");

    const res = formatCode(messyHtml, "html");
    assert.equal(res.ok, true);
    assert.ok(res.formatted.includes("    <main>"));
    assert.ok(res.formatted.includes("      <h1>Hola</h1>"));
    assert.ok(res.formatted.includes("  conservar   espacios"));
    assert.ok(res.formatted.includes("      <p>Despues</p>"));
    assert.equal(formatCode(res.formatted, "html").changed, false);
  });

  test("SQL: normaliza palabras clave en mayúsculas sin alterar literales de texto ni comentarios", () => {
    const sql = [
      "-- select comentado",
      "select id, nombre",
      "from usuarios",
      "where estado = 'select from where';"
    ].join("\n");
    const res = formatCode(sql, "sql");
    assert.equal(res.ok, true);
    assert.equal(
      res.formatted,
      [
        "-- select comentado",
        "SELECT id, nombre",
        "FROM usuarios",
        "WHERE estado = 'select from where';",
        ""
      ].join("\n")
    );
  });

  test("Python y Markdown: limpieza segura sin romper indentación ni saltos duros", () => {
    const py = "def foo():   \n\tif True:\n\t    return 1   \n\n\n\nprint(foo())\n";
    const resPy = formatCode(py, "python");
    assert.equal(resPy.formatted, "def foo():\n    if True:\n        return 1\n\n\nprint(foo())\n");

    const md = "# Titulo   \nLinea con salto duro  \n   \nTexto\n";
    const resMd = formatCode(md, "markdown");
    assert.equal(resMd.formatted, "# Titulo\nLinea con salto duro  \n\nTexto\n");
  });

  test("Propiedad de idempotencia en todos los lenguajes soportados", () => {
    const samples = [
      ["js", "const a = [1,2];\nfunction f(){\nreturn a.map(x => {\nreturn x*2;\n});\n}"],
      ["ts", "interface User { id: number; }\nconst u: User = {\nid: 1\n};"],
      ["cpp", "#include <iostream>\nint main() {\nfor(int i=0;i<3;i++){\nstd::cout<<i;\n}\n}"],
      ["css", ".card{display:flex;gap:8px;}"],
      ["html", "<div>\n<p>\nHola\n</p>\n</div>"],
      ["sql", "select * from items where id = 1;"],
      ["json", '{"a":1,"b":{"c":true}}']
    ];
    for (const [lang, sample] of samples) {
      const first = formatCode(sample, lang);
      assert.equal(first.ok, true, `Primer formateo debe ser ok para ${lang}`);
      const second = formatCode(first.formatted, lang);
      assert.equal(second.formatted, first.formatted, `Debe ser idempotente para ${lang}`);
      assert.equal(second.changed, false);
    }
  });

  test("EditorManager: replaceEntireDocument con preserveCursorLine preserva línea de cursor y notifica onDocChange", async () => {
    const mount = document.createElement("div");
    let latest = "";
    let lastSel = null;
    const editor = await createEditorManager({
      mountEl: mount,
      enableMinimap: false,
      onDocChange: (_id, content) => {
        latest = content;
      },
      onSelectionChange: (sel) => {
        lastSel = sel;
      }
    });

    editor.openFile({
      id: "demo.js",
      path: "demo.js",
      shortName: "demo.js",
      lang: "js",
      content: "function a() {\nreturn 1;\n}\n"
    });
    editor.goToLine(2);
    const fmt = formatCode(editor.getValue(), "js");
    editor.replaceEntireDocument(fmt.formatted, { preserveCursorLine: true });

    assert.equal(latest, "function a() {\n  return 1;\n}\n");
    assert.equal(lastSel?.cursorLine, 2);
    editor.destroy();
  });
});
