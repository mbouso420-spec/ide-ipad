/**
 * Expansor léxico de sintaxis JSX / TSX a llamadas `__studioJsx(...)` sin dependencias externas.
 */

import {
  EXPR_START_KEYWORDS,
  FOUR_CHAR_OPS,
  THREE_CHAR_OPS,
  TWO_CHAR_OPS,
  canStartRegex,
  tokenize
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

export function expandJsxInSource(source, fileName, transpileExprFn) {
  let usedJsx = false;

  const isJsxAllowedAfter = (lastSig, lastSigWasProp = false) => {
    if (!lastSig) return true;
    if (lastSig.type === "template_head" || lastSig.type === "template_mid") return true;
    if (lastSig.type === "ident") {
      return !lastSigWasProp && EXPR_START_KEYWORDS.has(lastSig.value);
    }
    if (lastSig.type === "punct") {
      return (
        lastSig.value !== ")" &&
        lastSig.value !== "]" &&
        lastSig.value !== "}" &&
        lastSig.value !== "++" &&
        lastSig.value !== "--"
      );
    }
    return false;
  };

  function scanJsSegment(src, startIdx, stopOnCloseCurly) {
    let p = startIdx;
    let segCursor = startIdx;
    const chunks = [];
    let depth = stopOnCloseCurly ? 1 : 0;
    let lastSig = null;
    let lastSigWasProp = false;

    const setLast = (tok, wasProp = false) => {
      lastSig = tok;
      lastSigWasProp = wasProp;
    };

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
        setLast({ type: "string", value: ch }, false);
        continue;
      }

      if (ch === "`") {
        const tplStart = p;
        const tplRes = skipTemplate(p);
        chunks.push(src.slice(segCursor, tplStart), tplRes.text);
        segCursor = tplRes.endIdx;
        p = tplRes.endIdx;
        setLast({ type: "template_full", value: "`" }, false);
        continue;
      }

      if (ch === "/" && canStartRegex(lastSig, lastSigWasProp)) {
        let j = p + 1;
        let inClass = false;
        let closedRegex = false;
        while (j < src.length) {
          const rc = src[j];
          if (rc === "\\") {
            j += 2;
            continue;
          }
          if (rc === "[") inClass = true;
          else if (rc === "]" && inClass) inClass = false;
          else if (rc === "/" && !inClass) {
            closedRegex = true;
            j += 1;
            break;
          } else if (rc === "\n") {
            break;
          }
          j += 1;
        }
        if (closedRegex) {
          while (j < src.length && /[a-z]/i.test(src[j])) j += 1;
          p = j;
          setLast({ type: "regex", value: "/" }, false);
          continue;
        }
      }

      if (ch === "<" && isJsxAllowedAfter(lastSig, lastSigWasProp)) {
        let afterLt = p + 1;
        while (afterLt < src.length && /\s/.test(src[afterLt])) afterLt += 1;
        if (src[afterLt] === ">" || /[A-Za-z_$]/.test(src[afterLt] || "")) {
          let isArrowGen = false;
          if (src[afterLt] !== ">") {
            const probeTokens = tokenize(src.slice(p, Math.min(src.length, p + 512)));
            isArrowGen = isArrowGenericAhead(probeTokens, 0);
          }
          if (!isArrowGen) {
            let parsed = null;
            try {
              parsed = parseJsxElement(src, p);
            } catch (err) {
              if (err instanceof Error && err.message.startsWith("Etiqueta JSX")) {
                throw err;
              }
              parsed = null;
            }
            if (parsed) {
              chunks.push(src.slice(segCursor, p), parsed.js);
              segCursor = parsed.endIdx;
              p = parsed.endIdx;
              setLast({ type: "punct", value: ")" }, false);
              continue;
            }
          }
        }
      }

      if (ch === "{") {
        depth += 1;
        setLast({ type: "punct", value: "{" }, false);
        p += 1;
        continue;
      }
      if (ch === "}") {
        if (stopOnCloseCurly) {
          depth -= 1;
          if (depth === 0) {
            chunks.push(src.slice(segCursor, p));
            return {
              inner: chunks.join(""),
              endIdx: p + 1
            };
          }
        }
        setLast({ type: "punct", value: "}" }, false);
        p += 1;
        continue;
      }

      if (/[A-Za-z_$]/.test(ch) || ch.charCodeAt(0) > 127) {
        let j = p + 1;
        while (j < src.length && (/[A-Za-z0-9_$]/.test(src[j]) || src.charCodeAt(j) > 127)) j += 1;
        const wasProp = Boolean(lastSig && lastSig.type === "punct" && (lastSig.value === "." || lastSig.value === "?."));
        setLast({ type: "ident", value: src.slice(p, j) }, wasProp);
        p = j;
        continue;
      }

      if (/[0-9]/.test(ch)) {
        let j = p + 1;
        while (j < src.length && /[0-9A-Za-z_.]/.test(src[j])) j += 1;
        setLast({ type: "number", value: src.slice(p, j) }, false);
        p = j;
        continue;
      }

      const quad = src.slice(p, p + 4);
      const tri = src.slice(p, p + 3);
      const duo = src.slice(p, p + 2);
      const op = FOUR_CHAR_OPS.has(quad)
        ? quad
        : THREE_CHAR_OPS.has(tri)
          ? tri
          : TWO_CHAR_OPS.has(duo)
            ? duo
            : ch;
      setLast({ type: "punct", value: op }, false);
      p += op.length;
    }

    if (stopOnCloseCurly) {
      throw new Error(`Llave JSX sin cerrar en ${fileName}`);
    }
    chunks.push(src.slice(segCursor));
    return { inner: chunks.join(""), endIdx: src.length };
  }

  function findBalancedCurly(src, openIdx) {
    return scanJsSegment(src, openIdx + 1, true);
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
      while (p < src.length && /[A-Za-z0-9_$.-]/.test(src[p])) p += 1;
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
        while (p < src.length) {
          if (/\s/.test(src[p])) {
            p += 1;
            continue;
          }
          if (src[p] === "/" && src[p + 1] === "/") {
            const nl = src.indexOf("\n", p + 2);
            p = nl === -1 ? src.length : nl + 1;
            continue;
          }
          if (src[p] === "/" && src[p + 1] === "*") {
            const endC = src.indexOf("*/", p + 2);
            p = endC === -1 ? src.length : endC + 2;
            continue;
          }
          break;
        }
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
          // Omitir solo comentarios JSX puros `{/* ... */}` sin descartar `{/* a */ expr /* b */}`
          const withoutBlockComments = trimmed.replace(/\/\*[\s\S]*?\*\//g, "").trim();
          if (withoutBlockComments) {
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

  const expanded = scanJsSegment(source, 0, false);
  return { code: expanded.inner, usedJsx };
}
