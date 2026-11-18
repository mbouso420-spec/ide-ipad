/**
 * Semilla inicial del espacio de trabajo y catálogo de plantillas de proyectos locales.
 */

import { escapeHtml } from "../../utils/dom.js";
import { makeFileKey } from "./dbCore.js";

export const SEED_ENTRIES = [
  {
    path: "src/main.cpp",
    content: `#include <iostream>\n#include <vector>\n\nstd::size_t calcularBuffer(std::size_t bloques) {\n    return bloques * 1024ULL;\n}\n\nint main() {\n    std::vector<int> datos = {4, 8, 16, 32};\n    std::cout << "Buffer listo: " << calcularBuffer(datos.size()) << "\\n";\n    return 0;\n}\n`
  },
  {
    path: "web/index.html",
    content: `<!DOCTYPE html>\n<html lang="es">\n<head>\n  <meta charset="UTF-8" />\n  <title>Demo App</title>\n  <link rel="stylesheet" href="./styles.css" />\n</head>\n<body>\n  <main class="contenedor">\n    <h1>Hola desde el iPad</h1>\n    <p id="salida">Probando vista previa en vivo.</p>\n  </main>\n  <script src="./app.js"></script>\n</body>\n</html>\n`
  },
  {
    path: "web/styles.css",
    content: `:root {\n  --acento: oklch(52% 0.165 252);\n}\n\nbody {\n  font-family: system-ui, sans-serif;\n  margin: 0;\n  background: #11151d;\n  color: #eef2f8;\n}\n\n.contenedor {\n  max-width: 960px;\n  margin-inline: auto;\n  padding: 24px;\n}\n`
  },
  {
    path: "web/app.js",
    content: `const saludar = (nombre) => {\n  return \`Bienvenido al proyecto, \${nombre}\`;\n};\n\nconsole.log(saludar("Dev"));\n`
  },
  {
    path: "scripts/ejemplo.py",
    content: `def resumen_notas(notas):\n    promedio = sum(notas) / len(notas)\n    return round(promedio, 2)\n\nvalores = [8, 9, 10, 7, 9]\nprint("Notas:", valores)\nprint("Promedio final:", resumen_notas(valores))\n`
  },
  {
    path: "db/schema.sql",
    content: `CREATE TABLE proyectos (\n    id INTEGER PRIMARY KEY,\n    nombre TEXT NOT NULL,\n    actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\n\nSELECT id, nombre\nFROM proyectos\nWHERE id = 1;\n`
  }
];

function escapeCString(str) {
  return String(str || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

export const PROJECT_TEMPLATES = [
  {
    id: "web",
    name: "Web Estática",
    description: "HTML5, CSS3 y JavaScript con vista previa en vivo.",
    filesPreview: ["index.html", "styles.css", "app.js"]
  },
  {
    id: "ts",
    name: "TypeScript + Módulos ES",
    description: "Proyecto tipado con módulos locales 100% offline.",
    filesPreview: ["index.html", "src/main.ts", "src/utils.ts"]
  },
  {
    id: "python",
    name: "Python 3",
    description: "Script Python en WebAssembly (Pyodide) + datos JSON.",
    filesPreview: ["main.py", "datos.json"]
  },
  {
    id: "sql",
    name: "SQLite Playground",
    description: "Tablas, datos de prueba y consultas SQL en memoria.",
    filesPreview: ["schema.sql"]
  },
  {
    id: "c",
    name: "C / C++ Multi-archivo",
    description: "Programa modular con cabecera .h y fuentes .c.",
    filesPreview: ["main.c", "utils.h", "utils.c"]
  }
];

/**
 * Construye las entradas iniciales (carpetas y archivos) y pestañas abiertas según la plantilla elegida.
 * Si `templateId` es nulo/desconocido, conserva el preset clásico `main.cpp` por retrocompatibilidad.
 */
export function buildProjectTemplatePayload(projectId, cleanName, templateId, now) {
  const safeHtmlName = escapeHtml(cleanName);
  const safeCName = escapeCString(cleanName);

  let files = [];
  let folders = [];
  let openTabIds = [];
  let activeFileId = null;

  switch (templateId) {
    case "web":
      files = [
        {
          path: "index.html",
          content:
            `<!DOCTYPE html>\n<html lang="es">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${safeHtmlName}</title>\n  <link rel="stylesheet" href="./styles.css" />\n</head>\n<body>\n  <main class="card">\n    <h1>${safeHtmlName}</h1>\n    <p id="mensaje">Listo para editar en tiempo real.</p>\n    <button type="button" id="btn-accion">Probar interacción</button>\n  </main>\n  <script src="./app.js"></script>\n</body>\n</html>\n`
        },
        {
          path: "styles.css",
          content:
            `:root {\n  color-scheme: dark;\n  --accent: #6aa6ff;\n}\n\nbody {\n  margin: 0;\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  font-family: system-ui, sans-serif;\n  background: #0f131b;\n  color: #edf2fa;\n}\n\n.card {\n  padding: 24px 28px;\n  border-radius: 12px;\n  background: #171d29;\n  border: 1px solid #2b3447;\n}\n\nbutton {\n  margin-top: 12px;\n  padding: 8px 14px;\n  border-radius: 8px;\n  border: 0;\n  background: var(--accent);\n  color: #0b1019;\n  font-weight: 600;\n  cursor: pointer;\n}\n`
        },
        {
          path: "app.js",
          content:
            `const btn = document.getElementById("btn-accion");\nconst msg = document.getElementById("mensaje");\nlet clicks = 0;\n\nbtn?.addEventListener("click", () => {\n  clicks += 1;\n  if (msg) msg.textContent = \`Interacción #\${clicks} ejecutada correctamente.\`;\n  console.log("Click:", clicks);\n});\n`
        }
      ];
      openTabIds = ["index.html", "styles.css", "app.js"];
      activeFileId = "index.html";
      break;

    case "ts":
      folders = ["src"];
      files = [
        {
          path: "index.html",
          content:
            `<!DOCTYPE html>\n<html lang="es">\n<head>\n  <meta charset="UTF-8" />\n  <title>${safeHtmlName}</title>\n</head>\n<body>\n  <main>\n    <h1>${safeHtmlName} (TypeScript)</h1>\n    <pre id="app-salida"></pre>\n  </main>\n  <script type="module" src="./src/main.ts"></script>\n</body>\n</html>\n`
        },
        {
          path: "src/utils.ts",
          content:
            `export interface Resumen {\n  proyecto: string;\n  items: number;\n  total: number;\n}\n\nexport function calcularResumen(proyecto: string, valores: number[]): Resumen {\n  const total = valores.reduce((acc, n) => acc + n, 0);\n  return { proyecto, items: valores.length, total };\n}\n`
        },
        {
          path: "src/main.ts",
          content:
            `import { calcularResumen } from "./utils.js";\n\nconst resumen = calcularResumen(${JSON.stringify(cleanName)}, [10, 25, 40]);\nconsole.log("Resumen TS:", resumen);\n\nconst out = document.getElementById("app-salida");\nif (out) {\n  out.textContent = JSON.stringify(resumen, null, 2);\n}\n`
        }
      ];
      openTabIds = ["src/main.ts", "src/utils.ts", "index.html"];
      activeFileId = "src/main.ts";
      break;

    case "python":
      files = [
        {
          path: "main.py",
          content:
            `import json\n\nwith open("datos.json", "r", encoding="utf-8") as f:\n    datos = json.load(f)\n\nproyecto = datos.get("proyecto", ${JSON.stringify(cleanName)})\nvalores = datos.get("valores", [])\npromedio = round(sum(valores) / len(valores), 2) if valores else 0\n\nprint(f"Proyecto: {proyecto}")\nprint(f"Elementos: {len(valores)} | Promedio: {promedio}")\n`
        },
        {
          path: "datos.json",
          content:
            JSON.stringify(
              {
                proyecto: cleanName,
                valores: [12, 18, 25, 30, 15]
              },
              null,
              2
            ) + "\n"
        }
      ];
      openTabIds = ["main.py", "datos.json"];
      activeFileId = "main.py";
      break;

    case "sql":
      files = [
        {
          path: "schema.sql",
          content:
            `-- Playground SQLite para ${cleanName}\nCREATE TABLE usuarios (\n  id INTEGER PRIMARY KEY,\n  nombre TEXT NOT NULL,\n  rol TEXT NOT NULL\n);\n\nINSERT INTO usuarios (nombre, rol) VALUES\n  ('Ada Lovelace', 'Arquitectura'),\n  ('Alan Turing', 'Algoritmos'),\n  ('Grace Hopper', 'Compiladores');\n\nSELECT id, nombre, rol\nFROM usuarios\nORDER BY id ASC;\n`
        }
      ];
      openTabIds = ["schema.sql"];
      activeFileId = "schema.sql";
      break;

    case "c":
      files = [
        {
          path: "main.c",
          content:
            `#include <stdio.h>\n#include "utils.h"\n\nint main(void) {\n    int resultado = sumar_rango(1, 5);\n    printf("Proyecto: ${safeCName}\\n");\n    printf("Suma 1..5 = %d\\n", resultado);\n    return 0;\n}\n`
        },
        {
          path: "utils.h",
          content:
            `#ifndef UTILS_H\n#define UTILS_H\n\nint sumar_rango(int inicio, int fin);\n\n#endif\n`
        },
        {
          path: "utils.c",
          content:
            `#include "utils.h"\n\nint sumar_rango(int inicio, int fin) {\n    int suma = 0;\n    for (int i = inicio; i <= fin; i++) {\n        suma += i;\n    }\n    return suma;\n}\n`
        }
      ];
      openTabIds = ["main.c", "utils.h", "utils.c"];
      activeFileId = "main.c";
      break;

    default:
      files = [
        {
          path: "main.cpp",
          content: `#include <iostream>\n\nint main() {\n    std::cout << "Proyecto ${safeCName}\\n";\n    return 0;\n}\n`
        }
      ];
      openTabIds = ["main.cpp"];
      activeFileId = "main.cpp";
      break;
  }

  const records = [];
  for (const folderPath of folders) {
    records.push({
      key: makeFileKey(projectId, folderPath),
      projectId,
      path: folderPath,
      isFolder: true,
      content: "",
      baseContent: "",
      contentLoaded: true,
      deleted: false,
      updatedAt: now
    });
  }
  for (const item of files) {
    records.push({
      key: makeFileKey(projectId, item.path),
      projectId,
      path: item.path,
      isFolder: false,
      content: item.content,
      baseContent: "",
      contentLoaded: true,
      deleted: false,
      updatedAt: now
    });
  }

  return {
    openTabIds,
    activeFileId,
    records
  };
}
