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

const STARTER = { state: "starter" };

// A file as GitHub stores it: content is a string, or { state } for an upload
// GitHub never finished, which has no digest and cannot be downloaded.
let ids = 0;
function asset(file) {
  ids += 1;
  if (typeof file === "object" && !Buffer.isBuffer(file))
    return { id: ids, state: file.state, digest: file.digest ?? null, content: "" };
  return { id: ids, state: "uploaded", digest: `sha256:${sha256(file)}`, content: file };
}

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
  (group === "release" && ["view", "download", "list"].includes(action)) ||
  (group === "api" && action !== "-X");

const ASSETS = `https://api.github.com/repos/${REPO}/releases/assets/`;

const answer = (stdout) => ({ status: 0, stdout, stderr: "" });
const error = (stderr, stdout = "") => ({ status: 1, stdout, stderr: `${stderr}\n` });
const BAD_GATEWAY = "HTTP 502: Bad Gateway (https://uploads.github.com/)";

const stored = (assets) =>
  new Map(Object.entries(assets).map(([name, file]) => [name, asset(file)]));

const tagObject = (name) => sha256(`tag ${name}`).slice(0, 40);

// Stores the files one after another, as far as a break lets it.
const store = (target, files, broken, clobber) => {
  for (const [index, file] of files.entries()) {
    const name = path.basename(file);
    if (clobber) target.assets.delete(name);
    if (broken !== undefined && index === broken.after) {
      target.assets.set(name, asset(STARTER));
      return false;
    }
    target.assets.set(name, asset(readFileSync(file)));
  }
  return true;
};

// GitHub as gh sees it. Tags and releases are apart: a tag may have no
// release, a draft has no tag, and publishing a release creates its tag at the
// target only when the tag is missing. tags maps a name to a commit or to
// { commit, annotated }; a release that is not a draft gets a tag at its
// commit unless tags names one. Every stored file has its own id, and its
// address names that id: a file stored again under the same name is another
// one; it is read as JSON at its address, or as its bytes with the header
// Accept: application/octet-stream. An upload without --clobber onto a name
// the release holds fails as gh 2.102.0 fails it. refuse(args) may answer an
// error for a call before it is carried out, and reply(args, state) another
// answer instead of carrying it out;
// breaks(args) may answer { after, keepDraft } for a create or upload that
// stores `after` files, leaves the next one unfinished and fails, as an upload
// GitHub answers with 502; before(args, state) runs before any call, and
// meanwhile(args, state) after a write that succeeded.
function github({
  tags = {},
  releases = {},
  feeds = {},
  latest = true,
  latestDraft = false,
  refuse = () => undefined,
  reply = () => undefined,
  breaks = () => undefined,
  before = () => undefined,
  meanwhile = () => undefined,
} = {}) {
  const tagged = new Map(
    Object.entries(tags).map(([name, value]) => [
      name,
      typeof value === "string" ? { commit: value, annotated: false } : value,
    ]),
  );
  const state = new Map(
    Object.entries(releases).map(
      ([tag, { commit = COMMIT, draft = false, prerelease = true, assets = {} }]) => {
        if (!draft && !tagged.has(tag)) tagged.set(tag, { commit, annotated: false });
        return [tag, { commit, draft, prerelease, assets: stored(assets) }];
      },
    ),
  );
  if (latest)
    state.set("desktop-latest", {
      commit: OTHER,
      draft: latestDraft,
      prerelease: true,
      assets: new Map(
        Object.entries(feeds).map(([name, version]) => [
          name,
          asset(typeof version === "string" ? JSON.stringify({ version }) : version),
        ]),
      ),
    });
  const calls = [];

  const holding = (id) =>
    [...state.values()].find(({ assets }) => [...assets.values()].some((file) => file.id === id));

  const carry = (args) => {
    const { positional, flags } = parse(args);
    const [group, action, tag, ...files] = positional;
    if (group === "api") {
      const notFound = error("gh: Not Found (HTTP 404)", '{"message":"Not Found","status":"404"}');
      const method = action === "-X" ? args[2] : "GET";
      const address = action === "-X" || action === "-H" ? args[3] : action;
      if (address.startsWith(ASSETS)) {
        const id = Number(address.slice(ASSETS.length));
        const owner = holding(id);
        if (owner === undefined) return notFound;
        const [name, file] = [...owner.assets].find(([, { id: held }]) => held === id);
        if (method === "DELETE") {
          owner.assets.delete(name);
          return answer("");
        }
        assert.equal(method, "GET");
        if (action === "-H") {
          assert.equal(args[2], "Accept: application/octet-stream");
          return file.state === "uploaded" ? answer(file.content.toString()) : notFound;
        }
        return answer(JSON.stringify({ id, name, state: file.state, digest: file.digest }));
      }
      const route = address.slice(`repos/${REPO}/`.length);
      if (route.startsWith("git/ref/tags/")) {
        const name = route.slice("git/ref/tags/".length);
        const found = tagged.get(name);
        if (found === undefined) return notFound;
        const object = found.annotated
          ? { sha: tagObject(name), type: "tag" }
          : { sha: found.commit, type: "commit" };
        return answer(JSON.stringify({ ref: `refs/tags/${name}`, object }));
      }
      if (route.startsWith("git/tags/")) {
        const sha = route.slice("git/tags/".length);
        const name = [...tagged.keys()].find((key) => tagObject(key) === sha);
        if (name === undefined) return notFound;
        return answer(
          JSON.stringify({
            sha,
            tag: name,
            object: { sha: tagged.get(name).commit, type: "commit" },
          }),
        );
      }
      if (route.startsWith("commits/")) {
        const found = tagged.get(route.slice("commits/".length));
        if (found === undefined) return error(`gh: No commit found for SHA: ${route} (HTTP 422)`);
        return answer(`${found.commit}\n`);
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    }
    assert.deepEqual(flags["--repo"], [REPO]);
    if (action === "list") {
      // gh lists drafts as well.
      const listed = [...state].map(([name, { draft }]) => ({ tagName: name, isDraft: draft }));
      if (flags["--jq"]?.[0] === ".[].tagName")
        return answer(listed.map(({ tagName }) => `${tagName}\n`).join(""));
      assert.deepEqual(flags["--json"], ["tagName,isDraft"]);
      return answer(JSON.stringify(listed));
    }
    const target = state.get(tag);
    if (action === "create") {
      if (target !== undefined) return error("a release with the same tag name already exists");
      // gh creates a draft, uploads the files into it, then publishes it; when
      // an upload fails it deletes the draft.
      const created = {
        commit: flags["--target"][0],
        draft: true,
        prerelease: flags["--prerelease"]?.[0] === true,
        title: flags["--title"][0],
        notes: readFileSync(flags["--notes-file"][0], "utf8"),
        assets: new Map(),
      };
      state.set(tag, created);
      const broken = breaks(args);
      if (!store(created, files, broken, false)) {
        if (broken.keepDraft !== true) state.delete(tag);
        return error(BAD_GATEWAY);
      }
      created.draft = false;
      if (!tagged.has(tag)) tagged.set(tag, { commit: created.commit, annotated: false });
      return answer("");
    }
    if (target === undefined) return error("release not found");
    if (action === "view")
      return answer(
        JSON.stringify({
          isDraft: target.draft,
          isPrerelease: target.prerelease,
          assets: [...target.assets].map(([name, { id, digest, state: stage }]) => ({
            apiUrl: `${ASSETS}${id}`,
            name,
            digest,
            state: stage,
          })),
        }),
      );
    if (action === "download") {
      const wanted = [...target.assets].filter(([name]) => flags["--pattern"].includes(name));
      if (wanted.length === 0) return error("no assets match the file pattern");
      for (const [name, { content, state: stage }] of wanted) {
        if (stage !== "uploaded") return error("HTTP 404: Not Found");
        writeFileSync(path.join(flags["--dir"][0], name), content);
      }
      return answer("");
    }
    if (action === "upload") {
      const clobber = flags["--clobber"]?.[0] === true;
      const taken = files
        .map((file) => path.basename(file))
        .filter((name) => target.assets.has(name));
      if (taken.length > 0 && !clobber)
        return error(`asset under the same name already exists: [${taken.join(" ")}]`);
      return store(target, files, breaks(args), clobber) ? answer("") : error(BAD_GATEWAY);
    }
    // gh reads the release again and deletes whatever now carries the name.
    if (action === "delete-asset") {
      assert.deepEqual(flags["--yes"], [true]);
      if (!target.assets.delete(files[0])) return error(`asset ${files[0]} not found in ${tag}`);
      return answer("");
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };

  const gh = (args) => {
    calls.push(args);
    before(args, state);
    const refusal = refuse(args);
    if (refusal !== undefined) return error(refusal);
    const done = reply(args, state) ?? carry(args);
    if (done.status === 0 && !isRead(args)) meanwhile(args, state);
    return done;
  };
  return { gh, calls, state, tags: tagged, writes: () => calls.filter((args) => !isRead(args)) };
}

function publish(artifacts, fake, dryRun, ref = "refs/heads/main", attempt = "1") {
  const lines = [];
  const result = release({
    runId: "123",
    attempt,
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
    assert.match(
      output,
      /^dry run: would publish desktop\/v0\.49\.1-1ma\.123\.1 at a{40} from attempt 1 of run 123 with:/u,
    );
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

    const old = fake.calls.find((args) => args[0] === "api" && args[1] === "-H").at(-1);
    const writes = fake.writes();
    assert.equal(writes.length, 3);
    assert.deepEqual(writes[0].slice(0, 3), ["release", "create", tag]);
    assert.deepEqual(writes[1], ["api", "-X", "DELETE", old]);
    assert.deepEqual(writes[2].slice(0, 3), ["release", "upload", "desktop-latest"]);
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
  for (const dryRun of [false, true]) {
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

  test("has files of an earlier attempt than the run is at", () => {
    for (const dryRun of [true, false]) {
      const fake = github();
      assert.throws(
        () => publish(build(), fake, dryRun, "refs/heads/main", "2"),
        /run 123 is at attempt 2, but the files are of attempt 1 \(version 0\.49\.1-1ma\.123\.1\); rerun all jobs of the build, or start a new build/u,
      );
      assert.deepEqual(fake.calls, []);
    }
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

const TAG = "desktop/v0.49.1-1ma.123.1";
const OLD_FEEDS = {
  "desktop-version.json": "0.49.1-1ma.100.1",
  "server-version.json": "0.49.1-1ma.100.1",
};
const literal = (text) => text.replaceAll(".", "\\.");
// A call with the files it passes by name.
const shape = (args) =>
  parse(args).positional.map((part) => (path.isAbsolute(part) ? path.basename(part) : part));
const feedUploads = (fake) =>
  fake.writes().filter((args) => args[1] === "upload" && args[2] === "desktop-latest");
const filesOf = (fake, tag) =>
  Object.fromEntries(
    [...fake.state.get(tag).assets].map(([name, { id, digest, state }]) => [
      name,
      { id, digest, state },
    ]),
  );
const announces = (fake, name) =>
  JSON.parse(fake.state.get("desktop-latest").assets.get(name).content).version;

describe("the tag of a build", () => {
  test("at another commit without a release stops both modes before any write", () => {
    for (const annotated of [false, true])
      refused(
        build(),
        github({ tags: { [TAG]: { commit: OTHER, annotated } } }),
        /desktop\/v0\.49\.1-1ma\.123\.1 points at b{40}, not at the build commit a{40}/u,
      );
  });

  test("at the build commit without a release gets the pre-release created on it", () => {
    for (const annotated of [false, true]) {
      const artifacts = build();
      const fake = github({ tags: { [TAG]: { commit: COMMIT, annotated } } });
      assert.match(
        publish(artifacts, fake, true).output,
        /desktop\/v0\.49\.1-1ma\.123\.1 exists at the build commit; would create the pre-release on it/u,
      );
      assert.deepEqual(fake.writes(), []);
      publish(artifacts, fake, false);
      assert.deepEqual(
        fake.writes().map((args) => args.slice(0, 3)),
        [
          ["release", "create", TAG],
          ["release", "upload", "desktop-latest"],
        ],
      );
      assert.equal(fake.state.get(TAG).draft, false);
      assert.equal(Object.keys(assetsOf(fake, TAG)).length, 4);
      assert.deepEqual(fake.tags.get(TAG), { commit: COMMIT, annotated });
    }
  });

  test("counts as missing only by the status gh ends its message with", () => {
    refused(
      build(),
      github({
        refuse: (args) =>
          args[0] === "api" ? "gh: a 404 page (HTTP 404) said Bad Gateway (HTTP 502)" : undefined,
      }),
      /cannot read the tag desktop\/v0\.49\.1-1ma\.123\.1: gh: a 404 page \(HTTP 404\) said Bad Gateway \(HTTP 502\)/u,
    );
  });
});

describe("a draft", () => {
  for (const [what, tags] of [
    ["without a tag", {}],
    ["with a tag at the build commit", { [TAG]: COMMIT }],
  ])
    test(`under the tag, ${what}, stops both modes`, () => {
      const artifacts = build();
      const { dmg, zip } = names(artifacts.version);
      const fake = github({
        tags,
        feeds: OLD_FEEDS,
        releases: {
          [TAG]: {
            draft: true,
            assets: { [dmg]: `dmg ${artifacts.version}`, [zip]: `zip ${artifacts.version}` },
          },
        },
      });
      const feeds = filesOf(fake, "desktop-latest");
      refused(
        artifacts,
        fake,
        /desktop\/v0\.49\.1-1ma\.123\.1 is a draft release, left by an interrupted publication and never public; delete it with 'gh release delete desktop\/v0\.49\.1-1ma\.123\.1 --yes --repo 1ma-ai\/1ma', then run again/u,
      );
      assert.deepEqual(filesOf(fake, "desktop-latest"), feeds);
    });

  test("left by a create that gh could not clean up stops the rerun", () => {
    const artifacts = build();
    const fake = github({
      feeds: OLD_FEEDS,
      breaks: (args) => (args[1] === "create" ? { after: 2, keepDraft: true } : undefined),
    });
    assert.throws(
      () => publish(artifacts, fake, false),
      /cannot create the pre-release desktop\/v0\.49\.1-1ma\.123\.1: HTTP 502/u,
    );
    const writes = fake.writes().length;
    for (const dryRun of [true, false])
      assert.throws(() => publish(artifacts, fake, dryRun), /is a draft release/u);
    assert.equal(fake.writes().length, writes);
    assert.deepEqual(feedUploads(fake), []);
    assert.equal(announces(fake, "server-version.json"), "0.49.1-1ma.100.1");
  });

  test("as desktop-latest stops both modes", () => {
    refused(
      build(),
      github({ latestDraft: true }),
      /the desktop-latest release is a draft, which nobody can download; a maintainer publishes it/u,
    );
  });
});

describe("an unfinished upload", () => {
  test("into the release of the tag is completed by a rerun of the same inputs", () => {
    const artifacts = build();
    const { server } = names(artifacts.version);
    let broken = true;
    // The pre-release a maintainer created after a 403, without files.
    const fake = github({
      releases: { [TAG]: {} },
      feeds: OLD_FEEDS,
      breaks: (args) =>
        broken && args[1] === "upload" && args[2] === TAG ? { after: 2 } : undefined,
    });
    assert.throws(
      () => publish(artifacts, fake, false),
      /cannot upload .+ to desktop\/v0\.49\.1-1ma\.123\.1: HTTP 502/u,
    );
    const first = filesOf(fake, TAG);
    assert.equal(first[server].state, "starter");
    assert.equal(Object.keys(first).length, 3);
    assert.deepEqual(feedUploads(fake), []);

    broken = false;
    const writes = fake.writes().length;
    assert.match(
      publish(artifacts, fake, true).output,
      new RegExp(
        `has an unfinished ${literal(server)} \\(state starter\\); would remove it and upload it again\\n.+ already exists; would upload ${literal(server)}, SHA256SUMS`,
      ),
    );
    assert.equal(fake.writes().length, writes);
    const old = Object.values(filesOf(fake, "desktop-latest")).map(({ id }) => id);
    const { output } = publish(artifacts, fake, false);
    assert.match(
      output,
      new RegExp(`removed the unfinished ${literal(server)} \\(state starter\\)`),
    );
    assert.deepEqual(fake.writes().slice(writes).map(shape), [
      ["api", "-X", "DELETE", `${ASSETS}${first[server].id}`],
      ["release", "upload", TAG, server, "SHA256SUMS"],
      ...old.map((id) => ["api", "-X", "DELETE", `${ASSETS}${id}`]),
      ["release", "upload", "desktop-latest", "desktop-version.json", "server-version.json"],
    ]);
    const done = filesOf(fake, TAG);
    for (const [name, file] of Object.entries(first))
      if (file.state === "uploaded") assert.deepEqual(done[name], file);
    assert.equal(Object.keys(done).length, 4);
    assert.ok(Object.values(done).every(({ state }) => state === "uploaded"));
    assert.equal(done[server].digest, `sha256:${sha256(`server ${artifacts.version}`)}`);
    assert.equal(feedUploads(fake).length, 1);
    assert.equal(announces(fake, "server-version.json"), artifacts.version);
  });

  test("of a create that gh cleaned up leaves nothing, and the rerun creates the release", () => {
    const artifacts = build();
    let broken = true;
    const fake = github({
      feeds: OLD_FEEDS,
      breaks: (args) => (broken && args[1] === "create" ? { after: 2 } : undefined),
    });
    assert.throws(() => publish(artifacts, fake, false), /cannot create the pre-release/u);
    assert.equal(fake.state.has(TAG), false);
    assert.equal(fake.tags.has(TAG), false);
    broken = false;
    publish(artifacts, fake, false);
    assert.ok(Object.values(filesOf(fake, TAG)).every(({ state }) => state === "uploaded"));
    assert.equal(Object.keys(filesOf(fake, TAG)).length, 4);
    assert.equal(feedUploads(fake).length, 1);
  });

  test("of the feeds, one of them already replaced, is completed by a rerun", () => {
    const artifacts = build();
    let broken = true;
    const fake = github({
      feeds: OLD_FEEDS,
      breaks: (args) => (broken && args[2] === "desktop-latest" ? { after: 1 } : undefined),
    });
    assert.throws(
      () => publish(artifacts, fake, false),
      /cannot upload the feeds to desktop-latest: HTTP 502/u,
    );
    assert.equal(announces(fake, "desktop-version.json"), artifacts.version);
    assert.equal(
      fake.state.get("desktop-latest").assets.get("server-version.json").state,
      "starter",
    );
    const released = filesOf(fake, TAG);
    const starter = filesOf(fake, "desktop-latest")["server-version.json"].id;

    broken = false;
    const writes = fake.writes().length;
    assert.match(
      publish(artifacts, fake, true).output,
      /desktop-latest has an unfinished server-version\.json \(state starter\), counted as lost; would remove it/u,
    );
    assert.equal(fake.writes().length, writes);
    publish(artifacts, fake, false);
    assert.deepEqual(fake.writes().slice(writes).map(shape), [
      ["api", "-X", "DELETE", `${ASSETS}${starter}`],
      ["release", "upload", "desktop-latest", "server-version.json"],
    ]);
    assert.deepEqual(filesOf(fake, TAG), released);
    for (const name of ["desktop-version.json", "server-version.json"]) {
      assert.equal(fake.state.get("desktop-latest").assets.get(name).state, "uploaded");
      assert.equal(announces(fake, name), artifacts.version);
    }
  });

  test("of a feed counts as lost, and the published releases stay the floor", () => {
    refused(
      build(),
      github({
        feeds: { "desktop-version.json": "0.49.1-1ma.100.1", "server-version.json": STARTER },
        releases: { "desktop/v0.49.1-1ma.125.1": {} },
      }),
      /only move forward:\n1ma already published desktop\/v0\.49\.1-1ma\.125\.1/u,
    );
  });

  test("is not a fully uploaded file: one with another digest or with none stops both modes", () => {
    const artifacts = build();
    const { dmg, server } = names(artifacts.version);
    refused(
      artifacts,
      github({ releases: { [TAG]: { assets: { [server]: "another server" } } } }),
      new RegExp(`already has a different ${literal(server)}; refusing to replace`),
    );
    refused(
      artifacts,
      github({ releases: { [TAG]: { assets: { [dmg]: { state: "uploaded" } } } } }),
      new RegExp(`already has ${literal(dmg)} without a digest to compare; refusing to replace`),
    );
  });
});

// The files a complete release of the build holds.
function everyFile(version) {
  const { dmg, zip, server } = names(version);
  const contents = {
    [zip]: `zip ${version}`,
    [dmg]: `dmg ${version}`,
    [server]: `server ${version}`,
  };
  return {
    ...contents,
    SHA256SUMS: [zip, dmg, server].map((name) => `${sha256(contents[name])}  ${name}\n`).join(""),
  };
}

// A call that reads a file at its address as JSON, as before removing it.
const rereads = (args) =>
  args[0] === "api" && args.length === 2 && String(args[1]).startsWith(ASSETS);

// Changes GitHub once, right before the first call that removes an unfinished
// file, as a maintainer or another tool could.
const beforeRemoving = (change) => {
  let changed = false;
  return (args, state) => {
    const removing =
      rereads(args) || (args[0] === "api" && args[1] === "-X") || args[1] === "delete-asset";
    if (removing && !changed) {
      changed = true;
      change(state);
    }
  };
};

// The release of the tag with the server package left unfinished.
function unfinishedServer(artifacts, before) {
  const { dmg, zip, server } = names(artifacts.version);
  const files = everyFile(artifacts.version);
  return github({
    feeds: OLD_FEEDS,
    releases: { [TAG]: { assets: { [zip]: files[zip], [dmg]: files[dmg], [server]: STARTER } } },
    before,
  });
}

describe("an unfinished upload changed by someone else before it is removed", () => {
  test("into an uploaded file with other bytes keeps that file and stops before the feeds", () => {
    const artifacts = build();
    const { server } = names(artifacts.version);
    let replaced;
    const fake = unfinishedServer(
      artifacts,
      beforeRemoving((state) => {
        const { assets } = state.get(TAG);
        assets.delete(server);
        replaced = asset("a server uploaded by hand");
        assets.set(server, replaced);
      }),
    );
    assert.throws(
      () => publish(artifacts, fake, false),
      new RegExp(`already has a different ${literal(server)}; refusing to replace`, "u"),
    );
    const kept = fake.state.get(TAG).assets.get(server);
    assert.equal(kept.id, replaced.id);
    assert.equal(kept.content, "a server uploaded by hand");
    assert.deepEqual(feedUploads(fake), []);
    assert.equal(announces(fake, "server-version.json"), "0.49.1-1ma.100.1");
  });

  test("that vanished is uploaded without an error", () => {
    const artifacts = build();
    const { server } = names(artifacts.version);
    const fake = unfinishedServer(
      artifacts,
      beforeRemoving((state) => state.get(TAG).assets.delete(server)),
    );
    publish(artifacts, fake, false);
    const files = filesOf(fake, TAG);
    assert.equal(Object.keys(files).length, 4);
    assert.equal(files[server].digest, `sha256:${sha256(`server ${artifacts.version}`)}`);
    assert.equal(announces(fake, "server-version.json"), artifacts.version);
  });

  test("again after the release was read anew stops, naming the file", () => {
    const artifacts = build();
    const { server } = names(artifacts.version);
    const fake = unfinishedServer(artifacts, (args, state) => {
      if (rereads(args)) {
        const { assets } = state.get(TAG);
        assets.delete(server);
        assets.set(server, asset(STARTER));
      }
    });
    assert.throws(
      () => publish(artifacts, fake, false),
      new RegExp(
        `the unfinished ${literal(server)} in desktop/v0\\.49\\.1-1ma\\.123\\.1 changed meanwhile, also after`,
        "u",
      ),
    );
    assert.deepEqual(
      fake.writes().filter((args) => args[0] !== "api"),
      [],
    );
    assert.equal(announces(fake, "server-version.json"), "0.49.1-1ma.100.1");
  });

  test("of a feed, into a newer uploaded feed, keeps that feed and uploads no feed", () => {
    const artifacts = build();
    let replaced;
    const fake = github({
      feeds: { "desktop-version.json": "0.49.1-1ma.100.1", "server-version.json": STARTER },
      releases: { [TAG]: { assets: everyFile(artifacts.version) } },
      before: beforeRemoving((state) => {
        const { assets } = state.get("desktop-latest");
        assets.delete("server-version.json");
        replaced = asset(JSON.stringify({ version: "0.49.1-1ma.124.1" }));
        assets.set("server-version.json", replaced);
      }),
    });
    assert.throws(
      () => publish(artifacts, fake, false),
      /only move forward:\ndesktop-latest already announces 0\.49\.1-1ma\.124\.1 in server-version\.json/u,
    );
    assert.equal(
      fake.state.get("desktop-latest").assets.get("server-version.json").id,
      replaced.id,
    );
    assert.deepEqual(feedUploads(fake), []);
  });
});

describe("a draft of another, newer build", () => {
  test("does not count as published, and once it is published it stops the older build", () => {
    const artifacts = build();
    const newer = "desktop/v0.49.1-1ma.125.1";
    const fake = github({
      feeds: { "desktop-version.json": artifacts.version },
      releases: { [TAG]: { assets: everyFile(artifacts.version) }, [newer]: { draft: true } },
    });
    assert.match(publish(artifacts, fake, true).output, /and point desktop-latest at it/u);
    publish(artifacts, fake, false);
    assert.equal(announces(fake, "server-version.json"), artifacts.version);

    fake.state.get(newer).draft = false;
    fake.state.get("desktop-latest").assets.delete("server-version.json");
    const writes = fake.writes().length;
    for (const dryRun of [false, true])
      assert.throws(
        () => publish(artifacts, fake, dryRun),
        /only move forward:\n1ma already published desktop\/v0\.49\.1-1ma\.125\.1/u,
      );
    assert.equal(fake.writes().length, writes);
  });
});

describe("a release of the tag that is not a pre-release", () => {
  test("stops both modes before the feeds, and the same as a pre-release passes", () => {
    const artifacts = build();
    const normal = github({
      feeds: OLD_FEEDS,
      releases: { [TAG]: { prerelease: false, assets: everyFile(artifacts.version) } },
    });
    refused(
      artifacts,
      normal,
      /desktop\/v0\.49\.1-1ma\.123\.1 is a release, not a pre-release; a maintainer makes it one with 'gh release edit desktop\/v0\.49\.1-1ma\.123\.1 --prerelease --repo 1ma-ai\/1ma', then runs again/u,
    );
    assert.equal(announces(normal, "server-version.json"), "0.49.1-1ma.100.1");

    const pre = github({
      feeds: OLD_FEEDS,
      releases: { [TAG]: { assets: everyFile(artifacts.version) } },
    });
    const old = Object.values(filesOf(pre, "desktop-latest")).map(({ id }) => id);
    publish(artifacts, pre, false);
    assert.deepEqual(pre.writes().map(shape), [
      ...old.map((id) => ["api", "-X", "DELETE", `${ASSETS}${id}`]),
      ["release", "upload", "desktop-latest", "desktop-version.json", "server-version.json"],
    ]);
    assert.equal(announces(pre, "server-version.json"), artifacts.version);
  });
});

describe("feeds that already hold what would be written", () => {
  test("are not uploaded again by a rerun of a complete publication", () => {
    const artifacts = build();
    const fake = github({ feeds: OLD_FEEDS });
    publish(artifacts, fake, false);
    const feeds = filesOf(fake, "desktop-latest");
    const writes = fake.writes().length;
    assert.match(
      publish(artifacts, fake, true).output,
      /the feeds in desktop-latest already point at it/u,
    );
    assert.match(
      publish(artifacts, fake, false).output,
      /the feeds in desktop-latest already point at desktop\/v0\.49\.1-1ma\.123\.1; nothing uploaded/u,
    );
    assert.equal(fake.writes().length, writes);
    assert.deepEqual(filesOf(fake, "desktop-latest"), feeds);
  });

  test("leave only the lost feed to upload", () => {
    const artifacts = build();
    const fake = github({ feeds: OLD_FEEDS });
    publish(artifacts, fake, false);
    const kept = filesOf(fake, "desktop-latest")["server-version.json"];
    fake.state.get("desktop-latest").assets.delete("desktop-version.json");
    const writes = fake.writes().length;
    publish(artifacts, fake, false);
    assert.deepEqual(fake.writes().slice(writes).map(shape), [
      ["release", "upload", "desktop-latest", "desktop-version.json"],
    ]);
    assert.deepEqual(filesOf(fake, "desktop-latest")["server-version.json"], kept);
    assert.equal(announces(fake, "desktop-version.json"), artifacts.version);
  });
});

describe("a pre-release that does not read back complete after the upload", () => {
  for (const [what, write, tamper, found] of [
    ["is a draft", "create", (draft) => (draft.draft = true), "is a draft"],
    [
      "is not a pre-release",
      "create",
      (normal) => (normal.prerelease = false),
      "is not a pre-release; 'gh release edit desktop/v0\\.49\\.1-1ma\\.123\\.1 --prerelease --repo 1ma-ai/1ma' makes it one",
    ],
    [
      "lacks a file",
      "upload",
      (complete) => complete.assets.delete("SHA256SUMS"),
      "SHA256SUMS is missing",
    ],
  ])
    test(`${what}: the feeds stay as they were`, () => {
      const artifacts = build();
      const { dmg } = names(artifacts.version);
      const fake = github({
        feeds: OLD_FEEDS,
        releases:
          write === "upload" ? { [TAG]: { assets: { [dmg]: `dmg ${artifacts.version}` } } } : {},
        meanwhile: (args, state) => {
          if (args[1] === write && args[2] === TAG) tamper(state.get(TAG));
        },
      });
      const feeds = filesOf(fake, "desktop-latest");
      assert.throws(
        () => publish(artifacts, fake, false),
        new RegExp(
          `does not read back as a published pre-release of the build with every file:\\n(.+\\n)*.*${found}\\n(.+\\n)*The feeds in desktop-latest were not touched`,
          "u",
        ),
      );
      assert.deepEqual(feedUploads(fake), []);
      assert.deepEqual(filesOf(fake, "desktop-latest"), feeds);
    });
});

const NEWER = "0.49.1-1ma.124.1";
const NEWER_TAG = `desktop/v${NEWER}`;
const views = (fake, tag) =>
  fake.calls.filter((args) => args[1] === "view" && args[2] === tag).length;
const deletes = (fake) => fake.calls.filter((args) => args[0] === "api" && args[1] === "-X");
// Runs change once, before the first call that answers true to when(args).
const once = (when, change) => {
  let done = false;
  return (args, state) => {
    if (!done && when(args)) {
      done = true;
      change(state, args);
    }
  };
};
const uploadsTo = (tag) => (args) => args[1] === "upload" && args[2] === tag;
const feedOf = (version) => JSON.stringify({ version });

describe("a feed changed by hand while the run acts", () => {
  test("into a newer one after the starter was removed stays, and the run stops", () => {
    let newer;
    const fake = github({
      feeds: { "desktop-version.json": "0.49.1-1ma.100.1", "server-version.json": STARTER },
      releases: { [TAG]: { assets: {} }, [NEWER_TAG]: { draft: true, commit: OTHER } },
      before: once(uploadsTo("desktop-latest"), (state) => {
        state.get(NEWER_TAG).draft = false;
        newer = asset(feedOf(NEWER));
        state.get("desktop-latest").assets.set("server-version.json", newer);
      }),
    });
    assert.throws(
      () => publish(build(), fake, false),
      /only move forward:\n(.+\n)*1ma already published desktop\/v0\.49\.1-1ma\.124\.1/u,
    );
    const kept = fake.state.get("desktop-latest").assets.get("server-version.json");
    assert.equal(kept.id, newer.id);
    assert.equal(kept.content, feedOf(NEWER));
  });

  test("into a newer one while the missing files are uploaded stays, and no feed is uploaded", () => {
    const artifacts = build();
    const { dmg } = names(artifacts.version);
    let newer;
    const fake = github({
      feeds: OLD_FEEDS,
      releases: { [TAG]: { assets: { [dmg]: `dmg ${artifacts.version}` } } },
      meanwhile: (args, state) => {
        if (!uploadsTo(TAG)(args)) return;
        newer = asset(feedOf(NEWER));
        state.get("desktop-latest").assets.set("server-version.json", newer);
      },
    });
    assert.throws(
      () => publish(artifacts, fake, false),
      /only move forward:\ndesktop-latest already announces 0\.49\.1-1ma\.124\.1 in server-version\.json/u,
    );
    assert.equal(fake.state.get("desktop-latest").assets.get("server-version.json").id, newer.id);
    assert.deepEqual(feedUploads(fake), []);
    assert.deepEqual(deletes(fake), []);
  });

  test("whose starter went with a newer build published meanwhile stops on the fresh floor", () => {
    const artifacts = build();
    const fake = github({
      feeds: { "desktop-version.json": "0.49.1-1ma.100.1", "server-version.json": STARTER },
      releases: {
        [TAG]: { assets: everyFile(artifacts.version) },
        [NEWER_TAG]: { draft: true, commit: OTHER },
      },
      before: beforeRemoving((state) => {
        state.get(NEWER_TAG).draft = false;
        state.get("desktop-latest").assets.delete("server-version.json");
      }),
    });
    assert.throws(
      () => publish(artifacts, fake, false),
      /only move forward:\n1ma already published desktop\/v0\.49\.1-1ma\.124\.1/u,
    );
    assert.deepEqual(feedUploads(fake), []);
    assert.equal(fake.state.get("desktop-latest").assets.has("server-version.json"), false);
  });

  test("removed while the pre-release is completed is uploaded again, and the last read finds both", () => {
    const artifacts = build();
    const fake = github({ feeds: OLD_FEEDS });
    publish(artifacts, fake, false);
    fake.state.get(TAG).assets.delete("SHA256SUMS");
    const kept = filesOf(fake, "desktop-latest")["desktop-version.json"];
    const writes = fake.writes().length;
    const gh = fake.gh;
    const rerun = {
      ...fake,
      gh: (args) => {
        const done = gh(args);
        if (done.status === 0 && uploadsTo(TAG)(args))
          fake.state.get("desktop-latest").assets.delete("server-version.json");
        return done;
      },
    };
    const { published, output } = publish(artifacts, rerun, false);
    assert.equal(published, true);
    assert.match(output, /desktop-latest now announces 0\.49\.1-1ma\.123\.1$/u);
    assert.deepEqual(fake.writes().slice(writes).map(shape), [
      ["release", "upload", TAG, "SHA256SUMS"],
      ["release", "upload", "desktop-latest", "server-version.json"],
    ]);
    assert.deepEqual(filesOf(fake, "desktop-latest")["desktop-version.json"], kept);
    assert.equal(announces(fake, "server-version.json"), artifacts.version);
  });

  test("that vanishes before the last read fails the run, naming it", () => {
    const artifacts = build();
    const fake = github({ feeds: OLD_FEEDS });
    publish(artifacts, fake, false);
    const first = fake.calls.length;
    const gh = fake.gh;
    const rerun = {
      ...fake,
      gh: (args) => {
        // The third read of desktop-latest in the rerun is the last one.
        if (
          args[1] === "view" &&
          args[2] === "desktop-latest" &&
          views({ calls: fake.calls.slice(first) }, "desktop-latest") === 2
        )
          fake.state.get("desktop-latest").assets.delete("server-version.json");
        return gh(args);
      },
    };
    assert.throws(
      () => publish(artifacts, rerun, false),
      /the feeds in desktop-latest do not read back as announcing 0\.49\.1-1ma\.123\.1:\nserver-version\.json is missing\nA rerun reads the feeds again and completes them/u,
    );
  });

  test("whose name is taken meanwhile keeps the file that took it, and the run plans again", () => {
    const artifacts = build();
    let taker;
    const fake = github({
      releases: { [TAG]: { assets: everyFile(artifacts.version) } },
      before: once(uploadsTo("desktop-latest"), (state, args) => {
        const file = parse(args).positional.find((part) => part.endsWith("server-version.json"));
        taker = asset(readFileSync(file));
        state.get("desktop-latest").assets.set("server-version.json", taker);
      }),
    });
    const { output } = publish(artifacts, fake, false);
    assert.match(
      output,
      /a file named as one of desktop-version\.json, server-version\.json was attached to desktop-latest meanwhile; reading desktop-latest again/u,
    );
    assert.deepEqual(filesOf(fake, "desktop-latest")["server-version.json"], {
      id: taker.id,
      digest: taker.digest,
      state: "uploaded",
    });
    assert.deepEqual(feedUploads(fake).map(shape).at(-1), [
      "release",
      "upload",
      "desktop-latest",
      "desktop-version.json",
    ]);
    assert.equal(announces(fake, "desktop-version.json"), artifacts.version);
  });

  test("whose name is taken again after the re-plan stops, and the file that took it stays", () => {
    const artifacts = build();
    let taker;
    const fake = github({
      releases: { [TAG]: { assets: everyFile(artifacts.version) } },
      before: (args, state) => {
        if (!uploadsTo("desktop-latest")(args)) return;
        const { assets } = state.get("desktop-latest");
        for (const name of ["desktop-version.json", "server-version.json"])
          if (!assets.has(name)) {
            taker = asset(feedOf("0.49.1-1ma.100.1"));
            assets.set(name, taker);
          }
      },
    });
    assert.throws(
      () => publish(artifacts, fake, false),
      /was attached to desktop-latest meanwhile, also after desktop-latest was read again; a rerun reads it again/u,
    );
    assert.equal(fake.state.get("desktop-latest").assets.get("server-version.json").id, taker.id);
    assert.ok(
      feedUploads(fake).every((args) => !args.includes("--clobber")),
      "no upload goes over a name",
    );
  });
});

// Answers every read of a file at its address as JSON with stdout, or with
// stdout(id) for the id in the address.
const answering = (stdout) => (args) => {
  if (!rereads(args)) return undefined;
  const id = Number(args[1].slice(ASSETS.length));
  return answer(typeof stdout === "function" ? stdout(id) : stdout);
};

describe("the re-read of a file before it is removed", () => {
  const server = names("0.49.1-1ma.123.1").server;
  for (const [what, stdout] of [
    ["an empty object", "{}"],
    ["no state", (id) => JSON.stringify({ id, name: server })],
    ["a state that is not a string", (id) => JSON.stringify({ id, name: server, state: 5 })],
    ["null", "null"],
    ["no JSON", "Bad Gateway"],
  ])
    test(`answering ${what} stops, naming the file, and removes nothing`, () => {
      const artifacts = build();
      const fake = github({
        feeds: OLD_FEEDS,
        releases: { [TAG]: { assets: { [server]: STARTER } } },
        reply: answering(stdout),
      });
      assert.throws(
        () => publish(artifacts, fake, false),
        new RegExp(
          `cannot read the unfinished ${literal(server)} in desktop/v0\\.49\\.1-1ma\\.123\\.1 again`,
          "u",
        ),
      );
      assert.deepEqual(fake.writes(), []);
      assert.equal(views(fake, TAG), 2);
    });

  for (const [what, stdout] of [
    ["another id", (id) => JSON.stringify({ id: id + 1000, name: server, state: "starter" })],
    ["another name", (id) => JSON.stringify({ id, name: "other.tgz", state: "starter" })],
    ["a finished file", (id) => JSON.stringify({ id, name: server, state: "uploaded" })],
    ["a state GitHub does not name", (id) => JSON.stringify({ id, name: server, state: "gone" })],
  ])
    test(`answering ${what} plans again and removes nothing`, () => {
      const artifacts = build();
      const fake = github({
        feeds: OLD_FEEDS,
        releases: { [TAG]: { assets: { [server]: STARTER } } },
        reply: answering(stdout),
      });
      assert.throws(
        () => publish(artifacts, fake, false),
        new RegExp(
          `the unfinished ${literal(server)} in desktop/v0\\.49\\.1-1ma\\.123\\.1 changed meanwhile, also after`,
          "u",
        ),
      );
      assert.deepEqual(fake.writes(), []);
      assert.equal(views(fake, TAG), 3);
    });

  test("of a feed with other bytes answering another digest plans again and removes nothing", () => {
    const artifacts = build();
    const fake = github({
      feeds: OLD_FEEDS,
      releases: { [TAG]: { assets: everyFile(artifacts.version) } },
      reply: (args) => {
        if (!rereads(args)) return undefined;
        const id = Number(args[1].slice(ASSETS.length));
        return answer(
          JSON.stringify({
            id,
            name: "desktop-version.json",
            state: "uploaded",
            digest: "sha256:0",
          }),
        );
      },
    });
    assert.throws(
      () => publish(artifacts, fake, false),
      /desktop-version\.json in desktop-latest changed meanwhile, also after desktop-latest was read again/u,
    );
    assert.deepEqual(fake.writes(), []);
  });
});

describe("a file in a state GitHub does not name", () => {
  test("stops both modes before any write, in the release of the tag and in desktop-latest", () => {
    const artifacts = build();
    const { server } = names(artifacts.version);
    refused(
      artifacts,
      github({
        feeds: OLD_FEEDS,
        releases: { [TAG]: { assets: { [server]: { state: "gone" } } } },
      }),
      new RegExp(
        `desktop/v0\\.49\\.1-1ma\\.123\\.1 has ${literal(server)} in the state gone, which is neither uploaded nor unfinished`,
        "u",
      ),
    );
    refused(
      artifacts,
      github({
        feeds: {
          "desktop-version.json": "0.49.1-1ma.100.1",
          "server-version.json": { state: "gone" },
        },
      }),
      /desktop-latest has server-version\.json in the state gone, which is neither uploaded nor unfinished/u,
    );
  });
});

describe("a tag moved after the first read", () => {
  test("before the missing files are uploaded leaves the pre-release untouched, naming the commit", () => {
    const artifacts = build();
    const { dmg } = names(artifacts.version);
    const fake = github({
      feeds: OLD_FEEDS,
      releases: { [TAG]: { assets: { [dmg]: `dmg ${artifacts.version}` } } },
    });
    fake.gh = ((gh) => (args) => {
      if (args[1] === "list") fake.tags.get(TAG).commit = OTHER;
      return gh(args);
    })(fake.gh);
    assert.throws(
      () => publish(artifacts, fake, false),
      /desktop\/v0\.49\.1-1ma\.123\.1 points at b{40}, not at the build commit a{40}/u,
    );
    assert.deepEqual(fake.writes(), []);
    assert.deepEqual(Object.keys(filesOf(fake, TAG)), [dmg]);
  });

  test("right before the re-plan of an unfinished file stops it the same way", () => {
    const artifacts = build();
    const { server } = names(artifacts.version);
    const fake = unfinishedServer(
      artifacts,
      beforeRemoving((state) => state.get(TAG).assets.delete(server)),
    );
    fake.gh = ((gh) => (args) => {
      if (rereads(args)) fake.tags.get(TAG).commit = OTHER;
      return gh(args);
    })(fake.gh);
    assert.throws(
      () => publish(artifacts, fake, false),
      /desktop\/v0\.49\.1-1ma\.123\.1 points at b{40}, not at the build commit a{40}/u,
    );
    assert.deepEqual(fake.writes(), []);
  });
});

describe("a dry run", () => {
  test("reads every file it would remove at its address, and removes and uploads nothing", () => {
    const artifacts = build();
    const { server } = names(artifacts.version);
    const other = Buffer.from(JSON.stringify({ version: "0.49.1-1ma.100.1", by: "hand" }));
    const fake = github({
      feeds: { "desktop-version.json": other, "server-version.json": STARTER },
      releases: { [TAG]: { assets: { [server]: STARTER } } },
    });
    const files = [filesOf(fake, TAG)[server], ...Object.values(filesOf(fake, "desktop-latest"))];
    const { output } = publish(artifacts, fake, true);
    for (const { id } of files)
      assert.ok(fake.calls.some((args) => args.length === 2 && args[1] === `${ASSETS}${id}`));
    assert.match(output, /desktop-latest has a different desktop-version\.json; would replace it/u);
    assert.match(
      output,
      /desktop-latest has an unfinished server-version\.json \(state starter\), counted as lost; would remove it and upload it again/u,
    );
    assert.deepEqual(fake.writes(), []);
  });

  test("stops on an unreadable answer at the address of a file it would remove", () => {
    const fake = github({
      feeds: { "desktop-version.json": "0.49.1-1ma.123.1", "server-version.json": STARTER },
      reply: (args) => (rereads(args) ? answer("{}") : undefined),
    });
    assert.throws(
      () => publish(build(), fake, true),
      /cannot read the unfinished server-version\.json in desktop-latest again: GitHub answered no file/u,
    );
    assert.deepEqual(fake.writes(), []);
  });
});

describe("the bytes of a feed", () => {
  test("read at its address without its checksum stop both modes", () => {
    refused(
      build(),
      github({
        feeds: OLD_FEEDS,
        reply: (args) =>
          args[0] === "api" && args[1] === "-H"
            ? answer('{"version":"0.49.1-1ma.999.1"}')
            : undefined,
      }),
      /GitHub gave other bytes for desktop-version\.json in desktop-latest than its checksum sha256:/u,
    );
  });
});

describe("a rerun of a complete publication", () => {
  test("writes nothing and reads both pictures, each again before acting, and the feeds last", () => {
    const artifacts = build();
    const fake = github({ feeds: OLD_FEEDS });
    publish(artifacts, fake, false);
    const first = fake.calls.length;
    const feeds = filesOf(fake, "desktop-latest");
    const bytes = ["desktop-version.json", "server-version.json"].map((name) => [
      "api",
      "-H",
      "Accept: application/octet-stream",
      `${ASSETS}${feeds[name].id}`,
    ]);
    const tag = ["api", `repos/${REPO}/git/ref/tags/${TAG}`];
    const own = ["release", "view", TAG];
    const latest = ["release", "view", "desktop-latest"];
    const list = ["release", "list"];
    publish(artifacts, fake, false);
    assert.deepEqual(fake.calls.slice(first).map(shape), [
      tag,
      own,
      latest,
      list,
      ...bytes,
      tag,
      own,
      own,
      tag,
      latest,
      list,
      ...bytes,
      latest,
    ]);
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
