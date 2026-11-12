/**
 * Transpilador ligero 100% offline de TypeScript y JSX a JavaScript ejecutable en navegador.
 * Usa un tokenizador léxico para evitar dañar literales de texto, template strings,
 * expresiones regulares, comentarios u objetos literales.
 */

const JSX_RUNTIME_HELPER = `const __studioFragment = Symbol.for("studio.jsx.fragment");
function __studioJsx(type, props) {
  var children = [];
  for (var i = 2; i < arguments.length; i += 1) {
    children.push(arguments[i]);
  }
  if (typeof React !== "undefined" && React && typeof React.createElement === "function") {
    var reactType = type === __studioFragment && React.Fragment ? React.Fragment : type;
    return React.createElement.apply(React, [reactType, props].concat(children));
  }
  if (typeof type === "function") {
    var compProps = Object.assign({}, props || {});
    if (children.length === 1) compProps.children = children[0];
    else if (children.length > 1) compProps.children = children;
    return type(compProps);
  }
  if (typeof document === "undefined") {
    return { type: type, props: props || {}, children: children };
  }
  if (type === __studioFragment) {
    var frag = document.createDocumentFragment();
    __studioAppendChildren(frag, children);
    return frag;
  }
  var el = document.createElement(String(type));
  if (props) {
    var keys = Object.keys(props);
    for (var k = 0; k < keys.length; k += 1) {
      var key = keys[k];
      var val = props[key];
      if (val === null || val === undefined || val === false) continue;
      if (key === "className") {
        el.className = String(val);
      } else if (key === "style" && typeof val === "object") {
        Object.assign(el.style, val);
      } else if (key.indexOf("on") === 0 && typeof val === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (val === true) {
        el.setAttribute(key, "");
      } else {
        el.setAttribute(key, String(val));
      }
    }
  }
  __studioAppendChildren(el, children);
  return el;
}
function __studioAppendChildren(parent, list) {
  for (var i = 0; i < list.length; i += 1) {
    var child = list[i];
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      __studioAppendChildren(parent, child);
    } else if (typeof Node !== "undefined" && child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}
`;

const EXPR_BEFORE_REGEX_KEYWORDS = new Set([
  "return",
  "throw",
  "yield",
  "await",
  "case",
  "else",
  "typeof",
  "void",
  "delete",
  "in",
  "of",
  "instanceof",
  "new",
  "export",
  "default"
]);

const EXPR_START_KEYWORDS = new Set([
  "return",
  "throw",
  "yield",
  "await",
  "case",
  "else",
  "default",
  "export"
]);

const MODIFIER_KEYWORDS = new Set([
  "public",
  "private",
  "protected",
  "readonly",
  "override",
  "abstract",
  "declare"
]);

function canStartRegex(prevToken) {
  if (!prevToken) return true;
  if (prevToken.type === "ident") return EXPR_BEFORE_REGEX_KEYWORDS.has(prevToken.value);
  if (prevToken.type === "punct") {
    return (
      prevToken.value !== ")" &&
      prevToken.value !== "]" &&
      prevToken.value !== "}" &&
      prevToken.value !== "++" &&
      prevToken.value !== "--"
    );
  }
  return false;
}

const THREE_CHAR_OPS = new Set(["===", "!==", ">>>", "<<=", ">>=", "**=", "...", "&&=", "||=", "??="]);
const TWO_CHAR_OPS = new Set([
  "=>",
  "?.",
  "??",
  "&&",
  "||",
  "<=",
  ">=",
  "==",
  "!=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**",
  "<<",
  ">>",
  "++",
  "--",
  "::"
]);

function tokenize(source) {
  const tokens = [];
  const len = source.length;
  let i = 0;
  let lastSig = null;
  const tmplBraceStack = [];

  function scanTemplatePiece(isHead) {
    let val = isHead ? "`" : "}";
    if (!isHead) i += 1;
    else i += 1;
    while (i < len) {
      const ch = source[i];
      if (ch === "\\") {
        val += ch + (source[i + 1] || "");
        i += 2;
        continue;
      }
      if (ch === "`") {
        val += "`";
        i += 1;
        tokens.push({ type: isHead ? "template_full" : "template_tail", value: val });
        lastSig = tokens[tokens.length - 1];
        return;
      }
      if (ch === "$" && source[i + 1] === "{") {
        val += "${";
        i += 2;
        tokens.push({ type: isHead ? "template_head" : "template_mid", value: val });
        lastSig = tokens[tokens.length - 1];
        tmplBraceStack.push(0);
        return;
      }
      val += ch;
      i += 1;
    }
    tokens.push({ type: isHead ? "template_full" : "template_tail", value: val });
    lastSig = tokens[tokens.length - 1];
  }

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1] || "";

    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < len && /\s/.test(source[j])) j += 1;
      tokens.push({ type: "ws", value: source.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < len && source[j] !== "\n") j += 1;
      tokens.push({ type: "comment", value: source.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "/" && next === "*") {
      const closeIdx = source.indexOf("*/", i + 2);
      const j = closeIdx === -1 ? len : closeIdx + 2;
      tokens.push({ type: "comment", value: source.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      const tok = { type: "string", value: source.slice(i, j) };
      tokens.push(tok);
      lastSig = tok;
      i = j;
      continue;
    }

    if (ch === "`") {
      scanTemplatePiece(true);
      continue;
    }

    if (ch === "/" && canStartRegex(lastSig)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < len && source[j] !== "\n") {
        const rc = source[j];
        if (rc === "\\") {
          j += 2;
          continue;
        }
        if (rc === "[") inClass = true;
        else if (rc === "]" && inClass) inClass = false;
        else if (rc === "/" && !inClass) {
          closed = true;
          j += 1;
          while (j < len && /[a-z]/i.test(source[j])) j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        const tok = { type: "regex", value: source.slice(i, j) };
        tokens.push(tok);
        lastSig = tok;
        i = j;
        continue;
      }
    }

    if (ch === "}" && tmplBraceStack.length > 0 && tmplBraceStack[tmplBraceStack.length - 1] === 0) {
      tmplBraceStack.pop();
      scanTemplatePiece(false);
      continue;
    }

    if (tmplBraceStack.length > 0) {
      if (ch === "{") tmplBraceStack[tmplBraceStack.length - 1] += 1;
      else if (ch === "}") tmplBraceStack[tmplBraceStack.length - 1] -= 1;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < len && /[0-9a-fA-FxXoObBn._eE]/.test(source[j])) {
        if ((source[j] === "e" || source[j] === "E") && (source[j + 1] === "+" || source[j + 1] === "-")) {
          j += 2;
        } else {
          j += 1;
        }
      }
      const tok = { type: "number", value: source.slice(i, j) };
      tokens.push(tok);
      lastSig = tok;
      i = j;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
      const tok = { type: "ident", value: source.slice(i, j) };
      tokens.push(tok);
      lastSig = tok;
      i = j;
      continue;
    }

    const tri = source.slice(i, i + 3);
    const duo = source.slice(i, i + 2);
    const op = THREE_CHAR_OPS.has(tri) ? tri : TWO_CHAR_OPS.has(duo) ? duo : ch;
    const tok = { type: "punct", value: op };
    tokens.push(tok);
    lastSig = tok;
    i += op.length;
  }

  return tokens;
}

function nextSigIndex(tokens, idx) {
  let j = idx;
  while (j < tokens.length && (tokens[j].type === "ws" || tokens[j].type === "comment")) {
    j += 1;
  }
  return j;
}

function prevSigToken(tokens, idx) {
  let j = idx - 1;
  while (j >= 0 && (tokens[j].type === "ws" || tokens[j].type === "comment")) {
    j -= 1;
  }
  return j >= 0 ? tokens[j] : null;
}

function isArrowGenericAhead(tokens, ltIdx) {
  let depth = 0;
  let k = ltIdx;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "ws" || t.type === "comment") {
      k += 1;
      continue;
    }
    if (t.type === "punct" && t.value === "<") {
      depth += 1;
    } else if (t.type === "punct" && t.value === ">") {
      depth -= 1;
      if (depth === 0) {
        const after = nextSigIndex(tokens, k + 1);
        return after < tokens.length && tokens[after].type === "punct" && tokens[after].value === "(";
      }
    } else if (t.type === "punct" && (t.value === ";" || t.value === "{" || t.value === "}")) {
      return false;
    }
    k += 1;
  }
  return false;
}

function canStartJsxAt(tokens, idx) {
  const tok = tokens[idx];
  if (!tok || tok.type !== "punct" || tok.value !== "<") return false;
  const prev = prevSigToken(tokens, idx);
  if (prev) {
    if (prev.type === "number" || prev.type === "string" || prev.type === "regex" || prev.type === "template_full" || prev.type === "template_tail") {
      return false;
    }
    if (prev.type === "ident" && !EXPR_START_KEYWORDS.has(prev.value)) {
      return false;
    }
    if (prev.type === "punct" && (prev.value === ")" || prev.value === "]" || prev.value === "}")) {
      return false;
    }
  }
  const n1 = nextSigIndex(tokens, idx + 1);
  if (n1 >= tokens.length) return false;
  if (tokens[n1].type === "punct" && tokens[n1].value === ">") return true; // Fragment <>
  if (tokens[n1].type !== "ident") return false;
  return !isArrowGenericAhead(tokens, idx);
}

function expandJsxInSource(source, fileName) {
  let cursor = 0;
  let out = "";
  let usedJsx = false;

  function findBalancedCurly(src, openIdx) {
    const subTokens = tokenize(src.slice(openIdx));
    let depth = 0;
    let offset = openIdx;
    for (const t of subTokens) {
      if (t.type === "punct" && t.value === "{") depth += 1;
      else if (t.type === "punct" && t.value === "}") {
        depth -= 1;
        if (depth === 0) {
          return {
            inner: src.slice(openIdx + 1, offset),
            endIdx: offset + t.value.length
          };
        }
      }
      offset += t.value.length;
    }
    throw new Error(`Llave JSX sin cerrar en ${fileName}`);
  }

  function parseJsxElement(src, ltIdx) {
    let p = ltIdx + 1;
    while (p < src.length && /\s/.test(src[p])) p += 1;

    let tagName = "";
    let isFragment = false;
    if (src[p] === ">") {
      isFragment = true;
      p += 1;
    } else {
      const nameStart = p;
      while (p < src.length && /[A-Za-z0-9_$.]/.test(src[p])) p += 1;
      tagName = src.slice(nameStart, p);
      if (!tagName) return null;

      // Omitir argumentos genéricos opcionales en JSX <Comp<Foo> />
      while (p < src.length && /\s/.test(src[p])) p += 1;
      if (src[p] === "<") {
        let gDepth = 0;
        while (p < src.length) {
          if (src[p] === "<") gDepth += 1;
          else if (src[p] === ">") {
            gDepth -= 1;
            if (gDepth === 0) {
              p += 1;
              break;
            }
          }
          p += 1;
        }
      }
    }

    const propParts = [];
    let selfClosing = false;

    if (!isFragment) {
      while (p < src.length) {
        while (p < src.length && /\s/.test(src[p])) p += 1;
        if (src[p] === "/" && src[p + 1] === ">") {
          selfClosing = true;
          p += 2;
          break;
        }
        if (src[p] === ">") {
          p += 1;
          break;
        }
        if (src[p] === "{") {
          const exprRes = findBalancedCurly(src, p);
          const inner = exprRes.inner.trim();
          p = exprRes.endIdx;
          if (inner.startsWith("...")) {
            propParts.push(inner);
          }
          continue;
        }
        const attrStart = p;
        while (p < src.length && /[A-Za-z0-9_:-]/.test(src[p])) p += 1;
        const attrName = src.slice(attrStart, p);
        if (!attrName) return null;
        while (p < src.length && /\s/.test(src[p])) p += 1;
        if (src[p] === "=") {
          p += 1;
          while (p < src.length && /\s/.test(src[p])) p += 1;
          if (src[p] === '"' || src[p] === "'") {
            const q = src[p];
            let endQ = p + 1;
            while (endQ < src.length) {
              if (src[endQ] === "\\") endQ += 2;
              else if (src[endQ] === q) {
                endQ += 1;
                break;
              } else endQ += 1;
            }
            const strVal = src.slice(p, endQ);
            propParts.push(`${JSON.stringify(attrName)}: ${strVal}`);
            p = endQ;
          } else if (src[p] === "{") {
            const exprRes = findBalancedCurly(src, p);
            const transformedExpr = transpileCore(exprRes.inner, true, fileName);
            propParts.push(`${JSON.stringify(attrName)}: (${transformedExpr.code.trim()})`);
            if (transformedExpr.usedJsx) usedJsx = true;
            p = exprRes.endIdx;
          } else {
            return null;
          }
        } else {
          propParts.push(`${JSON.stringify(attrName)}: true`);
        }
      }
    }

    const childArgs = [];
    if (!selfClosing) {
      let textBuf = "";
      function flushText() {
        if (!textBuf) return;
        const hasNewline = textBuf.includes("\n");
        let clean = textBuf;
        if (hasNewline) {
          clean = clean.replace(/^\s*\n\s*|\s*\n\s*$/g, "").replace(/\s*\n\s*/g, " ");
        }
        if (clean.length > 0) {
          childArgs.push(JSON.stringify(clean));
        }
        textBuf = "";
      }

      while (p < src.length) {
        if (src[p] === "<" && src[p + 1] === "/") {
          flushText();
          const closeStart = p + 2;
          const gt = src.indexOf(">", closeStart);
          if (gt === -1) return null;
          const closeTag = src.slice(closeStart, gt).trim();
          if (isFragment ? closeTag !== "" : closeTag !== tagName) {
            throw new Error(`Etiqueta JSX </${closeTag}> no coincide con <${tagName}>`);
          }
          p = gt + 1;
          break;
        }
        if (src[p] === "<") {
          flushText();
          const child = parseJsxElement(src, p);
          if (!child) return null;
          childArgs.push(child.js);
          p = child.endIdx;
          continue;
        }
        if (src[p] === "{") {
          flushText();
          const exprRes = findBalancedCurly(src, p);
          const trimmed = exprRes.inner.trim();
          // Omitir comentarios JSX {/* ... */}
          if (trimmed && !/^\/\*[\s\S]*\*\/$/.test(trimmed)) {
            const sub = transpileCore(exprRes.inner, true, fileName);
            if (sub.usedJsx) usedJsx = true;
            if (sub.code.trim()) childArgs.push(sub.code.trim());
          }
          p = exprRes.endIdx;
          continue;
        }
        textBuf += src[p];
        p += 1;
      }
      flushText();
    }

    usedJsx = true;
    const typeArg = isFragment
      ? "__studioFragment"
      : /^[a-z]/.test(tagName)
        ? JSON.stringify(tagName)
        : tagName;
    const propsArg = propParts.length > 0 ? `{ ${propParts.join(", ")} }` : "null";
    const allArgs = [typeArg, propsArg, ...childArgs].join(", ");
    return {
      js: `__studioJsx(${allArgs})`,
      endIdx: p
    };
  }

  const tokens = tokenize(source);
  let pos = 0;
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const tok = tokens[idx];
    if (pos < cursor) {
      pos += tok.value.length;
      continue;
    }
    if (canStartJsxAt(tokens, idx)) {
      let parsed = null;
      try {
        parsed = parseJsxElement(source, pos);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Etiqueta JSX")) {
          throw err;
        }
        parsed = null;
      }
      if (parsed) {
        out += source.slice(cursor, pos) + parsed.js;
        cursor = parsed.endIdx;
      }
    }
    pos += tok.value.length;
  }
  out += source.slice(cursor);

  return { code: out, usedJsx };
}

function skipBalancedPair(tokens, startIdx, openChar, closeChar) {
  let depth = 0;
  let k = startIdx;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "punct" && t.value === openChar) {
      depth += 1;
    } else if (t.type === "punct" && t.value === closeChar) {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
    k += 1;
  }
  return k;
}

function skipTypeAnnotation(tokens, startIdx, stopPuncts) {
  let k = startIdx;
  let angle = 0;
  let paren = 0;
  let brace = 0;
  let bracket = 0;

  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "ws" || t.type === "comment") {
      k += 1;
      continue;
    }
    if (t.type === "punct") {
      const v = t.value;
      if (angle === 0 && paren === 0 && brace === 0 && bracket === 0 && stopPuncts.has(v)) {
        return k;
      }
      if (v === "(") paren += 1;
      else if (v === ")" && paren > 0) paren -= 1;
      else if (v === "{") brace += 1;
      else if (v === "}" && brace > 0) brace -= 1;
      else if (v === "[") bracket += 1;
      else if (v === "]" && bracket > 0) bracket -= 1;
      else if (v === "<") angle += 1;
      else if (v === ">" && angle > 0) angle -= 1;
      else if (v === ">>" && angle >= 2) angle -= 2;
      else if (v === ">>>" && angle >= 3) angle -= 3;
      else if (v === "=>" && paren === 0 && brace === 0 && bracket === 0 && angle === 0) {
        // Tipo función `() => void`: consumir retorno hasta delimitador externo
        k += 1;
        continue;
      }
    } else if (
      t.type === "ident" &&
      angle === 0 &&
      paren === 0 &&
      brace === 0 &&
      bracket === 0 &&
      (t.value === "in" || t.value === "of" || t.value === "extends" || t.value === "implements") &&
      stopPuncts.has(t.value)
    ) {
      return k;
    }
    k += 1;
  }
  return k;
}

function skipStatement(tokens, startIdx) {
  let k = startIdx;
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "punct") {
      if (t.value === "{") brace += 1;
      else if (t.value === "}") {
        if (brace > 0) brace -= 1;
        if (brace === 0 && paren === 0 && bracket === 0) {
          const nxt = nextSigIndex(tokens, k + 1);
          if (nxt < tokens.length && tokens[nxt].type === "ident" && tokens[nxt].value === "from") {
            k += 1;
            continue;
          }
          if (nxt < tokens.length && tokens[nxt].type === "punct" && tokens[nxt].value === ";") {
            return nxt + 1;
          }
          return k + 1;
        }
      } else if (t.value === "(") paren += 1;
      else if (t.value === ")" && paren > 0) paren -= 1;
      else if (t.value === "[") bracket += 1;
      else if (t.value === "]" && bracket > 0) bracket -= 1;
      else if (t.value === ";" && brace === 0 && paren === 0 && bracket === 0) {
        return k + 1;
      }
    } else if (
      t.type === "ws" &&
      t.value.includes("\n") &&
      brace === 0 &&
      paren === 0 &&
      bracket === 0
    ) {
      const prev = prevSigToken(tokens, k);
      const nxtIdx = nextSigIndex(tokens, k + 1);
      const nxt = nxtIdx < tokens.length ? tokens[nxtIdx] : null;
      const continues =
        (prev && prev.type === "punct" && (prev.value === "=" || prev.value === "|" || prev.value === "&")) ||
        (nxt && nxt.type === "punct" && (nxt.value === "|" || nxt.value === "&" || nxt.value === "{"));
      if (!continues) return k;
    }
    k += 1;
  }
  return k;
}

function compileEnumDeclaration(tokens, enumKwIdx) {
  const nameIdx = nextSigIndex(tokens, enumKwIdx + 1);
  if (nameIdx >= tokens.length || tokens[nameIdx].type !== "ident") return null;
  const enumName = tokens[nameIdx].value;
  const openBraceIdx = nextSigIndex(tokens, nameIdx + 1);
  if (openBraceIdx >= tokens.length || tokens[openBraceIdx].value !== "{") return null;
  const endIdx = skipBalancedPair(tokens, openBraceIdx, "{", "}");
  const props = [];
  let autoNum = 0;

  let k = openBraceIdx + 1;
  while (k < endIdx - 1) {
    k = nextSigIndex(tokens, k);
    if (k >= endIdx - 1) break;
    const keyTok = tokens[k];
    if (keyTok.type !== "ident" && keyTok.type !== "string") {
      k += 1;
      continue;
    }
    const keyName = keyTok.value;
    let nextIdx = nextSigIndex(tokens, k + 1);
    if (nextIdx < endIdx - 1 && tokens[nextIdx].value === "=") {
      const valStart = nextSigIndex(tokens, nextIdx + 1);
      let valEnd = valStart;
      let valStr = "";
      while (valEnd < endIdx - 1 && tokens[valEnd].value !== ",") {
        valStr += tokens[valEnd].value;
        valEnd += 1;
      }
      const trimmedVal = valStr.trim();
      const numVal = Number(trimmedVal);
      if (Number.isInteger(numVal)) {
        autoNum = numVal + 1;
      }
      props.push(`${keyName}: ${trimmedVal}`);
      k = valEnd + 1;
    } else {
      props.push(`${keyName}: ${autoNum}`);
      autoNum += 1;
      k = nextIdx + (tokens[nextIdx]?.value === "," ? 1 : 0);
    }
  }

  return {
    js: `const ${enumName} = { ${props.join(", ")} };`,
    nextIdx: endIdx
  };
}

function isParamParen(tokens, openParenIdx, stack) {
  const prev = prevSigToken(tokens, openParenIdx);
  if (prev) {
    if (prev.type === "ident" && (prev.value === "function" || prev.value === "catch" || prev.value === "constructor")) {
      return prev.value !== "catch";
    }
    if (prev.type === "punct" && prev.value === ">") {
      // `function foo<T>(` o `<T>(`
      return true;
    }
  }
  const closeIdx = skipBalancedPair(tokens, openParenIdx, "(", ")");
  const afterClose = nextSigIndex(tokens, closeIdx);
  if (afterClose < tokens.length) {
    const t = tokens[afterClose];
    if (t.type === "punct" && t.value === "=>") return true;
    if (t.type === "punct" && t.value === ":") {
      const retEnd = skipTypeAnnotation(
        tokens,
        afterClose + 1,
        new Set(["{", "=>", ";", ",", ")"])
      );
      if (retEnd < tokens.length && (tokens[retEnd].value === "=>" || tokens[retEnd].value === "{")) {
        return true;
      }
    }
  }
  // Verificar método de clase o función nombrada: `ident (` seguido de `) {` o `) :`
  if (prev && prev.type === "ident" && !EXPR_START_KEYWORDS.has(prev.value)) {
    const beforeName = prevSigToken(tokens, tokens.indexOf(prev));
    if (beforeName && beforeName.value === "function") return true;
    const topBrace = [...stack].reverse().find((s) => s.kind === "brace");
    if (topBrace?.inClass && afterClose < tokens.length && tokens[afterClose].value === "{") {
      return true;
    }
  }
  return false;
}

function looksLikeCallGeneric(tokens, ltIdx) {
  const prev = prevSigToken(tokens, ltIdx);
  if (!prev || prev.type !== "ident" || EXPR_BEFORE_REGEX_KEYWORDS.has(prev.value)) {
    return false;
  }
  let depth = 0;
  let k = ltIdx;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "punct" && t.value === "<") {
      depth += 1;
    } else if (t.type === "punct" && t.value === ">") {
      depth -= 1;
      if (depth === 0) {
        const after = nextSigIndex(tokens, k + 1);
        return (
          after < tokens.length &&
          tokens[after].type === "punct" &&
          (tokens[after].value === "(" || tokens[after].value === "=>")
        );
      }
    } else if (
      t.type === "punct" &&
      (t.value === ";" || t.value === "&&" || t.value === "||")
    ) {
      return false;
    } else if (t.type === "ws" && t.value.includes("\n")) {
      return false;
    }
    k += 1;
  }
  return false;
}

function stripTypeScriptFromTokens(tokens) {
  let out = "";
  let i = 0;
  let ternaryDepth = 0;
  let inVarDecl = false;
  let inVarInit = false;
  let inImportExportClause = false;
  let inCaseExpr = false;
  let pendingClassBody = false;
  let pendingConstructorParams = null;
  let injectConstructorThis = null;
  let waitingForSuperEnd = false;
  const stack = [];

  const TOP_TYPE_STOP = new Set(["=", ";", ",", "in", "of", ")", "}"]);
  const PARAM_TYPE_STOP = new Set([",", ")", "="]);
  const RET_TYPE_STOP = new Set(["{", "=>", ";", ",", ")"]);

  function currentBrace() {
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      if (stack[s].kind === "brace") return stack[s];
    }
    return null;
  }

  function currentParen() {
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      if (stack[s].kind === "paren") return stack[s];
    }
    return null;
  }

  while (i < tokens.length) {
    const tok = tokens[i];
    const prev = prevSigToken(tokens, i);

    if (tok.type === "ws" || tok.type === "comment") {
      if (tok.type === "ws" && tok.value.includes("\n") && inImportExportClause && prev?.type === "string") {
        inImportExportClause = false;
      }
      out += tok.value;
      i += 1;
      continue;
    }

    // import / export type
    if (tok.type === "ident" && (tok.value === "import" || tok.value === "export")) {
      const n1 = nextSigIndex(tokens, i + 1);
      if (n1 < tokens.length && tokens[n1].type === "ident") {
        if (tokens[n1].value === "type") {
          const n2 = nextSigIndex(tokens, n1 + 1);
          if (tokens[n2]?.value === "{" || tokens[n2]?.type === "ident" || tokens[n2]?.value === "*") {
            i = skipStatement(tokens, i);
            continue;
          }
        }
        if (tok.value === "export" && tokens[n1].value === "interface") {
          i = skipStatement(tokens, i);
          continue;
        }
        if (tok.value === "export" && tokens[n1].value === "enum") {
          const compiled = compileEnumDeclaration(tokens, n1);
          if (compiled) {
            out += `export ${compiled.js}`;
            i = compiled.nextIdx;
            continue;
          }
        }
        if (tok.value === "export" && tokens[n1].value === "const") {
          const n2 = nextSigIndex(tokens, n1 + 1);
          if (n2 < tokens.length && tokens[n2].value === "enum") {
            const compiled = compileEnumDeclaration(tokens, n2);
            if (compiled) {
              out += `export ${compiled.js}`;
              i = compiled.nextIdx;
              continue;
            }
          }
        }
      }
      const isStaticImport =
        tok.value === "import" &&
        n1 < tokens.length &&
        tokens[n1].value !== "(" &&
        tokens[n1].value !== ".";
      const isExportClause =
        tok.value === "export" &&
        n1 < tokens.length &&
        (tokens[n1].value === "{" || tokens[n1].value === "*");
      if (isStaticImport || isExportClause) {
        inImportExportClause = true;
      }
    }

    // Inline `type` en import { a, type B }
    if (inImportExportClause && tok.type === "ident" && tok.value === "type") {
      const n1 = nextSigIndex(tokens, i + 1);
      if (n1 < tokens.length && tokens[n1].type === "ident") {
        const afterName = nextSigIndex(tokens, n1 + 1);
        i = afterName < tokens.length && tokens[afterName].value === "," ? afterName + 1 : n1 + 1;
        continue;
      }
    }

    // Declaraciones puras de TS a nivel de bloque o módulo
    if (
      tok.type === "ident" &&
      (tok.value === "interface" || tok.value === "declare") &&
      (!prev || prev.value === ";" || prev.value === "{" || prev.value === "}" || prev.value === "export")
    ) {
      i = skipStatement(tokens, i);
      continue;
    }

    if (
      tok.type === "ident" &&
      tok.value === "type" &&
      (!prev || prev.value === ";" || prev.value === "{" || prev.value === "}" || prev.value === "export")
    ) {
      const n1 = nextSigIndex(tokens, i + 1);
      const n2 = n1 < tokens.length ? nextSigIndex(tokens, n1 + 1) : tokens.length;
      if (
        n1 < tokens.length &&
        tokens[n1].type === "ident" &&
        (tokens[n2]?.value === "=" || tokens[n2]?.value === "<")
      ) {
        i = skipStatement(tokens, i);
        continue;
      }
    }

    if (tok.type === "ident" && tok.value === "enum") {
      const compiled = compileEnumDeclaration(tokens, i);
      if (compiled) {
        out += compiled.js;
        i = compiled.nextIdx;
        continue;
      }
    }

    if (tok.type === "ident" && (tok.value === "const" || tok.value === "let" || tok.value === "var")) {
      const n1 = nextSigIndex(tokens, i + 1);
      if (tok.value === "const" && n1 < tokens.length && tokens[n1].value === "enum") {
        const compiled = compileEnumDeclaration(tokens, n1);
        if (compiled) {
          out += compiled.js;
          i = compiled.nextIdx;
          continue;
        }
      }
      inVarDecl = true;
      inVarInit = false;
    }

    if (
      tok.type === "ident" &&
      (tok.value === "case" ||
        (tok.value === "default" && tokens[nextSigIndex(tokens, i + 1)]?.value === ":"))
    ) {
      inCaseExpr = true;
    }

    if (tok.type === "ident" && tok.value === "class") {
      pendingClassBody = true;
    }

    if (tok.type === "ident" && tok.value === "implements") {
      const braceIdx = skipTypeAnnotation(tokens, i + 1, new Set(["{"]));
      i = braceIdx;
      continue;
    }

    if (tok.type === "ident" && MODIFIER_KEYWORDS.has(tok.value)) {
      const brace = currentBrace();
      const paren = currentParen();
      const inClassScope = Boolean(brace?.inClass) || (paren?.isParams && pendingConstructorParams !== null);
      const nextTokIdx = nextSigIndex(tokens, i + 1);
      const nextTok = nextTokIdx < tokens.length ? tokens[nextTokIdx] : null;
      if (
        (tok.value === "abstract" && nextTok?.value === "class") ||
        (inClassScope &&
          nextTok &&
          (nextTok.type === "ident" || nextTok.value === "[" || nextTok.value === "#"))
      ) {
        if (paren?.isParams && pendingConstructorParams !== null && nextTok.type === "ident") {
          pendingConstructorParams.push(nextTok.value);
        }
        i += 1;
        continue;
      }
    }

    if (tok.type === "ident" && tok.value === "constructor" && currentBrace()?.inClass) {
      pendingConstructorParams = [];
    }

    // as Type / satisfies Type (fuera de import/export)
    if (
      tok.type === "ident" &&
      (tok.value === "as" || tok.value === "satisfies") &&
      !inImportExportClause
    ) {
      const afterType = skipTypeAnnotation(
        tokens,
        i + 1,
        new Set([";", ",", ")", "]", "}", ":", "?", "&&", "||", "??", "=", "==", "===", "!=", "!==", "+", "-", "*", "/"])
      );
      i = afterType;
      continue;
    }

    // Genéricos de llamada, flecha o cabecera de clase <T>
    if (tok.type === "punct" && tok.value === "<") {
      const isArrowGen =
        isArrowGenericAhead(tokens, i) &&
        (!prev || prev.type === "punct" || EXPR_START_KEYWORDS.has(prev.value || "") || prev.value === "function" || prev.value === "async");
      if (pendingClassBody || isArrowGen || looksLikeCallGeneric(tokens, i)) {
        i = skipBalancedPair(tokens, i, "<", ">");
        continue;
      }
    }

    // Postfix `!` no-nulo: `ident!` o `)!` o `]!` o `!:` en asignación
    if (tok.type === "punct" && tok.value === "!") {
      const n1 = nextSigIndex(tokens, i + 1);
      if (
        prev &&
        (prev.type === "ident" || prev.value === ")" || prev.value === "]") &&
        (!tokens[n1] || tokens[n1].value !== "=")
      ) {
        i += 1;
        continue;
      }
    }

    // `?` ternario vs `?:` parámetro/propiedad opcional
    if (tok.type === "punct" && tok.value === "?") {
      const n1 = nextSigIndex(tokens, i + 1);
      if (n1 < tokens.length && tokens[n1].type === "punct" && tokens[n1].value === ":") {
        // `?: Type` -> saltar `?` y dejar que la rama de `:` borre `: Type`
        i += 1;
        continue;
      }
      ternaryDepth += 1;
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === ":") {
      if (inCaseExpr) {
        inCaseExpr = false;
        out += tok.value;
        i += 1;
        continue;
      }
      if (ternaryDepth > 0) {
        ternaryDepth -= 1;
        out += tok.value;
        i += 1;
        continue;
      }

      const brace = currentBrace();
      const paren = currentParen();

      if (brace && brace.isObject) {
        out += tok.value;
        i += 1;
        continue;
      }

      if (paren && paren.isParams) {
        const stopIdx = skipTypeAnnotation(tokens, i + 1, PARAM_TYPE_STOP);
        const stopTok = tokens[stopIdx];
        if (stopTok && stopTok.value === "=" && out.length > 0 && !/\s$/.test(out)) {
          out += " ";
        }
        i = stopIdx;
        continue;
      }

      if (prev && (prev.value === ")" || prev.value === "]") && !brace?.isObject) {
        const stopIdx = skipTypeAnnotation(tokens, i + 1, RET_TYPE_STOP);
        const stopTok = tokens[stopIdx];
        if (stopTok && (stopTok.value === "{" || stopTok.value === "=>") && out.length > 0 && !/\s$/.test(out)) {
          out += " ";
        }
        i = stopIdx;
        continue;
      }

      if (
        ((!brace || (!brace.isObject && !brace.isPattern)) && !paren && inVarDecl && !inVarInit) ||
        (brace?.inClass && !paren)
      ) {
        const stopIdx = skipTypeAnnotation(tokens, i + 1, TOP_TYPE_STOP);
        const stopTok = tokens[stopIdx];
        if (stopTok && (stopTok.value === "=" || stopTok.value === "in" || stopTok.value === "of") && out.length > 0 && !/\s$/.test(out)) {
          out += " ";
        }
        i = stopIdx;
        continue;
      }

      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === "(") {
      const isParams = isParamParen(tokens, i, stack);
      stack.push({ kind: "paren", isParams });
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === ")") {
      if (stack.length > 0 && stack[stack.length - 1].kind === "paren") {
        const closed = stack.pop();
        if (closed.isParams && pendingConstructorParams && pendingConstructorParams.length > 0) {
          injectConstructorThis = pendingConstructorParams;
          pendingConstructorParams = null;
        }
      }
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === "{") {
      if (pendingClassBody) {
        stack.push({ kind: "brace", isObject: false, isPattern: false, inClass: true });
        pendingClassBody = false;
        out += tok.value;
        i += 1;
        continue;
      }
      const parentBrace = currentBrace();
      const parentParen = currentParen();
      const isPattern = Boolean(
        !inImportExportClause &&
          !parentBrace?.isObject &&
          ((inVarDecl && !inVarInit && !parentParen) || parentParen?.isParams)
      );
      const isObj =
        !isPattern &&
        !inImportExportClause &&
        (!inVarDecl || inVarInit) &&
        prev &&
        prev.type === "punct" &&
        "=([,:;?+-*/%<>!".includes(prev.value);
      const isObjFromKeyword =
        !isPattern && prev && prev.type === "ident" && EXPR_START_KEYWORDS.has(prev.value);
      const braceIsObject = Boolean(isObj || isObjFromKeyword);
      stack.push({ kind: "brace", isObject: braceIsObject, isPattern, inClass: false });
      out += tok.value;
      if (injectConstructorThis && !braceIsObject) {
        const nextTokIdx = nextSigIndex(tokens, i + 1);
        if (tokens[nextTokIdx]?.value === "super") {
          waitingForSuperEnd = true;
        } else {
          const assignments = injectConstructorThis.map((p) => `this.${p} = ${p};`).join(" ");
          injectConstructorThis = null;
          out += ` ${assignments}`;
        }
      }
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === "}") {
      if (stack.length > 0 && stack[stack.length - 1].kind === "brace") {
        stack.pop();
      }
      inImportExportClause = false;
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "ident" && (tok.value === "in" || tok.value === "of") && inVarDecl) {
      inVarDecl = false;
      inVarInit = false;
    }

    if (tok.type === "punct" && tok.value === "=") {
      if (inVarDecl && !currentParen()) {
        inVarInit = true;
      }
    }

    if (tok.type === "punct" && tok.value === ";") {
      inVarDecl = false;
      inVarInit = false;
      inImportExportClause = false;
      out += tok.value;
      if (waitingForSuperEnd && injectConstructorThis) {
        waitingForSuperEnd = false;
        const assignments = injectConstructorThis.map((p) => `this.${p} = ${p};`).join(" ");
        injectConstructorThis = null;
        out += ` ${assignments}`;
      }
      i += 1;
      continue;
    }

    out += tok.value;
    i += 1;
  }

  return out;
}

function transpileCore(source, jsx, fileName) {
  let working = String(source ?? "");
  let usedJsx = false;
  if (jsx) {
    const jsxRes = expandJsxInSource(working, fileName);
    working = jsxRes.code;
    usedJsx = jsxRes.usedJsx;
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

/**
 * Expone el tokenizador léxico con desplazamientos exactos `[start, end)` en el fuente original
 * para análisis de módulos ES (import/export) sin interferir con strings, regex o comentarios.
 *
 * @param {string} source
 * @returns {Array<{ type: string, value: string, start: number, end: number }>}
 */
export function tokenizeJsWithOffsets(source) {
  const src = String(source ?? "");
  const tokens = tokenize(src);
  let pos = 0;
  for (const tok of tokens) {
    tok.start = pos;
    pos += tok.value.length;
    tok.end = pos;
  }
  return tokens;
}
