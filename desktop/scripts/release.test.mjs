import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { release, sumsOf } from "./release.mjs";

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const REPO = "1ma-ai/1ma";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const temporary = () => mkdtempSync(path.join(tmpdir(), "1ma-release-"));

const provenance = (commit, version) =>
  JSON.stringify({ oneMaCommit: commit, version, upstream: { tag: "v0.49.0" } });

function build({
  version = "0.49.1-1ma.123.1",
  serverVersion = version,
  serverCommit = COMMIT,
  server = true,
} = {}) {
  const root = temporary();
  const dist = path.join(root, "dist");
  const distServer = path.join(root, "dist-server");
  const app = path.join(dist, "apps", "desktop", "release");
  mkdirSync(app, { recursive: true });
  mkdirSync(distServer);
  writeFileSync(path.join(dist, "1ma-provenance.json"), provenance(COMMIT, version));
  writeFileSync(
    path.join(distServer, "1ma-provenance.json"),
    provenance(serverCommit, serverVersion),
  );
  writeFileSync(path.join(app, "desktop-version.json"), JSON.stringify({ version }));
  writeFileSync(path.join(app, `1ma-${version}-arm64.dmg`), `dmg ${version}`);
  writeFileSync(path.join(app, `1ma-${version}-arm64-mac.zip`), `zip ${version}`);
  writeFileSync(path.join(app, `1ma-${version}-arm64.dmg.blockmap`), "not published");
  if (server)
    writeFileSync(path.join(distServer, `1ma-server-${version}.tgz`), `server ${version}`);
  return { dist, distServer, version };
}

const names = (version) => ({
  dmg: `1ma-${version}-arm64.dmg`,
  zip: `1ma-${version}-arm64-mac.zip`,
  server: `1ma-server-${version}.tgz`,
});

const asset = (content) => ({ digest: `sha256:${sha256(content)}`, content });

const VALUED = new Set([
  "--json",
  "--jq",
  "--repo",
  "--pattern",
  "--dir",
  "--target",
  "--title",
  "--notes-file",
  "--limit",
]);

function parse(args) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    if (VALUED.has(args[index])) (flags[args[index]] ??= []).push(args[(index += 1)]);
    else if (args[index].startsWith("--")) flags[args[index]] = [true];
    else positional.push(args[index]);
  }
  return { positional, flags };
}

const isRead = ([group, action]) =>
  (group === "release" && ["view", "download", "list"].includes(action)) || group === "api";

const answer = (stdout) => ({ status: 0, stdout, stderr: "" });
const error = (stderr) => ({ status: 1, stdout: "", stderr: `${stderr}\n` });

// GitHub as gh sees it: releases by tag with the commit they point at and their
// files. refuse(args) may answer an error for a call before it is carried out.
function github({ releases = {}, feeds = {}, latest = true, refuse = () => undefined } = {}) {
  const state = new Map(
    Object.entries(releases).map(([tag, { commit = COMMIT, assets = {} }]) => [
      tag,
      {
        commit,
        assets: new Map(Object.entries(assets).map(([name, file]) => [name, asset(file)])),
      },
    ]),
  );
  if (latest)
    state.set("desktop-latest", {
      commit: OTHER,
      assets: new Map(
        Object.entries(feeds).map(([name, version]) => [name, asset(JSON.stringify({ version }))]),
      ),
    });
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const refusal = refuse(args);
    if (refusal !== undefined) return error(refusal);
    const { positional, flags } = parse(args);
    const [group, action, tag, ...files] = positional;
    if (group === "api") {
      const found = state.get(action.slice(`repos/${REPO}/commits/`.length));
      return found === undefined ? error("HTTP 404") : answer(`${found.commit}\n`);
    }
    assert.deepEqual(flags["--repo"], [REPO]);
    if (action === "list") return answer([...state.keys()].map((name) => `${name}\n`).join(""));
    const target = state.get(tag);
    if (action === "create") {
      if (target !== undefined) return error("a release with the same tag name already exists");
      state.set(tag, {
        commit: flags["--target"][0],
        prerelease: flags["--prerelease"]?.[0] === true,
        title: flags["--title"][0],
        notes: readFileSync(flags["--notes-file"][0], "utf8"),
        assets: new Map(files.map((file) => [path.basename(file), asset(readFileSync(file))])),
      });
      return answer("");
    }
    if (target === undefined) return error("release not found");
    if (action === "view")
      return answer(
        JSON.stringify({
          assets: [...target.assets].map(([name, { digest }]) => ({ name, digest })),
        }),
      );
    if (action === "download") {
      const wanted = [...target.assets].filter(([name]) => flags["--pattern"].includes(name));
      if (wanted.length === 0) return error("no assets match the file pattern");
      for (const [name, { content }] of wanted)
        writeFileSync(path.join(flags["--dir"][0], name), content);
      return answer("");
    }
    if (action === "upload") {
      const clobber = flags["--clobber"]?.[0] === true;
      const taken = files.filter((file) => target.assets.has(path.basename(file)));
      if (taken.length > 0 && !clobber) return error("asset under the same name already exists");
      for (const file of files) target.assets.set(path.basename(file), asset(readFileSync(file)));
      return answer("");
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, calls, state, writes: () => calls.filter((args) => !isRead(args)) };
}

function publish(artifacts, fake, dryRun, ref = "refs/heads/main") {
  const lines = [];
  const result = release({
    runId: "123",
    commit: COMMIT,
    dryRun,
    ref,
    repository: REPO,
    dist: artifacts.dist,
    distServer: artifacts.distServer,
    work: path.join(temporary(), "work"),
    gh: fake.gh,
    log: (line) => lines.push(line),
  });
  return { ...result, output: lines.join("\n") };
}

const assetsOf = (fake, tag) =>
  Object.fromEntries([...fake.state.get(tag).assets].map(([name, { digest }]) => [name, digest]));

describe("a dry run", () => {
  test("refuses when the release of the tag holds a different file of the same name", () => {
    const artifacts = build();
    const { dmg, server } = names(artifacts.version);
    const fake = github({
      releases: {
        [`desktop/v${artifacts.version}`]: {
          assets: { [dmg]: `dmg ${artifacts.version}`, [server]: "another server" },
        },
      },
    });
    assert.throws(
      () => publish(artifacts, fake, true),
      new RegExp(`already has a different ${server.replaceAll(".", "\\.")}; refusing to replace`),
    );
    assert.deepEqual(fake.writes(), []);
  });

  test("prints the checksums and the server feed it would publish, and writes nothing", () => {
    const artifacts = build();
    const fake = github();
    const { output } = publish(artifacts, fake, true);
    assert.match(output, /^dry run: would publish desktop\/v0\.49\.1-1ma\.123\.1 at a{40} with:/u);
    const { server } = names(artifacts.version);
    assert.match(output, new RegExp(`${sha256(`server ${artifacts.version}`)}  ${server}`));
    assert.match(output, /"package": "1ma-server-0\.49\.1-1ma\.123\.1\.tgz"/u);
    assert.deepEqual(fake.writes(), []);
  });
});

describe("a publication", () => {
  test("after a dry run of the same inputs creates the pre-release with every file, then the feeds", () => {
    const artifacts = build();
    const { dmg, zip, server } = names(artifacts.version);
    const tag = `desktop/v${artifacts.version}`;
    const fake = github({ feeds: { "server-version.json": "0.49.1-1ma.100.1" } });
    publish(artifacts, fake, true);
    assert.deepEqual(fake.writes(), []);
    publish(artifacts, fake, false);

    const created = fake.state.get(tag);
    assert.equal(created.commit, COMMIT);
    assert.equal(created.prerelease, true);
    assert.equal(created.title, `1ma ${artifacts.version}`);
    assert.match(
      created.notes,
      /^Test build of 1ma 0\.49\.1-1ma\.123\.1 for macOS on Apple Silicon, built from bb v0\.49\.0 with the 1ma patches at a{40}\./u,
    );
    assert.deepEqual(
      Object.keys(assetsOf(fake, tag)).toSorted(),
      [dmg, server, zip, "SHA256SUMS"].toSorted(),
    );
    const contents = {
      [dmg]: `dmg ${artifacts.version}`,
      [zip]: `zip ${artifacts.version}`,
      [server]: `server ${artifacts.version}`,
    };
    assert.equal(
      created.assets.get("SHA256SUMS").content.toString(),
      [zip, dmg, server].map((name) => `${sha256(contents[name])}  ${name}\n`).join(""),
    );

    const writes = fake.writes();
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].slice(0, 3), ["release", "create", tag]);
    assert.deepEqual(writes[1].slice(0, 3), ["release", "upload", "desktop-latest"]);
    const latest = fake.state.get("desktop-latest").assets;
    assert.deepEqual(JSON.parse(latest.get("server-version.json").content), {
      schemaVersion: 1,
      channel: "latest",
      version: artifacts.version,
      release: tag,
      package: server,
      commit: COMMIT,
      bb: "v0.49.0",
    });
    assert.deepEqual(JSON.parse(latest.get("desktop-version.json").content), {
      version: artifacts.version,
    });
  });

  test("into an existing release uploads only the missing files", () => {
    const artifacts = build();
    const { dmg, zip, server } = names(artifacts.version);
    const tag = `desktop/v${artifacts.version}`;
    const partial = github({
      releases: { [tag]: { assets: { [dmg]: `dmg ${artifacts.version}` } } },
    });
    const before = assetsOf(partial, tag);
    publish(artifacts, partial, true);
    assert.deepEqual(partial.writes(), []);
    publish(artifacts, partial, false);
    const uploaded = partial
      .writes()
      .filter((args) => args[2] === tag)
      .flatMap((args) => parse(args).positional.slice(3))
      .map((file) => path.basename(file));
    assert.deepEqual(uploaded.toSorted(), [server, zip, "SHA256SUMS"].toSorted());
    assert.equal(assetsOf(partial, tag)[dmg], before[dmg]);
  });

  test("into an existing release uploads nothing when a file differs", () => {
    const artifacts = build();
    const { dmg, zip, server } = names(artifacts.version);
    const tag = `desktop/v${artifacts.version}`;
    // The zip is missing and sorts before the server package, which differs.
    assert.ok(zip < server);
    const conflict = github({
      releases: {
        [tag]: { assets: { [dmg]: `dmg ${artifacts.version}`, [server]: "another server" } },
      },
    });
    assert.throws(
      () => publish(artifacts, conflict, false),
      /already has a different 1ma-server-/u,
    );
    assert.deepEqual(conflict.writes(), []);
  });

  test("whose feed upload failed leaves the release, and a rerun completes it without replacing a file", () => {
    const artifacts = build();
    const tag = `desktop/v${artifacts.version}`;
    let feedsFail = true;
    const fake = github({
      refuse: (args) =>
        feedsFail && args[1] === "upload" && args[2] === "desktop-latest" ? "HTTP 502" : undefined,
    });
    assert.throws(
      () => publish(artifacts, fake, false),
      /cannot upload the feeds to desktop-latest: HTTP 502/u,
    );
    const released = assetsOf(fake, tag);
    assert.equal(Object.keys(released).length, 4);
    assert.equal(fake.state.get("desktop-latest").assets.size, 0);

    feedsFail = false;
    const first = fake.calls.length;
    publish(artifacts, fake, false);
    const rerun = fake.calls.slice(first).filter((args) => !isRead(args));
    assert.deepEqual(
      rerun.map((args) => args.slice(0, 3)),
      [["release", "upload", "desktop-latest"]],
    );
    assert.deepEqual(assetsOf(fake, tag), released);
    assert.equal(
      JSON.parse(fake.state.get("desktop-latest").assets.get("server-version.json").content)
        .version,
      artifacts.version,
    );
  });
});

function refused(artifacts, fake, message) {
  for (const dryRun of [true, false]) {
    assert.throws(() => publish(artifacts, fake, dryRun), message);
    assert.deepEqual(fake.writes(), []);
  }
}

describe("a run started from another branch than main", () => {
  test("checks the build as a dry run, and publishes nothing when asked to publish", () => {
    const artifacts = build();
    const tried = github();
    assert.match(
      publish(artifacts, tried, true, "refs/heads/try").output,
      /dry run: would publish/u,
    );
    assert.deepEqual(tried.writes(), []);
    const fake = github();
    assert.throws(
      () => publish(artifacts, fake, false, "refs/heads/try"),
      /a publication is started from main; this run is at refs\/heads\/try/u,
    );
    assert.deepEqual(fake.calls, []);
  });
});

describe("a build that is not published", () => {
  test("was built from another commit", () => {
    refused(
      build({ serverCommit: OTHER }),
      github(),
      /dist-server\/1ma-provenance\.json says it was built from 'b{40}', but run 123 built a{40}/u,
    );
  });

  test("has a version that is not one", () => {
    refused(
      build({ version: "0.49.1-1ma.123.01" }),
      github(),
      /unexpected version '0\.49\.1-1ma\.123\.01'/u,
    );
  });

  test("has a version that does not name the run", () => {
    refused(
      build({ version: "0.49.1-1ma.124.1" }),
      github(),
      /run 123 built version '0\.49\.1-1ma\.124\.1', which does not name the run/u,
    );
  });

  test("has an app and a server of different versions", () => {
    refused(
      build({ serverVersion: "0.49.1-1ma.123.2" }),
      github(),
      /dist-server\/1ma-provenance\.json is for version 0\.49\.1-1ma\.123\.2, not 0\.49\.1-1ma\.123\.1/u,
    );
  });

  test("has no Linux server package", () => {
    refused(
      build({ server: false }),
      github(),
      /run 123 has no Linux server package for 0\.49\.1-1ma\.123\.1/u,
    );
  });

  test("has a release whose tag points at another commit", () => {
    refused(
      build(),
      github({ releases: { "desktop/v0.49.1-1ma.123.1": { commit: OTHER } } }),
      /desktop\/v0\.49\.1-1ma\.123\.1 points at b{40}, not at the build commit a{40}/u,
    );
  });

  test("cannot be compared with its release because GitHub did not answer", () => {
    refused(
      build(),
      github({ refuse: (args) => (args[1] === "view" ? "HTTP 502: Bad Gateway" : undefined) }),
      /cannot read release desktop\/v0\.49\.1-1ma\.123\.1: HTTP 502: Bad Gateway/u,
    );
  });

  test("has no desktop-latest release to announce it", () => {
    refused(build(), github({ latest: false }), /the desktop-latest release is missing/u);
  });

  test("is older than a feed or a published release", () => {
    refused(
      build(),
      github({ feeds: { "desktop-version.json": "0.49.1-1ma.124.1" } }),
      /only move forward:\ndesktop-latest already announces 0\.49\.1-1ma\.124\.1 in desktop-version\.json/u,
    );
    refused(
      build(),
      github({ releases: { "desktop/v0.49.1-1ma.125.1": {} } }),
      /only move forward:\n1ma already published desktop\/v0\.49\.1-1ma\.125\.1/u,
    );
  });
});

describe("SHA256SUMS", () => {
  test("is what sha256sum writes for the same files in the runner's locale", () => {
    const folder = temporary();
    for (const name of [
      "1ma-0.49.1-1ma.123.1-arm64.dmg",
      "1ma-0.49.1-1ma.123.1-arm64-mac.zip",
      "1ma-server-0.49.1-1ma.123.1.tgz",
      "Zeta.zip",
      "a_b",
      "a-b",
      "a.b",
      "a10",
      "a9",
    ])
      writeFileSync(path.join(folder, name), name);
    const real = spawnSync("bash", ["-c", "sha256sum -- *"], {
      cwd: folder,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C.UTF-8" },
    });
    assert.equal(real.status, 0, real.stderr);
    assert.equal(sumsOf(folder), real.stdout);
  });
});

describe("the command line", () => {
  test("refuses a dry-run flag it does not know before it calls gh", () => {
    const script = fileURLToPath(new URL("release.mjs", import.meta.url));
    const done = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { PATH: "", DRY_RUN: "yes" },
    });
    assert.equal(done.status, 1);
    assert.equal(done.stdout, "::error::DRY_RUN must be true or false, got 'yes'\n");
  });
});
