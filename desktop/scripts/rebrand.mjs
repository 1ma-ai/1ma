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
  if (/^\s*(?:>=|<=|[<>^~])\s*\d/.test(rest)) return "identifier";
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
  if (word === "BB") return "product";
  if (lineStart && (rest === " " || rest.startsWith(` ${PLACEHOLDER}`))) return "command";
  if (rules.commandMarkers.includes(first)) return "command";
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
    .filter((decision) => decision.kind === "product" || decision.kind === "replace")
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
    } else if (decision.kind === "replace") {
      const start = toRaw(decision.index);
      const end = toRaw(decision.index + decision.length);
      if (end - start !== decision.length)
        throw new Error(`${file}: an override covers escaped text at ${start}`);
      if (/["'`\\$]/.test(decision.to))
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
  const { rules, record, learn, decide, regexes, wholeTemplates } = options;
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
        const { decisions } = regexes(pattern);
        edits.push(
          ...editsFor(
            file,
            text,
            { cooked: pattern, rawStart: node.getStart(source) + 1, raw: pattern, escapes: false },
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
      handle([segment], contextOf(node), false);
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

// The index of source strings that tests may repeat: what the rules changed
// (product offsets), what they kept (kept offsets, so a test never changes a
// bb that stays somewhere) and the whole-text overrides.
export function createIndex(rules) {
  const byKey = new Map();
  const seen = new Set();
  const add = (entry) => {
    const id = `${entry.text}\u0001${entry.product.join(",")}\u0001${entry.kept.join(",")}`;
    if (seen.has(id)) return;
    seen.add(id);
    for (const key of anchorKeys(entry.text)) {
      const list = byKey.get(key) ?? [];
      list.push(entry);
      byKey.set(key, list);
    }
  };
  const variants = (text, product, kept) => {
    const forms = [];
    const base = { text, map: Array.from({ length: text.length }, (_, i) => i) };
    const squashed = collapsed(text);
    const cut = trimmed(squashed.text);
    forms.push(base, squashed, { text: cut.text, map: cut.map.map((i) => squashed.map[i]) });
    for (const form of forms) {
      if (form.text.length < 8 || !/\s/.test(form.text.trim())) continue;
      const position = new Map(form.map.map((original, index) => [original, index]));
      const move = (offsets) =>
        offsets.filter((offset) => position.has(offset)).map((offset) => position.get(offset));
      const entry = { text: form.text, product: move(product), kept: move(kept), replaces: [] };
      const escaped = escapedRegex(form.text);
      const escapedPosition = new Map();
      escaped.map.forEach((original, index) => {
        if (!escapedPosition.has(original) && escaped.text[index] !== "\\")
          escapedPosition.set(original, index);
      });
      entry.escaped = {
        text: escaped.text,
        product: entry.product.map((offset) => escapedPosition.get(offset)),
        kept: entry.kept.map((offset) => escapedPosition.get(offset)),
        replaces: [],
      };
      add(entry);
    }
  };
  const index = {
    replacement: rules.replacement,
    byKey,
    learn(text, decisions) {
      const product = decisions.filter((d) => d.kind === "product").map((d) => d.index);
      const replaced = decisions.filter((d) => d.kind === "replace");
      const kept = occurrences(text).filter(
        (offset) =>
          !product.includes(offset) &&
          !replaced.some((d) => d.index <= offset && offset < d.index + d.length),
      );
      variants(text, product, kept);
    },
    keep(text) {
      variants(text, [], occurrences(text));
    },
  };
  for (const entry of rules.replace) {
    const replace = { index: 0, length: entry.text.length, to: entry.to };
    add({
      text: entry.text,
      product: [],
      kept: [],
      replaces: [replace],
      escaped: {
        text: escapedRegex(entry.text).text,
        product: [],
        kept: [],
        replaces: [{ index: 0, length: escapedRegex(entry.text).text.length, to: entry.to }],
      },
    });
  }
  for (const entry of rules.keep) index.keep(entry.text);
  return index;
}

export function propagate(text, index, { regex = false } = {}) {
  const product = new Set();
  const kept = new Set();
  const replaces = [];
  const prose = text.length >= 8 && /\s/.test(text.trim());
  const candidates = new Set();
  for (const key of anchorKeys(text))
    for (const entry of index.byKey.get(key) ?? []) candidates.add(entry);
  for (const entry of candidates) {
    for (const form of regex ? [entry, entry.escaped] : [entry]) {
      for (let at = text.indexOf(form.text); at !== -1; at = text.indexOf(form.text, at + 1)) {
        for (const offset of form.product) product.add(at + offset);
        for (const offset of form.kept) kept.add(at + offset);
        for (const replace of form.replaces)
          replaces.push({ ...replace, index: at + replace.index });
      }
      if (prose && form.text.length > text.length) {
        for (let at = form.text.indexOf(text); at !== -1; at = form.text.indexOf(text, at + 1)) {
          const inside = (offset) => offset >= at && offset + 2 <= at + text.length;
          for (const offset of form.product) if (inside(offset)) product.add(offset - at);
          for (const offset of form.kept) if (inside(offset)) kept.add(offset - at);
        }
      }
    }
  }
  const chosen = [];
  for (const replace of replaces.toSorted((a, b) => a.index - b.index)) {
    if (chosen.some((other) => replace.index < other.index + other.length)) continue;
    chosen.push({ ...replace, kind: "replace" });
  }
  const decisions = [...chosen];
  for (const offset of product) {
    if (kept.has(offset)) continue;
    if (text.slice(offset, offset + 2).toLowerCase() !== "bb") continue;
    if (
      chosen.some((replace) => replace.index <= offset && offset < replace.index + replace.length)
    )
      continue;
    decisions.push({ index: offset, kind: "product" });
  }
  return { result: compose(text, decisions, index.replacement), decisions };
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
  const shipped = (file) => !rules.notShipped.some((prefix) => file.startsWith(prefix));
  const sorted = files.toSorted();
  for (const file of sorted.filter((name) => kindOf(name) && !TEST_PATH.test(name))) {
    const text = readFileSync(path.join(root, file), "utf8");
    if (!/bb/i.test(text)) continue;
    const kind = kindOf(file);
    if (excluded(file, rules) || !shipped(file)) {
      if (kind !== "source") continue;
      literalEdits(file, text, {
        rules,
        decide: (cooked) => ({ result: cooked, decisions: [] }),
        learn: (cooked) => {
          if (/\s/.test(cooked.trim())) index.keep(cooked);
        },
      });
      continue;
    }
    const edits =
      kind === "source"
        ? literalEdits(file, text, {
            rules,
            record,
            learn: (cooked, decisions) => index.learn(cooked, decisions),
            decide: (cooked, context) => rebrandString(cooked, context, rules),
            wholeTemplates: true,
          })
        : kind === "markdown"
          ? markdownEdits(file, text, rules, record)
          : manifestEdits(file, text, rules, record);
    rewrite(file, edits, text, changed);
  }
  const testEdits = new Map(rules.testReplace.map((entry) => [entry.file, []]));
  for (const entry of rules.testReplace) testEdits.get(entry.file).push(entry);
  for (const file of sorted.filter((name) => TEST_PATH.test(name) && SOURCE.test(name))) {
    let text = readFileSync(path.join(root, file), "utf8");
    if (!/bb/i.test(text)) continue;
    const edits = literalEdits(file, text, {
      rules,
      decide: (cooked) => propagate(cooked, index),
      regexes: (pattern) => propagate(pattern, index, { regex: true }),
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
  for (const file of testEdits.keys())
    if (!files.includes(file)) throw new Error(`testReplace names a missing file: ${file}`);
  return {
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
    `rebrand ${command}: ${changed.length} files, ${counts.product} product mentions -> ${rules.replacement}, ${counts.replace} overrides; kept ${counts.command} commands, ${counts.code} code spans, ${counts.cloud} bb cloud mentions, ${counts.identifier} identifiers, ${counts.keep} kept by rule, ${counts.link} links`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
