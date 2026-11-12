/**
 * Transpilador ligero 100% offline de TypeScript y JSX a JavaScript ejecutable en navegador.
 * Usa un tokenizador léxico para evitar dañar literales de texto, template strings,
 * expresiones regulares, comentarios u objetos literales.
 */

import {
  nextSigIndex,
  prevSigIndex,
  hasNewlineBetween,
  findMatchingDelimiter
} from "./jsTokenUtils.js";

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

function prevSigToken(tokens, idx) {
  const prevIdx = prevSigIndex(tokens, idx);
  return prevIdx >= 0 ? tokens[prevIdx] : null;
}

function findTopBrace(stack) {
  for (let s = stack.length - 1; s >= 0; s -= 1) {
    if (stack[s].kind === "brace") return stack[s];
  }
  return null;
}

const DISALLOW_ARROW_GENERIC_OPS = new Set([
  "&&",
  "||",
  "??",
  "==",
  "===",
  "!=",
  "!==",
  "<=",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "+=",
  "-=",
  "*=",
  "/=",
  "&&=",
  "||=",
  "??="
]);

function angleCloseCount(tok) {
  if (!tok || tok.type !== "punct") return 0;
  if (tok.value === ">") return 1;
  if (tok.value === ">>") return 2;
  if (tok.value === ">>>") return 3;
  return 0;
}

function hasNewlineBeforeToken(tokens, idx) {
  const prevIdx = prevSigIndex(tokens, idx);
  return hasNewlineBetween(tokens, prevIdx + 1, idx);
}

function isArrowGenericAhead(tokens, ltIdx) {
  let depth = 0;
  let innerParens = 0;
  let innerBraces = 0;
  let k = ltIdx;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "ws" || t.type === "comment") {
      k += 1;
      continue;
    }
    if (t.type === "punct") {
      if (t.value === "<") {
        depth += 1;
      } else {
        const closeAngles = angleCloseCount(t);
        if (closeAngles > 0) {
          depth -= closeAngles;
          if (depth === 0 && innerParens === 0 && innerBraces === 0) {
            const afterOpen = nextSigIndex(tokens, k + 1);
            if (afterOpen >= tokens.length || tokens[afterOpen].type !== "punct" || tokens[afterOpen].value !== "(") {
              return false;
            }
            const afterClose = skipBalancedPair(tokens, afterOpen, "(", ")");
            const retStart = nextSigIndex(tokens, afterClose);
            if (retStart >= tokens.length) return false;
            if (tokens[retStart].value === "=>") return true;
            if (tokens[retStart].value === ":") {
              const retEnd = skipTypeAnnotation(tokens, retStart + 1, new Set(["=>", ";", "{", ")", "}"]));
              return retEnd < tokens.length && tokens[retEnd].value === "=>";
            }
            return false;
          }
          if (depth <= 0) {
            return false;
          }
        } else if (t.value === "(" || t.value === "[") {
          innerParens += 1;
        } else if (t.value === ")" || t.value === "]") {
          if (innerParens === 0) return false;
          innerParens -= 1;
        } else if (t.value === "{") {
          innerBraces += 1;
        } else if (t.value === "}") {
          if (innerBraces === 0) return false;
          innerBraces -= 1;
        } else if (t.value === ";") {
          if (innerParens === 0 && innerBraces === 0) {
            return false;
          }
        } else if (depth === 1 && innerParens === 0 && innerBraces === 0 && DISALLOW_ARROW_GENERIC_OPS.has(t.value)) {
          return false;
        }
      }
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
  const outChunks = [];
  let usedJsx = false;

  function findBalancedCurly(src, openIdx) {
    let p = openIdx + 1;
    let cursorCurly = openIdx + 1;
    const chunks = [];
    let depth = 1;
    let lastSig = null;

    const skipQuoted = (idx, quote) => {
      let j = idx + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          return j + 1;
        }
        j += 1;
      }
      return src.length;
    };

    const skipTemplate = (idx) => {
      let j = idx + 1;
      let tplCursor = idx;
      const tplChunks = [];
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "`") {
          tplChunks.push(src.slice(tplCursor, j + 1));
          return { endIdx: j + 1, text: tplChunks.join("") };
        }
        if (src[j] === "$" && src[j + 1] === "{") {
          const nested = findBalancedCurly(src, j + 1);
          tplChunks.push(src.slice(tplCursor, j + 2), nested.inner, "}");
          tplCursor = nested.endIdx;
          j = nested.endIdx;
          continue;
        }
        j += 1;
      }
      tplChunks.push(src.slice(tplCursor, src.length));
      return { endIdx: src.length, text: tplChunks.join("") };
    };

    while (p < src.length) {
      const ch = src[p];

      if (/\s/.test(ch)) {
        p += 1;
        continue;
      }

      if (ch === "/" && src[p + 1] === "/") {
        const nl = src.indexOf("\n", p + 2);
        p = nl === -1 ? src.length : nl + 1;
        continue;
      }
      if (ch === "/" && src[p + 1] === "*") {
        const endC = src.indexOf("*/", p + 2);
        p = endC === -1 ? src.length : endC + 2;
        continue;
      }

      if (ch === "'" || ch === '"') {
        p = skipQuoted(p, ch);
        lastSig = { type: "string", value: ch };
        continue;
      }

      if (ch === "`") {
        const tplStart = p;
        const tplRes = skipTemplate(p);
        chunks.push(src.slice(cursorCurly, tplStart), tplRes.text);
        cursorCurly = tplRes.endIdx;
        p = tplRes.endIdx;
        lastSig = { type: "template_full", value: "`" };
        continue;
      }

      if (ch === "/" && canStartRegex(lastSig)) {
        let j = p + 1;
        let inClass = false;
        while (j < src.length) {
          const rc = src[j];
          if (rc === "\\") {
            j += 2;
            continue;
          }
          if (rc === "[") inClass = true;
          else if (rc === "]") inClass = false;
          else if (rc === "/" && !inClass) {
            j += 1;
            break;
          } else if (rc === "\n") {
            break;
          }
          j += 1;
        }
        while (j < src.length && /[a-z]/i.test(src[j])) j += 1;
        p = j;
        lastSig = { type: "regex", value: "/" };
        continue;
      }

      if (ch === "<") {
        const prevAllowsJsx =
          !lastSig ||
          (lastSig.type === "ident" && EXPR_START_KEYWORDS.has(lastSig.value)) ||
          (lastSig.type === "punct" &&
            lastSig.value !== ")" &&
            lastSig.value !== "]" &&
            lastSig.value !== "}" &&
            lastSig.value !== "++" &&
            lastSig.value !== "--");
        if (prevAllowsJsx) {
          let afterLt = p + 1;
          while (afterLt < src.length && /\s/.test(src[afterLt])) afterLt += 1;
          if (src[afterLt] === ">" || /[A-Za-z_$]/.test(src[afterLt] || "")) {
            let isArrowGen = false;
            if (src[afterLt] !== ">") {
              const probeTokens = tokenize(src.slice(p, Math.min(src.length, p + 512)));
              isArrowGen = isArrowGenericAhead(probeTokens, 0);
            }
            if (!isArrowGen) {
              const parsed = parseJsxElement(src, p);
              if (parsed) {
                chunks.push(src.slice(cursorCurly, p), parsed.js);
                cursorCurly = parsed.endIdx;
                p = parsed.endIdx;
                lastSig = { type: "punct", value: ")" };
                continue;
              }
            }
          }
        }
      }

      if (ch === "{") {
        depth += 1;
        lastSig = { type: "punct", value: "{" };
        p += 1;
        continue;
      }
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          chunks.push(src.slice(cursorCurly, p));
          return {
            inner: chunks.join(""),
            endIdx: p + 1
          };
        }
        lastSig = { type: "punct", value: "}" };
        p += 1;
        continue;
      }

      if (/[A-Za-z_$]/.test(ch)) {
        let j = p + 1;
        while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
        lastSig = { type: "ident", value: src.slice(p, j) };
        p = j;
        continue;
      }

      if (/[0-9]/.test(ch)) {
        let j = p + 1;
        while (j < src.length && /[0-9A-Za-z_.]/.test(src[j])) j += 1;
        lastSig = { type: "number", value: src.slice(p, j) };
        p = j;
        continue;
      }

      const tri = src.slice(p, p + 3);
      const duo = src.slice(p, p + 2);
      const op = THREE_CHAR_OPS.has(tri) ? tri : TWO_CHAR_OPS.has(duo) ? duo : ch;
      lastSig = { type: "punct", value: op };
      p += op.length;
    }
    throw new Error(`Llave JSX sin cerrar en ${fileName}`);
  }

  function skipGenericArgsInJsxTag(src, startIdx) {
    let p = startIdx;
    let gDepth = 0;
    while (p < src.length) {
      const ch = src[p];
      if (ch === "=" && src[p + 1] === ">") {
        p += 2;
        continue;
      }
      if (ch === "/" && src[p + 1] === "/") {
        const nl = src.indexOf("\n", p + 2);
        p = nl === -1 ? src.length : nl + 1;
        continue;
      }
      if (ch === "/" && src[p + 1] === "*") {
        const endC = src.indexOf("*/", p + 2);
        p = endC === -1 ? src.length : endC + 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        const q = ch;
        p += 1;
        while (p < src.length) {
          if (src[p] === "\\") {
            p += 2;
            continue;
          }
          if (src[p] === q) {
            p += 1;
            break;
          }
          p += 1;
        }
        continue;
      }
      if (ch === "<") {
        gDepth += 1;
      } else if (ch === ">") {
        gDepth -= 1;
        if (gDepth === 0) {
          return p + 1;
        }
      }
      p += 1;
    }
    return p;
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
        p = skipGenericArgsInJsxTag(src, p);
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
            const transformedExpr = transpileCore(exprRes.inner, false, fileName);
            propParts.push(`${JSON.stringify(attrName)}: (${transformedExpr.code.trim()})`);
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
      let closedTag = false;
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
          closedTag = true;
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
            const sub = transpileCore(exprRes.inner, false, fileName);
            if (sub.code.trim()) childArgs.push(sub.code.trim());
          }
          p = exprRes.endIdx;
          continue;
        }
        textBuf += src[p];
        p += 1;
      }
      if (!closedTag) return null;
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
        outChunks.push(source.slice(cursor, pos), parsed.js);
        cursor = parsed.endIdx;
      }
    }
    pos += tok.value.length;
  }
  outChunks.push(source.slice(cursor));

  return { code: outChunks.join(""), usedJsx };
}

function skipBalancedPair(tokens, startIdx, openChar, closeChar) {
  if (openChar !== "<" || closeChar !== ">") {
    return Math.min(tokens.length, findMatchingDelimiter(tokens, startIdx, openChar, closeChar) + 1);
  }
  let depth = 0;
  let k = startIdx;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "punct" && t.value === openChar) {
      depth += 1;
    } else {
      const closeCount = angleCloseCount(t);
      if (closeCount > 0) {
        depth -= closeCount;
        if (depth <= 0) return k + 1;
      }
    }
    k += 1;
  }
  return k;
}

const TYPE_CONT_PREV_KEYWORDS = new Set([
  "keyof",
  "typeof",
  "readonly",
  "infer",
  "is",
  "extends",
  "implements",
  "asserts",
  "new"
]);

function skipTypeAnnotation(tokens, startIdx, stopPuncts) {
  let k = startIdx;
  let angle = 0;
  let paren = 0;
  let brace = 0;
  let bracket = 0;

  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "ws" || t.type === "comment") {
      if (
        angle === 0 &&
        paren === 0 &&
        brace === 0 &&
        bracket === 0 &&
        t.value.includes("\n")
      ) {
        const prev = prevSigToken(tokens, k);
        const nxtIdx = nextSigIndex(tokens, k + 1);
        const nxt = nxtIdx < tokens.length ? tokens[nxtIdx] : null;
        const prevContinues =
          prev &&
          ((prev.type === "punct" &&
            (prev.value === "|" ||
              prev.value === "&" ||
              prev.value === "<" ||
              prev.value === "," ||
              prev.value === "=>" ||
              prev.value === "?" ||
              prev.value === ":" ||
              prev.value === ".")) ||
            (prev.type === "ident" && TYPE_CONT_PREV_KEYWORDS.has(prev.value)));
        const nextContinues =
          nxt &&
          ((nxt.type === "punct" &&
            (nxt.value === "|" ||
              nxt.value === "&" ||
              nxt.value === "." ||
              nxt.value === "=>")) ||
            (nxt.type === "ident" && (nxt.value === "extends" || nxt.value === "is")));
        if (!prevContinues && !nextContinues) {
          return k;
        }
      }
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
      let pDepth = 0;
      let bDepth = 0;
      let cDepth = 0;
      while (valEnd < endIdx - 1) {
        const vt = tokens[valEnd];
        if (pDepth === 0 && bDepth === 0 && cDepth === 0 && vt.type === "punct" && vt.value === ",") {
          break;
        }
        if (vt.type === "punct") {
          if (vt.value === "(") pDepth += 1;
          else if (vt.value === ")") pDepth = Math.max(0, pDepth - 1);
          else if (vt.value === "[") bDepth += 1;
          else if (vt.value === "]") bDepth = Math.max(0, bDepth - 1);
          else if (vt.value === "{") cDepth += 1;
          else if (vt.value === "}") cDepth = Math.max(0, cDepth - 1);
        }
        if (vt.type !== "comment") {
          valStr += vt.type === "ws" ? " " : vt.value;
        }
        valEnd += 1;
      }
      const trimmedVal = valStr.replace(/\s+/g, " ").trim();
      const numVal = Number(trimmedVal);
      if (trimmedVal !== "" && Number.isInteger(numVal)) {
        autoNum = numVal + 1;
      }
      props.push(`${keyName}: ${trimmedVal || "undefined"}`);
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

function isBeforeMethodOrNamedFuncHeader(tokens, openParenIdx, stack) {
  const prevIdx = prevSigIndex(tokens, openParenIdx);
  if (prevIdx < 0) return false;
  const prev = tokens[prevIdx];
  if (prev.type === "ident" && (prev.value === "function" || prev.value === "constructor")) {
    return true;
  }
  let nameIdx = prevIdx;
  let nameTok = prev;
  if (angleCloseCount(prev) > 0) {
    let j = prevIdx;
    let angle = angleCloseCount(prev);
    j -= 1;
    while (j >= 0 && angle > 0) {
      const tj = tokens[j];
      if (tj.type === "punct" && tj.value === "<") {
        angle -= 1;
      } else {
        angle += angleCloseCount(tj);
      }
      if (angle === 0) break;
      j -= 1;
    }
    nameIdx = prevSigIndex(tokens, j);
    if (nameIdx < 0) return false;
    nameTok = tokens[nameIdx];
  }
  if (nameTok.type !== "ident" || EXPR_START_KEYWORDS.has(nameTok.value)) {
    return false;
  }
  const beforeName = prevSigToken(tokens, nameIdx);
  if (beforeName && (beforeName.value === "function" || beforeName.value === "*")) {
    return true;
  }
  const topBrace = findTopBrace(stack);
  if (topBrace?.inClass) {
    return !beforeName || beforeName.value !== "=";
  }
  if (topBrace?.isObject) {
    if (nameTok.value === "async" && beforeName?.value === ":") {
      return false;
    }
    return beforeName?.value === "{" || beforeName?.value === "," || beforeName?.value === "async";
  }
  return false;
}

function classifyParamParen(tokens, openParenIdx, stack) {
  const prevIdx = prevSigIndex(tokens, openParenIdx);
  const prev = prevIdx >= 0 ? tokens[prevIdx] : null;
  if (prev) {
    if (prev.type === "ident" && prev.value === "catch") {
      return { isParams: false, isMethodOrFunc: false };
    }
    if (prev.type === "ident" && (prev.value === "function" || prev.value === "constructor")) {
      return { isParams: true, isMethodOrFunc: true };
    }
    if (angleCloseCount(prev) > 0) {
      // `function foo<T>(` o `<T>(`
      return { isParams: true, isMethodOrFunc: isBeforeMethodOrNamedFuncHeader(tokens, openParenIdx, stack) };
    }
  }
  const closeIdx = skipBalancedPair(tokens, openParenIdx, "(", ")");
  const afterClose = nextSigIndex(tokens, closeIdx);
  const isMethodOrFunc = isBeforeMethodOrNamedFuncHeader(tokens, openParenIdx, stack);
  if (afterClose < tokens.length) {
    const t = tokens[afterClose];
    if (t.type === "punct" && t.value === "=>") {
      return { isParams: true, isMethodOrFunc: false };
    }
    if (t.type === "punct" && t.value === ":") {
      const stopSet = isMethodOrFunc
        ? new Set(["{", ";", ",", ")"])
        : new Set(["{", "=>", ";", ",", ")"]);
      const retEnd = skipTypeAnnotation(tokens, afterClose + 1, stopSet);
      if (retEnd < tokens.length && (tokens[retEnd].value === "=>" || tokens[retEnd].value === "{")) {
        return { isParams: true, isMethodOrFunc };
      }
    }
  }
  // Verificar método de clase o función nombrada: `ident (` seguido de `) {`
  if (prev && prev.type === "ident" && !EXPR_START_KEYWORDS.has(prev.value)) {
    const beforeName = prevSigToken(tokens, prevIdx);
    if (beforeName && beforeName.value === "function") {
      return { isParams: true, isMethodOrFunc: true };
    }
    const topBrace = findTopBrace(stack);
    if ((topBrace?.inClass || topBrace?.isObject) && afterClose < tokens.length && tokens[afterClose].value === "{") {
      return { isParams: true, isMethodOrFunc: true };
    }
  }
  return { isParams: false, isMethodOrFunc: false };
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
    } else {
      const closeCount = angleCloseCount(t);
      if (closeCount > 0) {
        depth -= closeCount;
        if (depth === 0) {
          const after = nextSigIndex(tokens, k + 1);
          return (
            after < tokens.length &&
            tokens[after].type === "punct" &&
            (tokens[after].value === "(" || tokens[after].value === "=>")
          );
        }
        if (depth < 0) {
          return false;
        }
      } else if (
        t.type === "punct" &&
        (t.value === ";" || t.value === "&&" || t.value === "||")
      ) {
        return false;
      } else if (t.type === "ws" && t.value.includes("\n")) {
        return false;
      }
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
  let superBodyDepth = -1;
  let superCallClosed = false;
  let lastClosedParen = null;
  const stack = [];

  const OBJ_BEFORE_PUNCT = new Set([
    "=",
    "(",
    "[",
    ",",
    ":",
    ";",
    "?",
    "+",
    "-",
    "*",
    "/",
    "%",
    "<",
    ">",
    "!",
    "&&",
    "||",
    "??",
    "...",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&&=",
    "||=",
    "??="
  ]);
  const TOP_TYPE_STOP = new Set(["=", ";", ",", "in", "of", ")", "}"]);
  const PARAM_TYPE_STOP = new Set([",", ")", "="]);
  const RET_TYPE_STOP = new Set(["{", "=>", ";", ",", ")"]);
  const METHOD_RET_TYPE_STOP = new Set(["{", ";", ",", ")"]);
  const DECLARE_FOLLOWERS = new Set([
    "const",
    "let",
    "var",
    "function",
    "class",
    "abstract",
    "enum",
    "interface",
    "type",
    "namespace",
    "module",
    "async",
    "global"
  ]);
  const VAR_INIT_CONT_PREV = new Set([
    "=",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&&=",
    "||=",
    "??=",
    "?",
    ":",
    ",",
    "+",
    "-",
    "*",
    "/",
    "%",
    "&&",
    "||",
    "??",
    "==",
    "===",
    "!=",
    "!==",
    "<",
    ">",
    "<=",
    ">=",
    "<<",
    ">>",
    ">>>",
    "&",
    "|",
    "^",
    ".",
    "?.",
    "=>",
    "typeof",
    "await",
    "yield",
    "new",
    "return",
    "delete",
    "void",
    "in",
    "of",
    "instanceof"
  ]);
  const VAR_INIT_CONT_NEXT = new Set([
    ".",
    "?.",
    "?",
    ":",
    ",",
    "&&",
    "||",
    "??",
    "+",
    "-",
    "*",
    "/",
    "%",
    "==",
    "===",
    "!=",
    "!==",
    "<",
    ">",
    "<=",
    ">=",
    "as",
    "satisfies"
  ]);

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
      if (tok.value.includes("\n")) {
        if (inImportExportClause && prev?.type === "string") {
          inImportExportClause = false;
        }
        if (
          waitingForSuperEnd &&
          injectConstructorThis &&
          superCallClosed &&
          stack.length === superBodyDepth
        ) {
          const nxtIdx = nextSigIndex(tokens, i + 1);
          const nxt = nxtIdx < tokens.length ? tokens[nxtIdx] : null;
          if (
            !nxt ||
            (nxt.value !== "." &&
              nxt.value !== "?." &&
              nxt.value !== "(" &&
              nxt.value !== "[" &&
              nxt.value !== ";")
          ) {
            waitingForSuperEnd = false;
            superCallClosed = false;
            superBodyDepth = -1;
            const assignments = injectConstructorThis.map((p) => `this.${p} = ${p};`).join(" ");
            injectConstructorThis = null;
            out += `; ${assignments}`;
          }
        }
        if (inVarDecl) {
          const top = stack[stack.length - 1];
          const inStmtScope = !top || (top.kind === "brace" && !top.isObject && !top.isPattern);
          if (inStmtScope) {
            const nxtIdx = nextSigIndex(tokens, i + 1);
            const nxt = nxtIdx < tokens.length ? tokens[nxtIdx] : null;
            let continues = false;
            if (!inVarInit) {
              continues =
                Boolean(
                  prev &&
                    (prev.value === ":" ||
                      prev.value === "," ||
                      prev.value === "|" ||
                      prev.value === "&" ||
                      prev.value === "<" ||
                      prev.value === "const" ||
                      prev.value === "let" ||
                      prev.value === "var")
                ) ||
                Boolean(
                  nxt &&
                    (nxt.value === "=" ||
                      nxt.value === ":" ||
                      nxt.value === "|" ||
                      nxt.value === "&" ||
                      nxt.value === "in" ||
                      nxt.value === "of")
                );
            } else {
              continues =
                Boolean(prev && VAR_INIT_CONT_PREV.has(prev.value)) ||
                Boolean(nxt && VAR_INIT_CONT_NEXT.has(nxt.value));
            }
            if (!continues) {
              inVarDecl = false;
              inVarInit = false;
            }
          }
        }
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
        if (tok.value === "export" && (tokens[n1].value === "interface" || tokens[n1].value === "declare")) {
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

    // Inline `type` en import { a, type B, type C as D }
    if (inImportExportClause && tok.type === "ident" && tok.value === "type") {
      const n1 = nextSigIndex(tokens, i + 1);
      if (n1 < tokens.length && tokens[n1].type === "ident" && tokens[n1].value !== "as") {
        let endSpec = n1;
        const afterName = nextSigIndex(tokens, n1 + 1);
        if (afterName < tokens.length && tokens[afterName].type === "ident" && tokens[afterName].value === "as") {
          const aliasIdx = nextSigIndex(tokens, afterName + 1);
          if (aliasIdx < tokens.length && tokens[aliasIdx].type === "ident") {
            endSpec = aliasIdx;
          }
        }
        const afterSpec = nextSigIndex(tokens, endSpec + 1);
        i = afterSpec < tokens.length && tokens[afterSpec].value === "," ? afterSpec + 1 : endSpec + 1;
        continue;
      }
    }

    // Declaraciones puras de TS a nivel de bloque o módulo (incluyendo ASI tras salto de línea)
    const startsTsStmt =
      !prev ||
      (prev.value !== "." &&
        prev.value !== "?." &&
        (prev.value === ";" ||
          prev.value === "{" ||
          prev.value === "}" ||
          prev.value === "export" ||
          hasNewlineBeforeToken(tokens, i)));

    if (tok.type === "ident" && startsTsStmt) {
      if (tok.value === "interface") {
        const n1 = nextSigIndex(tokens, i + 1);
        if (n1 < tokens.length && tokens[n1].type === "ident") {
          i = skipStatement(tokens, i);
          continue;
        }
      }
      if (tok.value === "declare") {
        const n1 = nextSigIndex(tokens, i + 1);
        if (n1 < tokens.length && tokens[n1].type === "ident" && DECLARE_FOLLOWERS.has(tokens[n1].value)) {
          i = skipStatement(tokens, i);
          continue;
        }
      }
      if (tok.value === "type") {
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
        if (
          paren?.isParams &&
          pendingConstructorParams !== null &&
          nextTok.type === "ident" &&
          !MODIFIER_KEYWORDS.has(nextTok.value)
        ) {
          pendingConstructorParams.push(nextTok.value);
        }
        i += 1;
        continue;
      }
    }

    if (tok.type === "ident" && tok.value === "constructor" && currentBrace()?.inClass) {
      pendingConstructorParams = [];
    }

    // as Type / satisfies Type (fuera de import/export y accesos a propiedad `obj.as`)
    if (
      tok.type === "ident" &&
      (tok.value === "as" || tok.value === "satisfies") &&
      !inImportExportClause &&
      prev &&
      prev.value !== "." &&
      prev.value !== "?." &&
      !(prev.type === "ident" && (prev.value === "const" || prev.value === "let" || prev.value === "var" || prev.value === "function"))
    ) {
      const n1 = nextSigIndex(tokens, i + 1);
      const nTok = n1 < tokens.length ? tokens[n1] : null;
      const startsType =
        nTok &&
        (nTok.type === "ident" ||
          nTok.type === "string" ||
          nTok.type === "number" ||
          nTok.value === "{" ||
          nTok.value === "[" ||
          nTok.value === "(");
      if (startsType) {
        const afterType = skipTypeAnnotation(
          tokens,
          i + 1,
          new Set([";", ",", ")", "]", "}", ":", "?", "&&", "||", "??", "=", "==", "===", "!=", "!==", "+", "-", "*", "/"])
        );
        i = afterType;
        continue;
      }
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

    // Postfix `!` no-nulo: `ident!` o `)!` o `]!` sin salto de línea previo (ASI) ni operador prefijo tras keyword
    if (tok.type === "punct" && tok.value === "!") {
      const n1 = nextSigIndex(tokens, i + 1);
      const hasNewlineBefore = hasNewlineBeforeToken(tokens, i);
      if (
        !hasNewlineBefore &&
        prev &&
        (prev.type === "ident" || prev.value === ")" || prev.value === "]") &&
        !(prev.type === "ident" && EXPR_BEFORE_REGEX_KEYWORDS.has(prev.value)) &&
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

      const top = stack[stack.length - 1];
      const brace = currentBrace();
      const paren = currentParen();

      if (top?.kind === "paren" && top.isParams) {
        const stopIdx = skipTypeAnnotation(tokens, i + 1, PARAM_TYPE_STOP);
        const stopTok = tokens[stopIdx];
        if (stopTok && stopTok.value === "=" && out.length > 0 && !/\s$/.test(out)) {
          out += " ";
        }
        i = stopIdx;
        continue;
      }

      if (prev && (prev.value === ")" || prev.value === "]")) {
        const useMethodStop =
          prev.value === ")" &&
          lastClosedParen?.token === prev &&
          lastClosedParen.isMethodOrFunc;
        const stopIdx = skipTypeAnnotation(tokens, i + 1, useMethodStop ? METHOD_RET_TYPE_STOP : RET_TYPE_STOP);
        const stopTok = tokens[stopIdx];
        const canStripInObj = prev.value === ")" && (stopTok?.value === "{" || stopTok?.value === "=>");
        if (!brace?.isObject || canStripInObj) {
          if (stopTok && (stopTok.value === "{" || stopTok.value === "=>") && out.length > 0 && !/\s$/.test(out)) {
            out += " ";
          }
          i = stopIdx;
          continue;
        }
      }

      if (brace && brace.isObject) {
        out += tok.value;
        i += 1;
        continue;
      }

      if (
        ((!brace || (!brace.isObject && !brace.isPattern)) && !paren?.isParams && inVarDecl && !inVarInit) ||
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

    if (tok.type === "punct" && (tok.value === "." || tok.value === "?.")) {
      if (waitingForSuperEnd && stack.length === superBodyDepth) {
        superCallClosed = false;
      }
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === "[") {
      if (waitingForSuperEnd && stack.length === superBodyDepth) {
        superCallClosed = false;
      }
      stack.push({ kind: "bracket" });
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === "]") {
      if (stack.length > 0 && stack[stack.length - 1].kind === "bracket") {
        stack.pop();
      }
      if (waitingForSuperEnd && stack.length === superBodyDepth) {
        superCallClosed = true;
      }
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === "(") {
      if (waitingForSuperEnd && stack.length === superBodyDepth) {
        superCallClosed = false;
      }
      const parenMeta = classifyParamParen(tokens, i, stack);
      stack.push({ kind: "paren", isParams: parenMeta.isParams, isMethodOrFunc: parenMeta.isMethodOrFunc });
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === ")") {
      if (stack.length > 0 && stack[stack.length - 1].kind === "paren") {
        const closed = stack.pop();
        lastClosedParen = { token: tok, isMethodOrFunc: closed.isMethodOrFunc };
        if (closed.isParams && pendingConstructorParams && pendingConstructorParams.length > 0) {
          injectConstructorThis = pendingConstructorParams;
          pendingConstructorParams = null;
        }
      }
      if (waitingForSuperEnd && stack.length === superBodyDepth) {
        superCallClosed = true;
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
        OBJ_BEFORE_PUNCT.has(prev.value);
      const isObjFromKeyword =
        !isPattern && prev && prev.type === "ident" && EXPR_START_KEYWORDS.has(prev.value);
      const braceIsObject = Boolean(isObj || isObjFromKeyword);
      stack.push({ kind: "brace", isObject: braceIsObject, isPattern, inClass: false });
      out += tok.value;
      if (injectConstructorThis && !braceIsObject) {
        const nextTokIdx = nextSigIndex(tokens, i + 1);
        if (tokens[nextTokIdx]?.value === "super") {
          waitingForSuperEnd = true;
          superBodyDepth = stack.length;
          superCallClosed = false;
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
      if (waitingForSuperEnd && stack.length === superBodyDepth) {
        waitingForSuperEnd = false;
        superCallClosed = false;
        superBodyDepth = -1;
        if (injectConstructorThis) {
          const assignments = injectConstructorThis.map((p) => `this.${p} = ${p};`).join(" ");
          injectConstructorThis = null;
          out += `${out.trimEnd().endsWith(";") ? " " : "; "}${assignments} `;
        }
      }
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
      if (waitingForSuperEnd && injectConstructorThis && stack.length === superBodyDepth) {
        waitingForSuperEnd = false;
        superCallClosed = false;
        superBodyDepth = -1;
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

const SIMPLE_JS_EXPR_RE = /^[A-Za-z0-9_$.\s()[\],'"`+\-*/%&|^~?]+$/;

function transpileCore(source, jsx, fileName) {
  let working = String(source ?? "");
  let usedJsx = false;
  if (jsx) {
    const jsxRes = expandJsxInSource(working, fileName);
    working = jsxRes.code;
    usedJsx = jsxRes.usedJsx;
  } else if (SIMPLE_JS_EXPR_RE.test(working) && !/\b(?:as|satisfies)\b/.test(working)) {
    return { code: working, usedJsx: false };
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
