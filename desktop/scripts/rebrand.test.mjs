import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  diffInventory,
  formatInventory,
  loadRules,
  rebrandProse,
  rebrandString,
  rebrandTree,
} from "./rebrand.mjs";

const rules = {
  ...loadRules(),
  vocabulary: new Map([
    ["thread", new Set(["list", "show", "tell", "spawn"])],
    ["server", new Set(["move", "export", "import"])],
    ["plugin", new Set(["install", "build", "config"])],
    ["status", new Set()],
  ]),
};
const prose = (text) => rebrandProse(text, rules).result;

describe("product mentions", () => {
  test("become 1ma in prose, including possessives and capitals", () => {
    assert.equal(prose("Relaunch bb to finish updating"), "Relaunch 1ma to finish updating");
    assert.equal(
      prose("Plugin code and diff renderers on bb's Diff tab"),
      "Plugin code and diff renderers on 1ma's Diff tab",
    );
    assert.equal(
      prose("BB worktrees are the managed checkouts BB tracks."),
      "1ma worktrees are the managed checkouts 1ma tracks.",
    );
  });

  test("a CLI command word after a determiner is still the product", () => {
    assert.equal(prose("Could not reach this bb server"), "Could not reach this 1ma server");
    assert.equal(prose("Edit the bb plugin"), "Edit the 1ma plugin");
    assert.equal(
      prose("requires a bb thread with a live host"),
      "requires a 1ma thread with a live host",
    );
  });
});

describe("commands keep the bb name until the CLI is renamed", () => {
  test("a known subcommand, flag, placeholder or alternative follows", () => {
    assert.equal(
      prose("Cancel it with bb server move status."),
      "Cancel it with bb server move status.",
    );
    assert.equal(
      prose("bb plugin config <id> set <key> <value>"),
      "bb plugin config <id> set <key> <value>",
    );
    assert.equal(prose("bb file read|write|list ..."), "bb file read|write|list ...");
    assert.equal(prose("bb settings --json"), "bb settings --json");
  });

  test("a lead word, a code span, a usage string or a quick-start line marks a command", () => {
    assert.equal(prose("Run bb thread show to inspect it."), "Run bb thread show to inspect it.");
    assert.equal(
      prose("Use `bb thread tell <id>` and bb is fine"),
      "Use `bb thread tell <id>` and 1ma is fine",
    );
    assert.equal(prose('usage: "bb todo add <text>"'), 'usage: "bb todo add <text>"');
    assert.equal(
      prose("Quick start:\n  bb status\n  bb thread list"),
      "Quick start:\n  bb status\n  bb thread list",
    );
  });

  test("the bb CLI and the bb command keep their name", () => {
    assert.equal(
      prose("Install the bb CLI for use outside bb"),
      "Install the bb CLI for use outside 1ma",
    );
  });
});

describe("bb cloud services and identifiers stay", () => {
  test("bb account, bb connect and their possessives", () => {
    assert.equal(
      prose("This bb is not signed in to a bb account."),
      "This 1ma is not signed in to a bb account.",
    );
    assert.equal(prose("at your bb account's domain"), "at your bb account's domain");
    assert.equal(prose("Sign in to bb Connect…"), "Sign in to bb Connect…");
    assert.equal(
      prose("sign in to your bb\n            account"),
      "sign in to your bb\n            account",
    );
  });

  test("protocol markers, paths, ids, manifest keys and code inside strings", () => {
    assert.equal(
      prose("[bb message from thread:thr_1] hello"),
      "[bb message from thread:thr_1] hello",
    );
    assert.equal(
      prose("theme bb/endless-theme and bb:nord:light"),
      "theme bb/endless-theme and bb:nord:light",
    );
    assert.equal(
      prose('package.json has no "bb.server" entry'),
      'package.json has no "bb.server" entry',
    );
    assert.equal(
      prose('has no "bb": { "app": "./app.tsx" } field'),
      'has no "bb": { "app": "./app.tsx" } field',
    );
    assert.equal(prose("(async (bb) => { install(bb, x) })"), "(async (bb) => { install(bb, x) })");
  });

  test("a single word outside visible labels is an identifier", () => {
    assert.equal(rebrandString("bb", { kind: "value" }, rules).result, "bb");
    assert.equal(rebrandString("bb", { kind: "jsx-attribute", name: "alt" }, rules).result, "1ma");
    assert.equal(rebrandString("bb", { kind: "property", name: "title" }, rules).result, "1ma");
  });

  test("exact-text overrides win over the rules", () => {
    const override = { ...rules, keep: [{ text: "Moved to bb git " }] };
    assert.equal(
      rebrandString("Moved to bb git ", { kind: "value" }, override).result,
      "Moved to bb git ",
    );
  });
});

describe("rebrandTree edits only string contents", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rebrand-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  write(
    "apps/app/src/view.tsx",
    [
      'import { x } from "@bb/domain";',
      'const escaped = "line one\\nbb restores it";',
      "const template = `Open ${name} in bb or run bb thread list`;",
      'export const View = () => <p title="bb">Reload bb now</p>;',
      'const key = { "bb": 1 }[name];',
      "",
    ].join("\n"),
  );
  write("plugins/demo/PLUGIN_OVERVIEW.md", "Run bb threads here.\n\n```\nbb is code here\n```\n");
  write(
    "plugins/demo/package.json",
    `${JSON.stringify({ name: "bb-plugin-demo", description: "Run bb threads.", bb: { name: "Demo", description: "Run bb threads." } }, null, 2)}\n`,
  );
  write("apps/web/src/site.ts", 'export const site = "Welcome to bb today";\n');

  const result = rebrandTree(root, rules, { write: true });

  test("source literals, JSX text and labels change; code and keys do not", () => {
    const view = readFileSync(path.join(root, "apps/app/src/view.tsx"), "utf8");
    assert.match(view, /from "@bb\/domain"/);
    assert.match(view, /"line one\\n1ma restores it"/);
    assert.match(view, /in 1ma or run bb thread list/);
    assert.match(view, /title="1ma">Reload 1ma now</);
    assert.match(view, /\{ "bb": 1 \}/);
  });

  test("markdown outside code fences and the bb manifest section change", () => {
    const overview = readFileSync(path.join(root, "plugins/demo/PLUGIN_OVERVIEW.md"), "utf8");
    assert.equal(overview, "Run 1ma threads here.\n\n```\nbb is code here\n```\n");
    const manifest = JSON.parse(readFileSync(path.join(root, "plugins/demo/package.json"), "utf8"));
    assert.equal(manifest.bb.description, "Run 1ma threads.");
    assert.equal(manifest.description, "Run bb threads.");
  });

  test("code that bb does not ship is rewritten but left out of the inventory", () => {
    assert.match(
      readFileSync(path.join(root, "apps/web/src/site.ts"), "utf8"),
      /Welcome to 1ma today/,
    );
    assert.ok(![...result.inventory.keys()].some((key) => key.includes("Welcome")));
  });

  test("the inventory lists each text with its result and diffs line by line", () => {
    const text = formatInventory(result.inventory);
    assert.match(text, /\["Reload bb now","Reload 1ma now"\]/);
    const { added, removed } = diffInventory(text, text.replace("Reload 1ma now", "Reload bb now"));
    assert.equal(added.length, 1);
    assert.equal(removed.length, 1);
  });
});
