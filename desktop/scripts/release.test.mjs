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
  (group === "release" && ["view", "download", "list"].includes(action)) || group === "api";

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
// commit unless tags names one. refuse(args) may answer an error for a call
// before it is carried out; breaks(args) may answer { after, keepDraft } for a
// create or upload that stores `after` files, leaves the next one unfinished
// and fails, as an upload GitHub answers with 502; meanwhile(args, state) runs
// after a write that succeeded.
function github({
  tags = {},
  releases = {},
  feeds = {},
  latest = true,
  latestDraft = false,
  refuse = () => undefined,
  breaks = () => undefined,
  meanwhile = () => undefined,
} = {}) {
  const tagged = new Map(
    Object.entries(tags).map(([name, value]) => [
      name,
      typeof value === "string" ? { commit: value, annotated: false } : value,
    ]),
  );
  const state = new Map(
    Object.entries(releases).map(([tag, { commit = COMMIT, draft = false, assets = {} }]) => {
      if (!draft && !tagged.has(tag)) tagged.set(tag, { commit, annotated: false });
      return [tag, { commit, draft, assets: stored(assets) }];
    }),
  );
  if (latest)
    state.set("desktop-latest", {
      commit: OTHER,
      draft: latestDraft,
      assets: new Map(
        Object.entries(feeds).map(([name, version]) => [
          name,
          asset(typeof version === "string" ? JSON.stringify({ version }) : version),
        ]),
      ),
    });
  const calls = [];

  const carry = (args) => {
    const { positional, flags } = parse(args);
    const [group, action, tag, ...files] = positional;
    if (group === "api") {
      const route = action.slice(`repos/${REPO}/`.length);
      const notFound = error("gh: Not Found (HTTP 404)", '{"message":"Not Found","status":"404"}');
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
    if (action === "list") return answer([...state.keys()].map((name) => `${name}\n`).join(""));
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
          assets: [...target.assets].map(([name, { digest, state: stage }]) => ({
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
      const taken = files.filter((file) => target.assets.has(path.basename(file)));
      if (taken.length > 0 && !clobber) return error("asset under the same name already exists");
      return store(target, files, breaks(args), clobber) ? answer("") : error(BAD_GATEWAY);
    }
    if (action === "delete-asset") {
      assert.deepEqual(flags["--yes"], [true]);
      if (!target.assets.delete(files[0])) return error(`asset ${files[0]} not found in ${tag}`);
      return answer("");
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };

  const gh = (args) => {
    calls.push(args);
    const refusal = refuse(args);
    if (refusal !== undefined) return error(refusal);
    const done = carry(args);
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
    const { output } = publish(artifacts, fake, false);
    assert.match(
      output,
      new RegExp(`removed the unfinished ${literal(server)} \\(state starter\\)`),
    );
    assert.deepEqual(
      fake
        .writes()
        .slice(writes)
        .map((args) => parse(args).positional.slice(0, 3)),
      [
        ["release", "delete-asset", TAG],
        ["release", "upload", TAG],
        ["release", "upload", "desktop-latest"],
      ],
    );
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

    broken = false;
    const writes = fake.writes().length;
    assert.match(
      publish(artifacts, fake, true).output,
      /desktop-latest has an unfinished server-version\.json \(state starter\), counted as lost; would remove it/u,
    );
    assert.equal(fake.writes().length, writes);
    publish(artifacts, fake, false);
    assert.deepEqual(
      fake
        .writes()
        .slice(writes)
        .map((args) => parse(args).positional.map((part) => path.basename(part))),
      [
        ["release", "delete-asset", "desktop-latest", "server-version.json"],
        ["release", "upload", "desktop-latest", "desktop-version.json", "server-version.json"],
      ],
    );
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

describe("a pre-release that does not read back complete after the upload", () => {
  for (const [what, write, tamper, found] of [
    ["is a draft", "create", (draft) => (draft.draft = true), "is a draft"],
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
