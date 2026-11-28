import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { verdict } from "./workflow-result.mjs";

const read = (changed) => ({ result: "success", outputs: { changed } });
const job = (result) => ({ result, outputs: {} });
const desktop = (changed, patches, linux, macos) => ({
  changes: read(changed),
  patches: job(patches),
  "linux-server": job(linux),
  macos: job(macos),
});
const OFF = ["linux-server", "macos"];

describe("the verdict of a workflow that waits for its changed paths", () => {
  test("passes when the paths are touched and every job succeeded", () => {
    const needs = desktop("true", "success", "success", "success");
    assert.deepEqual(verdict({ needs, event: "push", offPullRequests: OFF }), []);
  });

  test("passes when the paths are untouched and every job was skipped", () => {
    const needs = desktop("false", "skipped", "skipped", "skipped");
    assert.deepEqual(verdict({ needs, event: "pull_request", offPullRequests: OFF }), []);
  });

  test("passes a pull request without the jobs the workflow keeps off pull requests", () => {
    const needs = desktop("true", "success", "skipped", "skipped");
    assert.deepEqual(verdict({ needs, event: "pull_request", offPullRequests: OFF }), []);
  });

  test("fails when the answer about the paths is missing, though every job was skipped", () => {
    for (const changed of [undefined, "", "True", "1"]) {
      const needs = desktop(changed, "skipped", "skipped", "skipped");
      assert.match(
        verdict({ needs, event: "pull_request", offPullRequests: OFF }).join("\n"),
        /not true or false/u,
        String(changed),
      );
    }
  });

  test("fails when the paths are touched and a job was skipped", () => {
    const needs = desktop("true", "skipped", "skipped", "skipped");
    assert.deepEqual(verdict({ needs, event: "pull_request", offPullRequests: OFF }), [
      "patches is skipped, it has to be success",
    ]);
  });

  test("fails a push when a job kept off pull requests was skipped", () => {
    const needs = desktop("true", "success", "success", "skipped");
    assert.deepEqual(verdict({ needs, event: "push", offPullRequests: OFF }), [
      "macos is skipped, it has to be success",
    ]);
  });

  test("fails when a job failed or was cancelled", () => {
    for (const result of ["failure", "cancelled"]) {
      const needs = desktop("true", "success", result, "skipped");
      assert.deepEqual(verdict({ needs, event: "push", offPullRequests: OFF }), [
        `linux-server is ${result}, it has to be success`,
        "macos is skipped, it has to be success",
      ]);
    }
  });

  test("fails when the paths were not read", () => {
    for (const result of ["failure", "cancelled", "skipped"]) {
      const needs = { ...desktop("true", "success", "success", "success"), changes: job(result) };
      assert.match(verdict({ needs, event: "push" }).join("\n"), /were not read/u);
    }
  });

  test("fails when a job ran though the paths are untouched", () => {
    const needs = desktop("false", "success", "skipped", "skipped");
    assert.deepEqual(verdict({ needs, event: "pull_request", offPullRequests: OFF }), [
      "patches is success, it has to be skipped",
    ]);
  });

  test("fails when a job named as off pull requests is not one it waits for", () => {
    const needs = desktop("true", "success", "skipped", "skipped");
    assert.match(
      verdict({ needs, event: "pull_request", offPullRequests: [...OFF, "mac"] }).join("\n"),
      /mac is not a job/u,
    );
  });

  test("fails when there is nothing to wait for but the answer", () => {
    assert.notDeepEqual(verdict({ needs: { changes: read("true") }, event: "push" }), []);
    assert.notDeepEqual(verdict({ needs: { e2e: job("success") }, event: "push" }), []);
  });
});

describe("the command a result job runs", () => {
  const script = fileURLToPath(new URL("workflow-result.mjs", import.meta.url));
  const run = (needs, env = {}) =>
    spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NEEDS: JSON.stringify(needs),
        GITHUB_EVENT_NAME: "pull_request",
        ...env,
      },
    });

  test("exits with zero on a passed pull request and names the jobs", () => {
    const done = run(desktop("true", "success", "skipped", "skipped"), {
      OFF_PULL_REQUESTS: "linux-server macos",
    });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /patches: success/u);
  });

  test("exits with an error annotation when a job the pull request needs was skipped", () => {
    const done = run(desktop("true", "success", "skipped", "skipped"));
    assert.equal(done.status, 1);
    assert.match(done.stdout, /::error::linux-server is skipped, it has to be success/u);
  });

  test("does not pass without the needs context", () => {
    assert.throws(() =>
      execFileSync(process.execPath, [script], { env: { PATH: process.env.PATH }, stdio: "pipe" }),
    );
  });
});
