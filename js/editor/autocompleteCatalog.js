/**
 * Diccionario de vocabulario y funciones estándar por lenguaje para autocompletado instantáneo.
 */
export const LANGUAGE_COMPLETIONS = {
  c: [
    { label: "printf", detail: "stdio.h · imprimir con formato", type: "function" },
    { label: "fprintf", detail: "stdio.h · imprimir en stream", type: "function" },
    { label: "sprintf", detail: "stdio.h · formatear en cadena", type: "function" },
    { label: "snprintf", detail: "stdio.h · formatear seguro con límite", type: "function" },
    { label: "scanf", detail: "stdio.h · leer entrada con formato", type: "function" },
    { label: "fscanf", detail: "stdio.h · leer desde archivo", type: "function" },
    { label: "sscanf", detail: "stdio.h · leer desde cadena", type: "function" },
    { label: "putchar", detail: "stdio.h · escribir carácter", type: "function" },
    { label: "getchar", detail: "stdio.h · leer carácter", type: "function" },
    { label: "puts", detail: "stdio.h · imprimir línea", type: "function" },
    { label: "fgets", detail: "stdio.h · leer línea segura", type: "function" },
    { label: "fopen", detail: "stdio.h · abrir archivo", type: "function" },
    { label: "fclose", detail: "stdio.h · cerrar archivo", type: "function" },
    { label: "fread", detail: "stdio.h · leer bloque binario", type: "function" },
    { label: "fwrite", detail: "stdio.h · escribir bloque binario", type: "function" },
    { label: "fseek", detail: "stdio.h · mover puntero de archivo", type: "function" },
    { label: "ftell", detail: "stdio.h · posición actual en archivo", type: "function" },
    { label: "fflush", detail: "stdio.h · vaciar buffer de salida", type: "function" },
    { label: "malloc", detail: "stdlib.h · reservar memoria dinámica", type: "function" },
    { label: "calloc", detail: "stdlib.h · reservar e inicializar en cero", type: "function" },
    { label: "realloc", detail: "stdlib.h · redimensionar memoria", type: "function" },
    { label: "free", detail: "stdlib.h · liberar memoria dinámica", type: "function" },
    { label: "memcpy", detail: "string.h · copiar bloque de memoria", type: "function" },
    { label: "memmove", detail: "string.h · mover bloque de memoria", type: "function" },
    { label: "memset", detail: "string.h · rellenar bloque de memoria", type: "function" },
    { label: "memcmp", detail: "string.h · comparar bloques de memoria", type: "function" },
    { label: "strlen", detail: "string.h · longitud de cadena", type: "function" },
    { label: "strcpy", detail: "string.h · copiar cadena", type: "function" },
    { label: "strncpy", detail: "string.h · copiar cadena con límite", type: "function" },
    { label: "strcat", detail: "string.h · concatenar cadena", type: "function" },
    { label: "strncat", detail: "string.h · concatenar con límite", type: "function" },
    { label: "strcmp", detail: "string.h · comparar cadenas", type: "function" },
    { label: "strncmp", detail: "string.h · comparar n caracteres", type: "function" },
    { label: "strchr", detail: "string.h · buscar carácter en cadena", type: "function" },
    { label: "strstr", detail: "string.h · buscar subcadena", type: "function" },
    { label: "atoi", detail: "stdlib.h · convertir cadena a int", type: "function" },
    { label: "atof", detail: "stdlib.h · convertir cadena a double", type: "function" },
    { label: "strtol", detail: "stdlib.h · convertir cadena a long", type: "function" },
    { label: "qsort", detail: "stdlib.h · ordenar arreglo (quicksort)", type: "function" },
    { label: "bsearch", detail: "stdlib.h · búsqueda binaria", type: "function" },
    { label: "exit", detail: "stdlib.h · terminar programa", type: "function" },
    { label: "abort", detail: "stdlib.h · abortar ejecución", type: "function" },
    { label: "assert", detail: "assert.h · verificar condición", type: "function" },
    { label: "sizeof", detail: "operador C · tamaño en bytes", type: "keyword" },
    { label: "typedef", detail: "palabra clave · alias de tipo", type: "keyword" },
    { label: "struct", detail: "palabra clave · estructura de datos", type: "keyword" },
    { label: "union", detail: "palabra clave · unión de datos", type: "keyword" },
    { label: "enum", detail: "palabra clave · enumeración", type: "keyword" },
    { label: "return", detail: "palabra clave · retornar valor", type: "keyword" },
    { label: "switch", detail: "palabra clave · selección múltiple", type: "keyword" },
    { label: "case", detail: "palabra clave · rama de switch", type: "keyword" },
    { label: "default", detail: "palabra clave · caso por defecto", type: "keyword" },
    { label: "break", detail: "palabra clave · salir de bloque/bucle", type: "keyword" },
    { label: "continue", detail: "palabra clave · siguiente iteración", type: "keyword" },
    { label: "while", detail: "palabra clave · bucle condicional", type: "keyword" },
    { label: "for", detail: "palabra clave · bucle iterativo", type: "keyword" },
    { label: "static", detail: "palabra clave · alcance estático", type: "keyword" },
    { label: "extern", detail: "palabra clave · símbolo externo", type: "keyword" },
    { label: "const", detail: "palabra clave · valor constante", type: "keyword" },
    { label: "volatile", detail: "palabra clave · variable volátil", type: "keyword" },
    { label: "unsigned", detail: "tipo C · entero sin signo", type: "type" },
    { label: "signed", detail: "tipo C · entero con signo", type: "type" },
    { label: "int", detail: "tipo C · entero", type: "type" },
    { label: "char", detail: "tipo C · carácter / byte", type: "type" },
    { label: "float", detail: "tipo C · punto flotante simple", type: "type" },
    { label: "double", detail: "tipo C · punto flotante doble", type: "type" },
    { label: "void", detail: "tipo C · sin valor / puntero genérico", type: "type" },
    { label: "bool", detail: "stdbool.h · booleano", type: "type" },
    { label: "size_t", detail: "stddef.h · tamaño sin signo", type: "type" },
    { label: "uint8_t", detail: "stdint.h · entero 8 bits sin signo", type: "type" },
    { label: "uint16_t", detail: "stdint.h · entero 16 bits sin signo", type: "type" },
    { label: "uint32_t", detail: "stdint.h · entero 32 bits sin signo", type: "type" },
    { label: "uint64_t", detail: "stdint.h · entero 64 bits sin signo", type: "type" },
    { label: "int32_t", detail: "stdint.h · entero 32 bits con signo", type: "type" },
    { label: "int64_t", detail: "stdint.h · entero 64 bits con signo", type: "type" },
    { label: "NULL", detail: "stddef.h · puntero nulo", type: "constant" },
    { label: "EOF", detail: "stdio.h · fin de archivo", type: "constant" },
    { label: "stdin", detail: "stdio.h · entrada estándar", type: "constant" },
    { label: "stdout", detail: "stdio.h · salida estándar", type: "constant" },
    { label: "stderr", detail: "stdio.h · salida de error", type: "constant" },
    { label: "#include <stdio.h>", detail: "directiva · entrada/salida estándar", type: "keyword" },
    { label: "#include <stdlib.h>", detail: "directiva · memoria y utilidades", type: "keyword" },
    { label: "#include <string.h>", detail: "directiva · funciones de cadenas", type: "keyword" },
    { label: "#include <stdbool.h>", detail: "directiva · tipo bool", type: "keyword" },
    { label: "#include <math.h>", detail: "directiva · funciones matemáticas", type: "keyword" },
    { label: "#define", detail: "directiva · definir macro", type: "keyword" }
  ],
  cpp: [
    { label: "std::cout", detail: "iostream · flujo de salida estándar", type: "variable" },
    { label: "std::cin", detail: "iostream · flujo de entrada estándar", type: "variable" },
    { label: "std::endl", detail: "iostream · salto de línea y flush", type: "function" },
    { label: "std::cerr", detail: "iostream · salida de errores", type: "variable" },
    { label: "std::string", detail: "string · cadena dinámica C++", type: "type" },
    { label: "std::vector", detail: "vector · arreglo dinámico STL", type: "type" },
    { label: "std::map", detail: "map · diccionario ordenado STL", type: "type" },
    { label: "std::unordered_map", detail: "unordered_map · tabla hash STL", type: "type" },
    { label: "std::set", detail: "set · conjunto ordenado STL", type: "type" },
    { label: "std::pair", detail: "utility · par de valores", type: "type" },
    { label: "std::unique_ptr", detail: "memory · puntero único inteligente", type: "type" },
    { label: "std::shared_ptr", detail: "memory · puntero compartido", type: "type" },
    { label: "std::make_unique", detail: "memory · construir unique_ptr", type: "function" },
    { label: "std::make_shared", detail: "memory · construir shared_ptr", type: "function" },
    { label: "std::sort", detail: "algorithm · ordenar rango", type: "function" },
    { label: "std::find", detail: "algorithm · buscar en rango", type: "function" },
    { label: "std::max", detail: "algorithm · valor máximo", type: "function" },
    { label: "std::min", detail: "algorithm · valor mínimo", type: "function" },
    { label: "std::move", detail: "utility · semántica de movimiento", type: "function" },
    { label: "push_back", detail: "STL · agregar elemento al final", type: "function" },
    { label: "emplace_back", detail: "STL · construir elemento al final", type: "function" },
    { label: "pop_back", detail: "STL · quitar último elemento", type: "function" },
    { label: "namespace", detail: "C++ · espacio de nombres", type: "keyword" },
    { label: "using namespace std;", detail: "C++ · importar espacio std", type: "keyword" },
    { label: "template", detail: "C++ · plantilla genérica", type: "keyword" },
    { label: "typename", detail: "C++ · parámetro de tipo", type: "keyword" },
    { label: "class", detail: "C++ · declaración de clase", type: "keyword" },
    { label: "public", detail: "C++ · acceso público", type: "keyword" },
    { label: "private", detail: "C++ · acceso privado", type: "keyword" },
    { label: "protected", detail: "C++ · acceso protegido", type: "keyword" },
    { label: "virtual", detail: "C++ · método polimórfico", type: "keyword" },
    { label: "override", detail: "C++ · sobrescribir método virtual", type: "keyword" },
    { label: "constexpr", detail: "C++ · evaluación en compilación", type: "keyword" },
    { label: "nullptr", detail: "C++ · puntero nulo tipado", type: "constant" },
    { label: "auto", detail: "C++ · deducción automática de tipo", type: "keyword" },
    { label: "#include <iostream>", detail: "directiva · entrada/salida C++", type: "keyword" },
    { label: "#include <vector>", detail: "directiva · contenedor std::vector", type: "keyword" },
    { label: "#include <string>", detail: "directiva · cadena std::string", type: "keyword" },
    { label: "#include <algorithm>", detail: "directiva · algoritmos STL", type: "keyword" }
  ],
  python: [
    { label: "print", detail: "built-in · mostrar en consola", type: "function" },
    { label: "input", detail: "built-in · leer línea del usuario", type: "function" },
    { label: "range", detail: "built-in · secuencia numérica", type: "function" },
    { label: "len", detail: "built-in · longitud de colección", type: "function" },
    { label: "enumerate", detail: "built-in · iterar con índice y valor", type: "function" },
    { label: "zip", detail: "built-in · combinar iterables", type: "function" },
    { label: "sorted", detail: "built-in · devolver lista ordenada", type: "function" },
    { label: "isinstance", detail: "built-in · comprobar tipo de objeto", type: "function" },
    { label: "sum", detail: "built-in · sumar elementos", type: "function" },
    { label: "min", detail: "built-in · valor mínimo", type: "function" },
    { label: "max", detail: "built-in · valor máximo", type: "function" },
    { label: "abs", detail: "built-in · valor absoluto", type: "function" },
    { label: "round", detail: "built-in · redondear número", type: "function" },
    { label: "open", detail: "built-in · abrir archivo", type: "function" },
    { label: "list", detail: "tipo · lista mutable", type: "type" },
    { label: "dict", detail: "tipo · diccionario clave-valor", type: "type" },
    { label: "set", detail: "tipo · conjunto único", type: "type" },
    { label: "tuple", detail: "tipo · tupla inmutable", type: "type" },
    { label: "int", detail: "tipo · entero", type: "type" },
    { label: "float", detail: "tipo · punto flotante", type: "type" },
    { label: "str", detail: "tipo · cadena de texto", type: "type" },
    { label: "bool", detail: "tipo · booleano", type: "type" },
    { label: "def", detail: "palabra clave · definir función", type: "keyword" },
    { label: "return", detail: "palabra clave · devolver resultado", type: "keyword" },
    { label: "class", detail: "palabra clave · definir clase", type: "keyword" },
    { label: "import", detail: "palabra clave · importar módulo", type: "keyword" },
    { label: "from", detail: "palabra clave · importar desde módulo", type: "keyword" },
    { label: "elif", detail: "palabra clave · condición alternativa", type: "keyword" },
    { label: "else", detail: "palabra clave · rama sino", type: "keyword" },
    { label: "while", detail: "palabra clave · bucle condicional", type: "keyword" },
    { label: "for", detail: "palabra clave · bucle sobre iterable", type: "keyword" },
    { label: "break", detail: "palabra clave · terminar bucle", type: "keyword" },
    { label: "continue", detail: "palabra clave · saltar iteración", type: "keyword" },
    { label: "pass", detail: "palabra clave · bloque vacío", type: "keyword" },
    { label: "try", detail: "palabra clave · capturar excepciones", type: "keyword" },
    { label: "except", detail: "palabra clave · manejar excepción", type: "keyword" },
    { label: "finally", detail: "palabra clave · bloque de cierre", type: "keyword" },
    { label: "raise", detail: "palabra clave · lanzar excepción", type: "keyword" },
    { label: "with", detail: "palabra clave · gestor de contexto", type: "keyword" },
    { label: "lambda", detail: "palabra clave · función anónima", type: "keyword" },
    { label: "yield", detail: "palabra clave · generador", type: "keyword" },
    { label: "async", detail: "palabra clave · corrutina asíncrona", type: "keyword" },
    { label: "await", detail: "palabra clave · esperar corrutina", type: "keyword" },
    { label: "True", detail: "constante · verdadero", type: "constant" },
    { label: "False", detail: "constante · falso", type: "constant" },
    { label: "None", detail: "constante · valor nulo", type: "constant" },
    { label: "__init__", detail: "método · constructor de clase", type: "function" },
    { label: "append", detail: "list · agregar al final", type: "function" },
    { label: "split", detail: "str · dividir en lista", type: "function" },
    { label: "join", detail: "str · unir iterable en cadena", type: "function" },
    { label: "strip", detail: "str · quitar espacios extremos", type: "function" },
    { label: "replace", detail: "str · reemplazar subcadena", type: "function" }
  ],
  js: [
    { label: "console.log", detail: "consola · imprimir mensaje", type: "function" },
    { label: "console.error", detail: "consola · imprimir error", type: "function" },
    { label: "console.warn", detail: "consola · imprimir advertencia", type: "function" },
    { label: "function", detail: "JS · declarar función", type: "keyword" },
    { label: "const", detail: "JS · constante de bloque", type: "keyword" },
    { label: "let", detail: "JS · variable de bloque", type: "keyword" },
    { label: "return", detail: "JS · retornar valor", type: "keyword" },
    { label: "async", detail: "JS · función asíncrona", type: "keyword" },
    { label: "await", detail: "JS · esperar promesa", type: "keyword" },
    { label: "Promise", detail: "JS · operación asíncrona", type: "type" },
    { label: "fetch", detail: "Web API · petición HTTP", type: "function" },
    { label: "setTimeout", detail: "Web API · temporizador diferido", type: "function" },
    { label: "clearTimeout", detail: "Web API · cancelar temporizador", type: "function" },
    { label: "setInterval", detail: "Web API · intervalo periódico", type: "function" },
    { label: "requestAnimationFrame", detail: "Web API · cuadro de animación", type: "function" },
    { label: "document.getElementById", detail: "DOM · buscar elemento por ID", type: "function" },
    { label: "document.querySelector", detail: "DOM · buscar primer selector CSS", type: "function" },
    { label: "document.querySelectorAll", detail: "DOM · buscar todos por selector", type: "function" },
    { label: "document.createElement", detail: "DOM · crear nodo HTML", type: "function" },
    { label: "addEventListener", detail: "DOM · escuchar evento", type: "function" },
    { label: "removeEventListener", detail: "DOM · quitar oyente de evento", type: "function" },
    { label: "JSON.stringify", detail: "JSON · serializar objeto a texto", type: "function" },
    { label: "JSON.parse", detail: "JSON · convertir texto a objeto", type: "function" },
    { label: "Object.keys", detail: "Object · arreglo de claves", type: "function" },
    { label: "Object.values", detail: "Object · arreglo de valores", type: "function" },
    { label: "Object.entries", detail: "Object · pares [clave, valor]", type: "function" },
    { label: "Array.isArray", detail: "Array · verificar si es arreglo", type: "function" },
    { label: "Array.from", detail: "Array · crear desde iterable", type: "function" },
    { label: "forEach", detail: "Array · recorrer elementos", type: "function" },
    { label: "map", detail: "Array · transformar elementos", type: "function" },
    { label: "filter", detail: "Array · filtrar elementos", type: "function" },
    { label: "reduce", detail: "Array · acumular en un valor", type: "function" },
    { label: "find", detail: "Array · buscar primer coincidente", type: "function" },
    { label: "includes", detail: "Array/String · comprobar existencia", type: "function" },
    { label: "export", detail: "ESM · exportar módulo", type: "keyword" },
    { label: "import", detail: "ESM · importar módulo", type: "keyword" },
    { label: "default", detail: "JS · exportación/rama por defecto", type: "keyword" },
    { label: "class", detail: "JS · declarar clase", type: "keyword" },
    { label: "constructor", detail: "JS · inicializador de instancia", type: "function" },
    { label: "extends", detail: "JS · heredar de clase", type: "keyword" },
    { label: "typeof", detail: "JS · consultar tipo primitivo", type: "keyword" },
    { label: "instanceof", detail: "JS · verificar prototipo", type: "keyword" },
    { label: "try", detail: "JS · bloque seguro", type: "keyword" },
    { label: "catch", detail: "JS · capturar error", type: "keyword" },
    { label: "finally", detail: "JS · ejecutar siempre al final", type: "keyword" },
    { label: "throw", detail: "JS · lanzar excepción", type: "keyword" },
    { label: "switch", detail: "JS · condicional múltiple", type: "keyword" }
  ],
  ts: [
    { label: "interface", detail: "TS · contrato de tipo", type: "keyword" },
    { label: "type", detail: "TS · alias de tipo", type: "keyword" },
    { label: "readonly", detail: "TS · propiedad inmutable", type: "keyword" },
    { label: "implements", detail: "TS · implementar interfaz", type: "keyword" },
    { label: "private", detail: "TS · miembro privado", type: "keyword" },
    { label: "public", detail: "TS · miembro público", type: "keyword" },
    { label: "protected", detail: "TS · miembro protegido", type: "keyword" },
    { label: "unknown", detail: "TS · tipo seguro desconocido", type: "type" },
    { label: "never", detail: "TS · tipo sin retorno", type: "type" },
    { label: "Record", detail: "TS · mapa tipado Record<K, V>", type: "type" },
    { label: "Partial", detail: "TS · propiedades opcionales", type: "type" }
  ],
  html: [
    { label: "<!DOCTYPE html>", detail: "HTML5 · declaración de documento", type: "keyword" },
    { label: "header", detail: "HTML · encabezado semántico", type: "tag" },
    { label: "nav", detail: "HTML · barra de navegación", type: "tag" },
    { label: "main", detail: "HTML · contenido principal", type: "tag" },
    { label: "section", detail: "HTML · sección temática", type: "tag" },
    { label: "article", detail: "HTML · artículo independiente", type: "tag" },
    { label: "aside", detail: "HTML · panel complementario", type: "tag" },
    { label: "footer", detail: "HTML · pie de página", type: "tag" },
    { label: "button", detail: "HTML · botón interactivo", type: "tag" },
    { label: "input", detail: "HTML · campo de entrada", type: "tag" },
    { label: "textarea", detail: "HTML · área de texto multilínea", type: "tag" },
    { label: "select", detail: "HTML · lista desplegable", type: "tag" },
    { label: "option", detail: "HTML · opción de lista", type: "tag" },
    { label: "dialog", detail: "HTML · ventana modal nativa", type: "tag" },
    { label: "canvas", detail: "HTML · lienzo gráfico 2D/WebGL", type: "tag" },
    { label: "script", detail: "HTML · bloque o módulo JS", type: "tag" },
    { label: "stylesheet", detail: "HTML · hoja de estilos", type: "constant" },
    { label: "placeholder", detail: "atributo · texto de ayuda", type: "property" },
    { label: "aria-label", detail: "accesibilidad · etiqueta lectora", type: "property" }
  ],
  css: [
    { label: "display", detail: "CSS · modelo de caja (flex, grid…)", type: "property" },
    { label: "position", detail: "CSS · posicionamiento", type: "property" },
    { label: "justify-content", detail: "Flex/Grid · alineación eje principal", type: "property" },
    { label: "align-items", detail: "Flex/Grid · alineación eje transversal", type: "property" },
    { label: "flex-direction", detail: "Flex · dirección de fila o columna", type: "property" },
    { label: "grid-template-columns", detail: "Grid · definición de columnas", type: "property" },
    { label: "background-color", detail: "CSS · color de fondo", type: "property" },
    { label: "border-radius", detail: "CSS · redondeo de esquinas", type: "property" },
    { label: "box-shadow", detail: "CSS · sombra de contenedor", type: "property" },
    { label: "transition", detail: "CSS · transición animada", type: "property" },
    { label: "transform", detail: "CSS · transformación geométrica", type: "property" },
    { label: "overflow", detail: "CSS · control de desborde", type: "property" },
    { label: "font-family", detail: "CSS · familia tipográfica", type: "property" },
    { label: "font-size", detail: "CSS · tamaño de fuente", type: "property" },
    { label: "font-weight", detail: "CSS · grosor de fuente", type: "property" },
    { label: "line-height", detail: "CSS · altura de línea", type: "property" },
    { label: "pointer-events", detail: "CSS · interacción de puntero", type: "property" },
    { label: "user-select", detail: "CSS · selección de texto", type: "property" },
    { label: "minmax", detail: "CSS Grid · rango mínimo y máximo", type: "function" },
    { label: "clamp", detail: "CSS · valor fluido acotado", type: "function" },
    { label: "@media", detail: "CSS · consulta de medios responsiva", type: "keyword" }
  ],
  sql: [
    { label: "SELECT", detail: "SQL · consultar columnas", type: "keyword" },
    { label: "FROM", detail: "SQL · tabla de origen", type: "keyword" },
    { label: "WHERE", detail: "SQL · filtrar filas", type: "keyword" },
    { label: "INSERT INTO", detail: "SQL · insertar registros", type: "keyword" },
    { label: "VALUES", detail: "SQL · valores a insertar", type: "keyword" },
    { label: "UPDATE", detail: "SQL · actualizar registros", type: "keyword" },
    { label: "DELETE FROM", detail: "SQL · eliminar registros", type: "keyword" },
    { label: "CREATE TABLE", detail: "SQL · crear tabla", type: "keyword" },
    { label: "ALTER TABLE", detail: "SQL · modificar estructura", type: "keyword" },
    { label: "DROP TABLE", detail: "SQL · eliminar tabla", type: "keyword" },
    { label: "PRIMARY KEY", detail: "SQL · clave primaria", type: "keyword" },
    { label: "FOREIGN KEY", detail: "SQL · clave foránea", type: "keyword" },
    { label: "REFERENCES", detail: "SQL · tabla referenciada", type: "keyword" },
    { label: "AUTOINCREMENT", detail: "SQLite · incremento automático", type: "keyword" },
    { label: "INNER JOIN", detail: "SQL · unión interna", type: "keyword" },
    { label: "LEFT JOIN", detail: "SQL · unión izquierda", type: "keyword" },
    { label: "GROUP BY", detail: "SQL · agrupar resultados", type: "keyword" },
    { label: "HAVING", detail: "SQL · filtrar grupos", type: "keyword" },
    { label: "ORDER BY", detail: "SQL · ordenar filas", type: "keyword" },
    { label: "LIMIT", detail: "SQL · cantidad máxima de filas", type: "keyword" },
    { label: "OFFSET", detail: "SQL · desplazamiento de paginación", type: "keyword" },
    { label: "DISTINCT", detail: "SQL · valores sin duplicados", type: "keyword" },
    { label: "COUNT", detail: "SQL · contar registros", type: "function" },
    { label: "COALESCE", detail: "SQL · primer valor no nulo", type: "function" },
    { label: "INTEGER", detail: "SQL · tipo entero", type: "type" },
    { label: "VARCHAR", detail: "SQL · texto longitud variable", type: "type" }
  ],
  rust: [
    { label: "println!", detail: "macro Rust · imprimir con salto", type: "function" },
    { label: "eprintln!", detail: "macro Rust · imprimir en stderr", type: "function" },
    { label: "format!", detail: "macro Rust · formatear String", type: "function" },
    { label: "vec!", detail: "macro Rust · inicializar vector", type: "function" },
    { label: "struct", detail: "Rust · definir estructura", type: "keyword" },
    { label: "enum", detail: "Rust · tipo algebraico", type: "keyword" },
    { label: "impl", detail: "Rust · bloque de implementación", type: "keyword" },
    { label: "trait", detail: "Rust · interfaz de comportamiento", type: "keyword" },
    { label: "match", detail: "Rust · coincidencia de patrones", type: "keyword" },
    { label: "Option", detail: "std · valor opcional Some/None", type: "type" },
    { label: "Result", detail: "std · resultado Ok/Err", type: "type" },
    { label: "String", detail: "std · cadena en heap", type: "type" },
    { label: "Vec", detail: "std · vector dinámico", type: "type" },
    { label: "unwrap", detail: "Result/Option · extraer valor", type: "function" },
    { label: "expect", detail: "Result/Option · extraer con mensaje", type: "function" },
    { label: "return", detail: "Rust · retornar valor", type: "keyword" }
  ],
  go: [
    { label: "fmt.Println", detail: "fmt · imprimir línea", type: "function" },
    { label: "fmt.Printf", detail: "fmt · imprimir con formato", type: "function" },
    { label: "fmt.Sprintf", detail: "fmt · formatear cadena", type: "function" },
    { label: "package", detail: "Go · declarar paquete", type: "keyword" },
    { label: "import", detail: "Go · importar paquetes", type: "keyword" },
    { label: "func", detail: "Go · declarar función", type: "keyword" },
    { label: "return", detail: "Go · retornar valores", type: "keyword" },
    { label: "struct", detail: "Go · definir estructura", type: "keyword" },
    { label: "interface", detail: "Go · definir interfaz", type: "keyword" },
    { label: "defer", detail: "Go · posponer hasta el cierre", type: "keyword" },
    { label: "range", detail: "Go · iterar colección", type: "keyword" },
    { label: "append", detail: "built-in · agregar a slice", type: "function" },
    { label: "make", detail: "built-in · inicializar slice/map/chan", type: "function" }
  ],
  java: [
    { label: "System.out.println", detail: "Java · imprimir línea en consola", type: "function" },
    { label: "System.out.printf", detail: "Java · imprimir con formato", type: "function" },
    { label: "public", detail: "Java · visibilidad pública", type: "keyword" },
    { label: "private", detail: "Java · visibilidad privada", type: "keyword" },
    { label: "protected", detail: "Java · visibilidad protegida", type: "keyword" },
    { label: "class", detail: "Java · declarar clase", type: "keyword" },
    { label: "interface", detail: "Java · declarar interfaz", type: "keyword" },
    { label: "extends", detail: "Java · heredar de clase", type: "keyword" },
    { label: "implements", detail: "Java · implementar interfaz", type: "keyword" },
    { label: "static", detail: "Java · miembro de clase", type: "keyword" },
    { label: "final", detail: "Java · constante / no sobrescribible", type: "keyword" },
    { label: "return", detail: "Java · retornar valor", type: "keyword" },
    { label: "String", detail: "java.lang · cadena de texto", type: "type" },
    { label: "ArrayList", detail: "java.util · lista dinámica", type: "type" },
    { label: "HashMap", detail: "java.util · mapa hash", type: "type" }
  ],
  csharp: [
    { label: "Console.WriteLine", detail: "System · imprimir línea", type: "function" },
    { label: "Console.Write", detail: "System · imprimir sin salto", type: "function" },
    { label: "namespace", detail: "C# · espacio de nombres", type: "keyword" },
    { label: "using", detail: "C# · directiva o bloque de recurso", type: "keyword" },
    { label: "public", detail: "C# · acceso público", type: "keyword" },
    { label: "private", detail: "C# · acceso privado", type: "keyword" },
    { label: "class", detail: "C# · declarar clase", type: "keyword" },
    { label: "interface", detail: "C# · declarar interfaz", type: "keyword" },
    { label: "async", detail: "C# · método asíncrono", type: "keyword" },
    { label: "await", detail: "C# · esperar Task", type: "keyword" },
    { label: "return", detail: "C# · retornar valor", type: "keyword" },
    { label: "List", detail: "Collections.Generic · lista tipada", type: "type" },
    { label: "Dictionary", detail: "Collections.Generic · diccionario", type: "type" }
  ]
};

/**
 * Extrae el fragmento de palabra o directiva inmediatamente anterior a la posición del cursor.
 * @param {string} docText
 * @param {number} cursorOffset
 * @returns {{ word: string, from: number, to: number }}
 */
export function extractWordBeforeCursor(docText, cursorOffset) {
  const safeDoc = String(docText ?? "");
  const pos = Math.min(Math.max(0, Number(cursorOffset) || 0), safeDoc.length);
  // Si el carácter inmediatamente posterior al cursor es alfanumérico, no estamos al final de la palabra
  if (pos < safeDoc.length && /[A-Za-z0-9_]/.test(safeDoc[pos])) {
    return { word: "", from: pos, to: pos };
  }
  const before = safeDoc.slice(0, pos);
  const match = before.match(/(#?[A-Za-z_][A-Za-z0-9_:.!-]*)$/);
  if (!match) {
    return { word: "", from: pos, to: pos };
  }
  const word = match[1];
  return {
    word,
    from: pos - word.length,
    to: pos
  };
}

/**
 * Distancia de edición Damerau-Levenshtein acotada para detectar similitud en prefijos de 3+ letras.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function computeEditDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

/**
 * Calcula un puntaje de coincidencia (0 a 100) entre lo que el usuario está escribiendo (query)
 * y una palabra candidata del lenguaje o del archivo.
 * Soporta prefijos exactos (`prin` -> `printf`), miembros (`cout` -> `std::cout`),
 * subcadenas (`prin` -> `fprintf`) y similitud difusa de 3+ letras (`prinf` -> `printf`).
 *
 * @param {string} query
 * @param {string} candidateLabel
 * @returns {number}
 */
export function scoreCompletionMatch(query, candidateLabel) {
  const q = String(query || "").trim().toLowerCase();
  const c = String(candidateLabel || "").trim().toLowerCase();
  if (!q || !c || q === c) return 0;

  // 1. Coincidencia exacta de prefijo (ej: "prin" -> "printf")
  if (c.startsWith(q)) {
    return 100 - Math.min(25, c.length - q.length);
  }

  // 2. Coincidencia sin el "#" inicial o tras "::", ".", " " o "<" (ej: "inc" -> "#include <stdio.h>", "cout" -> "std::cout")
  const stripped = c.replace(/^#/, "");
  if (stripped.startsWith(q)) {
    return 92 - Math.min(25, stripped.length - q.length);
  }

  const segments = c.split(/(?:::|\.|\s+|<|>)/).filter(Boolean);
  for (const seg of segments) {
    if (seg !== q && seg.startsWith(q)) {
      return 86 - Math.min(20, seg.length - q.length);
    }
  }

  // 3. Coincidencia de subcadena directa con 2+ letras (ej: "prin" dentro de "fprintf" o "sprintf")
  if (q.length >= 2) {
    const idx = c.indexOf(q);
    if (idx !== -1) {
      return 74 - Math.min(18, idx * 2) - Math.min(15, c.length - q.length);
    }
  }

  // 4. A partir de 3 letras: subsecuencia en orden o similitud por distancia de edición (typos)
  if (q.length >= 3) {
    const targetWord = segments[segments.length - 1] || stripped;
    if (targetWord[0] === q[0]) {
      // 4a. Subsecuencia ordenada con la misma inicial (ej: "prtf" -> "printf", "scnf" -> "scanf")
      let qi = 0;
      for (let ci = 0; ci < targetWord.length && qi < q.length; ci++) {
        if (targetWord[ci] === q[qi]) qi++;
      }
      if (qi === q.length) {
        return 62 - Math.min(20, targetWord.length - q.length);
      }

      // 4b. Similitud con el prefijo o palabra completa (ej: "prinf" -> "printf", "retrun" -> "return")
      const prefixSlice = targetWord.slice(0, Math.min(targetWord.length, q.length + 1));
      const distPrefix = computeEditDistance(q, prefixSlice);
      const distFull = computeEditDistance(q, targetWord);
      const bestDist = Math.min(distPrefix, distFull);
      const maxAllowed = q.length >= 5 ? 2 : 1;
      if (bestDist <= maxAllowed) {
        return 54 - bestDist * 10 - Math.min(12, Math.abs(targetWord.length - q.length));
      }
    }
  }

  return 0;
}

/**
 * Obtiene la lista ordenada de sugerencias de autocompletado para el lenguaje activo y el documento actual.
 * En C++ incluye tanto el vocabulario de C++ como las funciones estándar de C (`printf`, `scanf`, etc.).
 *
 * @param {string} lang
 * @param {string} query
 * @param {string} [docText=""]
 * @param {number} [limit=8]
 * @returns {Array<{ label: string, apply: string, detail: string, type: string, score: number }>}
 */
export function getLanguageCompletions(lang, query, docText = "", limit = 8) {
  const cleanQuery = String(query || "").trim();
  if (cleanQuery.length < 2) return [];

  const normalizedLang =
    lang === "tsx" || lang === "typescript" ? "ts"
    : lang || "js";

  const pool = [];
  if (LANGUAGE_COMPLETIONS[normalizedLang]) {
    pool.push(...LANGUAGE_COMPLETIONS[normalizedLang]);
  }
  if (normalizedLang === "cpp" && LANGUAGE_COMPLETIONS.c) {
    pool.push(...LANGUAGE_COMPLETIONS.c);
  }
  if (normalizedLang === "ts" && LANGUAGE_COMPLETIONS.js) {
    pool.push(...LANGUAGE_COMPLETIONS.js);
  }

  const seen = new Set();
  const scored = [];

  for (const item of pool) {
    if (seen.has(item.label)) continue;
    const score = scoreCompletionMatch(cleanQuery, item.label);
    if (score > 0) {
      seen.add(item.label);
      scored.push({
        label: item.label,
        apply: item.label,
        detail: item.detail || "",
        type: item.type || "keyword",
        score: score + 5 // Prioridad leve para palabras estándar del lenguaje
      });
    }
  }

  // Extraer también identificadores definidos por el usuario en el archivo actual
  if (docText && typeof docText === "string") {
    const matches = docText.match(/[A-Za-z_][A-Za-z0-9_]{2,50}/g) || [];
    for (const word of matches) {
      if (seen.has(word) || word === cleanQuery) continue;
      const score = scoreCompletionMatch(cleanQuery, word);
      if (score > 0) {
        seen.add(word);
        scored.push({
          label: word,
          apply: word,
          detail: "en este archivo",
          type: "variable",
          score
        });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length || a.label.localeCompare(b.label));
  return scored.slice(0, Math.max(1, limit));
}

/**
 * Controlador visual de la barra inferior de sugerencias en vivo (`#editor-autocomplete-bar`),
 * que muestra opciones para elegir con un toque o con Tab mientras el usuario escribe.
 */
export function createAutocompleteBarController({ mountEl, onAccept }) {
  let barEl = typeof document !== "undefined" ? document.getElementById("editor-autocomplete-bar") : null;
  let trackEl = typeof document !== "undefined" ? document.getElementById("editor-autocomplete-track") : null;
  let createdLocally = false;

  if (!barEl && mountEl && typeof document !== "undefined") {
    barEl = document.createElement("div");
    barEl.className = "editor-autocomplete-bar";
    barEl.setAttribute("role", "region");
    barEl.setAttribute("aria-label", "Sugerencias de autocompletado");
    barEl.hidden = true;

    const hintEl = document.createElement("span");
    hintEl.className = "editor-autocomplete-hint";
    hintEl.textContent = "Sugerencias";

    trackEl = document.createElement("div");
    trackEl.className = "editor-autocomplete-track";

    barEl.append(hintEl, trackEl);
    const parent = mountEl.parentElement || mountEl;
    parent.appendChild(barEl);
    createdLocally = true;
  }

  let currentItems = [];
  let selectedIndex = 0;
  let currentWordRange = { word: "", from: 0, to: 0 };

  function update(items, wordRange) {
    currentItems = Array.isArray(items) ? items : [];
    currentWordRange = wordRange || { word: "", from: 0, to: 0 };
    selectedIndex = 0;

    if (!barEl || !trackEl) return;

    if (currentItems.length === 0) {
      barEl.hidden = true;
      trackEl.innerHTML = "";
      return;
    }

    barEl.hidden = false;
    renderPills();
  }

  function renderPills() {
    if (!trackEl) return;
    trackEl.innerHTML = "";
    currentItems.slice(0, 6).forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = idx === selectedIndex
        ? "editor-autocomplete-pill is-selected"
        : "editor-autocomplete-pill";
      btn.setAttribute("aria-label", `Autocompletar ${item.label}`);
      btn.title = item.detail ? `${item.label} (${item.detail})` : item.label;

      const labelSpan = document.createElement("span");
      labelSpan.className = "editor-autocomplete-label code-font";
      labelSpan.textContent = item.label;
      btn.appendChild(labelSpan);

      if (item.detail) {
        const detailSpan = document.createElement("span");
        detailSpan.className = "editor-autocomplete-detail";
        detailSpan.textContent = item.detail.split("·")[0].trim();
        btn.appendChild(detailSpan);
      }

      if (idx === selectedIndex) {
        const kbd = document.createElement("kbd");
        kbd.className = "editor-autocomplete-kbd";
        kbd.textContent = "Tab";
        btn.appendChild(kbd);
      }

      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        onAccept(item, currentWordRange);
      });

      trackEl.appendChild(btn);
    });
  }

  function hide() {
    currentItems = [];
    selectedIndex = 0;
    if (barEl) barEl.hidden = true;
    if (trackEl) trackEl.innerHTML = "";
  }

  function moveSelection(delta) {
    if (currentItems.length === 0) return false;
    const max = Math.min(6, currentItems.length);
    selectedIndex = (selectedIndex + delta + max) % max;
    renderPills();
    return true;
  }

  function acceptCurrent() {
    if (currentItems.length === 0) return false;
    const chosen = currentItems[selectedIndex] || currentItems[0];
    if (!chosen) return false;
    onAccept(chosen, currentWordRange);
    return true;
  }

  return {
    update,
    hide,
    moveSelection,
    acceptCurrent,
    isOpen: () => currentItems.length > 0,
    getItems: () => [...currentItems],
    destroy() {
      hide();
      if (createdLocally && barEl?.parentElement) {
        barEl.remove();
      }
    }
  };
}
