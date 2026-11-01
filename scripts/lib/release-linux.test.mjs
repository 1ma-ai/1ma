import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deployPlugins, deployable, installedSource, parseArgs } from "./release-linux.mjs";

const SHA = "8887e030c929493074c2eccd71e0242e209eaa70";

function fakeBb({
  sources = {},
  failInstall = new Set(),
  theme = "1ma",
  themeAfterInstall = null,
}) {
  const calls = [];
  const installed = { ...sources };
  let active = theme;
  return {
    calls,
    installed,
    bb: {
      activeTheme: () => active,
      setTheme: (id) => {
        calls.push(`theme ${id}`);
        active = id;
      },
      source: (id) => installed[id] ?? null,
      remove: (id) => {
        calls.push(`remove ${id}`);
        delete installed[id];
      },
      install: (from) => {
        calls.push(`install ${from}`);
        if (themeAfterInstall) active = themeAfterInstall;
        if (failInstall.has(from)) throw new Error(`cannot build ${from}`);
        const id = from.startsWith("/") ? from.split("/").pop() : /#([^/]+)\//.exec(from)[1];
        installed[id] = from.startsWith("/") ? `path:${from}` : from;
      },
    },
  };
}

const entries = [
  { id: "1ma-theme", directory: "/release/plugins/1ma-theme", version: "0.1.0" },
  { id: "1ma-brand", directory: "/release/plugins/1ma-brand", version: "0.3.0" },
];

describe("arguments", () => {
  test("a typo in a flag stops the release instead of being ignored", () => {
    assert.throws(() => parseArgs(["--replace-manged"]), /unknown option --replace-manged/);
    assert.throws(() => parseArgs(["main", "feature"]), /at most one ref/);
    assert.deepEqual(parseArgs([]), { ref: "origin/main", replaceManaged: false });
    assert.deepEqual(parseArgs(["--replace-managed", "abc123"]), {
      ref: "abc123",
      replaceManaged: true,
    });
  });
});

describe("which commits may be deployed", () => {
  const green = { status: "completed", conclusion: "success" };
  test("only a commit on main whose latest CI run on main succeeded", () => {
    assert.equal(deployable({ sha: SHA, onMain: true, latestCiRun: green }), null);
    assert.match(
      deployable({ sha: SHA, onMain: false, latestCiRun: green }),
      /not on origin\/main/,
    );
    assert.match(deployable({ sha: SHA, onMain: true, latestCiRun: null }), /no CI run/);
    assert.match(
      deployable({
        sha: SHA,
        onMain: true,
        latestCiRun: { status: "in_progress", conclusion: null },
      }),
      /still in_progress/,
    );
    assert.match(
      deployable({
        sha: SHA,
        onMain: true,
        latestCiRun: { status: "completed", conclusion: "failure" },
      }),
      /finished with failure/,
    );
    assert.match(deployable({ sha: "", onMain: true, latestCiRun: green }), /cannot resolve/);
  });
});

describe("installed sources", () => {
  test("a missing source is unknown, not a crash", () => {
    assert.equal(installedSource(null), null);
    assert.equal(
      installedSource('{"requested":"path:/release/plugins/1ma-theme"}'),
      "path:/release/plugins/1ma-theme",
    );
    assert.equal(installedSource("{}"), "unknown");
  });
});

describe("deploying", () => {
  test("managed installs are left alone without --replace-managed", () => {
    const fake = fakeBb({
      sources: { "1ma-brand": "git+https://github.com/1ma-ai/1ma#1ma-brand/v0.3.0" },
    });
    const blocked = deployPlugins({ entries, replaceManaged: false, bb: fake.bb, log: () => {} });
    assert.deepEqual(blocked, [
      "1ma-brand (installed from git+https://github.com/1ma-ai/1ma#1ma-brand/v0.3.0)",
    ]);
    assert.deepEqual(fake.calls, ["install /release/plugins/1ma-theme"]);
  });

  test("a failed replacement puts the previous install back", () => {
    const previous = "git+https://github.com/1ma-ai/1ma#1ma-brand/v0.3.0";
    const fake = fakeBb({
      sources: { "1ma-brand": previous },
      failInstall: new Set(["/release/plugins/1ma-brand"]),
    });
    assert.throws(
      () => deployPlugins({ entries, replaceManaged: true, bb: fake.bb, log: () => {} }),
      /cannot build \/release\/plugins\/1ma-brand/,
    );
    assert.deepEqual(fake.calls.slice(-3), [
      "remove 1ma-brand",
      "install /release/plugins/1ma-brand",
      `install ${previous}`,
    ]);
    assert.equal(fake.installed["1ma-brand"], previous);
  });

  test("an unknown previous source is reported instead of guessed", () => {
    const fake = fakeBb({
      sources: { "1ma-brand": "unknown" },
      failInstall: new Set(["/release/plugins/1ma-brand"]),
    });
    assert.throws(
      () => deployPlugins({ entries, replaceManaged: true, bb: fake.bb, log: () => {} }),
      /previous source is unknown, so the plugin is not installed now/,
    );
  });

  test("the theme comes back even when an install fails", () => {
    const fake = fakeBb({
      theme: "1ma",
      themeAfterInstall: "bb-default",
      failInstall: new Set(["/release/plugins/1ma-brand"]),
    });
    assert.throws(() =>
      deployPlugins({ entries, replaceManaged: false, bb: fake.bb, log: () => {} }),
    );
    assert.equal(fake.bb.activeTheme(), "1ma");
    assert.equal(fake.calls.at(-1), "theme 1ma");
  });
});
