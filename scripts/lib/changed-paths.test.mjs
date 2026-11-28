import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { changedFiles, pathspecs } from "./changed-paths.mjs";

const DESKTOP = ["desktop/**", "pnpm-lock.yaml", "!desktop/**/*.md"];

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function pullRequest(changes, { merge = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "changed-paths-"));
  roots.push(root);
  const git = (...args) =>
    execFileSync(
      "git",
      ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args],
      { encoding: "utf8" },
    );
  const write = (files) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
    git("add", "-A");
  };
  git("init", "-q", "-b", "main");
  write({
    "desktop/README.md": "a",
    "desktop/scripts/prepare.mjs": "a",
    "desktop/rebrand/README.md": "a",
    "plugins/1ma-bots/server.ts": "a",
    "pnpm-lock.yaml": "a",
  });
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "change");
  write(changes);
  git("commit", "-q", "-m", "change");
  git("checkout", "-q", "main");
  write({ "docs/other.md": "moved on" });
  git("commit", "-q", "-m", "base moved on");
  if (merge) git("merge", "-q", "--no-ff", "-m", "merge", "change");
  return root;
}

describe("changed paths of a pull request", () => {
  test("a file under a path counts, whatever the base branch got meanwhile", () => {
    const root = pullRequest({ "desktop/scripts/prepare.mjs": "b", "docs/plan.md": "b" });
    assert.deepEqual(changedFiles(root, DESKTOP), ["desktop/scripts/prepare.mjs"]);
  });

  test("a file named exactly counts", () => {
    assert.deepEqual(changedFiles(pullRequest({ "pnpm-lock.yaml": "b" }), DESKTOP), [
      "pnpm-lock.yaml",
    ]);
  });

  test("excluded files do not count at any depth", () => {
    const root = pullRequest({ "desktop/README.md": "b", "desktop/rebrand/README.md": "b" });
    assert.deepEqual(changedFiles(root, DESKTOP), []);
  });

  test("a pull request elsewhere changes nothing here", () => {
    assert.deepEqual(changedFiles(pullRequest({ "plugins/1ma-bots/server.ts": "b" }), DESKTOP), []);
  });

  test("a checkout that is not the merge of a pull request is refused, not read as unchanged", () => {
    const root = pullRequest({ "desktop/scripts/prepare.mjs": "b" }, { merge: false });
    assert.throws(() => changedFiles(root, DESKTOP), /not the merge commit/);
  });
});

describe("patterns", () => {
  test("a pattern after an exclusion is refused: the filter and git would disagree", () => {
    assert.throws(() => pathspecs(["desktop/**", "!desktop/**/*.md", "desktop/README.md"]), {
      message: /follows a ! pattern/,
    });
  });

  test("characters the filter and git read differently are refused", () => {
    for (const pattern of ["desktop/file?.mjs", "desktop/[ab].mjs", "desktop/a+.mjs", "!!desktop"])
      assert.throws(() => pathspecs([pattern]), /read this pattern differently/, pattern);
  });

  test("a list of exclusions alone is refused", () => {
    assert.throws(() => pathspecs(["", "!desktop/**/*.md"]), /no paths/);
  });
});
