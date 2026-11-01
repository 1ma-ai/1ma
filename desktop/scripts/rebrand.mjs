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

export function decideOccurrence(text, index, rules) {
  const end = index + 2;
  if (insideCodeSpan(text, index)) return "code";
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
  if (next === "/") return "identifier";
  if (next === ":" && text[end + 1] !== undefined && !/\s/.test(text[end + 1])) return "identifier";
  if (next === "." && /\p{L}/u.test(text[end + 1] ?? "")) return "identifier";
  const after = /^\s+([^\s]+)(?:\s+([^\s]+))?/.exec(text.slice(end));
  const first = after ? bareWord(after[1]) : "";
  const second = after && after[2] ? after[2] : "";
  const before = text.slice(0, index).replace(/["'`(]+$/, "");
  const leading = /(?:^|\s)([^\s]+)\s+$/.exec(before);
  const lead = leading ? bareWord(leading[1]).toLowerCase() : "";
  const lineStart = /(?:^|\n)[ \t]*["'`]?[ \t]*$/.test(text.slice(0, index));
  if (lineStart && text.slice(end) === " ") return "command";
  if (rules.cloudWords.includes(first.toLowerCase())) return "cloud";
  if (rules.strongCommandLeads.includes(lead)) return "command";
  if (rules.commandMarkers.includes(first)) return "command";
  if (text.slice(index, end) === "BB") return "product";
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
    if (lineStart && /^ [^\s]+[ \t]*(?:\n|$)/.test(text.slice(end))) return "command";
    return "product";
  }
  if (lead === "npx" || lead === "$") return "command";
  return "product";
}

export function rebrandProse(text, rules) {
  const decisions = [];
  WORD.lastIndex = 0;
  for (let match = WORD.exec(text); match; match = WORD.exec(text)) {
    decisions.push({ index: match.index, kind: decideOccurrence(text, match.index, rules) });
  }
  let result = text;
  for (const decision of decisions.toReversed()) {
    if (decision.kind !== "product") continue;
    result = result.slice(0, decision.index) + rules.replacement + result.slice(decision.index + 2);
  }
  return { result, decisions };
}

function override(text, rules) {
  if (rules.keep.some((entry) => entry.text === text))
    return { result: text, decisions: [{ kind: "keep" }] };
  const replaced = rules.replace.find((entry) => entry.text === text);
  if (replaced) return { result: replaced.to, decisions: [{ kind: "override" }] };
  return null;
}

export function rebrandString(text, context, rules) {
  const fixed = override(text, rules);
  if (fixed) return fixed;
  WORD.lastIndex = 0;
  const links = LINK.test(text) ? [{ kind: "link" }] : [];
  if (!WORD.test(text)) return { result: text, decisions: links };
  const prose = /\s/.test(text.trim()) || context.kind === "jsx-text";
  const visibleToken =
    (context.kind === "jsx-attribute" && VISIBLE_ATTRIBUTES.has(context.name)) ||
    (context.kind === "property" && VISIBLE_PROPERTIES.has(context.name));
  if (!prose && !visibleToken)
    return { result: text, decisions: [{ kind: "identifier" }, ...links] };
  const { result, decisions } = rebrandProse(text, rules);
  return { result, decisions: [...decisions, ...links] };
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

function literalEdits(file, text, rules, record, decide) {
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const edits = [];
  const visit = (node) => {
    let cooked = null;
    let rawStart = 0;
    let raw = "";
    let escapes = true;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      cooked = node.text;
      rawStart = node.getStart(source) + 1;
      raw = text.slice(rawStart, node.end - 1);
      escapes = !(node.parent && ts.isJsxAttribute(node.parent));
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      cooked = node.text;
      rawStart = node.getStart(source) + 1;
      raw = node.rawText ?? "";
    } else if (ts.isJsxText(node)) {
      cooked = node.text;
      rawStart = node.pos;
      raw = text.slice(rawStart, node.end);
      escapes = false;
    }
    if (cooked !== null && !escapes && raw !== cooked)
      throw new Error(`${file}: literal text differs from its source at ${rawStart}`);
    if (cooked !== null && /bb/i.test(cooked)) {
      const context = contextOf(node);
      if (context.kind !== "module" && context.kind !== "key") {
        const { result, decisions } = decide(cooked, context);
        record(file, cooked, result, decisions);
        if (result !== cooked) {
          if (decisions.some((decision) => decision.kind === "override")) {
            if (escapes && raw !== cooked)
              throw new Error(
                `${file}: an override targets a literal with escapes: ${JSON.stringify(cooked)}`,
              );
            edits.push({ start: rawStart, end: rawStart + raw.length, text: result });
          } else {
            const map = escapes ? cookedToRaw(raw) : null;
            for (const decision of decisions) {
              if (decision.kind !== "product") continue;
              const at = rawStart + (map ? map[decision.index] : decision.index);
              const original = text.slice(at, at + 2);
              if (original.toLowerCase() !== "bb")
                throw new Error(
                  `${file}: cannot map "bb" at ${at} (found ${JSON.stringify(original)})`,
                );
              edits.push({ start: at, end: at + 2, text: rules.replacement });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edits;
}

// Tests follow the source: a test literal changes only where it holds a source
// string the rules changed, so test inputs, command lines and patterns that the
// tests build themselves keep bb's wording.
export function propagateToTest(text, changes) {
  const exact = changes.get(text);
  if (exact) return exact;
  const decisions = [];
  const claimed = [];
  for (const [original, change] of changes.longest) {
    if (original.length < 12 || !change.offsets) continue;
    for (let at = text.indexOf(original); at !== -1; at = text.indexOf(original, at + 1)) {
      if (claimed.some(([start, stop]) => at < stop && start < at + original.length)) continue;
      claimed.push([at, at + original.length]);
      for (const offset of change.offsets) decisions.push({ index: at + offset, kind: "product" });
    }
  }
  if (decisions.length === 0) return { result: text, decisions: [] };
  decisions.sort((a, b) => a.index - b.index);
  let result = text;
  for (const decision of decisions.toReversed())
    result = result.slice(0, decision.index) + "\u0000" + result.slice(decision.index + 2);
  return { result: result.replaceAll("\u0000", changes.replacement), decisions };
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
  const counts = {
    product: 0,
    code: 0,
    command: 0,
    cloud: 0,
    identifier: 0,
    link: 0,
    keep: 0,
    override: 0,
  };
  const record = (file, text, result, decisions) => {
    for (const decision of decisions) counts[decision.kind] += 1;
    if (TEST_PATH.test(file) || decisions.length === 0) return;
    if (rules.notShipped.some((prefix) => file.startsWith(prefix))) return;
    const key = JSON.stringify(result === text ? [text] : [text, result]);
    const sources = inventory.get(key) ?? new Set();
    sources.add(file);
    inventory.set(key, sources);
  };
  const changes = new Map();
  const remember = (text, result, decisions) => {
    if (result === text || changes.has(text)) return;
    const whole = decisions.some((decision) => decision.kind === "override");
    const offsets = whole
      ? null
      : decisions
          .filter((decision) => decision.kind === "product")
          .map((decision) => decision.index);
    changes.set(text, {
      result,
      decisions: whole ? decisions : decisions.filter((d) => d.kind === "product"),
      offsets,
    });
  };
  const rewrite = (file, edits, text) => {
    if (edits.length === 0) return;
    let next = text;
    for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
      next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    }
    changed.push(file);
    if (write) writeFileSync(path.join(root, file), next);
  };
  const inScope = files.toSorted().filter((file) => kindOf(file) && !excluded(file, rules));
  for (const file of inScope.filter((name) => !TEST_PATH.test(name))) {
    const text = readFileSync(path.join(root, file), "utf8");
    if (!/bb/i.test(text)) continue;
    const kind = kindOf(file);
    const remembering = (name, cooked, result, decisions) => {
      record(name, cooked, result, decisions);
      remember(cooked, result, decisions);
    };
    const edits =
      kind === "source"
        ? literalEdits(file, text, rules, remembering, (cooked, context) =>
            rebrandString(cooked, context, rules),
          )
        : kind === "markdown"
          ? markdownEdits(file, text, rules, record)
          : manifestEdits(file, text, rules, record);
    rewrite(file, edits, text);
  }
  changes.longest = [...changes.entries()].toSorted(([a], [b]) => b.length - a.length);
  changes.replacement = rules.replacement;
  for (const file of inScope.filter((name) => TEST_PATH.test(name) && SOURCE.test(name))) {
    const text = readFileSync(path.join(root, file), "utf8");
    if (!/bb/i.test(text)) continue;
    rewrite(
      file,
      literalEdits(file, text, rules, record, (cooked) => propagateToTest(cooked, changes)),
      text,
    );
  }
  return { inventory, changed, counts };
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
    `rebrand ${command}: ${changed.length} files, ${counts.product} product mentions -> ${rules.replacement}; kept ${counts.command} commands, ${counts.code} code spans, ${counts.cloud} bb cloud mentions, ${counts.identifier} identifiers, ${counts.link} links`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
