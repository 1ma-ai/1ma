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
  test("the CLI keeps its name in capitals too", () => {
    assert.equal(
      prose("Tell agents about the BB CLI, threads, and links."),
      "Tell agents about the BB CLI, threads, and links.",
    );
    assert.equal(prose("BB CLI skill"), "BB CLI skill");
    assert.equal(
      prose("Install the bb CLI for use outside bb."),
      "Install the bb CLI for use outside 1ma.",
    );
  });

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

  test("code inside strings stays", () => {
    assert.equal(
      prose("bb === null ? missingPageValue.read : 1"),
      "bb === null ? missingPageValue.read : 1",
    );
    assert.equal(
      prose("const bb = window.bridge; return bb;"),
      "const bb = window.bridge; return bb;",
    );
    assert.equal(prose("ready = bb && bb.ready"), "ready = bb && bb.ready");
    assert.equal(prose('plugin "x" requires bb >=99.0.0'), 'plugin "x" requires 1ma >=99.0.0');
    assert.equal(prose("Done! bb will restart now"), "Done! 1ma will restart now");
    assert.equal(prose("let bb run it while you rest"), "let 1ma run it while you rest");
    assert.equal(prose("Create a new bb skill that"), "Create a new 1ma skill that");
    assert.equal(prose("const bb = new BBSdk({ baseUrl })"), "const bb = new BBSdk({ baseUrl })");
    assert.equal(
      prose("$power = Add-Type -Name KeepAwake -Namespace Bb -PassThru"),
      "$power = Add-Type -Name KeepAwake -Namespace Bb -PassThru",
    );
  });

  test("substitutions in a template are arguments only on a command line", () => {
    const at = "\uE000";
    assert.equal(prose(`  bb tasks ${at} ${at}`), `  bb tasks ${at} ${at}`);
    assert.equal(
      prose(`Edit the bb plugin ${at} at ${at}.`),
      `Edit the 1ma plugin ${at} at ${at}.`,
    );
    assert.equal(prose(`- Linked bb project: ${at}`), `- Linked 1ma project: ${at}`);
    assert.equal(
      prose(`BB ${at} components vendored from the BB app`),
      `1ma ${at} components vendored from the 1ma app`,
    );
  });

  test("a single word outside visible labels is an identifier", () => {
    assert.equal(rebrandString("bb", { kind: "value" }, rules).result, "bb");
    assert.equal(rebrandString("bb", { kind: "jsx-attribute", name: "alt" }, rules).result, "1ma");
    assert.equal(rebrandString("bb", { kind: "property", name: "title" }, rules).result, "1ma");
  });

  test("overrides apply inside longer texts and win over the rules", () => {
    const override = { ...rules, keep: [{ text: "Moved to bb git " }] };
    assert.equal(
      rebrandString("Moved to bb git ", { kind: "value" }, override).result,
      "Moved to bb git ",
    );
    assert.equal(
      rebrandString("\n  BB Official\n", { kind: "jsx-text" }, rules).result,
      "\n  Built-in\n",
    );
    assert.equal(
      rebrandString("Reviewed by BB Community; bb shows it", { kind: "value" }, rules).result,
      "Reviewed by BB Community; 1ma shows it",
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
      "const tick = `The \\`read\\` tool takes \\`${name}\\`, which inspects bb`;",
      "const author = `${skill} is BB Official`;",
      "export const Gone = () => <p>Relaunch bb to finish updating</p>;",
      "export const Long = () => <p>Your data is saved first. If it fails to start,\n        bb restores the last version.</p>;",
      'const window = "bb"; const id = "bb";',
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
  write("apps/cli/src/restart.ts", 'export const restart = "Restart bb when it updates";\n');
  write(
    "apps/app/src/view.test.tsx",
    [
      'expect(screen.getByText("Reload bb now")).toBeTruthy();',
      'expect(log).toContain("first, then Reload bb now please");',
      "const input = \"bb thread message thr_x 'Reload bb'\";",
      'Reflect.deleteProperty(window, "bb");',
      'expect(screen.getByRole("button", { name: /Relaunch bb to finish updating/ })).toBeTruthy();',
      'expect(text).toContain("If it fails to start, bb restores");',
      'expect(log).toContain("Restart bb when it updates");',
      'expect(screen.getByText("BB Official\'s GitHub avatar")).toBeTruthy();',
      'expect(screen.getByRole("heading", { name: /^BB/u })).toBeTruthy();',
      "",
    ].join("\n"),
  );
  write("apps/cli/src/help.ts", 'export const help = "Restart bb when done";\n');
  write("plugins/demo/skills/demo/SKILL.md", "Use bb carefully.\n");

  const result = rebrandTree(
    root,
    {
      ...rules,
      testReplace: [
        {
          file: "apps/app/src/view.test.tsx",
          find: "/^BB/u",
          replace: "/^Built-in/u",
          reason: "test",
        },
      ],
      testKeep: [],
    },
    { write: true },
  );

  test("source literals, JSX text and labels change; code and keys do not", () => {
    const view = readFileSync(path.join(root, "apps/app/src/view.tsx"), "utf8");
    assert.match(view, /from "@bb\/domain"/);
    assert.match(view, /"line one\\n1ma restores it"/);
    assert.match(view, /in 1ma or run bb thread list/);
    assert.match(view, /title="1ma">Reload 1ma now</);
    assert.match(view, /\{ "bb": 1 \}/);
    assert.match(view, /which inspects 1ma`/);
    assert.match(view, /\$\{skill\} is Built-in`/);
    assert.match(view, /const window = "bb"; const id = "bb";/);
  });

  test("markdown outside code fences and the bb manifest section change", () => {
    const overview = readFileSync(path.join(root, "plugins/demo/PLUGIN_OVERVIEW.md"), "utf8");
    assert.equal(overview, "Run 1ma threads here.\n\n```\nbb is code here\n```\n");
    const manifest = JSON.parse(readFileSync(path.join(root, "plugins/demo/package.json"), "utf8"));
    assert.equal(manifest.bb.description, "Run 1ma threads.");
    assert.equal(manifest.description, "Run bb threads.");
  });

  test("tests follow the source strings and keep their own inputs", () => {
    const spec = readFileSync(path.join(root, "apps/app/src/view.test.tsx"), "utf8");
    assert.match(spec, /getByText\("Reload 1ma now"\)/);
    assert.match(spec, /toContain\("first, then Reload 1ma now please"\)/);
    assert.match(spec, /"bb thread message thr_x 'Reload bb'"/);
    assert.match(spec, /deleteProperty\(window, "bb"\)/);
    assert.match(spec, /name: \/Relaunch 1ma to finish updating\//);
    assert.match(spec, /toContain\("If it fails to start, 1ma restores"\)/);
    assert.match(spec, /toContain\("Restart bb when it updates"\)/);
    assert.match(spec, /getByText\("Built-in's GitHub avatar"\)/);
    assert.match(spec, /name: \/\^Built-in\/u/);
  });

  test("the CLI, skills and other later phases stay untouched", () => {
    assert.match(
      readFileSync(path.join(root, "apps/cli/src/help.ts"), "utf8"),
      /Restart bb when done/,
    );
    assert.equal(
      readFileSync(path.join(root, "plugins/demo/skills/demo/SKILL.md"), "utf8"),
      "Use bb carefully.\n",
    );
  });

  test("code that 1ma does not ship stays as bb wrote it", () => {
    assert.match(
      readFileSync(path.join(root, "apps/web/src/site.ts"), "utf8"),
      /Welcome to bb today/,
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

const manifest = (name, dependencies = {}) =>
  `${JSON.stringify({ name, dependencies }, null, 2)}\n`;

describe("tests follow only the sources they can reach", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rebrand-scope-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  write(
    "apps/app/package.json",
    manifest("@bb/app", { "@bb/shared": "workspace:*", "bb-plugin-bb-guide": "workspace:*" }),
  );
  write(
    "apps/app/src/update.tsx",
    [
      "export const updating = (v) => `Updating bb to ${v}`;",
      "export const Reach = () => <h1>Could not reach this bb server</h1>;",
      "export const requires = (r, v) => `requires bb ${r}, this is ${v}`;",
      'export const remove = (id) => `Remove "${id}" from bb and delete its settings?`;',
      'export const Region = () => <section aria-label="bb">x</section>;',
      'export const official = "BB Official";',
      'export const open = "Open bb settings.";',
      'export const start = "Ready to start using bb";',
      'export const relaunch = "Relaunch bb to finish updating";',
      'export const marker = "Written by bb: runs the bb command of the bb installed on this computer.";',
      "",
    ].join("\n"),
  );
  write(
    "apps/app/src/update.test.tsx",
    [
      'expect(screen.getByText("Updating bb to 1.2.0")).toBeTruthy();',
      'expect(title).toBe("Could not reach this bb server");',
      'expect(text).toContain("Requires bb >= 0.15.");',
      'expect(screen.getByText(/Remove "github" from bb/)).toBeTruthy();',
      'screen.getByRole("region", { name: "bb" });',
      'const project = { name: "bb" };',
      'navigate("/plugins?source=publisher%3ABB%20Official");',
      'expect(out).toContain("bb plugin update fresh");',
      'screen.getByRole("link", { name: "Open bb settings" });',
      'expect(message).toBe("This bb server moved to desk.");',
      'expect(prompt).toBe("Create a new bb plugin that ");',
      'expect(row.textContent).toContain("Updating bb");',
      'expect(screen.queryByRole("button", { name: /Copy the command|Relaunch bb|Download/ })).toBeNull();',
      "expect(text).toMatch(/Written by bb: runs the bb command of the bb installed on this computer\\./);",
      'const pasted = "using bb\'s Plugin Guide.";',
      "",
    ].join("\n"),
  );
  write("packages/shared/package.json", manifest("@bb/shared"));
  write(
    "packages/shared/src/move.ts",
    [
      "export const moved = (to) => `This bb server moved to ${to}.`;",
      "export const create = (x) => `Create a new bb plugin that ${x}`;",
      'export const plugin = "Updates the bb plugin update notes";',
      "",
    ].join("\n"),
  );
  write("plugins/bb-guide/package.json", manifest("bb-plugin-bb-guide"));
  write(
    "plugins/bb-guide/src/guide.ts",
    "export const guide = (x) => `Create a new bb plugin that ${x}`;\n",
  );
  write("apps/mobile/package.json", manifest("@bb/mobile"));
  write(
    "apps/mobile/src/reach.ts",
    [
      'export const reach = "Could not reach this bb server";',
      "export const updating = (v) => `Updating bb to ${v}`;",
      "",
    ].join("\n"),
  );
  write("apps/mobile/src/reach.test.ts", 'expect(reach).toBe("Could not reach this bb server");\n');
  write("apps/cli/package.json", manifest("@bb/cli", { "@bb/shared": "workspace:*" }));
  write(
    "apps/cli/src/usage.ts",
    [
      'export const usage = "Inspect the bb server with care";',
      "export const create = (x) => `Create a new bb plugin that ${x}`;",
      "",
    ].join("\n"),
  );
  write(
    "apps/cli/src/usage.test.ts",
    [
      'expect(label).toContain("BB Official");',
      'expect(moved).toBe("This bb server moved to desk.");',
      'expect(prompt).toBe("Create a new bb plugin that ");',
      "",
    ].join("\n"),
  );
  write("apps/server/package.json", manifest("@bb/server"));
  write(
    "apps/server/src/assets/install.sh",
    'fail_step "Could not register the bb host-daemon launch agent $label."\n',
  );
  write(
    "apps/server/src/agent.ts",
    'export const agent = "Restart the bb host-daemon launch agent";\n',
  );
  write("apps/server/src/label.ts", 'export const label = "the bb host-daemon launch agent";\n');
  write(
    "apps/server/test/install.test.ts",
    'expect(out).toContain("Could not register the bb host-daemon launch agent x.");\n',
  );

  write(
    "plugins/guide/package.json",
    `${JSON.stringify({ name: "bb-plugin-guide", bb: { name: "BB guide" } }, null, 2)}\n`,
  );
  write(
    "plugins/plugin-api-docs/src/surfaces.ts",
    'export const usedBy = ["Automations", "BB guide"];\nexport const intro = "Read the BB guide first";\n',
  );
  write(
    "plugins/plugin-api-docs/src/first-party-plugins.json",
    `${JSON.stringify([{ id: "guide", name: "BB guide" }], null, 2)}\n`,
  );
  write("plugins/plugin-api-docs/src/surfaces.test.ts", 'expect(usedBy).toContain("BB guide");\n');

  rebrandTree(
    root,
    {
      ...rules,
      testReplace: [],
      testKeep: [
        { file: "apps/app/src/update.test.tsx", text: "Open bb settings", reason: "test" },
      ],
    },
    { write: true },
  );
  const read = (file) => readFileSync(path.join(root, file), "utf8");

  test("a renamed plugin name follows its exact references everywhere", () => {
    assert.match(read("plugins/guide/package.json"), /"name": "1ma guide"/);
    const surfaces = read("plugins/plugin-api-docs/src/surfaces.ts");
    assert.match(surfaces, /\["Automations", "1ma guide"\]/);
    assert.match(surfaces, /"Read the BB guide first"/);
    assert.match(
      read("plugins/plugin-api-docs/src/first-party-plugins.json"),
      /"name": "1ma guide"/,
    );
    assert.match(read("plugins/plugin-api-docs/src/surfaces.test.ts"), /toContain\("1ma guide"\)/);
  });

  test("a test follows its package and dependencies through template values and case", () => {
    const spec = read("apps/app/src/update.test.tsx");
    assert.match(spec, /getByText\("Updating 1ma to 1\.2\.0"\)/);
    assert.match(spec, /toBe\("Could not reach this 1ma server"\)/);
    assert.match(spec, /toContain\("Requires 1ma >= 0\.15\."\)/);
    assert.match(spec, /getByText\(\/Remove "github" from 1ma\/\)/);
    assert.match(spec, /toBe\("This 1ma server moved to desk\."\)/);
    assert.match(spec, /toContain\("Updating 1ma"\)/);
  });

  test("each alternative of a regular expression follows on its own", () => {
    const spec = read("apps/app/src/update.test.tsx");
    assert.match(spec, /name: \/Copy the command\|Relaunch 1ma\|Download\/ \}/);
    assert.ok(
      spec.includes(
        "/Written by 1ma: runs the bb command of the 1ma installed on this computer\\./",
      ),
    );
  });

  test("an overlap where only the ends meet needs three words", () => {
    assert.match(read("apps/app/src/update.test.tsx"), /"using bb's Plugin Guide\."/);
  });

  test("single words, commands and kept phrases stay; encoded overrides follow", () => {
    const spec = read("apps/app/src/update.test.tsx");
    assert.match(spec, /getByRole\("region", \{ name: "bb" \}\)/);
    assert.match(spec, /const project = \{ name: "bb" \}/);
    assert.match(spec, /publisher%3ABuilt-in"/);
    assert.match(spec, /toContain\("bb plugin update fresh"\)/);
    assert.match(spec, /name: "Open bb settings"/);
  });

  test("a tie between renamed and kept sources follows the test's own kind", () => {
    assert.match(read("apps/app/src/update.test.tsx"), /toBe\("Create a new 1ma plugin that "\)/);
    assert.match(read("apps/cli/src/usage.test.ts"), /toBe\("Create a new bb plugin that "\)/);
  });

  test("code 1ma leaves alone keeps its tests, except for renamed dependencies", () => {
    assert.match(read("apps/mobile/src/reach.test.ts"), /toBe\("Could not reach this bb server"\)/);
    const cli = read("apps/cli/src/usage.test.ts");
    assert.match(cli, /toContain\("BB Official"\)/);
    assert.match(cli, /toBe\("This 1ma server moved to desk\."\)/);
  });

  test("scripts the rebrand leaves alone keep the tests that read their output", () => {
    assert.match(
      read("apps/server/test/install.test.ts"),
      /Could not register the bb host-daemon launch agent x\./,
    );
    assert.match(read("apps/server/src/agent.ts"), /Restart the 1ma host-daemon launch agent/);
    assert.match(read("apps/server/src/label.ts"), /the 1ma host-daemon launch agent/);
  });
});

const tree = (files) => {
  const root = mkdtempSync(path.join(tmpdir(), "rebrand-guard-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
};

describe("prepare stops where a test could pass without testing anything", () => {
  const source = {
    "apps/app/package.json": manifest("@bb/app", { "@bb/templates": "workspace:*" }),
    "apps/app/src/update.tsx": 'export const label = "Download the update and restart bb";\n',
    "packages/templates/package.json": manifest("@bb/templates"),
    "packages/templates/src/guide.ts": 'export const tip = "Restart bb when it updates";\n',
  };
  const negative = 'expect(alert).not.toContain("Restart bb");\n';
  const rule = {
    file: "apps/app/src/update.test.tsx",
    find: 'not.toContain("Restart bb")',
    replace: 'not.toContain("Restart 1ma")',
    reason: "test",
  };

  test("a negative assertion that a renamed source could reach needs a reviewed rule", () => {
    const root = tree({ ...source, "apps/app/src/update.test.tsx": negative });
    after(() => rmSync(root, { recursive: true, force: true }));
    assert.throws(
      () => rebrandTree(root, { ...rules, testReplace: [], testKeep: [] }),
      /negative assertions[\s\S]*"Restart bb"/,
    );
    rebrandTree(root, { ...rules, testReplace: [rule], testKeep: [] }, { write: true });
    assert.match(
      readFileSync(path.join(root, "apps/app/src/update.test.tsx"), "utf8"),
      /not\.toContain\("Restart 1ma"\)/,
    );
  });

  test("a test rule fails once its file no longer has the text", () => {
    const root = tree({ ...source, "apps/app/src/update.test.tsx": "expect(1).toBe(1);\n" });
    after(() => rmSync(root, { recursive: true, force: true }));
    assert.throws(
      () =>
        rebrandTree(root, {
          ...rules,
          testReplace: [],
          testKeep: [
            { file: "apps/app/src/update.test.tsx", text: "Open bb settings", reason: "test" },
          ],
        }),
      /testKeep "Open bb settings" no longer matches/,
    );
  });
});
