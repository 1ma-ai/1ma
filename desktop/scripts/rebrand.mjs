import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REBRAND_DIR = path.resolve(here, "../rebrand");

const WORD = /(?<![\p{L}\p{N}_@./\\-])bb(?![\p{L}\p{N}_-])/giu;
const LINK = /getbb\.app|github\.com\/get-bb/iu;
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_PATH =
  /(?:\.test\.|\.spec\.|\.stories\.|\/test\/|\/tests\/|\/__tests__\/|\/\.ladle\/|^tests\/)/;
const CODE_KEYWORDS = new Set([
  "const",
  "var",
  "return",
  "typeof",
  "await",
  "yield",
  "instanceof",
  "void",
]);
const VISIBLE_ATTRIBUTES = new Set([
  "title",
  "label",
  "alt",
  "aria-label",
  "placeholder",
  "description",
]);
const VISIBLE_PROPERTIES = new Set([
  "title",
  "label",
  "description",
  "placeholder",
  "heading",
  "ariaLabel",
  "tooltip",
]);

export function loadRules(directory = REBRAND_DIR) {
  return JSON.parse(readFileSync(path.join(directory, "rules.json"), "utf8"));
}

function insideCodeSpan(text, index) {
  let ticks = 0;
  for (let i = 0; i < index; i += 1) if (text[i] === "`") ticks += 1;
  return ticks % 2 === 1;
}

function bareWord(token) {
  return token
    .replace(/^[("'`]+/, "")
    .replace(/[.,;:!?)"'`\]…]+$/, "")
    .replace(/['’]s$/, "");
}

export const PLACEHOLDER = "\uE000";

export function decideOccurrence(text, index, rules) {
  const end = index + 2;
  const word = text.slice(index, end);
  if (insideCodeSpan(text, index)) return "code";
  if (word === "Bb") return "identifier";
  const next = text[end] ?? "";
  const previous = text[index - 1] ?? "";
  if (previous === "[") return "identifier";
  if (previous === "(" && /[\p{L}\p{N}_$]/u.test(text[index - 2] ?? "")) return "identifier";
  if (previous === "(" && next === ",") return "identifier";
  if (next === ")" && /^\)\s*=>/.test(text.slice(end))) return "identifier";
  if (/["'`]/.test(previous) && next === previous) return "identifier";
  if (next === "(" || next === "[") return "identifier";
  const rest = text.slice(end);
  if (/^\s*(?:===?|!==?|&&|\|\||\?\?|=>|[+\-*/%]=|\?\.|=(?!=))/.test(rest)) return "identifier";
  const head = text.slice(0, index);
  if (/(?:===?\s*|!==?\s*|(?<![=!<>])=\s*|&&\s*|\|\|\s*|!)$/.test(head)) return "identifier";
  const keyword = /([A-Za-z_$][\w$]*)\s+$/.exec(head)?.[1];
  if (keyword && CODE_KEYWORDS.has(keyword)) return "identifier";
  const rawLead = /(?:^|\s)(\S+)\s+$/.exec(head)?.[1] ?? "";
  if (/^--?[A-Za-z][\w-]*$/.test(rawLead)) return "identifier";
  if (next === "/") return "identifier";
  if (next === ":" && text[end + 1] !== undefined && !/\s/.test(text[end + 1])) return "identifier";
  if (next === "." && /\p{L}/u.test(text[end + 1] ?? "")) return "identifier";
  const after = /^\s+([^\s]+)(?:\s+([^\s]+))?/.exec(rest);
  const first = after ? bareWord(after[1]) : "";
  const second = after && after[2] ? after[2] : "";
  const before = head.replace(/["'`(]+$/, "");
  const leading = /(?:^|\s)([^\s]+)\s+$/.exec(before);
  const lead = leading ? bareWord(leading[1]).toLowerCase() : "";
  const lineStart = /(?:^|\n)[ \t]*["'`]?[ \t]*$/.test(head);
  if (rules.cloudWords.includes(first.toLowerCase())) return "cloud";
  if (rules.strongCommandLeads.includes(lead)) return "command";
  if (rules.commandMarkers.includes(first)) return "command";
  if (word === "BB") return "product";
  if (lineStart && (rest === " " || rest.startsWith(` ${PLACEHOLDER}`))) return "command";
  const vocabulary = rules.vocabulary ?? new Map();
  const command = Object.hasOwn(rules.cli, first) || vocabulary.has(first);
  if (command) {
    const sub = bareWord(second);
    if (
      /^(?:-|<|\[|…|\.\.\.)/.test(second) ||
      /^[a-z-]+\|/.test(second) ||
      rules.commandMarkers.includes(sub)
    )
      return "command";
    if (rules.determiners.includes(lead)) return "product";
    if (
      (Object.hasOwn(rules.cli, first) && rules.cli[first].includes(sub)) ||
      vocabulary.get(first)?.has(sub)
    )
      return "command";
    if (rules.commandLeads.includes(lead)) return "command";
    if (lineStart && /^ [^\s]+[ \t]*(?:\n|$)/.test(rest)) return "command";
    if (lineStart && after[1] === first && second.startsWith(PLACEHOLDER)) return "command";
    return "product";
  }
  if (lead === "npx" || lead === "$") return "command";
  return "product";
}

function occurrences(text) {
  const found = [];
  WORD.lastIndex = 0;
  for (let match = WORD.exec(text); match; match = WORD.exec(text)) found.push(match.index);
  return found;
}

function overrideRanges(text, rules) {
  const ranges = [];
  const claim = (start, end, range) => {
    if (ranges.some((other) => start < other.end && other.start < end)) return;
    ranges.push({ start, end, ...range });
  };
  const entries = [
    ...rules.replace.map((entry) => ({ ...entry, kind: "replace" })),
    ...rules.keep.map((entry) => ({ ...entry, kind: "keep" })),
  ].toSorted((a, b) => b.text.length - a.text.length);
  for (const entry of entries) {
    for (let at = text.indexOf(entry.text); at !== -1; at = text.indexOf(entry.text, at + 1)) {
      claim(at, at + entry.text.length, { kind: entry.kind, to: entry.to });
    }
  }
  return ranges;
}

function compose(text, decisions, replacement) {
  let result = text;
  const edits = decisions
    .filter((decision) => ["product", "replace", "name"].includes(decision.kind))
    .toSorted((a, b) => b.index - a.index);
  for (const edit of edits) {
    const length = edit.kind === "product" ? 2 : edit.length;
    const value = edit.kind === "product" ? replacement : edit.to;
    result = result.slice(0, edit.index) + value + result.slice(edit.index + length);
  }
  return result;
}

export function rebrandProse(text, rules) {
  const decisions = occurrences(text).map((index) => ({
    index,
    kind: decideOccurrence(text, index, rules),
  }));
  return { result: compose(text, decisions, rules.replacement), decisions };
}

export function rebrandString(text, context, rules) {
  const ranges = overrideRanges(text, rules);
  const decisions = ranges.map((range) =>
    range.kind === "replace"
      ? { index: range.start, length: range.end - range.start, kind: "replace", to: range.to }
      : { index: range.start, kind: "keep" },
  );
  if (LINK.test(text)) decisions.push({ kind: "link" });
  const found = occurrences(text).filter(
    (index) => !ranges.some((range) => range.start <= index && index < range.end),
  );
  if (found.length > 0) {
    const prose = /\s/.test(text.trim()) || context.kind === "jsx-text";
    const visibleToken =
      (context.kind === "jsx-attribute" && VISIBLE_ATTRIBUTES.has(context.name)) ||
      (context.kind === "property" && VISIBLE_PROPERTIES.has(context.name));
    if (!prose && !visibleToken) decisions.push({ kind: "identifier" });
    else
      for (const index of found)
        decisions.push({ index, kind: decideOccurrence(text, index, rules) });
  }
  return { result: compose(text, decisions, rules.replacement), decisions };
}
function cookedToRaw(raw) {
  const map = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== "\\") {
      map.push(i);
      i += 1;
      continue;
    }
    const next = raw[i + 1];
    if (next === "\r" && raw[i + 2] === "\n") {
      i += 3;
      continue;
    }
    if (next === "\n" || next === "\r" || next === "\u2028" || next === "\u2029") {
      i += 2;
      continue;
    }
    let length = 2;
    let units = 1;
    if (next === "x") length = 4;
    else if (next === "u" && raw[i + 2] === "{") {
      const close = raw.indexOf("}", i);
      length = close - i + 1;
      units = Number.parseInt(raw.slice(i + 3, close), 16) > 0xffff ? 2 : 1;
    } else if (next === "u") length = 6;
    for (let unit = 0; unit < units; unit += 1) map.push(i);
    i += length;
  }
  map.push(raw.length);
  return map;
}

function calleeName(call) {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return "";
}

// A literal a test asserts the absence of: expect(x).not.toContain("…"),
// expect.not.stringContaining("…") or a queryBy… lookup, also inside an options
// object ({ name: /…/ }).
function negativeAssertion(node) {
  let current = node;
  while (
    current.parent &&
    (ts.isPropertyAssignment(current.parent) ||
      ts.isObjectLiteralExpression(current.parent) ||
      ts.isArrayLiteralExpression(current.parent))
  )
    current = current.parent;
  const call = current.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(current)) return false;
  if (/^query(?:All)?By/u.test(calleeName(call))) return true;
  for (
    let callee = call.expression;
    ts.isPropertyAccessExpression(callee);
    callee = callee.expression
  )
    if (callee.name.text === "not") return true;
  return false;
}

function contextOf(node) {
  const parent = node.parent;
  if (ts.isJsxText(node)) return { kind: "jsx-text" };
  if (!parent) return { kind: "value" };
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return { kind: "module" };
  if (ts.isExternalModuleReference(parent)) return { kind: "module" };
  if (ts.isLiteralTypeNode(parent) && parent.parent && ts.isImportTypeNode(parent.parent))
    return { kind: "module" };
  if (
    ts.isCallExpression(parent) &&
    (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(parent.expression) && parent.expression.text === "require"))
  )
    return { kind: "module" };
  if (ts.isPropertyAssignment(parent) && parent.name === node) return { kind: "key" };
  if (ts.isPropertySignature(parent) && parent.name === node) return { kind: "key" };
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
    return { kind: "key" };
  if (ts.isJsxAttribute(parent)) return { kind: "jsx-attribute", name: parent.name.getText() };
  if (ts.isPropertyAssignment(parent)) return { kind: "property", name: parent.name.getText() };
  return { kind: "value" };
}

function editsFor(file, text, segment, decisions, replacement) {
  const map = segment.escapes ? cookedToRaw(segment.raw) : null;
  const toRaw = (index) => segment.rawStart + (map ? map[index] : index);
  const edits = [];
  for (const decision of decisions) {
    if (decision.kind === "product") {
      const at = toRaw(decision.index);
      const found = text.slice(at, at + 2);
      if (found.toLowerCase() !== "bb")
        throw new Error(`${file}: cannot map "bb" at ${at} (found ${JSON.stringify(found)})`);
      edits.push({ start: at, end: at + 2, text: replacement });
    } else if (decision.kind === "replace" || decision.kind === "name") {
      const start = toRaw(decision.index);
      const end = toRaw(decision.index + decision.length);
      if (end - start !== decision.length)
        throw new Error(`${file}: an override covers escaped text at ${start}`);
      const unsafe = segment.regex ? /(?<!\\)\/|[\n\r]/u : /["'`\\$]/u;
      if (unsafe.test(decision.to))
        throw new Error(`${file}: an override result needs escaping: ${decision.to}`);
      edits.push({ start, end, text: decision.to });
    }
  }
  return edits;
}

function literalSegment(node, source, text) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const rawStart = node.getStart(source) + 1;
    return {
      cooked: node.text,
      rawStart,
      raw: text.slice(rawStart, node.end - 1),
      escapes: !(node.parent && ts.isJsxAttribute(node.parent)),
    };
  }
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
    return {
      cooked: node.text,
      rawStart: node.getStart(source) + 1,
      raw: node.rawText ?? "",
      escapes: true,
    };
  if (ts.isJsxText(node))
    return {
      cooked: node.text,
      rawStart: node.pos,
      raw: text.slice(node.pos, node.end),
      escapes: false,
    };
  return null;
}

// Source files: every string, whole template and JSX text goes through the rules.
// Test files: string parts follow the source through the propagation index, and
// regular expression literals do too; nothing in a test is decided by the rules.
function literalEdits(file, text, options) {
  const { rules, record, learn, learnTemplate, decide, regexes, wholeTemplates } = options;
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const edits = [];
  const handle = (segments, context, display) => {
    const full = segments.map((segment) => segment.cooked).join(PLACEHOLDER);
    if (!/bb/i.test(full)) return;
    if (context.kind === "module" || context.kind === "key") return;
    const { result, decisions } = decide(full, context);
    record?.(
      file,
      display ? full.replaceAll(PLACEHOLDER, "${…}") : full,
      display ? result.replaceAll(PLACEHOLDER, "${…}") : result,
      decisions,
    );
    let offset = 0;
    const local = segments.map((segment) => {
      const start = offset;
      offset += segment.cooked.length + PLACEHOLDER.length;
      return { segment, start, end: start + segment.cooked.length, decisions: [] };
    });
    for (const decision of decisions) {
      if (decision.index === undefined) continue;
      const part = local.find((item) => item.start <= decision.index && decision.index < item.end);
      if (!part) throw new Error(`${file}: a decision falls on a template placeholder`);
      if (decision.kind === "replace" && decision.index + decision.length > part.end)
        throw new Error(`${file}: an override spans a template placeholder`);
      part.decisions.push({ ...decision, index: decision.index - part.start });
    }
    for (const part of local) {
      learn?.(part.segment.cooked, part.decisions);
      edits.push(...editsFor(file, text, part.segment, part.decisions, rules.replacement));
    }
    if (local.length > 1)
      learnTemplate?.(
        local.map((part) => ({ text: part.segment.cooked, decisions: part.decisions })),
      );
  };
  const visit = (node) => {
    if (wholeTemplates && ts.isTemplateExpression(node)) {
      const parts = [node.head, ...node.templateSpans.map((span) => span.literal)];
      handle(
        parts.map((part) => literalSegment(part, source, text)),
        contextOf(node),
        true,
      );
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    if (regexes && node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const literal = node.getText(source);
      const pattern = literal.slice(1, literal.lastIndexOf("/"));
      if (/bb/i.test(pattern)) {
        const { decisions } = regexes(pattern, { negative: negativeAssertion(node) });
        edits.push(
          ...editsFor(
            file,
            text,
            {
              cooked: pattern,
              rawStart: node.getStart(source) + 1,
              raw: pattern,
              escapes: false,
              regex: true,
            },
            decisions,
            rules.replacement,
          ),
        );
      }
      return;
    }
    const segment = literalSegment(node, source, text);
    if (segment) {
      if (!segment.escapes && segment.raw !== segment.cooked)
        throw new Error(`${file}: literal text differs from its source at ${segment.rawStart}`);
      handle([segment], { ...contextOf(node), negative: negativeAssertion(node) }, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edits;
}

const EDGE = /[\s"'`.,;:!?()[\]{}…—–-]/u;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/;

function collapsed(text) {
  let out = "";
  const map = [];
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i])) {
      if (out.endsWith(" ")) continue;
      map.push(i);
      out += " ";
    } else {
      map.push(i);
      out += text[i];
    }
  }
  return { text: out, map };
}

function trimmed(text) {
  let start = 0;
  let end = text.length;
  while (start < end && EDGE.test(text[start]) && !/bb/i.test(text.slice(start, start + 2)))
    start += 1;
  while (end > start && EDGE.test(text[end - 1])) end -= 1;
  return {
    text: text.slice(start, end),
    map: Array.from({ length: end - start }, (_, i) => start + i),
  };
}

function escapedRegex(text) {
  let out = "";
  const map = [];
  for (let i = 0; i < text.length; i += 1) {
    if (REGEX_SPECIAL.test(text[i])) {
      map.push(i);
      out += "\\";
    }
    map.push(i);
    out += text[i];
  }
  return { text: out, map };
}

function anchorKeys(text) {
  const keys = new Set();
  for (const index of occurrences(text)) {
    const previous = /([\p{L}\p{N}']+)[^\p{L}\p{N}]*$/u.exec(
      text.slice(Math.max(0, index - 40), index),
    );
    const following = /^[^\p{L}\p{N}]*([\p{L}\p{N}']+)/u.exec(text.slice(index + 2, index + 42));
    const before = previous ? previous[1].toLowerCase() : "";
    const after = following ? following[1].toLowerCase() : "";
    keys.add(`${before}>${after}`);
    keys.add(`>${after}`);
    keys.add(`${before}>`);
  }
  return keys;
}

// The part of text[start, end) without surrounding whitespace.
function core(text, start, end) {
  return text.slice(start, end).trim();
}

function wordCount(text) {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

// Where the rules changed bb in a source text (product) and where it stays (kept).
function marked(text, decisions) {
  const product = decisions.filter((d) => d.kind === "product").map((d) => d.index);
  const replaced = decisions.filter((d) => d.kind === "replace" || d.kind === "name");
  const kept = occurrences(text).filter(
    (offset) =>
      !product.includes(offset) &&
      !replaced.some((d) => d.index <= offset && offset < d.index + d.length),
  );
  return { product, kept, replaced };
}

// Matching ignores case: a component may capitalise the text a test passes in.
function lowered(text) {
  let out = "";
  for (const char of text) {
    const lower = char.toLowerCase();
    out += lower.length === char.length ? lower : char;
  }
  return out;
}

// The same text as a regular expression would spell it, with the bb offsets moved.
function escapedForm(text, product, kept) {
  const escaped = escapedRegex(text);
  const position = new Map();
  escaped.map.forEach((original, index) => {
    if (!position.has(original) && escaped.text[index] !== "\\") position.set(original, index);
  });
  return {
    match: lowered(escaped.text),
    product: product.map((offset) => position.get(offset)),
    kept: kept.map((offset) => position.get(offset)),
  };
}

// The index of source strings that tests may repeat. Each entry remembers the
// package of its source (scope), whether the rebrand renamed that source or
// left it alone, where the rules changed bb (product) and where bb stays (kept).
// Overrides are indexed for the packages where they were applied; keep rules
// from rules.json are explicit and win over learned entries.
export function createIndex(rules) {
  const byKey = new Map();
  const seen = new Set();
  const add = (entry) => {
    const id = [
      entry.scope ?? "*",
      entry.explicit ? "!" : "",
      entry.match,
      entry.product.join(","),
      entry.kept.join(","),
      entry.rebranded ? "r" : "",
    ].join("\u0001");
    if (seen.has(id)) return;
    seen.add(id);
    for (const key of anchorKeys(entry.match)) {
      const list = byKey.get(key) ?? [];
      list.push(entry);
      byKey.set(key, list);
    }
  };
  const variants = (text, product, kept, scope, explicit, rebranded) => {
    const base = { text, map: Array.from({ length: text.length }, (_, i) => i) };
    const squashed = collapsed(text);
    const cut = trimmed(squashed.text);
    const forms = [base, squashed, { text: cut.text, map: cut.map.map((i) => squashed.map[i]) }];
    for (const form of forms) {
      if (form.text.length < 8 || !/\s/.test(form.text.trim())) continue;
      const position = new Map(form.map.map((original, index) => [original, index]));
      const move = (offsets) =>
        offsets.filter((offset) => position.has(offset)).map((offset) => position.get(offset));
      const entry = {
        scope,
        explicit,
        rebranded,
        match: lowered(form.text),
        product: move(product),
        kept: move(kept),
      };
      entry.escaped = escapedForm(form.text, entry.product, entry.kept);
      add(entry);
    }
  };
  const replaces = [];
  const replaceIds = new Set();
  const replaceEntry = (text, to, scope, encode = true) => {
    const id = `${scope ?? "*"}\u0001${text}\u0001${to}`;
    if (replaceIds.has(id)) return;
    replaceIds.add(id);
    const encoded = encodeURIComponent(text);
    if (encode && encoded !== text) replaceEntry(encoded, encodeURIComponent(to), scope, false);
    const escaped = escapedRegex(text).text;
    replaces.push({
      scope,
      forms: [
        { match: lowered(text), length: text.length, to },
        { match: lowered(escaped), length: escaped.length, to: escapedRegex(to).text, regex: true },
      ],
    });
  };
  const templateKeys = new Map();
  const template = (parts, scope, rebranded) => {
    const forms = parts.map(({ text, product, kept }) => ({
      match: lowered(text),
      product,
      kept,
      escaped: escapedForm(text, product, kept),
    }));
    const entry = {
      scope,
      rebranded,
      parts: forms.map(({ match, product, kept }) => ({ match, product, kept })),
      escaped: forms.map((form) => form.escaped),
    };
    const keys = new Set();
    for (const part of entry.parts) for (const key of anchorKeys(part.match)) keys.add(key);
    for (const key of keys) {
      const list = templateKeys.get(key) ?? [];
      list.push(entry);
      templateKeys.set(key, list);
    }
  };
  const index = {
    replacement: rules.replacement,
    byKey,
    templateKeys,
    replaces,
    learnTemplate(parts, scope = null) {
      template(
        parts.map(({ text, decisions }) => ({ text, ...marked(text, decisions) })),
        scope,
        true,
      );
    },
    keepTemplate(parts, scope = null) {
      template(
        parts.map(({ text }) => ({ text, product: [], kept: occurrences(text) })),
        scope,
        false,
      );
    },
    learn(text, decisions, scope = null) {
      const { product, kept, replaced } = marked(text, decisions);
      variants(text, product, kept, scope, false, true);
      for (const decision of replaced)
        replaceEntry(
          text.slice(decision.index, decision.index + decision.length),
          decision.to,
          scope,
        );
    },
    keep(text, scope = null, explicit = false) {
      variants(text, [], occurrences(text), scope, explicit, false);
    },
  };
  for (const entry of rules.keep) index.keep(entry.text, null, true);
  return index;
}

// Decides each bb of a test string from the source strings it shares text with.
// A source text and the test string are aligned on a bb they share; the overlap
// must read the same and, without surrounding whitespace, span two words and at
// least 8 characters, so a test can repeat a source text, quote part of it, or cut
// through a template value. When neither string contains the other, the overlap
// rests on where both happen to end and needs three words. Only sources of the test's package and its
// dependencies count (scope). Explicit rules win; then the longest overlap; then,
// for an overlap of three words or more, sources treated like the test's own
// package (renamed or left alone); a remaining tie keeps bb. A bb the rules
// would keep in the test itself (a command, code, an identifier, a bb cloud
// service) is never changed (veto). The relaxed mode, used only to flag
// suspicious negative assertions, accepts two-word partial overlaps and lets a
// renamed source win a tie.
export function propagate(
  text,
  index,
  { regex = false, scope = null, veto = null, keep = [], rebranded = true, relaxed = false } = {},
) {
  const haystack = lowered(text);
  const marks = occurrences(haystack);
  const evidence = new Map();
  const partialWords = relaxed ? 2 : 3;
  const rank = (found) => [
    found.explicit ? 1 : 0,
    found.length,
    found.explicit || (found.words >= 3 && found.rebranded === rebranded) ? 1 : 0,
    (found.kind === "kept") !== relaxed ? 1 : 0,
  ];
  const consider = (offset, found) => {
    const current = evidence.get(offset);
    if (!current) {
      evidence.set(offset, found);
      return;
    }
    const [a, b] = [rank(found), rank(current)];
    const first = a.findIndex((value, position) => value !== b[position]);
    if (first !== -1 && a[first] > b[first]) evidence.set(offset, found);
  };
  for (const phrase of keep) {
    const needle = lowered(phrase);
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1))
      for (const offset of occurrences(needle))
        consider(at + offset, { length: needle.length, kind: "kept", explicit: true });
  }
  const replaces = [];
  const visible = (entry) => entry.scope === null || scope === null || scope.has(entry.scope);
  const candidates = new Set();
  for (const key of anchorKeys(haystack))
    for (const entry of index.byKey.get(key) ?? []) if (visible(entry)) candidates.add(entry);
  for (const entry of index.replaces) {
    if (!visible(entry)) continue;
    for (const form of entry.forms) {
      if (form.regex && !regex) continue;
      for (
        let at = haystack.indexOf(form.match);
        at !== -1;
        at = haystack.indexOf(form.match, at + 1)
      )
        replaces.push({ index: at, length: form.length, to: form.to });
    }
  }
  for (const entry of candidates) {
    for (const form of regex ? [entry, entry.escaped] : [entry]) {
      const needle = form.match;
      const own = [
        ...form.product.map((offset) => [offset, "product"]),
        ...form.kept.map((offset) => [offset, "kept"]),
      ];
      const shifts = new Set();
      for (const mark of marks) for (const [offset] of own) shifts.add(mark - offset);
      for (const shift of shifts) {
        let start = Math.max(0, shift);
        let end = Math.min(haystack.length, shift + needle.length);
        if (entry.explicit && end - start !== needle.length) continue;
        if (haystack.slice(start, end) !== needle.slice(start - shift, end - shift)) continue;
        const whole = end - start === needle.length || end - start === haystack.length;
        while (start < end && /\s/u.test(haystack[start])) start += 1;
        while (end > start && /\s/u.test(haystack[end - 1])) end -= 1;
        const overlap = haystack.slice(start, end);
        if (overlap.length < 8 || !/\S\s+\S/u.test(overlap)) continue;
        const words = wordCount(overlap);
        if (!whole && words < partialWords) continue;
        for (const [offset, kind] of own) {
          const at = offset + shift;
          if (at < start || at + 2 > end) continue;
          consider(at, {
            length: overlap.length,
            words,
            kind,
            explicit: entry.explicit,
            rebranded: entry.rebranded,
          });
        }
      }
    }
  }
  const templates = new Set();
  for (const key of anchorKeys(haystack))
    for (const entry of index.templateKeys.get(key) ?? []) if (visible(entry)) templates.add(entry);
  for (const entry of templates)
    for (const parts of regex ? [entry.parts, entry.escaped] : [entry.parts])
      parts.forEach((part, at) => {
        for (const found of templateEvidence(haystack, marks, parts, at, partialWords))
          consider(found.offset, { ...found, explicit: false, rebranded: entry.rebranded });
      });
  const chosen = [];
  for (const replace of replaces.toSorted((a, b) => a.index - b.index)) {
    if (chosen.some((other) => replace.index < other.index + other.length)) continue;
    const covered = [...evidence].some(
      ([offset, found]) =>
        found.explicit &&
        found.kind === "kept" &&
        replace.index <= offset &&
        offset < replace.index + replace.length,
    );
    if (!covered) chosen.push({ ...replace, kind: "replace" });
  }
  const decisions = [...chosen];
  for (const [offset, found] of evidence) {
    if (found.kind !== "product") continue;
    if (text.slice(offset, offset + 2).toLowerCase() !== "bb") continue;
    if (
      chosen.some((replace) => replace.index <= offset && offset < replace.index + replace.length)
    )
      continue;
    if (veto?.(text, offset)) continue;
    decisions.push({ index: offset, kind: "product" });
  }
  return { result: compose(text, decisions, index.replacement), decisions };
}

// A template part aligned on a bb of the test string, with the template parts
// around it found in order on either side: a placeholder may stand for any text,
// and the test string may start or end inside a part.
function templateEvidence(haystack, marks, parts, at, minWords) {
  const part = parts[at];
  const own = [
    ...part.product.map((offset) => [offset, "product"]),
    ...part.kept.map((offset) => [offset, "kept"]),
  ];
  const found = [];
  if (own.length === 0) return found;
  const shifts = new Set();
  for (const mark of marks) for (const [offset] of own) shifts.add(mark - offset);
  for (const shift of shifts) {
    const start = Math.max(0, shift);
    const end = Math.min(haystack.length, shift + part.match.length);
    if (start >= end) continue;
    if (haystack.slice(start, end) !== part.match.slice(start - shift, end - shift)) continue;
    const pieces = [core(haystack, start, end)];
    let left = shift;
    for (let index = at - 1; index >= 0 && left > 0; index -= 1) {
      const before = parts[index].match;
      if (before.length === 0) continue;
      const position = haystack.lastIndexOf(before, left - before.length);
      if (position !== -1 && position + before.length <= left) {
        pieces.push(core(before, 0, before.length));
        left = position;
        continue;
      }
      for (let size = Math.min(left, before.length - 1); size > 0; size -= 1)
        if (before.endsWith(haystack.slice(0, size))) {
          pieces.push(core(haystack, 0, size));
          break;
        }
      break;
    }
    let right = shift + part.match.length;
    for (let index = at + 1; index < parts.length && right < haystack.length; index += 1) {
      const after = parts[index].match;
      if (after.length === 0) continue;
      const position = haystack.indexOf(after, right);
      if (position !== -1) {
        pieces.push(core(after, 0, after.length));
        right = position + after.length;
        continue;
      }
      for (let size = Math.min(haystack.length - right, after.length - 1); size > 0; size -= 1)
        if (after.startsWith(haystack.slice(haystack.length - size))) {
          pieces.push(core(haystack, haystack.length - size, haystack.length));
          break;
        }
      break;
    }
    const context = pieces.filter((piece) => piece.length > 0);
    if (context.length < 2) continue;
    const length = context.reduce((sum, piece) => sum + piece.length, 0);
    const words = context.reduce((sum, piece) => sum + wordCount(piece), 0);
    if (length < 8 || words < minWords) continue;
    for (const [offset, kind] of own) {
      const position = offset + shift;
      if (position >= start && position + 2 <= end)
        found.push({ offset: position, length, words, kind });
    }
  }
  return found;
}

// The top-level alternatives of a regular expression pattern: each is its own
// text ("Copy the command|Relaunch bb|Download").
export function alternatives(pattern) {
  const parts = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "|" && depth === 0) {
      parts.push({ start, text: pattern.slice(start, i) });
      start = i + 1;
    }
  }
  parts.push({ start, text: pattern.slice(start) });
  return parts;
}

// Lines of files the rebrand leaves alone (scripts, docs, skills): split where
// a script substitutes a value or a string starts or ends.
const SCRIPT_BREAK = /\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][\w]*|["'`]/u;
const TEXT_FILE = /\.(?:sh|bash|zsh|ps1|psm1|cmd|bat|md|mdx|txt|ya?ml|toml|html?)$/i;

export function keptPhrases(text) {
  const phrases = [];
  for (const line of text.split("\n")) {
    if (!/bb/i.test(line)) continue;
    for (const piece of line.split(SCRIPT_BREAK))
      if (/bb/i.test(piece) && /\s/.test(piece.trim())) phrases.push(piece);
  }
  return phrases;
}

// The workspace packages and what each depends on, so a test only follows the
// sources it can reach.
export function packageGraph(root, files) {
  const manifests = new Map();
  for (const file of files) {
    if (path.posix.basename(file) !== "package.json") continue;
    if (/\/(?:test|tests|__tests__|fixtures|__fixtures__)\//.test(file)) continue;
    try {
      manifests.set(
        path.posix.dirname(file),
        JSON.parse(readFileSync(path.join(root, file), "utf8")),
      );
    } catch {
      // not a manifest
    }
  }
  const directoryOf = new Map();
  for (const [directory, manifest] of manifests)
    if (typeof manifest.name === "string") directoryOf.set(manifest.name, directory);
  const direct = new Map();
  for (const [directory, manifest] of manifests) {
    const dependencies = new Set();
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ])
      for (const name of Object.keys(manifest[field] ?? {}))
        if (directoryOf.has(name) && directoryOf.get(name) !== directory)
          dependencies.add(directoryOf.get(name));
    direct.set(directory, dependencies);
  }
  const packageOf = (file) => {
    for (let directory = path.posix.dirname(file); ; directory = path.posix.dirname(directory)) {
      if (manifests.has(directory)) return directory;
      if (directory === "." || directory === "/") return ".";
    }
  };
  const scopes = new Map();
  const scopeOf = (file) => {
    const start = packageOf(file);
    if (scopes.has(start)) return scopes.get(start);
    const scope = new Set([start]);
    const queue = [start];
    while (queue.length > 0)
      for (const dependency of direct.get(queue.pop()) ?? [])
        if (!scope.has(dependency)) {
          scope.add(dependency);
          queue.push(dependency);
        }
    scopes.set(start, scope);
    return scope;
  };
  return { packageOf, scopeOf };
}

function markdownEdits(file, text, rules, record) {
  const edits = [];
  let fenced = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /bb/i.test(line)) {
      const { result, decisions } = rebrandString(line, { kind: "jsx-text" }, rules);
      record(file, line, result, decisions);
      if (result !== line) edits.push({ start: offset, end: offset + line.length, text: result });
    }
    offset += line.length + 1;
  }
  return edits;
}

function manifestEdits(file, text, rules, record) {
  const manifest = JSON.parse(text).bb;
  if (!manifest) return [];
  const edits = [];
  for (const key of ["name", "description"]) {
    const value = manifest[key];
    if (typeof value !== "string") continue;
    const { result, decisions } = rebrandString(value, { kind: "jsx-text" }, rules);
    record(file, value, result, decisions);
    if (result === value) continue;
    const needle = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    const section = text.indexOf('"bb": {');
    const at = section === -1 ? -1 : text.indexOf(needle, section);
    if (at === -1) throw new Error(`${file}: cannot locate bb.${key}`);
    edits.push({
      start: at,
      end: at + needle.length,
      text: `${JSON.stringify(key)}: ${JSON.stringify(result)}`,
    });
  }
  return edits;
}

function firstWord(value) {
  return /^[a-z][a-z0-9-]*/.exec(value)?.[0];
}

function commandCall(expression) {
  let current = expression;
  while (
    current &&
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression)
  ) {
    const [argument] = current.arguments;
    if (current.expression.name.text === "command" && argument && ts.isStringLiteralLike(argument))
      return { receiver: current.expression.expression, name: firstWord(argument.text) };
    current = current.expression.expression;
  }
  return null;
}

export function collectVocabulary(root, files) {
  const tree = new Map();
  const add = (command, subcommand) => {
    if (!tree.has(command)) tree.set(command, new Set());
    if (subcommand) tree.get(command).add(subcommand);
  };
  const nestedKeys = (object, command) => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : null;
      if (key) add(command, key);
      const value = property.initializer;
      if (
        ts.isCallExpression(value) &&
        value.arguments[0] &&
        ts.isObjectLiteralExpression(value.arguments[0])
      )
        for (const inner of value.arguments[0].properties)
          if (
            ts.isPropertyAssignment(inner) &&
            ts.isIdentifier(inner.name) &&
            inner.name.text === "commands" &&
            ts.isObjectLiteralExpression(inner.initializer)
          )
            nestedKeys(inner.initializer, command);
    }
  };
  const unresolved = [];
  for (const file of files) {
    if (!SOURCE.test(file) || TEST_PATH.test(file)) continue;
    const text = readFileSync(path.join(root, file), "utf8");
    if (!text.includes(".command(") && !text.includes("defineCli(")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const owners = new Map();
    const ownerOf = (receiver) => {
      if (!ts.isIdentifier(receiver)) return null;
      if (receiver.text === "program") return "";
      return owners.get(receiver.text) ?? null;
    };
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const call = commandCall(node.initializer);
        if (call && call.name) {
          const owner = ownerOf(call.receiver);
          if (owner === "") owners.set(node.name.text, call.name);
          else if (owner) owners.set(node.name.text, owner);
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const [argument] = node.arguments;
        if (
          node.expression.name.text === "command" &&
          argument &&
          ts.isStringLiteralLike(argument)
        ) {
          const receiver = node.expression.expression;
          const owner = ownerOf(receiver);
          const name = firstWord(argument.text);
          if (owner === "" && name) add(name);
          else if (owner && name) add(owner, name);
          else if (owner === null && name) {
            const directory = /^apps\/cli\/src\/commands\/([a-z][a-z0-9-]*)\//.exec(file)?.[1];
            if (directory) unresolved.push([directory, name]);
            else if (ts.isIdentifier(receiver)) unresolved.push([receiver.text, name]);
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "defineCli"
      ) {
        const [argument] = node.arguments;
        if (argument && ts.isObjectLiteralExpression(argument)) {
          let name = null;
          let commands = null;
          for (const property of argument.properties) {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
            if (property.name.text === "name" && ts.isStringLiteralLike(property.initializer))
              name = property.initializer.text;
            if (
              property.name.text === "commands" &&
              ts.isObjectLiteralExpression(property.initializer)
            )
              commands = property.initializer;
          }
          if (name) {
            add(name);
            if (commands) nestedKeys(commands, name);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const [receiver, name] of unresolved) if (tree.has(receiver)) add(receiver, name);
  return tree;
}

export function walk(root, relative, skip, out) {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, child, skip, out);
    else if (entry.isFile()) out.push(child);
  }
}

function kindOf(file) {
  if (SOURCE.test(file)) return "source";
  if (file.endsWith("/PLUGIN_OVERVIEW.md")) return "markdown";
  if (/^plugins\/[^/]+\/package\.json$/.test(file)) return "manifest";
  return null;
}

export function excluded(file, rules) {
  return (
    rules.exclude.some((prefix) => file.startsWith(prefix)) ||
    rules.excludeSegments.some((segment) => file.includes(segment))
  );
}

export function rebrandTree(root, rules, { write = false } = {}) {
  const files = [];
  const skip = new Set(rules.skipDirectories);
  for (const top of rules.roots) {
    try {
      if (statSync(path.join(root, top)).isDirectory()) walk(root, top, skip, files);
    } catch {
      // a root bb does not have
    }
  }
  rules = { ...rules, vocabulary: collectVocabulary(root, files) };
  const inventory = new Map();
  const changed = [];
  const testsChanged = [];
  const counts = {
    product: 0,
    replace: 0,
    keep: 0,
    code: 0,
    command: 0,
    cloud: 0,
    identifier: 0,
    link: 0,
    name: 0,
  };
  const record = (file, text, result, decisions) => {
    for (const decision of decisions) counts[decision.kind] += 1;
    if (decisions.length === 0) return;
    const key = JSON.stringify(result === text ? [text] : [text, result]);
    const sources = inventory.get(key) ?? new Set();
    sources.add(file);
    inventory.set(key, sources);
  };
  const rewrite = (file, edits, text, list) => {
    if (edits.length === 0) return text;
    let next = text;
    for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
      next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    }
    list.push(file);
    if (write) writeFileSync(path.join(root, file), next);
    return next;
  };
  const index = createIndex(rules);
  const note = (scope) => (file, original, result, decisions) => {
    record(file, original, result, decisions);
    index.learn(original, decisions, scope);
  };
  const graph = packageGraph(root, files);
  const shipped = (file) => !rules.notShipped.some((prefix) => file.startsWith(prefix));
  const sorted = files.toSorted();
  // A renamed plugin name changes wherever a string is exactly that name, in
  // code the rebrand otherwise leaves alone and in JSON too: those strings refer
  // to the plugin (first-party tables, "used by" lists) and must keep matching.
  const names = new Map();
  for (const file of sorted.filter((name) => kindOf(name) === "manifest")) {
    if (excluded(file, rules) || !shipped(file)) continue;
    const value = JSON.parse(readFileSync(path.join(root, file), "utf8")).bb?.name;
    if (typeof value !== "string") continue;
    const { result } = rebrandString(value, { kind: "jsx-text" }, rules);
    if (result !== value) names.set(value, result);
  }
  const named = (cooked) => {
    const to = names.get(cooked);
    if (to === undefined) return null;
    return { result: to, decisions: [{ index: 0, length: cooked.length, kind: "name", to }] };
  };
  for (const file of sorted.filter((name) => !TEST_PATH.test(name))) {
    const kind = kindOf(file);
    const leftAlone = excluded(file, rules) || !shipped(file);
    if (!kind && !TEXT_FILE.test(file)) continue;
    const text = readFileSync(path.join(root, file), "utf8");
    if (!/bb/i.test(text)) continue;
    const scope = graph.packageOf(file);
    if (kind !== "source" && (leftAlone || !kind)) {
      for (const phrase of keptPhrases(text)) index.keep(phrase, scope);
      continue;
    }
    if (leftAlone) {
      const edits = literalEdits(file, text, {
        rules,
        record,
        decide: (cooked) => named(cooked) ?? { result: cooked, decisions: [] },
        learn: (cooked) => {
          if (/\s/.test(cooked.trim()) && !names.has(cooked)) index.keep(cooked, scope);
        },
        learnTemplate: (parts) => index.keepTemplate(parts, scope),
        wholeTemplates: true,
      });
      rewrite(file, edits, text, changed);
      continue;
    }
    const edits =
      kind === "source"
        ? literalEdits(file, text, {
            rules,
            record,
            learn: (cooked, decisions) => index.learn(cooked, decisions, scope),
            learnTemplate: (parts) => index.learnTemplate(parts, scope),
            decide: (cooked, context) => named(cooked) ?? rebrandString(cooked, context, rules),
            wholeTemplates: true,
          })
        : kind === "markdown"
          ? markdownEdits(file, text, rules, note(scope))
          : manifestEdits(file, text, rules, note(scope));
    rewrite(file, edits, text, changed);
  }
  for (const file of sorted.filter((name) => name.endsWith(".json"))) {
    if (names.size === 0 || path.posix.basename(file) === "package.json") continue;
    const text = readFileSync(path.join(root, file), "utf8");
    let next = text;
    for (const [from, to] of names) {
      const needle = JSON.stringify(from);
      if (!next.includes(needle)) continue;
      next = next.replaceAll(needle, JSON.stringify(to));
      if (!TEST_PATH.test(file)) record(file, from, to, [{ kind: "name" }]);
    }
    if (next !== text) {
      (TEST_PATH.test(file) ? testsChanged : changed).push(file);
      if (write) writeFileSync(path.join(root, file), next);
    }
  }
  const testEdits = new Map(rules.testReplace.map((entry) => [entry.file, []]));
  for (const entry of rules.testReplace) testEdits.get(entry.file).push(entry);
  const testKeeps = new Map();
  for (const entry of rules.testKeep ?? [])
    testKeeps.set(entry.file, [...(testKeeps.get(entry.file) ?? []), entry.text]);
  const kept = new Set(["code", "command", "cloud", "identifier"]);
  const veto = (text, offset) => kept.has(decideOccurrence(text, offset, rules));
  const suspicious = [];
  for (const file of sorted.filter((name) => TEST_PATH.test(name) && SOURCE.test(name))) {
    let text = readFileSync(path.join(root, file), "utf8");
    if (!/bb/i.test(text) && !testEdits.has(file) && !testKeeps.has(file)) continue;
    const keep = testKeeps.get(file) ?? [];
    for (const phrase of keep)
      if (!text.includes(phrase))
        throw new Error(`${file}: testKeep "${phrase}" no longer matches; review it`);
    const scope = graph.scopeOf(file);
    const rebranded = !excluded(file, rules) && shipped(file);
    const options = { scope, veto, keep, rebranded };
    const byAlternative = (pattern, more) => {
      const decisions = [];
      for (const { start, text: part } of alternatives(pattern))
        for (const decision of propagate(part, index, { ...options, regex: true, ...more })
          .decisions)
          decisions.push({ ...decision, index: decision.index + start });
      return { result: compose(pattern, decisions, rules.replacement), decisions };
    };
    const flag = (literal, decided, relaxed) => {
      const reviewed = (testEdits.get(file) ?? []).some((entry) => entry.find.includes(literal));
      if (relaxed.result !== decided.result && !reviewed)
        suspicious.push(
          `${file}: ${JSON.stringify(literal)} stays as is, but a renamed source suggests ${JSON.stringify(relaxed.result)}`,
        );
    };
    const edits = literalEdits(file, text, {
      rules,
      decide: (cooked, context) => {
        const decided = named(cooked) ?? propagate(cooked, index, options);
        if (context.negative && !named(cooked))
          flag(cooked, decided, propagate(cooked, index, { ...options, relaxed: true }));
        return decided;
      },
      regexes: (pattern, context) => {
        const decided = byAlternative(pattern, {});
        if (context.negative) flag(pattern, decided, byAlternative(pattern, { relaxed: true }));
        return decided;
      },
    });
    text = rewrite(file, edits, text, testsChanged);
    for (const entry of testEdits.get(file) ?? []) {
      if (!text.includes(entry.find))
        throw new Error(`${file}: testReplace "${entry.find}" no longer matches; review it`);
      const next = text.replaceAll(entry.find, entry.replace);
      if (!testsChanged.includes(file)) testsChanged.push(file);
      if (write) writeFileSync(path.join(root, file), next);
      text = next;
    }
  }
  for (const file of [...testEdits.keys(), ...testKeeps.keys()])
    if (!files.includes(file)) throw new Error(`a test rule names a missing file: ${file}`);
  if (suspicious.length > 0)
    throw new Error(
      `These negative assertions in bb's tests may check text the rebrand renamed, so they could pass without testing anything. Add a testReplace or testKeep entry with a reason for each:\n${suspicious.join("\n")}`,
    );
  return {
    context: { index, graph, rules, veto },
    inventory,
    changed: [...changed, ...testsChanged],
    sourcesChanged: changed,
    testsChanged,
    counts,
  };
}

export function formatInventory(inventory) {
  const rows = [...inventory.keys()].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `[\n${rows.join(",\n")}\n]\n`;
}

export function diffInventory(expected, actual) {
  const before = new Set(expected.split("\n"));
  const after = new Set(actual.split("\n"));
  const removed = [...before].filter((line) => !after.has(line) && line.length > 1);
  const added = [...after].filter((line) => !before.has(line) && line.length > 1);
  return { added, removed };
}

function main(argv) {
  const [command, tree] = argv;
  if (!["apply", "check", "update"].includes(command) || !tree) {
    throw new Error(
      "usage: node desktop/scripts/rebrand.mjs apply|check|update <prepared bb tree>",
    );
  }
  const rules = loadRules();
  const lockPath = path.join(REBRAND_DIR, "inventory.json");
  const { inventory, changed, counts } = rebrandTree(path.resolve(tree), rules, {
    write: command === "apply",
  });
  const actual = formatInventory(inventory);
  if (command === "update") {
    writeFileSync(lockPath, actual);
    console.log(`wrote ${lockPath}: ${inventory.size} texts`);
    return;
  }
  const { added, removed } = diffInventory(readFileSync(lockPath, "utf8"), actual);
  if (added.length > 0 || removed.length > 0) {
    console.error(
      `bb strings differ from desktop/rebrand/inventory.json (${added.length} new or changed, ${removed.length} gone).`,
    );
    for (const line of removed.slice(0, 40)) console.error(`- ${line}`);
    for (const line of added.slice(0, 40)) console.error(`+ ${line}`);
    console.error("Review them, adjust desktop/rebrand/rules.json if needed, then run `update`.");
    process.exitCode = 1;
    return;
  }
  console.log(
    `rebrand ${command}: ${changed.length} files, ${counts.product} product mentions -> ${rules.replacement}, ${counts.replace} overrides, ${counts.name} plugin name references; kept ${counts.command} commands, ${counts.code} code spans, ${counts.cloud} bb cloud mentions, ${counts.identifier} identifiers, ${counts.keep} kept by rule, ${counts.link} links`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
