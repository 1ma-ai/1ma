import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decide, failuresIn } from "./known-test-failures.mjs";

const ESC = "\u001B";
const known = {
  bb: "desktop-v0.49.0",
  tests: [
    {
      package: "bb-environment-provider-host",
      file: "test/workspace-git-fetch.test.ts",
      name: "remote branch refresh > fetches and prunes only origin when other remotes exist (interactive: true)",
      reason: "git 2.56",
    },
  ],
};
const gitFailure = `${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m ${ESC}[30m${ESC}[42m bb-environment-provider-host:isolated ${ESC}[49m${ESC}[39m test/workspace-git-fetch.test.ts${ESC}[2m > ${ESC}[22mremote branch refresh${ESC}[2m > ${ESC}[22mfetches and prunes only origin when other remotes exist (interactive: true)`;
const counts = (failed) => `\n      Tests  ${failed} failed | 45 passed (${45 + failed})\n`;
const summary = (tasks, failed = 1) =>
  `${counts(failed)}\n Tasks:    51 successful, 52 total\nFailed:    ${tasks}\n ERROR  run failed: command  exited (1)\n`;
const run = (log, status = 1, list = known) =>
  decide({ status, log, known: list, tag: "desktop-v0.49.0" });

describe("reading a shard's log", () => {
  test("finds failed tests with their package, file and name, and the failed tasks", () => {
    const { tests, tasks } = failuresIn(
      `${gitFailure}\n${gitFailure}\n${summary("bb-environment-provider-host#test, @bb/app#test")}`,
    );
    assert.deepEqual(tests, [
      {
        package: "bb-environment-provider-host",
        file: "test/workspace-git-fetch.test.ts",
        name: known.tests[0].name,
      },
    ]);
    assert.deepEqual(tasks, ["bb-environment-provider-host#test", "@bb/app#test"]);
  });

  test("reads colour codes the way GitHub's log viewer spells them", () => {
    const viewer = gitFailure.replaceAll(ESC, "^[");
    assert.equal(failuresIn(viewer).tests[0]?.package, "bb-environment-provider-host");
  });
});

describe("deciding a shard", () => {
  test("passes when turbo passed", () => {
    assert.deepEqual(run("", 0), { ok: true, lines: [] });
  });

  test("passes when every failed test is a known failure, and says so", () => {
    const result = run(`${gitFailure}${summary("bb-environment-provider-host#test")}`);
    assert.equal(result.ok, true);
    assert.match(result.lines[0], /^known failure \(git 2\.56\)/);
  });

  test("fails on a failure that is not listed", () => {
    const other = gitFailure.replace("(interactive: true)", "(interactive: false)");
    const result = run(`${gitFailure}\n${other}${summary("bb-environment-provider-host#test", 2)}`);
    assert.equal(result.ok, false);
    assert.ok(result.lines.some((line) => line.startsWith("new failure:")));
  });

  test("fails when a whole test file failed next to a known failure", () => {
    const file = ` FAIL  bb-environment-provider-host:isolated  test/other.test.ts [ test/other.test.ts ]`;
    const result = run(`${gitFailure}\n${file}${summary("bb-environment-provider-host#test")}`);
    assert.equal(result.ok, false);
  });

  test("fails when a task failed without a failed test, or turbo failed without a task", () => {
    assert.equal(
      run(`${gitFailure}${summary("bb-environment-provider-host#test, @bb/app#test")}`).ok,
      false,
    );
    assert.equal(
      run(`${gitFailure}${summary("bb-environment-provider-host#typecheck")}`).ok,
      false,
    );
    assert.equal(run(gitFailure).ok, false);
  });

  test("an error outside any test, next to a known failure, fails the shard", () => {
    const unhandled = `\n⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯\nVitest caught 1 unhandled error during the test run.\n      Errors  1 error\n`;
    const result = run(`${gitFailure}${unhandled}${summary("bb-environment-provider-host#test")}`);
    assert.equal(result.ok, false);
    assert.ok(result.lines.some((line) => line.includes("outside any test")));
  });

  test("a failed test vitest counted but the log does not name fails the shard", () => {
    const result = run(`${gitFailure}${summary("bb-environment-provider-host#test", 2)}`);
    assert.equal(result.ok, false);
    assert.ok(result.lines.some((line) => line.includes("counted 2 failed tests")));
  });

  test("a list reviewed for another bb release fails even a green shard", () => {
    const result = run("", 0, { ...known, bb: "desktop-v0.48.1" });
    assert.equal(result.ok, false);
    assert.match(result.lines[0], /reviewed for desktop-v0\.48\.1/);
  });
});
