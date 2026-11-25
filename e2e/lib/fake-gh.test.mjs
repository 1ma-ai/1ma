import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const gh = path.resolve(import.meta.dirname, "fake-gh/gh");
const directory = mkdtempSync(path.join(tmpdir(), "fake-gh-"));
const fixtures = path.join(directory, "fixtures.json");
const PULL = "/repos/example/app/pulls/7";
writeFileSync(fixtures, JSON.stringify({ [PULL]: { number: 7 } }));
after(() => rmSync(directory, { recursive: true, force: true }));

function call(...args) {
  return spawnSync(process.execPath, [gh, ...args], {
    encoding: "utf8",
    env: { ...process.env, E2E_GH_FIXTURES: fixtures, E2E_GH_ALLOW: "^/repos/example/app/" },
  });
}

describe("fake gh", () => {
  it("answers the read-only call the plugin makes with the fixture", () => {
    const result = call(
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      PULL,
    );
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { number: 7 });
  });

  for (const spelling of [
    ["--method", "POST"],
    ["--method=POST"],
    ["--method=GET"],
    ["-X", "POST"],
    ["-XPOST"],
    ["-X", "GET"],
    ["-f", "title=x"],
    ["-F", "title=x"],
    ["--field", "title=x"],
    ["--raw-field=title=x"],
    ["--input", "body.json"],
    ["--paginate"],
  ])
    it(`refuses ${spelling.join(" ")} on an allowed path`, () => {
      const result = call("api", ...spelling, PULL);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
    });

  it("refuses a second path and a path outside the allowed ones", () => {
    assert.equal(call("api", PULL, "/repos/example/app/pulls/8").status, 2);
    assert.equal(call("api", "/repos/other/app/pulls/7").status, 2);
    assert.equal(call("pr", "view", "7").status, 2);
  });
});
