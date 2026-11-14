import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { applySeries, checkoutUpstream } from "./series.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "1ma-series-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (name) => path.join(scratch, `${name}-${(counter += 1)}`);

function git(cwd, ...args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const lines = (count, change = {}) =>
  `${Array.from({ length: count }, (_, index) => change[index + 1] ?? `line ${index + 1}`).join("\n")}\n`;

// An upstream with a release the series was written on and a later one that
// changed the lines right next to what the series changes.
function upstream() {
  const dir = fresh("bb");
  mkdirSync(dir);
  git(dir, "init", "--quiet");
  writeFileSync(path.join(dir, "app.txt"), lines(12));
  writeFileSync(path.join(dir, "other.txt"), lines(3));
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "release 1");
  git(dir, "tag", "v1");
  writeFileSync(path.join(dir, "app.txt"), lines(12, { 4: "line 4, changed by bb" }));
  writeFileSync(path.join(dir, "other.txt"), "rewritten by bb\n");
  git(dir, "commit", "--quiet", "-am", "release 2");
  git(dir, "tag", "v2");
  return {
    dir,
    v1: git(dir, "rev-parse", "v1^{commit}"),
    v2: git(dir, "rev-parse", "v2^{commit}"),
  };
}

// The series as 1ma exports it: format-patch on top of release 1.
function series(bb) {
  const work = fresh("work");
  git(scratch, "clone", "--quiet", bb.dir, work);
  git(work, "checkout", "--quiet", "--detach", "v1");
  writeFileSync(path.join(work, "app.txt"), lines(12, { 6: "line 6, changed by 1ma" }));
  git(work, "commit", "--quiet", "-am", "1ma: change line 6");
  writeFileSync(path.join(work, "other.txt"), lines(3, { 2: "line 2, changed by 1ma" }));
  git(work, "commit", "--quiet", "-am", "1ma: change other");
  writeFileSync(path.join(work, "new.txt"), "added by 1ma\n");
  git(work, "add", "new.txt");
  git(work, "commit", "--quiet", "-m", "1ma: add a file");
  const dir = fresh("patches");
  mkdirSync(dir);
  git(
    work,
    "format-patch",
    "--quiet",
    "--no-numbered",
    "--no-signature",
    "--zero-commit",
    "-o",
    dir,
    "v1..HEAD",
  );
  return dir;
}

describe("the 1ma patch series on a bb release", () => {
  test("lands on a newer release by a three-way merge when the release it was written on is fetched too", () => {
    const bb = upstream();
    const patches = series(bb);
    const out = fresh("tree");
    checkoutUpstream(out, { repository: bb.dir, tag: "v2", commit: bb.v2, seriesBase: bb.v1 });
    const result = applySeries(out, patches);
    assert.deepEqual(
      result.applied.map((patch) => patch.replace(/^\d{4}-/, "")),
      ["1ma-change-line-6.patch", "1ma-add-a-file.patch"],
    );
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].name, /1ma-change-other/);
    assert.deepEqual(result.failed[0].files, ["other.txt"]);
    assert.equal(
      readFileSync(path.join(out, "app.txt"), "utf8"),
      lines(12, { 4: "line 4, changed by bb", 6: "line 6, changed by 1ma" }),
    );
  });

  test("without the release it was written on, the merge has nothing to compare with", () => {
    const bb = upstream();
    const patches = series(bb);
    const out = fresh("tree");
    checkoutUpstream(out, { repository: bb.dir, tag: "v2", commit: bb.v2 });
    const result = applySeries(out, patches);
    assert.match(result.failed[0].name, /1ma-change-line-6/);
    assert.match(result.failed[0].message, /fake ancestor|lacking or useless/);
  });

  test("on the release it was written on, every patch applies and the commits stay", () => {
    const bb = upstream();
    const patches = series(bb);
    const out = fresh("tree");
    checkoutUpstream(out, { repository: bb.dir, tag: "v1", commit: bb.v1 });
    const result = applySeries(out, patches);
    assert.equal(result.applied.length, 3);
    assert.deepEqual(result.failed, []);
    assert.equal(git(out, "rev-list", "--count", `${bb.v1}..HEAD`), "3");
  });

  test("refuses a tag that no longer points at the pinned commit", () => {
    const bb = upstream();
    assert.throws(
      () => checkoutUpstream(fresh("tree"), { repository: bb.dir, tag: "v2", commit: bb.v1 }),
      /refusing a moved tag/,
    );
  });
});
