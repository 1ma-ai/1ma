import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { compareVersions, oneMaVersion } from "./version.mjs";

const script = fileURLToPath(new URL("version.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

describe("the version of a 1ma build", () => {
  test("is the next patch of the bb release, as a prerelease naming the run", () => {
    assert.equal(oneMaVersion("0.49.0", "42358180199", "1"), "0.49.1-1ma.42358180199.1");
    assert.equal(oneMaVersion("1.9.9", "7", "3"), "1.9.10-1ma.7.3");
  });

  test("refuses a bb version that is not a release, and runs that are not numbers", () => {
    assert.throws(() => oneMaVersion("0.49.0-nightly.1.1", "7", "1"), /not a bb release/);
    assert.throws(() => oneMaVersion("0.49", "7", "1"), /not a bb release/);
    assert.throws(() => oneMaVersion("0.49.0", "", "1"), /run id must be a positive integer/);
    assert.throws(() => oneMaVersion("0.49.0", "7", "0"), /run attempt must be a positive integer/);
  });
});

describe("version order", () => {
  test("a 1ma build is newer than the bb release it is built on, older than bb's next one", () => {
    const build = oneMaVersion("0.49.0", "100", "1");
    assert.equal(compareVersions(build, "0.49.0"), 1);
    assert.equal(compareVersions(build, "0.49.1"), -1);
    assert.equal(compareVersions(oneMaVersion("0.50.0", "1", "1"), build), 1);
  });

  test("later runs and attempts are newer, compared as numbers", () => {
    assert.equal(compareVersions("0.49.1-1ma.10.1", "0.49.1-1ma.9.1"), 1);
    assert.equal(compareVersions("0.49.1-1ma.9.2", "0.49.1-1ma.9.1"), 1);
    assert.equal(compareVersions("0.49.1-1ma.9.1", "0.49.1-1ma.9.1"), 0);
    assert.equal(compareVersions("0.49.1-1ma.9", "0.49.1-1ma.9.1"), -1);
  });

  test("numeric prerelease identifiers sort before alphanumeric ones", () => {
    assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
    assert.equal(compareVersions("1.0.0-beta", "1.0.0-alpha"), 1);
  });

  test("rejects what is not a semantic version", () => {
    assert.throws(() => compareVersions("0.49", "0.49.0"), /not a semantic version/);
    assert.throws(() => compareVersions("0.49.0-01", "0.49.0"), /not a semantic version/);
  });
});

function feeds(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "1ma-feeds-"));
  for (const [name, version] of Object.entries(files))
    writeFileSync(path.join(dir, name), JSON.stringify({ version }));
  return dir;
}

describe("the feeds only move forward", () => {
  test("a build may replace feeds that announce it or an older build", () => {
    const dir = feeds({
      "desktop-version.json": "0.49.1-1ma.9.1",
      "server-version.json": "0.49.1-1ma.9.2",
    });
    const result = run("forward", "0.49.1-1ma.9.2", dir);
    assert.equal(result.status, 0, result.stderr);
  });

  test("refuses when any feed, not only the server's, announces a newer build", () => {
    // A release that failed halfway can leave the app's feed ahead of the server's.
    const dir = feeds({
      "desktop-version.json": "0.49.1-1ma.10.1",
      "server-version.json": "0.49.1-1ma.9.1",
    });
    const result = run("forward", "0.49.1-1ma.9.2", dir);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /already announces 0\.49\.1-1ma\.10\.1 in desktop-version\.json, newer than 0\.49\.1-1ma\.9\.2/,
    );
  });

  test("refuses when a published release is newer, even if no feed names it any more", () => {
    // A failed upload with --clobber can remove the feed that announced it.
    const dir = feeds({ "server-version.json": "0.49.1-1ma.9.1" });
    const published = path.join(dir, "..", `published-${path.basename(dir)}.txt`);
    writeFileSync(published, "desktop/v0.49.1-1ma.9.1\ndesktop/v0.49.1-1ma.10.1\nsomething-else\n");
    const result = run("forward", "0.49.1-1ma.9.2", dir, published);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /already published desktop\/v0\.49\.1-1ma\.10\.1, newer than 0\.49\.1-1ma\.9\.2/,
    );
    assert.equal(run("forward", "0.49.1-1ma.10.1", dir, published).status, 0);
  });

  test("refuses a feed without a version it can compare", () => {
    const result = run("forward", "0.49.1-1ma.9.2", feeds({ "desktop-version.json": "latest" }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a semantic version/);
  });
});

describe("the command line", () => {
  test("prints the next version and comparisons", () => {
    assert.equal(run("next", "0.49.0", "5", "1").stdout.trim(), "0.49.1-1ma.5.1");
    assert.equal(run("compare", "0.49.1-1ma.5.1", "0.49.0").stdout.trim(), "1");
  });

  test("fails with its usage on unknown input", () => {
    const result = run("bump");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage:/);
  });
});
