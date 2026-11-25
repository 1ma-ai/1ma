import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { shardMatrix } from "./shard-matrix.mjs";

const shard = (name) => ({ shard: name, filter: "--filter=@bb/server", vitestShard: "1/2" });

describe("the test matrix from bb's planner", () => {
  test("is the planner's own list of shards", () => {
    const tests = { include: [shard("server-1"), shard("server-2")] };
    assert.deepEqual(shardMatrix({ tests, lint: true }), tests);
  });

  test("is refused when it has no shard: GitHub would skip the tests and call it passed", () => {
    for (const selection of [{ tests: { include: [] } }, { tests: {} }, {}, null, { tests: [] }])
      assert.throws(() => shardMatrix(selection), /no test shards/u, JSON.stringify(selection));
  });

  test("is refused when a shard has no name", () => {
    assert.throws(() => shardMatrix({ tests: { include: [{ filter: "x" }] } }), /without a name/u);
  });
});

describe("the command the plan job runs", () => {
  const script = fileURLToPath(new URL("shard-matrix.mjs", import.meta.url));
  const root = mkdtempSync(path.join(tmpdir(), "shard-matrix-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const run = (selection) => {
    const input = path.join(root, "selection.json");
    const output = path.join(root, "output");
    writeFileSync(input, JSON.stringify(selection));
    writeFileSync(output, "");
    const done = spawnSync(process.execPath, [script, input], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output },
    });
    return { ...done, output: readFileSync(output, "utf8") };
  };

  test("writes the matrix as the tests output", () => {
    const tests = { include: [shard("server-1")] };
    const done = run({ tests });
    assert.equal(done.status, 0, done.stderr);
    assert.equal(done.output, `tests=${JSON.stringify(tests)}\n`);
  });

  test("fails and writes nothing for a plan without shards", () => {
    const done = run({ tests: { include: [] } });
    assert.notEqual(done.status, 0);
    assert.equal(done.output, "");
  });
});
