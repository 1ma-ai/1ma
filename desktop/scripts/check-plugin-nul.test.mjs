import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

const script = path.join(import.meta.dirname, "check-plugin-nul.mjs");
const scratch = mkdtempSync(path.join(tmpdir(), "1ma-plugin-nul-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A 1ma checkout with one embedded plugin, one plugin that is not embedded, and
// only the files given as tracked.
function checkout(tracked, untracked = {}) {
  const repo = mkdtempSync(path.join(scratch, "repo-"));
  const files = {
    "desktop/embedded-plugins.json": '["1ma-brand"]\n',
    "plugins/1ma-brand/package.json": "{}\n",
    "plugins/1ma-sidebar/README.md": "Sidebar\0\n",
    ...tracked,
  };
  for (const [file, text] of Object.entries({ ...files, ...untracked })) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  }
  for (const args of [
    ["init", "-q"],
    ["add", "--", ...Object.keys(files)],
  ]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return repo;
}

const check = (repo) => spawnSync(process.execPath, [script, repo], { encoding: "utf8" });

describe("literal NUL bytes in the embedded 1ma plugins", () => {
  test("a NUL in a shipped Markdown file fails the check with its file and line", () => {
    const result = check(
      checkout({ "plugins/1ma-brand/PLUGIN_OVERVIEW.md": "# 1ma Brand\nShips\0 with 1ma\n" }),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^"plugins\/1ma-brand\/PLUGIN_OVERVIEW\.md":2: Literal NUL byte/m);
  });

  test("binary assets, untracked files and plugins 1ma does not embed pass", () => {
    const result = check(
      checkout(
        {
          "plugins/1ma-brand/PLUGIN_OVERVIEW.md": "# 1ma Brand\n",
          "plugins/1ma-brand/assets/icon.PNG": "\x89PNG\0\0",
        },
        { "plugins/1ma-brand/notes.md": "draft\0\n" },
      ),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Checked 2 tracked files/);
  });
});
