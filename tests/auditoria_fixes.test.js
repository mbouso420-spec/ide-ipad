import "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { truncateCodeContent, cleanHistoryForAi, estimateTokens, formatInlineMarkdown } = await import("../js/ai/chatController.js");
const { decodeImportedFile, MAX_IMPORT_FILE_BYTES } = await import("../js/storage/fileImport.js");
const { wrapTextWithDelimiters, createEditorManager } = await import("../js/editor/editorManager.js");
const { parseQuickOpenQuery } = await import("../js/ui/quickOpenModal.js");
const { generateDuplicatePath } = await import("../js/ui/explorerController.js");
const { buildZipArchive, computeCrc32, getDosDateTime } = await import("../js/storage/zipExporter.js");
const { formatStorageBytes, getStorageQuotaEstimate } = await import("../js/storage/storageQuota.js");
const {
  resolveRelativePath,
  findBestHtmlEntrypoint,
  findTargetHtmlFile,
  filterFolderScopeFiles,
  bundleHtmlWithFolderAssets,
  IGNORED_PREVIEW_DIRS,
  extractReferencedAssetPaths,
  extractCssImportPaths,
  buildWorkspaceAssetMap,
  getSavedPreviewHtml,
  savePreviewHtml
} = await import("../js/ui/livePreviewModal.js");
const { convertResultsToCsv, convertResultsToJson } = await import("../js/preview/sqlRunner.js");
const {
  buildWandboxPayload,
  compileAndRunWandbox,
  parseGccErrors,
  mountCRunnerView,
  hasMainFunction,
  sanitizeLoopOutput,
  extractNewOutputDelta,
  trimInitialMenuOutput,
  trimPrematureMenuRepeat,
  createTerminalHistory
} = await import("../js/preview/cRunner.js");
const { fetchRepoBranches, createRepoBranch } = await import("../js/github/githubService.js");

describe("Verificación de Arreglos de Auditoría (Fases 1, 2, 3 y 4)", () => {
  describe("FALLA-02: Presupuesto y truncamiento de contexto en el Asistente IA", () => {
    test("contenido menor al límite no se trunca", () => {
      const code = "console.log('hola mundo');\n".repeat(10);
      assert.equal(truncateCodeContent(code, 1000), code);
    });

    test("contenido mayor al límite conserva cabecera y pie con aviso de líneas omitidas", () => {
      const lines = [];
      for (let i = 1; i <= 2000; i += 1) {
        lines.push(`const linea_${i} = ${i};`);
      }
      const raw = lines.join("\n");
      const truncated = truncateCodeContent(raw, 2000);

      assert.ok(truncated.length < raw.length);
      assert.ok(truncated.includes("const linea_1 = 1;"), "debe conservar la cabecera");
      assert.ok(truncated.includes("const linea_2000 = 2000;"), "debe conservar el pie");
      assert.ok(truncated.includes("líneas omitidas por límite de contexto de la API gratuita"));
    });
  });

  describe("FALLA-06: Saneamiento del historial de chat al abortar", () => {
    test("elimina anotaciones de interrupción y no envía mensajes vacíos", () => {
      const convo = [
        { role: "user", content: "¿Cómo hago un bucle en JS?" },
        { role: "assistant", content: "Podés usar for...\n\n*(Generación detenida)*" },
        { role: "user", content: "Explicame mejor" },
        { role: "assistant", content: "\n\n*(Respuesta interrumpida: Error de red al conectar)*" }
      ];

      const cleaned = cleanHistoryForAi(convo);
      assert.equal(cleaned.length, 3, "debe omitir el último turno que quedó completamente vacío");
      assert.equal(cleaned[0].content, "¿Cómo hago un bucle en JS?");
      assert.equal(cleaned[1].content, "Podés usar for...");
      assert.equal(cleaned[2].content, "Explicame mejor");
      assert.ok(!cleaned.some((m) => m.content.includes("Generación detenida")));
      assert.ok(!cleaned.some((m) => m.content.includes("Respuesta interrumpida")));
    });
  });

  describe("FALLA-04: Límite de tamaño en importación de archivos", () => {
    test("MAX_IMPORT_FILE_BYTES es 5 MB", () => {
      assert.equal(MAX_IMPORT_FILE_BYTES, 5 * 1024 * 1024);
    });

    test("rechaza buffers que superan el límite con motivo descriptivo", () => {
      const hugeBuffer = new Uint8Array(MAX_IMPORT_FILE_BYTES + 10);
      const res = decodeImportedFile(hugeBuffer, "datos.txt");
      assert.equal(res.ok, false);
      assert.match(res.reason, /supera el límite de 5 MB/);
    });

    test("acepta archivos UTF-8 válidos dentro del límite", () => {
      const valid = new TextEncoder().encode("let a = 123;");
      const res = decodeImportedFile(valid, "codigo.js");
      assert.equal(res.ok, true);
      assert.equal(res.text, "let a = 123;");
    });
  });

  describe("FALLA-03 y FALLA-12: Seguridad y Pre-cacheo Offline", () => {
    test("index.html declara Content-Security-Policy estricta", () => {
      const htmlPath = path.resolve(__dirname, "../index.html");
      const html = fs.readFileSync(htmlPath, "utf-8");
      assert.ok(html.includes('http-equiv="Content-Security-Policy"'), "falta meta CSP en index.html");
      assert.ok(html.includes("default-src 'self'"), "CSP debe restringir default-src a 'self'");
      assert.ok(html.includes("api.github.com"), "CSP debe autorizar GitHub API");
      assert.ok(html.includes("generativelanguage.googleapis.com"), "CSP debe autorizar Gemini API");
    });

    test("sw.js pre-cachea Acorn en RUNTIME_CACHE durante el evento install", () => {
      const swPath = path.resolve(__dirname, "../sw.js");
      const sw = fs.readFileSync(swPath, "utf-8");
      assert.ok(sw.includes("ACORN_CDN_URL"), "falta constante ACORN_CDN_URL en sw.js");
      assert.ok(sw.includes("https://esm.sh/acorn@8.14.0"), "debe apuntar a la versión exacta de Acorn");
      assert.ok(sw.includes("RUNTIME_CACHE"), "debe almacenar en RUNTIME_CACHE");
    });
  });

  describe("Fase 3: Auto-Wrap de selecciones con símbolos táctiles", () => {
    test("envuelve texto con paréntesis conservando la selección interna", () => {
      const wrapped = wrapTextWithDelimiters("()", "variable", 1);
      assert.equal(wrapped.text, "(variable)");
      assert.equal(wrapped.selectFrom, 1);
      assert.equal(wrapped.selectTo, 9);
    });

    test("envuelve texto con llaves, corchetes y comillas", () => {
      assert.equal(wrapTextWithDelimiters("{}", "items", 1).text, "{items}");
      assert.equal(wrapTextWithDelimiters("[]", "1, 2, 3", 1).text, "[1, 2, 3]");
      assert.equal(wrapTextWithDelimiters('""', "cadena", 1).text, '"cadena"');
      assert.equal(wrapTextWithDelimiters("''", "caracter", 1).text, "'caracter'");
      assert.equal(wrapTextWithDelimiters("``", "template", 1).text, "`template`");
    });

    test("envuelve texto con bloques multilínea de triple backtick", () => {
      const wrapped = wrapTextWithDelimiters("``````", "const x = 10;", 3);
      assert.equal(wrapped.text, "```const x = 10;```");
      assert.equal(wrapped.selectFrom, 3);
      assert.equal(wrapped.selectTo, 16);
    });
  });

  describe("Fase 3: Salto directo a línea desde la Paleta Rápida (Cmd+P)", () => {
    test("detecta archivo y número de línea", () => {
      const res = parseQuickOpenQuery("app.js:140");
      assert.equal(res.fileQuery, "app.js");
      assert.equal(res.targetLine, 140);
    });

    test("admite salto directo sin archivo para el archivo activo (:45)", () => {
      const res = parseQuickOpenQuery(":45");
      assert.equal(res.fileQuery, "");
      assert.equal(res.targetLine, 45);
    });

    test("no altera consultas normales de archivos sin número de línea", () => {
      const res1 = parseQuickOpenQuery("src/main.py");
      assert.equal(res1.fileQuery, "src/main.py");
      assert.equal(res1.targetLine, null);

      const res2 = parseQuickOpenQuery("app.js:");
      assert.equal(res2.fileQuery, "app.js:");
      assert.equal(res2.targetLine, null);

      const res3 = parseQuickOpenQuery("archivo:no_numero");
      assert.equal(res3.fileQuery, "archivo:no_numero");
      assert.equal(res3.targetLine, null);
    });

    test("ignora espacios superfluos alrededor", () => {
      const res = parseQuickOpenQuery("  styles.css:25   ");
      assert.equal(res.fileQuery, "styles.css");
      assert.equal(res.targetLine, 25);
    });
  });

  describe("Fase 3: Duplicación inteligente en el Explorador", () => {
    test("inserta .copia antes de la extensión estándar", () => {
      const dup = generateDuplicatePath("utils.js", ["utils.js"]);
      assert.equal(dup, "utils.copia.js");
    });

    test("añade sufijo numérico secuencial si el duplicado ya existe", () => {
      const existing = ["utils.js", "utils.copia.js"];
      const dup2 = generateDuplicatePath("utils.js", existing);
      assert.equal(dup2, "utils.copia 2.js");

      existing.push("utils.copia 2.js");
      const dup3 = generateDuplicatePath("utils.js", existing);
      assert.equal(dup3, "utils.copia 3.js");
    });

    test("soporta dotfiles (.gitignore) y archivos sin extensión (Makefile)", () => {
      assert.equal(generateDuplicatePath(".gitignore", [".gitignore"]), ".gitignore.copia");
      assert.equal(generateDuplicatePath("Makefile", ["Makefile"]), "Makefile.copia");
    });

    test("conserva la estructura de carpetas anidadas", () => {
      const dup = generateDuplicatePath("src/components/Header.vue", ["src/components/Header.vue"]);
      assert.equal(dup, "src/components/Header.copia.vue");
    });
  });

  describe("Fase 4: Exportador ZIP offline (PKZIP 2.0)", () => {
    test("computeCrc32 calcula correctamente el checksum estándar", () => {
      assert.equal(computeCrc32(new Uint8Array(0)), 0);
      const testBytes = new TextEncoder().encode("123456789");
      assert.equal(computeCrc32(testBytes), 0xcbf43926);
    });

    test("getDosDateTime genera campos de fecha y hora válidos para MS-DOS", () => {
      const date = new Date(2026, 10, 4, 15, 30, 20);
      const { dosDate, dosTime } = getDosDateTime(date);
      assert.ok(dosDate > 0);
      assert.ok(dosTime > 0);
    });

    test("buildZipArchive genera un archivo PKZIP 2.0 válido con firmas oficiales", () => {
      const files = [
        { path: "index.html", content: "<!DOCTYPE html><html><body>Hola</body></html>" },
        { path: "src/app.js", content: "console.log('Studio IDE');" },
        { path: "assets/empty.txt", content: "" }
      ];

      const zipBytes = buildZipArchive(files);
      assert.ok(zipBytes instanceof Uint8Array);
      assert.ok(zipBytes.byteLength > 100);

      const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);

      // Firma 1: Local File Header signature (0x04034b50 -> "PK\x03\x04")
      assert.equal(view.getUint32(0, true), 0x04034b50, "Firma de cabecera local PK 3 4 esperada");

      // Buscar Central Directory Header signature (0x02014b50 -> "PK\x01\x02")
      let hasCentralDir = false;
      for (let i = 0; i < zipBytes.byteLength - 4; i += 1) {
        if (view.getUint32(i, true) === 0x02014b50) {
          hasCentralDir = true;
          break;
        }
      }
      assert.ok(hasCentralDir, "Debe contener firma de directorio central (PK 1 2)");

      // Buscar End of Central Directory signature (0x06054b50 -> "PK\x05\x06")
      let hasEocd = false;
      for (let i = 0; i < zipBytes.byteLength - 4; i += 1) {
        if (view.getUint32(i, true) === 0x06054b50) {
          hasEocd = true;
          const totalEntries = view.getUint16(i + 10, true);
          assert.equal(totalEntries, 3, "El EOCD debe reflejar 3 archivos empaquetados");
          break;
        }
      }
      assert.ok(hasEocd, "Debe contener firma de fin de directorio central (PK 5 6)");
    });

    test("buildZipArchive soporta proyecto vacío sin lanzar excepciones", () => {
      const zipBytes = buildZipArchive([]);
      assert.ok(zipBytes.byteLength >= 22);
      const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
      assert.equal(view.getUint32(0, true), 0x06054b50, "Zip vacío contiene directamente el EOCD");
    });
  });

  describe("Fase 4: Previsualización Multi-Página (Resolución de rutas relativas)", () => {
    test("resuelve enlaces en el mismo directorio", () => {
      assert.equal(resolveRelativePath("", "contacto.html"), "contacto.html");
      assert.equal(resolveRelativePath("pages", "contacto.html"), "pages/contacto.html");
      assert.equal(resolveRelativePath("pages", "./contacto.html"), "pages/contacto.html");
    });

    test("resuelve navegación hacia directorios padre (../)", () => {
      assert.equal(resolveRelativePath("pages/blog", "../index.html"), "pages/index.html");
      assert.equal(resolveRelativePath("pages/blog/sub", "../../index.html"), "pages/index.html");
      assert.equal(resolveRelativePath("pages", "../index.html"), "index.html");
    });

    test("respeta rutas absolutas del workspace", () => {
      assert.equal(resolveRelativePath("pages/blog", "/index.html"), "index.html");
      assert.equal(resolveRelativePath("pages/blog", "/src/app.js"), "src/app.js");
    });
  });

  describe("Fase 4: Asistente IA (Estimador de Tokens y Enlaces Markdown)", () => {
    test("estimateTokens calcula ~4 caracteres por token con redondeo hacia arriba", () => {
      assert.equal(estimateTokens(0), 0);
      assert.equal(estimateTokens(4), 1);
      assert.equal(estimateTokens(5), 2);
      assert.equal(estimateTokens(40), 10);
      assert.equal(estimateTokens(1000), 250);
      assert.equal(estimateTokens(null), 0);
      assert.equal(estimateTokens(-10), 0);
    });

    test("formatInlineMarkdown renderiza enlaces https:// y http:// seguros", () => {
      const html = formatInlineMarkdown("Revisá la [documentación oficial](https://example.com/docs).");
      assert.equal(
        html,
        'Revisá la <a href="https://example.com/docs" target="_blank" rel="noopener noreferrer" class="chat-link">documentación oficial</a>.'
      );
    });

    test("formatInlineMarkdown bloquea protocolos peligrosos (javascript:, data:)", () => {
      const htmlXss = formatInlineMarkdown("[Ataque XSS](javascript:alert(1))");
      assert.ok(!htmlXss.includes("<a "), "No debe crear elemento <a> para javascript:");
      assert.ok(!htmlXss.includes("<script"), "No debe contener scripts crudos");

      const htmlData = formatInlineMarkdown("[Data URI](data:text/html,<script>alert(1)</script>)");
      assert.ok(!htmlData.includes("<a "), "No debe crear elemento <a> para data:");
      assert.ok(!htmlData.includes("<script>"), "No debe inyectar script de data URI");
    });

    test("formatInlineMarkdown neutraliza inyecciones de atributos en URLs", () => {
      const malicious = '[payload](https://example.com/"onmouseover="alert(1))';
      const rendered = formatInlineMarkdown(malicious);
      assert.ok(!rendered.includes('"onmouseover='), "No debe permitir inyección de atributos con comillas crudas");
      assert.ok(rendered.includes('&quot;onmouseover='), "Las comillas dentro de la URL deben estar escapadas");
    });
  });

  describe("Fase 4: Gestión de Cuota de Almacenamiento", () => {
    test("formatStorageBytes formatea adecuadamente distintos órdenes de magnitud", () => {
      assert.equal(formatStorageBytes(0), "0 B");
      assert.equal(formatStorageBytes(512), "512 B");
      assert.equal(formatStorageBytes(1024), "1.0 KB");
      assert.equal(formatStorageBytes(1536), "1.5 KB");
      assert.equal(formatStorageBytes(1024 * 1024), "1.0 MB");
      assert.equal(formatStorageBytes(5.5 * 1024 * 1024), "5.5 MB");
      assert.equal(formatStorageBytes(1024 * 1024 * 1024), "1.00 GB");
      assert.equal(formatStorageBytes(2.5 * 1024 * 1024 * 1024), "2.50 GB");
    });

    test("formatStorageBytes es resiliente ante valores inválidos o negativos", () => {
      assert.equal(formatStorageBytes(-100), "0 B");
      assert.equal(formatStorageBytes(null), "0 B");
      assert.equal(formatStorageBytes(undefined), "0 B");
      assert.equal(formatStorageBytes(NaN), "0 B");
      assert.equal(formatStorageBytes("invalido"), "0 B");
    });

    test("getStorageQuotaEstimate devuelve soporte seguro en cualquier entorno", async () => {
      const estimate = await getStorageQuotaEstimate();
      assert.equal(typeof estimate.supported, "boolean");
      assert.equal(typeof estimate.usageBytes, "number");
      assert.equal(typeof estimate.quotaBytes, "number");
      assert.equal(typeof estimate.usageFormatted, "string");
      assert.equal(typeof estimate.quotaFormatted, "string");
      assert.equal(typeof estimate.percentage, "number");
    });
  });

  describe("Fase 4: Ramas de GitHub (fetchRepoBranches y createRepoBranch)", () => {
    test("createRepoBranch rechaza nombres de rama vacíos", async () => {
      await assert.rejects(
        () => createRepoBranch({ token: "ghp_ValidTestToken1234567890abcdef", owner: "o", repo: "r", branchName: "" }),
        /El nombre de la rama no puede estar vacío/
      );
      await assert.rejects(
        () => createRepoBranch({ token: "ghp_ValidTestToken1234567890abcdef", owner: "o", repo: "r", branchName: "   " }),
        /El nombre de la rama no puede estar vacío/
      );
    });

    test("fetchRepoBranches y createRepoBranch realizan peticiones REST válidas", async () => {
      const originalFetch = globalThis.fetch;
      const calls = [];
      globalThis.fetch = async (url, init = {}) => {
        const u = new URL(url);
        const key = `${init.method || "GET"} ${u.pathname}`;
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ key, url: String(url), body });
        if (key === "GET /repos/o/r/branches") {
          return new Response(JSON.stringify([{ name: "main" }, { name: "develop" }]), { status: 200 });
        }
        if (key === "POST /repos/o/r/git/refs") {
          return new Response(JSON.stringify({ ref: body.ref, object: { sha: body.sha } }), { status: 201 });
        }
        return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
      };

      try {
        const branches = await fetchRepoBranches({ token: "ghp_ValidTestToken1234567890abcdef", owner: "o", repo: "r" });
        assert.deepEqual(branches.map((b) => b.name), ["main", "develop"]);

        const created = await createRepoBranch({
          token: "ghp_ValidTestToken1234567890abcdef",
          owner: "o",
          repo: "r",
          branchName: "feature/nueva",
          fromSha: "SHA123"
        });
        assert.equal(created.ref, "refs/heads/feature/nueva");
        assert.equal(created.commitSha, "SHA123");

        const postCall = calls.find((c) => c.key === "POST /repos/o/r/git/refs");
        assert.ok(postCall);
        assert.equal(postCall.body.ref, "refs/heads/feature/nueva");
        assert.equal(postCall.body.sha, "SHA123");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Fase 5: Motor de Vista Previa Evolucionado (Entrypoints, Multi-Página, C/C++ y SQL)", () => {
    describe("Resolución Inteligente de Entrypoints (findBestHtmlEntrypoint)", () => {
      const allFiles = [
        { path: "index.html", shortName: "index.html", content: '<!DOCTYPE html><html><head><script src="app.js"></script></head><body>Raíz</body></html>' },
        { path: "app.js", shortName: "app.js", content: "console.log('root app');" },
        { path: "admin/index.html", shortName: "index.html", content: '<!DOCTYPE html><html><head><link rel="stylesheet" href="admin.css"></head><body>Admin</body></html>' },
        { path: "admin/admin.css", shortName: "admin.css", content: "body { background: black; }" },
        { path: "admin/custom.js", shortName: "custom.js", content: "console.log('admin custom');" },
        { path: "landing/promo.html", shortName: "promo.html", content: '<!DOCTYPE html><html><head><script src="../shared/util.js"></script></head><body>Promo</body></html>' },
        { path: "shared/util.js", shortName: "util.js", content: "export const pi = 3.14;" }
      ];

      test("prioriza HTML que enlaza explícitamente el script JS mediante <script src=...>", () => {
        const bestForUtil = findBestHtmlEntrypoint(allFiles, { path: "shared/util.js", shortName: "util.js" });
        assert.ok(bestForUtil);
        assert.equal(bestForUtil.path, "landing/promo.html");
      });

      test("prioriza HTML que enlaza explícitamente el stylesheet CSS mediante <link href=...>", () => {
        const bestForCss = findBestHtmlEntrypoint(allFiles, { path: "admin/admin.css", shortName: "admin.css" });
        assert.ok(bestForCss);
        assert.equal(bestForCss.path, "admin/index.html");
      });

      test("si no hay referencia directa, toma index.html en la misma carpeta", () => {
        const bestForCustom = findBestHtmlEntrypoint(allFiles, { path: "admin/custom.js", shortName: "custom.js" });
        assert.ok(bestForCustom);
        assert.equal(bestForCustom.path, "admin/index.html");
      });

      test("si no hay index.html en la misma carpeta, toma index.html en la raíz del proyecto", () => {
        const otherFiles = [
          { path: "index.html", shortName: "index.html", content: "<html><body>Raíz</body></html>" },
          { path: "sub/modulo.js", shortName: "modulo.js", content: "console.log(1);" }
        ];
        const best = findBestHtmlEntrypoint(otherFiles, { path: "sub/modulo.js", shortName: "modulo.js" });
        assert.ok(best);
        assert.equal(best.path, "index.html");
      });

      test("si no hay index.html, toma el primer HTML disponible en el workspace", () => {
        const otherFiles = [
          { path: "vistas/home.html", shortName: "home.html", content: "<html><body>Home</body></html>" },
          { path: "scripts/main.js", shortName: "main.js", content: "console.log(1);" }
        ];
        const best = findBestHtmlEntrypoint(otherFiles, { path: "scripts/main.js", shortName: "main.js" });
        assert.ok(best);
        assert.equal(best.path, "vistas/home.html");
      });

      test("devuelve null si no existe ningún archivo HTML en todo el workspace", () => {
        const jsOnlyFiles = [
          { path: "scripts/main.js", shortName: "main.js", content: "console.log(1);" },
          { path: "scripts/util.js", shortName: "util.js", content: "console.log(2);" }
        ];
        const best = findBestHtmlEntrypoint(jsOnlyFiles, { path: "scripts/main.js", shortName: "main.js" });
        assert.equal(best, null);
      });
    });

    describe("Navegación Multi-Página Tolerante (findTargetHtmlFile)", () => {
      const workspaceFiles = [
        { path: "index.html", shortName: "index.html", content: "<html><body>Home</body></html>" },
        { path: "catalogo.html", shortName: "catalogo.html", content: "<html><body>Catálogo</body></html>" },
        { path: "vistas/contacto.html", shortName: "contacto.html", content: "<html><body>Contacto</body></html>" },
        { path: "vistas/sub/detalle.html", shortName: "detalle.html", content: "<html><body>Detalle</body></html>" }
      ];

      test("resuelve enlaces relativos simples (catalogo.html)", () => {
        const target = findTargetHtmlFile(workspaceFiles, "index.html", "catalogo.html");
        assert.ok(target);
        assert.equal(target.path, "catalogo.html");
      });

      test("resuelve enlaces con ./ y ../ respetando la carpeta del HTML activo", () => {
        const fromSub = findTargetHtmlFile(workspaceFiles, "vistas/sub/detalle.html", "../contacto.html");
        assert.ok(fromSub);
        assert.equal(fromSub.path, "vistas/contacto.html");

        const fromVistas = findTargetHtmlFile(workspaceFiles, "vistas/contacto.html", "../index.html");
        assert.ok(fromVistas);
        assert.equal(fromVistas.path, "index.html");
      });

      test("resuelve enlaces absolutos (/vistas/contacto.html)", () => {
        const target = findTargetHtmlFile(workspaceFiles, "index.html", "/vistas/contacto.html");
        assert.ok(target);
        assert.equal(target.path, "vistas/contacto.html");
      });

      test("resuelve enlaces sin extensión (.html implícito)", () => {
        const target = findTargetHtmlFile(workspaceFiles, "index.html", "catalogo");
        assert.ok(target);
        assert.equal(target.path, "catalogo.html");
      });

      test("resuelve archivos HTML por coincidencia de nombre base si se movieron de carpeta", () => {
        const target = findTargetHtmlFile(workspaceFiles, "index.html", "contacto.html");
        assert.ok(target);
        assert.equal(target.path, "vistas/contacto.html");
      });

      test("limpia querystrings (?id=1) y fragmentos (#seccion)", () => {
        const target = findTargetHtmlFile(workspaceFiles, "index.html", "catalogo.html?categoria=libros#top");
        assert.ok(target);
        assert.equal(target.path, "catalogo.html");
      });

      test("devuelve null si el HTML solicitado no existe en el workspace", () => {
        const target = findTargetHtmlFile(workspaceFiles, "index.html", "inexistente.html");
        assert.equal(target, null);
      });
    });

    describe("Exportadores de Resultados SQL (convertResultsToCsv / convertResultsToJson)", () => {
      const sampleResults = [
        {
          columns: ["id", "nombre", "descripcion", "precio"],
          values: [
            [1, "Notebook Pro", "Con pantalla de 16\", alta gama", 1499.99],
            [2, "Mouse USB", "Cable reforzado, 1.8m", 25.50]
          ]
        }
      ];

      test("convertResultsToCsv genera cabeceras y filas con escape de comillas y comas", () => {
        const csv = convertResultsToCsv(sampleResults);
        assert.ok(csv.includes("id,nombre,descripcion,precio"));
        assert.ok(csv.includes('1,Notebook Pro,"Con pantalla de 16"", alta gama",1499.99'));
        assert.ok(csv.includes('2,Mouse USB,"Cable reforzado, 1.8m",25.5'));
      });

      test("convertResultsToCsv devuelve cadena vacía para resultados vacíos", () => {
        assert.equal(convertResultsToCsv([]), "");
        assert.equal(convertResultsToCsv(null), "");
      });

      test("convertResultsToJson transforma resultados tabulares en array de objetos clave-valor", () => {
        const json = convertResultsToJson(sampleResults);
        assert.equal(json.length, 2);
        assert.equal(json[0].id, 1);
        assert.equal(json[0].nombre, "Notebook Pro");
        assert.equal(json[0].precio, 1499.99);
        assert.equal(json[1].id, 2);
        assert.equal(json[1].nombre, "Mouse USB");
      });
    });

    describe("Compilador y Ejecutor C/C++ (buildWandboxPayload / compileAndRunWandbox)", () => {
      test("buildWandboxPayload selecciona gcc-head-c y c17 para archivos .c", () => {
        const payload = buildWandboxPayload({
          activeFile: { path: "main.c", content: '#include <stdio.h>\nint main(){ printf("hola"); return 0; }' }
        });
        assert.equal(payload.compiler, "gcc-head-c");
        assert.ok(payload.options.includes("c17"));
        assert.equal(payload.codes.length, 0);
      });

      test("buildWandboxPayload selecciona gcc-head y c++20 para archivos .cpp/.hpp", () => {
        const payload = buildWandboxPayload({
          activeFile: { path: "main.cpp", content: '#include <iostream>\nint main(){ std::cout << "hola"; }' }
        });
        assert.equal(payload.compiler, "gcc-head");
        assert.ok(payload.options.includes("c++20"));
      });

      test("buildWandboxPayload empaqueta headers compañeros en codes y fuentes .c/.cpp en compiler-option-raw", () => {
        const payload = buildWandboxPayload({
          activeFile: { path: "src/main.cpp", content: '#include "math.hpp"\nint main(){ return add(1,2); }' },
          companionFiles: [
            { path: "src/math.hpp", content: "int add(int a, int b);" },
            { path: "src/math.cpp", content: '#include "math.hpp"\nint add(int a, int b){ return a + b; }' }
          ],
          stdin: "42\n"
        });

        assert.equal(payload.stdin, "42\n");
        assert.equal(payload.codes.length, 2);
        const headerCode = payload.codes.find((c) => c.file === "math.hpp");
        assert.ok(headerCode, "Debe incluir el header math.hpp en codes");

        const rawOpt = payload["compiler-option-raw"];
        assert.ok(rawOpt.includes("math.cpp"), "Debe incluir el archivo fuente companion en compiler-option-raw para compilación conjunta");
      });

      test("compileAndRunWandbox procesa salida estándar y códigos de estado", async () => {
        const mockFetch = async () => {
          return new Response(
            JSON.stringify({
              status: "0",
              program_output: "Resultado: 42\n",
              program_error: ""
            }),
            { status: 200 }
          );
        };

        const res = await compileAndRunWandbox({ compiler: "gcc-head", code: "..." }, mockFetch);
        assert.equal(res.status, 0);
        assert.equal(res.success, true);
        assert.equal(res.stdout, "Resultado: 42\n");
      });
    });
  });

  describe("Fase 6: Aislamiento C/C++, Detección de Errores GCC y Reemplazo de Código IA", () => {
    describe("Parsea Errores GCC y Señalización de Línea (parseGccErrors)", () => {
      test("parseGccErrors extrae correctamente línea, columna, severidad y mensaje de errores GCC", () => {
        const stderr = "prog.c:12:5: error: expected ';' before '}' token\nmain.c:45:10: fatal error: stdio.h: No such file";
        const errors = parseGccErrors(stderr);
        assert.equal(errors.length, 2);
        assert.equal(errors[0].line, 12);
        assert.equal(errors[0].column, 5);
        assert.equal(errors[0].severity, "error");
        assert.equal(errors[0].message, "expected ';' before '}' token");

        assert.equal(errors[1].line, 45);
        assert.equal(errors[1].column, 10);
        assert.equal(errors[1].severity, "fatal error");
        assert.equal(errors[1].message, "stdio.h: No such file");
      });

      test("parseGccErrors tolera advertencias y líneas sin columna", () => {
        const stderr = "math.cpp:8: warning: unused variable 'contador'\ntest.h:15: error: syntax error";
        const errors = parseGccErrors(stderr);
        assert.equal(errors.length, 2);
        assert.equal(errors[0].line, 8);
        assert.equal(errors[0].severity, "warning");
        assert.equal(errors[0].message, "unused variable 'contador'");

        assert.equal(errors[1].line, 15);
        assert.equal(errors[1].severity, "error");
        assert.equal(errors[1].message, "syntax error");
      });

      test("parseGccErrors devuelve array vacío si la salida no contiene errores o es nula", () => {
        assert.deepEqual(parseGccErrors("Compilación exitosa sin mensajes"), []);
        assert.deepEqual(parseGccErrors(""), []);
        assert.deepEqual(parseGccErrors(null), []);
      });
    });

    describe("Marcadores de Error en el Editor (addErrorMarker / clearErrorMarkers)", async () => {
      test("addErrorMarker registra línea y mensaje; getErrorMarkers devuelve los marcadores activos", async () => {
        const mount = document.createElement("div");
        const editor = await createEditorManager({
          mountEl: mount,
          onDocChange: () => {},
          onSelectionChange: () => {}
        });

        editor.openFile({ id: "main.c", path: "main.c", lang: "c", content: 'int main() {\n  int x = 1\n  return 0;\n}' });
        assert.equal(editor.getErrorMarkers().length, 0);

        editor.addErrorMarker(2, "expected ';' before 'return'");
        const markers = editor.getErrorMarkers();
        assert.equal(markers.length, 1);
        assert.equal(markers[0].lineNum, 2);
        assert.equal(markers[0].errorMessage, "expected ';' before 'return'");

        editor.clearErrorMarkers();
        assert.equal(editor.getErrorMarkers().length, 0);
      });
    });

    describe("Inyector de Código de la IA: Reemplazo Completo sin Escribir en Cursor", async () => {
      test("replaceEntireDocument reemplaza todo el rango del documento (0 a doc.length)", async () => {
        const mount = document.createElement("div");
        let lastContent = "";
        const editor = await createEditorManager({
          mountEl: mount,
          onDocChange: (_, content) => { lastContent = content; },
          onSelectionChange: () => {}
        });

        const initialCode = "function vieja() {\n  return 1;\n}";
        editor.openFile({ id: "app.js", path: "app.js", lang: "js", content: initialCode });

        const nuevoCodigo = "function nueva() {\n  return 42;\n}";
        editor.replaceEntireDocument(nuevoCodigo);

        assert.equal(lastContent, nuevoCodigo);
        assert.ok(!lastContent.includes("vieja"), "No debe quedar código residual del archivo anterior");
      });

      test("replaceSelection sin selección activa reemplaza todo el documento de punta a punta", async () => {
        const mount = document.createElement("div");
        let lastContent = "";
        const editor = await createEditorManager({
          mountEl: mount,
          onDocChange: (_, content) => { lastContent = content; },
          onSelectionChange: () => {}
        });

        editor.openFile({ id: "main.py", path: "main.py", lang: "python", content: "print('viejo')" });

        // Sin selección (cursor colapsado): la acción de reemplazo debe reemplazar todo el documento
        editor.replaceSelection("print('nuevo completo')");
        assert.equal(lastContent, "print('nuevo completo')");
        assert.ok(!lastContent.includes("viejo"));
      });
    });

    describe("Optimización en Repositorios Gigantes y Aislamiento C/C++", () => {
      test("filterFolderScopeFiles excluye carpetas pesadas (node_modules, .git, dist) y archivos lazy", () => {
        const allFiles = [
          { path: "src/app.js", content: "console.log(1);" },
          { path: "src/lazy.js", content: null },
          { path: "src/node_modules/pkg/index.js", content: "module.exports = {};" },
          { path: ".git/HEAD", content: "ref: refs/heads/main" },
          { path: "dist/bundle.js", content: "var a=1;" }
        ];

        const scoped = filterFolderScopeFiles(allFiles, "");
        assert.equal(scoped.length, 1);
        assert.equal(scoped[0].path, "src/app.js");
      });

      test("bundleHtmlWithFolderAssets no incrusta archivos que superan MAX_PREVIEW_ASSET_BYTES (512 KB)", () => {
        const hugeContent = "/* gigante */\n" + "x".repeat(600 * 1024);
        const map = new Map([
          ["styles.css", { path: "styles.css", content: hugeContent }]
        ]);

        const rawHtml = '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head><body>Hola</body></html>';
        const bundled = bundleHtmlWithFolderAssets("index.html", rawHtml, map);

        assert.ok(!bundled.includes(hugeContent), "No debe incrustar assets gigantes para evitar congelamientos");
        assert.ok(bundled.includes('href="styles.css"'), "Conserva la etiqueta link sin congelar el hilo");
      });

      test("mountCRunnerView monta la interfaz interactiva con terminal y stdin sin usar iframes", () => {
        const container = document.createElement("div");
        const instance = mountCRunnerView(container, {
          activeFile: { path: "main.c", shortName: "main.c", content: 'int main(){return 0;}' },
          fetchFn: async () => new Response(JSON.stringify({ status: 0, program_output: "Hola C" }), { status: 200 })
        });

        assert.ok(container.querySelector(".c-runner-shell"), "Debe montar el shell nativo de C Runner");
        assert.ok(container.querySelector(".c-stdin-textarea"), "Debe incluir el textarea de entrada estándar stdin");
        assert.ok(container.querySelector(".c-terminal-card"), "Debe incluir la terminal de ejecución");
        assert.ok(container.querySelector(".c-terminal-input-bar"), "Debe incluir la barra de comandos interactiva paso a paso");
        assert.ok(container.querySelector(".c-terminal-input"), "Debe incluir el input interactivo");
        assert.ok(container.querySelector(".btn-c-send-step"), "Debe incluir el botón de enviar paso");
        assert.ok(container.querySelector(".btn-c-reset-step"), "Debe incluir el botón de reiniciar sesión");
        assert.equal(container.querySelectorAll("iframe").length, 0, "No debe contener ningún iframe HTML");

        instance.destroy();
      });

      test("sanitizeLoopOutput trunca bucles infinitos por EOF y extractNewOutputDelta calcula salida incremental", () => {
        const loopText = "=== MENU ===\nOpcion: \n".repeat(40);
        const sanitized = sanitizeLoopOutput(loopText);
        assert.ok(sanitized.length < loopText.length, "Debe truncar la repetición masiva");
        assert.ok(sanitized.includes("espera tu respuesta"), "Debe incluir el aviso pedagógico");

        const delta = extractNewOutputDelta("Hola mundo\n", "Hola mundo\nNueva linea\n");
        assert.equal(delta, "Nueva linea\n");

        const initialMenu = "=== CALCULADORA EN C ===\n1. Sumar\n2. Salir\nOpcion: ";
        const chunkWithPrematureMenu = "\n[SUMA] Ingrese dos numeros: \n=== CALCULADORA EN C ===\n1. Sumar\n2. Salir\n";
        const trimmed = trimPrematureMenuRepeat(chunkWithPrematureMenu, initialMenu);
        assert.equal(trimmed.includes("=== CALCULADORA EN C ==="), false, "Debe suprimir la reaparición prematura del menú");
        assert.ok(trimmed.includes("[SUMA] Ingrese dos numeros:"), "Conserva el prompt de los números");

        const repeatedMenuInitial = `${initialMenu}\n${initialMenu}\n${initialMenu}`;
        const singleInitial = trimInitialMenuOutput(repeatedMenuInitial);
        assert.equal(singleInitial.split("=== CALCULADORA EN C ===").length - 1, 1, "Debe dejar una sola aparición del menú en paso 0");
      });

      test("hasMainFunction detecta firmas de main e ignora comentarios y prototipos", () => {
        assert.equal(hasMainFunction("int main() { return 0; }"), true);
        assert.equal(hasMainFunction("int main(int argc, char* argv[])\n{\n  return 0;\n}"), true);
        assert.equal(hasMainFunction("void main() {}"), true);
        assert.equal(hasMainFunction("auto main() -> int { return 0; }"), true);
        assert.equal(hasMainFunction("// int main() {\nint foo() { return 1; }"), false);
        assert.equal(hasMainFunction("/* int main() { */\nint foo() { return 1; }"), false);
        assert.equal(hasMainFunction("int domain_search() { return 0; }"), false);
        assert.equal(hasMainFunction("int main();\nint foo() { return 0; }"), false);
        assert.equal(hasMainFunction("int sumar(int a, int b) { return a + b; }"), false);
      });

      test("buildWandboxPayload en archivo .c descarta archivos C++ (.cpp) evitando 'multiple definition of main' y llamadas a libstdc++", () => {
        const activeFile = {
          path: "src/prog.c",
          shortName: "prog.c",
          content: '#include <stdio.h>\nint main() { printf("Hola C\\n"); return 0; }'
        };
        const companionFiles = [
          {
            path: "src/main.cpp",
            shortName: "main.cpp",
            content: '#include <iostream>\n#include <vector>\nint main() { std::cout << "Hola C++"; return 0; }'
          },
          {
            path: "src/vector_helper.hpp",
            shortName: "vector_helper.hpp",
            content: '#pragma once\nclass Helper {};'
          }
        ];

        const payload = buildWandboxPayload({ activeFile, companionFiles });
        assert.equal(payload.compiler, "gcc-head-c");
        assert.equal(payload.options, "c17,warning");
        assert.equal(payload.codes.length, 0, "No debe incluir archivos C++ (.cpp ni .hpp) en una compilación C");
        assert.ok(!payload["compiler-option-raw"].includes("main.cpp"), "No debe pasar main.cpp al compilador gcc de C");
      });

      test("buildWandboxPayload descarta archivos compañeros con su propio main() pero incluye módulos y headers legítimos", () => {
        const activeFile = {
          path: "src/prog.c",
          shortName: "prog.c",
          content: '#include <stdio.h>\n#include "utils.h"\nint main() { printf("%d", sumar(2, 3)); return 0; }'
        };
        const companionFiles = [
          {
            path: "src/utils.h",
            shortName: "utils.h",
            content: 'int sumar(int a, int b);'
          },
          {
            path: "src/utils.c",
            shortName: "utils.c",
            content: 'int sumar(int a, int b) { return a + b; }'
          },
          {
            path: "src/otro_ejercicio.c",
            shortName: "otro_ejercicio.c",
            content: '#include <stdio.h>\nint main() { return 0; }'
          }
        ];

        const payload = buildWandboxPayload({ activeFile, companionFiles });
        assert.equal(payload.codes.length, 2, "Debe incluir utils.h y utils.c en codes");
        const codeFiles = payload.codes.map((c) => c.file);
        assert.ok(codeFiles.includes("utils.h"), "Debe tener utils.h para #include");
        assert.ok(codeFiles.includes("utils.c"), "Debe tener utils.c para enlace");
        assert.ok(!codeFiles.includes("otro_ejercicio.c"), "No debe incluir otro_ejercicio.c porque tiene su propio main()");

        assert.ok(payload["compiler-option-raw"].includes("utils.c"), "utils.c debe compilarse con gcc");
        assert.ok(!payload["compiler-option-raw"].includes("utils.h"), "utils.h no debe pasarse al linker");
        assert.ok(!payload["compiler-option-raw"].includes("otro_ejercicio.c"), "otro_ejercicio.c no debe pasarse al linker");
      });
    });

    describe("Optimización y Precarga de Proyectos Web Grandes y GitHub Lazy en Live Preview", () => {
      test("IGNORED_PREVIEW_DIRS contiene directorios de dependencias y builds pesados", () => {
        assert.ok(IGNORED_PREVIEW_DIRS.has("node_modules"));
        assert.ok(IGNORED_PREVIEW_DIRS.has(".git"));
        assert.ok(IGNORED_PREVIEW_DIRS.has("dist"));
        assert.ok(IGNORED_PREVIEW_DIRS.has("build"));
        assert.ok(IGNORED_PREVIEW_DIRS.has(".next"));
        assert.ok(IGNORED_PREVIEW_DIRS.has(".cache"));
        assert.ok(IGNORED_PREVIEW_DIRS.has("out"));
      });

      test("extractReferencedAssetPaths extrae rutas relativas y absolutas de hojas CSS y scripts JS", () => {
        const html = `
          <!DOCTYPE html>
          <html>
            <head>
              <link rel="stylesheet" href="css/estilos.css">
              <link rel="stylesheet" href="./tokens.css?v=2">
              <link rel="stylesheet" href="/global.css#main">
              <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap.min.css">
              <link rel="icon" href="favicon.ico">
            </head>
            <body>
              <script src="../shared/app.js"></script>
              <script src="./main.js?cache=false"></script>
              <script src="//unpkg.com/vue@3"></script>
              <script>console.log("inline");</script>
            </body>
          </html>
        `;

        const refs = extractReferencedAssetPaths("pages/contacto.html", html);
        // Debe resolver respecto a "pages/"
        assert.ok(refs.includes("pages/css/estilos.css"));
        assert.ok(refs.includes("pages/tokens.css"));
        assert.ok(refs.includes("global.css"));
        assert.ok(refs.includes("shared/app.js"));
        assert.ok(refs.includes("pages/main.js"));
        // No debe incluir CDNs externos
        assert.equal(refs.some((r) => r.includes("jsdelivr") || r.includes("unpkg")), false);
        // No debe incluir favicon ni scripts inline
        assert.equal(refs.some((r) => r.includes("favicon")), false);
      });

      test("extractCssImportPaths extrae reglas @import locales y descarta URLs absolutas", () => {
        const css = `
          @import url("tokens.css");
          @import url('./components/button.css');
          @import '../theme/dark.css';
          @import url("https://fonts.googleapis.com/css?family=Roboto");
          @import url('//cdn.jsdelivr.net/npm/normalize.css');
          body { color: red; }
        `;

        const imports = extractCssImportPaths("css/styles.css", css);
        assert.ok(imports.includes("css/tokens.css"));
        assert.ok(imports.includes("css/components/button.css"));
        assert.ok(imports.includes("theme/dark.css"));
        assert.equal(imports.some((i) => i.includes("googleapis") || i.includes("jsdelivr")), false);
      });

      test("bundleHtmlWithFolderAssets con allowParentTraversal=true incrusta archivos referenciados con ../", () => {
        const fileMap = new Map([
          ["secret.js", { path: "secret.js", content: 'console.log("compartido");' }],
          ["css/estilos.css", { path: "css/estilos.css", content: "body { background: #000; }" }]
        ]);

        const html = '<script src="../secret.js"></script><link rel="stylesheet" href="../css/estilos.css">';
        const out = bundleHtmlWithFolderAssets("subcarpeta/index.html", html, fileMap, null, (c) => c, null, true);

        assert.ok(out.includes('console.log("compartido");'), "Debe incrustar secret.js");
        assert.ok(out.includes("background: #000;"), "Debe incrustar estilos.css");
        assert.ok(!out.includes('src="../secret.js"'), "No debe dejar el script src externo");
      });

      test("bundleHtmlWithFolderAssets inyecta de forma recursiva reglas @import CSS locales", () => {
        const fileMap = new Map([
          ["css/main.css", { path: "css/main.css", content: '@import url("tokens.css");\n@import "./layout.css";\nbody { font-size: 16px; }' }],
          ["css/tokens.css", { path: "css/tokens.css", content: ":root { --brand: #ff0000; }" }],
          ["css/layout.css", { path: "css/layout.css", content: ".container { max-width: 1200px; }" }]
        ]);

        const html = '<link rel="stylesheet" href="css/main.css">';
        const out = bundleHtmlWithFolderAssets("index.html", html, fileMap, null, (c) => c, null, true);

        assert.ok(out.includes("--brand: #ff0000;"), "Debe inlinear tokens.css recursivamente");
        assert.ok(out.includes("max-width: 1200px;"), "Debe inlinear layout.css recursivamente");
        assert.ok(out.includes("font-size: 16px;"), "Debe conservar las reglas de main.css");
        assert.ok(!out.includes('@import url("tokens.css");'), "Debe reemplazar la sentencia @import original");
      });

      test("buildWorkspaceAssetMap mapea rutas normalizadas y atajos shortName", () => {
        const files = [
          { path: "src/index.html", shortName: "index.html", content: "<h1>Hola</h1>" },
          { path: "src/app.js", shortName: "app.js", content: "const a = 1;" }
        ];

        const map = buildWorkspaceAssetMap(files);
        assert.ok(map.has("src/index.html"));
        assert.ok(map.has("src/app.js"));
        assert.ok(map.has("app.js"), "Debe tener alias por shortName para resolución tolerante");
      });
    });

    describe("Evolución Terminal C/C++: Historial de Comandos con Flechas (createTerminalHistory)", () => {
      test("createTerminalHistory agrega comandos válidos y omite duplicados consecutivos o vacíos", () => {
        const history = createTerminalHistory();
        history.push("1");
        history.push("1"); // duplicado consecutivo
        history.push("   "); // vacío
        history.push("10 20");
        history.push("5");

        assert.deepEqual(history.getEntries(), ["1", "10 20", "5"]);
      });

      test("navegación con Flecha Arriba recupera comandos anteriores y preserva borrador inicial", () => {
        const history = createTerminalHistory();
        history.push("1");
        history.push("10 20");
        history.push("5");

        // El usuario está escribiendo un borrador 'calc' y presiona Arriba
        assert.equal(history.navigateUp("calc"), "5");
        assert.equal(history.navigateUp(), "10 20");
        assert.equal(history.navigateUp(), "1");
        // No avanza más allá del primer comando
        assert.equal(history.navigateUp(), "1");

        // Navegación hacia abajo
        assert.equal(history.navigateDown(), "10 20");
        assert.equal(history.navigateDown(), "5");
        // Al final, restaura el borrador que tenía el usuario
        assert.equal(history.navigateDown(), "calc");
      });

      test("clear reinicia entradas y estado de navegación", () => {
        const history = createTerminalHistory();
        history.push("opcion 1");
        history.navigateUp("borrador");
        history.clear();

        assert.deepEqual(history.getEntries(), []);
        assert.equal(history.getIndex(), -1);
      });

      test("mountCRunnerView navega el historial con eventos de teclado ArrowUp y ArrowDown", async () => {
        const container = document.createElement("div");
        const instance = mountCRunnerView(container, {
          activeFile: { path: "main.c", shortName: "main.c", content: "int main(){}" },
          fetchFn: async () => new Response(JSON.stringify({ status: 0, program_output: "Ready" }), { status: 200 })
        });

        // Esperar a que finalice el paso 0 de inicialización
        await new Promise((r) => setTimeout(r, 15));

        const input = container.querySelector(".c-terminal-input");
        const btnSend = container.querySelector(".btn-c-send-step");

        // Enviar dos comandos esperando resolución de fetch
        input.value = "1";
        btnSend.click();
        await new Promise((r) => setTimeout(r, 15));

        input.value = "10 20";
        btnSend.click();
        await new Promise((r) => setTimeout(r, 15));

        // Escribir un texto y presionar ArrowUp
        input.value = "nuevo";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
        assert.equal(input.value, "10 20", "Debe cargar el último comando enviado");

        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
        assert.equal(input.value, "1", "Debe retroceder al comando previo");

        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        assert.equal(input.value, "10 20", "Debe avanzar hacia adelante");

        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        assert.equal(input.value, "nuevo", "Debe restaurar el borrador 'nuevo'");

        instance.destroy();
      });
    });

    describe("Evolución Vista Previa: Recordar último HTML por Proyecto (savePreviewHtml / getSavedPreviewHtml)", () => {
      test("savePreviewHtml persiste y getSavedPreviewHtml recupera la ruta del HTML para cada proyecto", () => {
        const projA = "proj-alpha";
        const projB = "proj-beta";

        savePreviewHtml(projA, "admin/dashboard.html");
        savePreviewHtml(projB, "public/catalogo.html");

        assert.equal(getSavedPreviewHtml(projA), "admin/dashboard.html");
        assert.equal(getSavedPreviewHtml(projB), "public/catalogo.html");
      });

      test("findBestHtmlEntrypoint prioriza el HTML recordado del proyecto sobre index.html genérico", () => {
        const allFiles = [
          { path: "index.html", shortName: "index.html", content: "<html><body>Home</body></html>" },
          { path: "catalogo.html", shortName: "catalogo.html", content: "<html><body>Catalogo</body></html>" },
          { path: "contacto.html", shortName: "contacto.html", content: "<html><body>Contacto</body></html>" }
        ];

        // Sin preferencia, prioriza index.html
        const defaultChoice = findBestHtmlEntrypoint(allFiles, { path: "styles/theme.css", shortName: "theme.css" });
        assert.equal(defaultChoice.path, "index.html");

        // Con preferencia recordada 'catalogo.html', prioriza catalogo.html
        const preferredChoice = findBestHtmlEntrypoint(
          allFiles,
          { path: "styles/theme.css", shortName: "theme.css" },
          "catalogo.html"
        );
        assert.equal(preferredChoice.path, "catalogo.html");
      });
    });

    describe("Evolución Errores C/C++: Líneas de Error Interactivas con Salto al Editor", () => {
      test("mountCRunnerView renderiza líneas de error clickeables y activa onGoToLine en la línea señalada", async () => {
        const container = document.createElement("div");
        let jumpedLine = null;

        const fakeGccStderr = [
          "prog.c: In function 'main':",
          "prog.c:14:5: error: expected ';' before 'return'",
          "   14 |     return 0;",
          "      |     ^~~~~~",
          "prog.c:22:9: warning: unused variable 'x' [-Wunused-variable]"
        ].join("\n");

        const instance = mountCRunnerView(container, {
          activeFile: { path: "prog.c", shortName: "prog.c", content: "int main(){}" },
          onGoToLine(line) {
            jumpedLine = line;
          },
          fetchFn: async () =>
            new Response(
              JSON.stringify({
                status: 1,
                compiler_error: fakeGccStderr,
                compiler_output: "",
                program_output: ""
              }),
              { status: 200 }
            )
        });

        // Esperar la ejecución inicial
        await new Promise((r) => setTimeout(r, 20));

        const banner = container.querySelector(".c-term-err-banner");
        assert.ok(banner, "Debe mostrar el banner informativo de errores");

        const errLines = container.querySelectorAll(".c-term-err-line");
        assert.equal(errLines.length, 2, "Debe renderizar 2 líneas de error/warning interactivas");

        // Simular clic en la segunda línea de error (línea 22)
        errLines[1].click();
        assert.equal(jumpedLine, 22, "Al hacer clic en el warning debe invocar onGoToLine(22)");

        // Simular clic en la primera línea de error (línea 14)
        errLines[0].click();
        assert.equal(jumpedLine, 14, "Al hacer clic en el error debe invocar onGoToLine(14)");

        instance.destroy();
      });
    });

    describe("Persistencia y Respaldo Resiliente de Credenciales (IndexedDB + localStorage)", () => {
      test("saveCredentialsBackup persiste el paquete en IndexedDB y readCredentialsBackup lo recupera intacto", async () => {
        const { saveCredentialsBackup, readCredentialsBackup } = await import("../js/storage/workspaceDb.js");
        const sampleBundle = JSON.stringify({
          gemini: "AIzaSyTest123",
          groq: "gsk_test456",
          githubPat: "github_pat_test789",
          activeProvider: "groq"
        });

        await saveCredentialsBackup(sampleBundle);
        const recovered = await readCredentialsBackup();
        assert.equal(recovered, sampleBundle, "IndexedDB debe devolver exactamente el JSON guardado");
      });

      test("hasStoredCredentials detecta presencia de claves de IA o token de GitHub", async () => {
        const { hasStoredCredentials, saveApiKey, clearApiKey } = await import("../js/ai/providers.js");
        clearApiKey("gemini");
        clearApiKey("groq");
        localStorage.removeItem("ide.github.pat");
        sessionStorage.removeItem("ide.github.pat");

        assert.equal(hasStoredCredentials(), false, "Sin claves ni PAT debe ser false");

        saveApiKey("gemini", "AIzaSyKey");
        assert.equal(hasStoredCredentials(), true, "Con clave Gemini debe ser true");

        clearApiKey("gemini");
        assert.equal(hasStoredCredentials(), false);

        localStorage.setItem("ide.github.pat", "github_pat_valid");
        assert.equal(hasStoredCredentials(), true, "Con GitHub PAT debe ser true");
        localStorage.removeItem("ide.github.pat");
      });

      test("Simulación iPad Safari: si localStorage se vacía por recarga, se restaura desde IndexedDB", async () => {
        const { exportKeysBundle, importKeysBundle, saveApiKey, getApiKey } = await import("../js/ai/providers.js");
        const { saveCredentialsBackup, readCredentialsBackup } = await import("../js/storage/workspaceDb.js");

        // 1. El usuario tiene configurado Gemini y su token de GitHub
        saveApiKey("gemini", "AIzaSyKeyValiosa");
        localStorage.setItem("ide.github.pat", "github_pat_secreto123");
        const bundle = exportKeysBundle();
        await saveCredentialsBackup(bundle);

        // 2. Simular limpieza de Safari en iPadOS (vaciado de localStorage)
        localStorage.clear();
        sessionStorage.clear();
        assert.equal(getApiKey("gemini"), "", "localStorage quedó vacío");
        assert.equal(localStorage.getItem("ide.github.pat"), null, "PAT quedó vacío");

        // 3. Proceso de auto-restauración de Studio IDE al arrancar
        const backupJson = await readCredentialsBackup();
        assert.ok(backupJson, "El respaldo en IndexedDB debe seguir intacto");
        const restoredCount = importKeysBundle(backupJson);

        assert.equal(restoredCount, 2, "Debe haber restaurado 2 credenciales (Gemini y GitHub PAT)");
        assert.equal(getApiKey("gemini"), "AIzaSyKeyValiosa", "La clave de Gemini debe estar restaurada");
        assert.equal(localStorage.getItem("ide.github.pat"), "github_pat_secreto123", "El PAT de GitHub debe estar restaurado");
      });
    });
  });
});
