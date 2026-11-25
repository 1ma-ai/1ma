// Publishes one Desktop build as the pre-release desktop/v<version> and then
// points the feeds in the desktop-latest release at it. Everything that can be
// checked without writing is checked before the first write, and a dry run
// stops right before it: a publication of the same inputs after a passing dry
// run fails only on what changed in the releases meanwhile or on a write
// GitHub refuses.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFeedsMoveForward, compareVersions } from "./version.mjs";

const FEEDS = "desktop-latest";
const MAIN = "refs/heads/main";
const SUMS = "SHA256SUMS";

export class ReleaseError extends Error {}

function fail(message) {
  throw new ReleaseError(message);
}

export function sha256File(file) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  const descriptor = openSync(file, "r");
  try {
    for (let read; (read = readSync(descriptor, buffer, 0, buffer.length, null)) > 0;)
      hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

// What `sha256sum -- *` writes in the folder. The runner's locale is C.UTF-8,
// where the glob sorts names by code point, as sort() does for these names.
export function sumsOf(folder) {
  return readdirSync(folder)
    .filter((name) => !name.startsWith("."))
    .toSorted()
    .map((name) => `${sha256File(path.join(folder, name))}  ${name}\n`)
    .join("");
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return fail(`cannot read ${file}: ${error.message}`);
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isVersion(version) {
  try {
    return typeof version === "string" && compareVersions(version, version) === 0;
  } catch {
    return false;
  }
}

const said = (done) => (done.stderr ?? "").trim();

function notes(version, upstream, commit) {
  return `Test build of 1ma ${version} for macOS on Apple Silicon, built from bb ${upstream} with the 1ma patches at ${commit}. Download the .dmg; SHA256SUMS lists the checksums.

1ma-server-${version}.tgz is the 1ma server for Linux from the same commit (bb's bb-app package with the 1ma patches and rebrand; the command keeps the name bb-app for now). Install it with npm install <file> in an empty folder and start node_modules/.bin/bb-app with Node 24. It updates itself from the releases of this repository; ONEMA_UPDATE_COMMAND_PREFIX runs its npm install under a wrapper, such as a resource limit. Builds older than 0.49.1 install bb from npm instead and must be started with --no-in-app-updates.

The build is signed ad hoc, not by Apple yet. First launch: open 1ma once, then System Settings > Privacy & Security > Open Anyway, and enter your password. macOS treats every test build as a new app, so it asks again after each update, also for permissions such as the microphone.

Quit bb completely before opening 1ma: both use port 38886. 1ma keeps its data in ~/.1ma, separate from bb.
`;
}

// gh is called as gh(args) and answers { status, stdout, stderr }.
// The workflow file and this tool come from the branch the run was started on,
// so only a run on main publishes by main's rules. A dry run writes nothing and
// may try another branch's version of them.
export function release({
  runId,
  commit,
  dryRun,
  ref,
  repository,
  dist,
  distServer,
  work,
  gh,
  log,
}) {
  if (!dryRun && ref !== MAIN)
    fail(
      `a publication is started from main; this run is at ${ref}. Only a dry run may start from another branch`,
    );
  if (!/^[0-9]+$/u.test(runId ?? "")) fail("run_id must be a run number");
  if (!/^[0-9a-f]{40}$/u.test(commit ?? "")) fail(`run ${runId} has no build commit`);
  const records = [dist, distServer].map((folder) => {
    const file = path.join(folder, "1ma-provenance.json");
    return { file, record: readJson(file) };
  });
  for (const { file, record } of records) {
    if (record.oneMaCommit !== commit)
      fail(
        `${file} says it was built from '${record.oneMaCommit}', but run ${runId} built ${commit}`,
      );
  }
  const app = path.join(dist, "apps", "desktop", "release");
  const { version } = readJson(path.join(app, "desktop-version.json"));
  if (!isVersion(version)) fail(`unexpected version '${version}'`);
  if (!version.includes(`-1ma.${runId}.`))
    fail(`run ${runId} built version '${version}', which does not name the run`);
  for (const { file, record } of records) {
    if (record.version !== version)
      fail(`${file} is for version ${record.version}, not ${version}`);
  }
  const upstream = records[0].record.upstream?.tag;
  if (typeof upstream !== "string" || upstream === "")
    fail(`${records[0].file} names no bb release`);
  const tag = `desktop/v${version}`;

  mkdirSync(work, { recursive: true });
  if (readdirSync(work).length > 0) fail(`the work folder ${work} is not empty`);
  const upload = path.join(work, "upload");
  const feeds = path.join(work, "feeds");
  const announced = path.join(work, "announced");
  for (const folder of [upload, feeds, announced]) mkdirSync(folder);
  const appFiles = readdirSync(app).filter((name) => isFile(path.join(app, name)));
  for (const extension of [".dmg", ".zip"]) {
    const found = appFiles.filter((name) => name.endsWith(extension));
    if (found.length === 0) fail(`run ${runId} has no ${extension} of the macOS app`);
    for (const name of found) copyFileSync(path.join(app, name), path.join(upload, name));
  }
  const server = path.join(distServer, `1ma-server-${version}.tgz`);
  if (!isFile(server)) fail(`run ${runId} has no Linux server package for ${version}`);
  copyFileSync(server, path.join(upload, path.basename(server)));
  const sums = sumsOf(upload);
  writeFileSync(path.join(upload, SUMS), sums);
  const files = readdirSync(upload).toSorted();

  copyFileSync(path.join(app, "desktop-version.json"), path.join(feeds, "desktop-version.json"));
  const serverFeed = `${JSON.stringify(
    {
      schemaVersion: 1,
      channel: "latest",
      version,
      release: tag,
      package: `1ma-server-${version}.tgz`,
      commit,
      bb: upstream,
    },
    null,
    2,
  )}\n`;
  writeFileSync(path.join(feeds, "server-version.json"), serverFeed);
  const notesFile = path.join(work, "notes.md");
  writeFileSync(notesFile, notes(version, upstream, commit));

  // Fails on any error other than a missing release, so a dry run cannot pass
  // on a check that never ran.
  const view = gh(["release", "view", tag, "--json", "assets", "--repo", repository]);
  let published = null;
  if (view.status === 0) {
    const tagged = gh(["api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"]);
    if (tagged.status !== 0) fail(`cannot read the commit of ${tag}: ${said(tagged)}`);
    const sha = tagged.stdout.trim();
    if (sha !== commit) fail(`${tag} points at ${sha}, not at the build commit ${commit}`);
    let assets;
    try {
      ({ assets } = JSON.parse(view.stdout));
    } catch (error) {
      fail(`cannot read the files of ${tag}: ${error.message}`);
    }
    published = new Map(assets.map(({ name, digest }) => [name, digest]));
  } else if (!said(view).includes("release not found")) {
    fail(`cannot read release ${tag}: ${said(view)}`);
  }
  // A published file is never replaced: one that is already there must be the
  // same file, and the missing ones are uploaded only when none differs.
  const missing = [];
  for (const name of published === null ? [] : files) {
    if (!published.has(name)) missing.push(name);
    else if (published.get(name) !== `sha256:${sha256File(path.join(upload, name))}`)
      fail(`${tag} already has a different ${name}; refusing to replace a published file`);
  }

  // The feeds only move forward: an older run never replaces a newer one.
  // Every feed this run replaces is checked, since a release that failed
  // halfway can leave one feed ahead of another.
  // A feed can be lost by a failed upload (--clobber removes the old file
  // first); a published release cannot, so the newest release tag is the
  // floor as well.
  const feedFiles = readdirSync(feeds).toSorted();
  const download = gh([
    "release",
    "download",
    FEEDS,
    ...feedFiles.flatMap((name) => ["--pattern", name]),
    "--dir",
    announced,
    "--repo",
    repository,
  ]);
  if (download.status !== 0) {
    if (said(download).includes("release not found"))
      fail(`the ${FEEDS} release is missing; a maintainer creates it once (desktop/README.md)`);
    if (!/no assets (match|to download)/u.test(said(download)))
      fail(`cannot read ${FEEDS}: ${said(download)}`);
  }
  const list = gh([
    "release",
    "list",
    "--limit",
    "1000",
    "--json",
    "tagName",
    "--jq",
    ".[].tagName",
    "--repo",
    repository,
  ]);
  if (list.status !== 0) fail(`cannot list the published releases: ${said(list)}`);
  try {
    checkFeedsMoveForward(version, announced, list.stdout.split("\n").filter(Boolean));
  } catch (error) {
    fail(`the feeds in ${FEEDS} only move forward:\n${error.message}`);
  }

  if (dryRun) {
    log(`dry run: would publish ${tag} at ${commit} with:`);
    log(sums.trimEnd());
    if (published !== null)
      log(
        missing.length === 0
          ? `${tag} already holds all of them`
          : `${tag} already exists; would upload ${missing.join(", ")}`,
      );
    log(`and point ${FEEDS} at it:`);
    log(serverFeed.trimEnd());
    return { tag, published: false };
  }

  const write = (args, what) => {
    const done = gh([...args, "--repo", repository]);
    if (done.status !== 0) fail(`${what}: ${said(done)}`);
  };
  const paths = (names) => names.map((name) => path.join(upload, name));
  if (published === null) {
    // GITHUB_TOKEN may not create a release on a commit that changes workflow
    // files (HTTP 403). A maintainer then creates the pre-release with the tag
    // at the build commit, and a rerun uploads the files into it.
    write(
      [
        "release",
        "create",
        tag,
        "--prerelease",
        "--target",
        commit,
        "--title",
        `1ma ${version}`,
        "--notes-file",
        notesFile,
        ...paths(files),
      ],
      `cannot create the pre-release ${tag}`,
    );
  } else if (missing.length > 0) {
    write(
      ["release", "upload", tag, ...paths(missing)],
      `cannot upload ${missing.join(", ")} to ${tag}`,
    );
  }
  log(`published ${tag}`);
  write(
    ["release", "upload", FEEDS, ...feedFiles.map((name) => path.join(feeds, name)), "--clobber"],
    `cannot upload the feeds to ${FEEDS}`,
  );
  log(`${FEEDS} now announces ${version}`);
  return { tag, published: true };
}

function required(env, name) {
  const value = env[name];
  if (value === undefined || value === "") fail(`${name} is not set`);
  return value;
}

export function fromEnvironment(env) {
  const flag = env.DRY_RUN;
  if (flag !== "true" && flag !== "false")
    fail(`DRY_RUN must be true or false, got '${flag ?? ""}'`);
  return {
    runId: required(env, "RUN_ID"),
    commit: required(env, "COMMIT"),
    dryRun: flag === "true",
    ref: required(env, "GITHUB_REF"),
    repository: required(env, "GITHUB_REPOSITORY"),
    dist: required(env, "DIST"),
    distServer: required(env, "DIST_SERVER"),
    work: required(env, "WORK"),
  };
}

function runGh(args) {
  const done = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    status: done.status ?? 1,
    stdout: done.stdout ?? "",
    stderr: done.error === undefined ? done.stderr : done.error.message,
  };
}

// A workflow command keeps a message of several lines in one annotation.
const annotation = (message) =>
  message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    release({ ...fromEnvironment(process.env), gh: runGh, log: console.log });
  } catch (error) {
    console.log(`::error::${annotation(error.message)}`);
    process.exitCode = 1;
  }
}
