import { rng } from "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { computeLineDiff } = await import("../js/ui/diffModal.js");
const { parseMarkdownSegments, formatProseHtml, formatInlineMarkdown } = await import("../js/ai/chatController.js");
const {
  bundleHtmlWithFolderAssets,
  resolveRelativePath,
  renderMarkdownDocumentHtml,
  buildStandalonePythonPreview,
  findSiblingHtmlInSameFolder
} = await import("../js/ui/livePreviewModal.js");
const { buildHierarchy, flattenVisibleTree } = await import("../js/ui/explorerController.js");

/** LCS de referencia independiente (DP clásica, sin recortes de prefijo/sufijo). */
function refLcsLen(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Reconstruye ambas versiones a partir de las operaciones crudas (sin colapsar). */
function rebuild(oldStr, newStr) {
  // Desactiva el colapso pidiendo todas las filas: las filas "skip" se rellenan desde el original.
  const { rows } = computeLineDiff(oldStr, newStr);
  const a = oldStr === "" ? [] : oldStr.replace(/\r\n/g, "\n").split("\n");
  const b = newStr === "" ? [] : newStr.replace(/\r\n/g, "\n").split("\n");
  const outOld = [];
  const outNew = [];
  let ia = 0;
  let ib = 0;
  for (const row of rows) {
    if (row.type === "skip") {
      for (let k = 0; k < row.count; k += 1) {
        outOld.push(a[ia]);
        outNew.push(b[ib]);
        ia += 1;
        ib += 1;
      }
    } else if (row.type === "eq") {
      assert.equal(row.text, a[ia]);
      assert.equal(row.text, b[ib]);
      assert.equal(row.lineNo, ib + 1, "número de línea de contexto debe referir al archivo nuevo");
      outOld.push(row.text);
      outNew.push(row.text);
      ia += 1;
      ib += 1;
    } else if (row.type === "del") {
      outOld.push(row.text);
      ia += 1;
    } else {
      outNew.push(row.text);
      ib += 1;
    }
  }
  return { outOld, outNew, a, b };
}

describe("Motor de Diff línea por línea", () => {
  test("textos idénticos no generan cambios", () => {
    const r = computeLineDiff("a\nb\n", "a\nb\n");
    assert.equal(r.addedCount, 0);
    assert.equal(r.removedCount, 0);
  });

  test("solo difieren CRLF/LF -> lineEndingsOnly", () => {
    const r = computeLineDiff("a\r\nb\r\n", "a\nb\n");
    assert.equal(r.lineEndingsOnly, true);
    assert.equal(r.addedCount + r.removedCount, 0);
  });

  test("vacío -> contenido y contenido -> vacío", () => {
    assert.deepEqual(
      [computeLineDiff("", "x\ny").addedCount, computeLineDiff("", "x\ny").removedCount],
      [2, 0]
    );
    assert.deepEqual(
      [computeLineDiff("x\ny", "").addedCount, computeLineDiff("x\ny", "").removedCount],
      [0, 2]
    );
  });

  test("propiedad (fuzz 400): el diff reconstruye ambas versiones y es mínimo frente a un LCS de referencia", () => {
    const r = rng(7);
    const vocab = ["a", "b", "c", "", "d", "  x", "ñ"];
    for (let iter = 0; iter < 400; iter += 1) {
      const gen = () => {
        const n = Math.floor(r() * 25);
        const lines = [];
        for (let i = 0; i < n; i += 1) lines.push(vocab[Math.floor(r() * vocab.length)]);
        return lines.join("\n");
      };
      const o = gen();
      const n = r() < 0.3 ? o : gen();
      const { outOld, outNew, a, b } = rebuild(o, n);
      assert.deepEqual(outOld, a, `old no reconstruido (iter ${iter})`);
      assert.deepEqual(outNew, b, `new no reconstruido (iter ${iter})`);
      const { addedCount, removedCount } = computeLineDiff(o, n);
      const lcs = refLcsLen(a, b);
      assert.equal(addedCount, b.length - lcs, `adds no mínimos iter ${iter}`);
      assert.equal(removedCount, a.length - lcs, `dels no mínimos iter ${iter}`);
    }
  });

  test("[BUG-18] archivo grande (1500 líneas) con cambios solo en la primera y última línea reporta +2 -2", () => {
    const base = Array.from({ length: 1500 }, (_, i) => `linea ${i}`);
    const changed = [...base];
    changed[0] = "PRIMERA";
    changed[1499] = "ULTIMA";
    const r = computeLineDiff(base.join("\n"), changed.join("\n"));
    assert.equal(r.addedCount, 2);
    assert.equal(r.removedCount, 2);
  });

  test("[BUG-18] archivo grande reconstruible tras el modo rápido", () => {
    const r = rng(99);
    const base = Array.from({ length: 2000 }, (_, i) => `l${i}`);
    const changed = base.map((l) => (r() < 0.02 ? `${l}*` : l));
    const { outOld, outNew, a, b } = rebuild(base.join("\n"), changed.join("\n"));
    assert.deepEqual(outOld, a);
    assert.deepEqual(outNew, b);
  });

  test("propiedad (fuzz 12): camino Myers en archivos de 1000-1400 líneas reconstruye y es mínimo vs. LCS de referencia", () => {
    const r = rng(2024);
    for (let iter = 0; iter < 12; iter += 1) {
      const len = 1000 + Math.floor(r() * 400);
      const a = Array.from({ length: len }, () => `v${Math.floor(r() * 40)}`);
      const b = [];
      for (const line of a) {
        const x = r();
        if (x < 0.03) continue; // borrado
        if (x < 0.06) b.push(`nuevo${Math.floor(r() * 1000)}`); // reemplazo
        else b.push(line);
        if (r() < 0.03) b.push(`ins${Math.floor(r() * 1000)}`); // inserción
      }
      // Forzar cambio en extremos para que el recorte de prefijo/sufijo no achique la zona central
      a[0] = "INICIO-A";
      b[0] = "INICIO-B";
      a[a.length - 1] = "FIN-A";
      b[b.length - 1] = "FIN-B";
      const o = a.join("\n");
      const nw = b.join("\n");
      const { outOld, outNew } = rebuild(o, nw);
      assert.deepEqual(outOld, a, `old no reconstruido iter ${iter}`);
      assert.deepEqual(outNew, b, `new no reconstruido iter ${iter}`);
      const { addedCount, removedCount } = computeLineDiff(o, nw);
      const lcs = refLcsLen(a, b);
      assert.equal(addedCount, b.length - lcs, `adds no mínimos iter ${iter}`);
      assert.equal(removedCount, a.length - lcs, `dels no mínimos iter ${iter}`);
    }
  });

  test("rendimiento: peor caso dentro del presupuesto Myers (5000+5000 líneas, ~1900 ediciones) < 3 s", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `l${i}`);
    const b = a.map((l, i) => (i % 5 === 0 ? `${l}*` : l));
    const t0 = performance.now();
    const res = computeLineDiff(a.join("\n"), b.join("\n"));
    const ms = performance.now() - t0;
    console.log(`    Myers 5000 líneas / 1000 reemplazos = ${ms.toFixed(0)} ms`);
    assert.equal(res.addedCount, 1000);
    assert.equal(res.removedCount, 1000);
    assert.ok(ms < 3000, `${ms} ms`);
  });

  test("rendimiento: 5000 líneas totalmente distintas < 1.5 s", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 5000 }, (_, i) => `b${i}`).join("\n");
    const t0 = performance.now();
    const r = computeLineDiff(a, b);
    const ms = performance.now() - t0;
    assert.equal(r.addedCount, 5000);
    assert.equal(r.removedCount, 5000);
    assert.ok(ms < 1500, `${ms} ms`);
  });
});

const XSS_PAYLOADS = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  '"><svg onload=alert(1)>',
  "**<b onclick=x>negrita</b>**",
  "`<img src=x>` y <iframe src=javascript:alert(1)>",
  "# <h1 onmouseover=alert(1)>",
  "- <a href=javascript:alert(1)>x</a>",
  "> <style>*{display:none}</style>",
  "\u0000CODE0\u0000<img src=x onerror=alert(2)>",
  "[click](javascript:alert(1))",
  "[ok](https://e.com/\"onmouseover=alert(1))",
  "[xss](https://e.com/`code`onmouseover=alert(1))",
  "[v1](https://e.com/\u0000CODE0\u0000\"onfocus=alert(1))",
  "[v2](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[v3](vbscript:msgbox(1))",
  "[v4](https://e.com/a\u2028b\"onmouseover=alert(1))",
  "[`nested`](https://e.com/path?x=`\"onmouseover=alert(1)`)"
];

/** Elimina las etiquetas permitidas y verifica que no quede ningún '<' crudo. */
function assertNoRawTags(html, allowed) {
  const tagRe = new RegExp(`</?(${allowed.join("|")})((?:\\s+[a-z-]+="[^"<>]*")*)\\s*>`, "gi");
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const attrs = [...m[2].matchAll(/([a-z-]+)="([^"]*)"/gi)];
    for (const [, name, value] of attrs) {
      assert.ok(["class", "href", "target", "rel"].includes(name.toLowerCase()), `atributo no permitido ${name} en ${html}`);
      if (name.toLowerCase() === "href") {
        assert.match(value, /^(https?:\/\/|#)/, `href peligroso: ${value}`);
      }
    }
  }
  const stripped = html.replace(tagRe, "");
  assert.ok(!stripped.includes("<"), `HTML no escapado: ${html}`);
}

describe("Seguridad: Markdown del chat IA (formatProseHtml)", () => {
  const allowed = ["p", "br", "strong", "em", "code", "h3", "hr", "blockquote", "ul", "ol", "li", "a"];
  for (const payload of XSS_PAYLOADS) {
    test(`escapa ${JSON.stringify(payload).slice(0, 50)}`, () => {
      assertNoRawTags(formatProseHtml(payload), allowed);
    });
  }
  test("fuzz 3000 cadenas aleatorias con < > \" ` * no producen etiquetas crudas", () => {
    const r = rng(1234);
    const alphabet = ["<", ">", '"', "'", "`", "*", "**", "#", "-", " ", "\n", "img", "script", "on", "=", "a", "\u0000"];
    for (let i = 0; i < 3000; i += 1) {
      let s = "";
      const len = Math.floor(r() * 30);
      for (let k = 0; k < len; k += 1) s += alphabet[Math.floor(r() * alphabet.length)];
      assertNoRawTags(formatProseHtml(s), allowed);
    }
  });
  test("formato básico: negrita, cursiva, código inline", () => {
    assert.equal(
      formatInlineMarkdown("**a** y *b* con `x<y`"),
      "<strong>a</strong> y <em>b</em> con <code class=\"chat-inline-code\">x&lt;y</code>"
    );
  });
});

describe("Segmentación de bloques de código del chat (parseMarkdownSegments)", () => {
  test("texto + bloque cerrado + texto", () => {
    const s = parseMarkdownSegments("Hola\n```python\nprint(1)\n```\nChau");
    assert.deepEqual(s, [
      { type: "prose", content: "Hola" },
      { type: "code", lang: "python", code: "print(1)" },
      { type: "prose", content: "Chau" }
    ]);
  });
  test("bloque sin cerrar durante streaming se muestra como código", () => {
    const s = parseMarkdownSegments("Mirá:\n```js\nconst a = 1;");
    assert.equal(s[1].type, "code");
    assert.equal(s[1].code, "const a = 1;");
  });
  test("varios bloques consecutivos", () => {
    const s = parseMarkdownSegments("```a\n1\n```\n```b\n2\n```");
    assert.deepEqual(s.map((x) => `${x.type}:${x.lang ?? ""}:${x.code ?? x.content}`), ["code:a:1", "code:b:2"]);
  });
  test("cadena vacía -> sin segmentos", () => {
    assert.deepEqual(parseMarkdownSegments(""), []);
  });
});

describe("Seguridad: vista previa Markdown (renderMarkdownDocumentHtml)", () => {
  const allowed = ["p", "br", "strong", "em", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "a"];
  for (const payload of XSS_PAYLOADS) {
    test(`escapa ${JSON.stringify(payload).slice(0, 50)}`, () => {
      assertNoRawTags(renderMarkdownDocumentHtml(payload), allowed);
    });
  }
  test("enlace https válido se genera con rel=noopener", () => {
    const html = renderMarkdownDocumentHtml("[doc](https://example.com/a?b=1&c=2)");
    assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">doc<\/a>/);
  });
  test("tabla con separador", () => {
    const html = renderMarkdownDocumentHtml("| a | b |\n|---|---|\n| 1 | 2 |");
    assert.match(html, /<thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody>/);
  });
  test("bloque de código escapa HTML", () => {
    assert.match(renderMarkdownDocumentHtml("```html\n<script>x</script>\n```"), /&lt;script&gt;x&lt;\/script&gt;/);
  });
});

describe("Empaquetador de vista previa HTML", () => {
  const mk = (path, content) => ({ path, content, shortName: path.split("/").pop() });
  const mapOf = (...files) => new Map(files.map((f) => [f.path, f]));

  test("incrusta CSS y JS relativos de la misma carpeta y respeta externos", () => {
    const html = `<!DOCTYPE html><html><head><link rel="stylesheet" href="./styles.css"><link rel="stylesheet" href="https://cdn.x/y.css"></head><body><script src="app.js"></script><script src="https://cdn.x/z.js"></script></body></html>`;
    const out = bundleHtmlWithFolderAssets("web/index.html", html, mapOf(mk("web/styles.css", "body{color:red}"), mk("web/app.js", "console.log(1)")));
    assert.match(out, /<style data-source="web\/styles.css">\nbody\{color:red\}\n<\/style>/);
    assert.match(out, /<script data-source="web\/app.js">\nconsole.log\(1\)\n<\/script>/);
    assert.match(out, /href="https:\/\/cdn.x\/y.css"/);
    assert.match(out, /src="https:\/\/cdn.x\/z.js"/);
  });

  test("'</script>' dentro del JS no rompe el documento y '$&' / '$1' se preservan literalmente", () => {
    const js = 'const s = "</script><img src=x onerror=alert(1)>"; const t = "$& $1 $$";';
    const out = bundleHtmlWithFolderAssets("i.html", '<head></head><script src="a.js"></script>', mapOf(mk("a.js", js)));
    assert.ok(!out.includes('"</script><img'), "cierre de script no escapado");
    assert.ok(out.includes('"$& $1 $$"'), "patrones de reemplazo de String.replace alterados");
  });

  test("'</style>' dentro del CSS se neutraliza", () => {
    const out = bundleHtmlWithFolderAssets("i.html", '<link rel="stylesheet" href="s.css">', mapOf(mk("s.css", "a{}</style><script>alert(1)</script>")));
    assert.ok(!/<\/style><script>alert/.test(out));
  });

  test("referencias '../' fuera de la carpeta no se incrustan", () => {
    const out = bundleHtmlWithFolderAssets("web/i.html", '<script src="../secret.js"></script>', mapOf(mk("secret.js", "x")));
    assert.match(out, /src="\.\.\/secret\.js"/);
  });

  test("defer se mueve al final del body y type=module se conserva", () => {
    const out = bundleHtmlWithFolderAssets(
      "i.html",
      '<head></head><body><script defer src="d.js"></script><script type="module" src="m.js"></script><p>x</p></body>',
      mapOf(mk("d.js", "DEFER"), mk("m.js", "MOD"))
    );
    assert.ok(out.indexOf("DEFER") > out.indexOf("<p>x</p>"));
    assert.match(out, /<script type="module" data-source="m.js">\nMOD/);
  });

  test("resolveRelativePath", () => {
    assert.equal(resolveRelativePath("web", "./a/b.js"), "web/a/b.js");
    assert.equal(resolveRelativePath("web/x", "../b.js"), "web/b.js");
    assert.equal(resolveRelativePath("web", "/root.js"), "root.js");
    assert.equal(resolveRelativePath("", "a.js"), "a.js");
  });

  test("findSiblingHtmlInSameFolder prefiere index.html y detecta enlace con nombre con caracteres regex", () => {
    const files = [mk("w/zz.html", ""), mk("w/index.html", '<script src="a+b(1).js"></script>')];
    const r = findSiblingHtmlInSameFolder(files, "w", mk("w/a+b(1).js", ""));
    assert.equal(r.file.path, "w/index.html");
    assert.equal(r.linksThisJs, true);
  });
});

describe("Vista previa Python: carga útil embebida", () => {
  test("código con '</script>' y comillas viaja intacto dentro del JSON embebido", () => {
    const code = 'print("</script><script>alert(1)</script>")\nx = \'<!--\'\n';
    const html = buildStandalonePythonPreview(
      { path: "s/main.py", shortName: "main.py", content: code },
      [{ path: "s/util.py", content: "def f(): return '</script>'" }, { path: "s/datos.json", content: '{"a":1}' }],
      "s"
    );
    const m = html.match(/<script id="__py_payload" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(m, "no se encontró el payload");
    const payload = JSON.parse(m[1]);
    assert.equal(payload.code, code);
    assert.deepEqual(payload.modules.map((x) => x.path).sort(), ["datos.json", "util.py"]);
    assert.deepEqual(payload.modPrefixes, ["util"]);
    // Solo debe existir el cierre legítimo de la etiqueta del payload, nunca uno inyectado
    assert.equal((m[1].match(/<\/script/gi) || []).length, 0);
  });
});

describe("Árbol del Explorador (buildHierarchy / flattenVisibleTree)", () => {
  test("carpetas antes que archivos, orden alfabético y colapso", () => {
    const root = buildHierarchy([
      { path: "z.txt", isFolder: false },
      { path: "src", isFolder: true },
      { path: "src/b.js", isFolder: false },
      { path: "src/a.js", isFolder: false },
      { path: "lib/x/y.js", isFolder: false }
    ]);
    const flat = flattenVisibleTree(root, 0, new Set(["lib"]));
    assert.deepEqual(flat.map((n) => `${n.depth}:${n.path}`), ["0:lib", "0:src", "1:src/a.js", "1:src/b.js", "0:z.txt"]);
  });
});

describe("Vista previa: los scripts generados compilan (guarda de Vuelta #4)", () => {
  test("Python: script principal y ejecutor del Worker son JavaScript válido", () => {
    const html = buildStandalonePythonPreview(
      { path: "a/main.py", shortName: "main.py", content: 'print("hola")\nx = "\n"\n' },
      [{ path: "a/util.py", content: "def f():\n    return 1\n" }],
      "a"
    );
    const blocks = [...html.matchAll(/<script(?:\s+id="([^"]*)")?(?:\s+type="([^"]*)")?>([\s\S]*?)<\/script>/g)];
    const runnable = blocks.filter((m) => !m[2] || m[2] === "text/plain");
    assert.ok(runnable.length >= 2, `se esperaban ≥2 scripts ejecutables, hubo ${runnable.length}`);
    for (const m of runnable) {
      assert.doesNotThrow(() => new Function(m[3]), `script ${m[1] || "(principal)"} no compila`);
    }
    const runner = blocks.find((m) => m[1] === "__py_runner_src")[3];
    assert.doesNotThrow(() => new Function("self", "__loadScript", runner));
  });
});
