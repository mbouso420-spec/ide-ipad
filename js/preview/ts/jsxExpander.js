/**
 * Expansor léxico de sintaxis JSX / TSX a llamadas `__studioJsx(...)` sin dependencias externas.
 */

import { nextSigIndex } from "../jsTokenUtils.js";
import {
  EXPR_START_KEYWORDS,
  THREE_CHAR_OPS,
  TWO_CHAR_OPS,
  canStartRegex,
  tokenize,
  prevSigToken
} from "./tsTokenizer.js";
import { isArrowGenericAhead } from "./typeStripper.js";

export const JSX_RUNTIME_HELPER = `const __studioFragment = Symbol.for("studio.jsx.fragment");
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

export function expandJsxInSource(source, fileName, transpileExprFn) {
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
            const transformedSpread = transpileExprFn(inner.slice(3), fileName).code.trim();
            propParts.push(`...${transformedSpread}`);
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
            const rawStrVal = src.slice(p, endQ);
            const strVal = rawStrVal.includes("\n") || rawStrVal.includes("\r")
              ? `${q}${rawStrVal.slice(1, -1).replace(/\r\n?/g, "\\n").replace(/\n/g, "\\n")}${q}`
              : rawStrVal;
            propParts.push(`${JSON.stringify(attrName)}: ${strVal}`);
            p = endQ;
          } else if (src[p] === "{") {
            const exprRes = findBalancedCurly(src, p);
            const transformedExpr = transpileExprFn(exprRes.inner, fileName);
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
            const sub = transpileExprFn(exprRes.inner, fileName);
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
      : !tagName.includes(".") && /^[a-z]/.test(tagName)
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
