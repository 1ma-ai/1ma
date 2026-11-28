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

// gh ends the message of a failed API call with the HTTP status; a status
// quoted earlier in the text is GitHub's wording, not the answer.
const notFound = (done) => said(done).endsWith("(HTTP 404)");

const UPLOADED = "uploaded";

// The commit refs/tags/<tag> points at, through annotated tags, or null when
// there is no such tag. Read as a tag, so a branch of the same name cannot
// answer.
function readTag(gh, repository, tag) {
  let found = gh(["api", `repos/${repository}/git/ref/tags/${tag}`]);
  if (found.status !== 0) {
    if (notFound(found)) return null;
    fail(`cannot read the tag ${tag}: ${said(found)}`);
  }
  for (;;) {
    let object;
    try {
      ({ object } = JSON.parse(found.stdout));
    } catch (error) {
      fail(`cannot read the tag ${tag}: ${error.message}`);
    }
    if (!/^[0-9a-f]{40}$/u.test(String(object?.sha)))
      fail(`cannot read the tag ${tag}: GitHub names no object it points at`);
    if (object.type === "commit") return object.sha;
    if (object.type !== "tag") fail(`${tag} points at a ${object.type}, not at a commit`);
    found = gh(["api", `repos/${repository}/git/tags/${object.sha}`]);
    if (found.status !== 0) fail(`cannot read the tag ${tag}: ${said(found)}`);
  }
}

// The release under the tag, draft or not, with its files by name, or null
// when there is none.
function readRelease(gh, repository, tag) {
  const view = gh([
    "release",
    "view",
    tag,
    "--json",
    "isDraft,isPrerelease,assets",
    "--repo",
    repository,
  ]);
  if (view.status !== 0) {
    if (said(view).includes("release not found")) return null;
    fail(`cannot read release ${tag}: ${said(view)}`);
  }
  try {
    const { isDraft, isPrerelease, assets } = JSON.parse(view.stdout);
    return {
      draft: isDraft === true,
      prerelease: isPrerelease === true,
      assets: new Map(
        assets.map(({ name, digest, state, apiUrl }) => [name, { digest, state, address: apiUrl }]),
      ),
    };
  } catch (error) {
    return fail(`cannot read the files of ${tag}: ${error.message}`);
  }
}

// The tags of the releases that are not drafts: a draft was never public.
function readPublishedTags(gh, repository) {
  const list = gh([
    "release",
    "list",
    "--limit",
    "1000",
    "--json",
    "tagName,isDraft",
    "--repo",
    repository,
  ]);
  if (list.status !== 0) fail(`cannot list the published releases: ${said(list)}`);
  let entries;
  try {
    entries = JSON.parse(list.stdout);
  } catch (error) {
    fail(`cannot list the published releases: ${error.message}`);
  }
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry?.tagName !== "string"))
    fail("cannot list the published releases: GitHub names no tag of one");
  return entries.filter((entry) => entry.isDraft !== true).map((entry) => entry.tagName);
}

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
  attempt,
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
  if (!/^[0-9]+$/u.test(attempt ?? "")) fail(`run ${runId} has no attempt number`);
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
  // The green result checked is the run's latest attempt, while GitHub may
  // hand over the artifacts of an earlier one.
  const built = new RegExp(`-1ma\\.${runId}\\.([0-9]+)$`, "u").exec(version);
  if (built === null) fail(`run ${runId} built version '${version}', which does not name the run`);
  if (built[1] !== attempt)
    fail(
      `run ${runId} is at attempt ${attempt}, but the files are of attempt ${built[1]} (version ${version}); rerun all jobs of the build, or start a new build, and publish that`,
    );
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
  for (const folder of [upload, feeds]) mkdirSync(folder);
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

  // Every read fails on any error other than a missing tag or release, so a
  // dry run cannot pass on a check that never ran.
  const digests = new Map(
    files.map((name) => [name, `sha256:${sha256File(path.join(upload, name))}`]),
  );
  const tagged = readTag(gh, repository, tag);
  if (tagged !== null && tagged !== commit)
    fail(`${tag} points at ${tagged}, not at the build commit ${commit}`);
  const prerelease = `'gh release edit ${tag} --prerelease --repo ${repository}'`;
  const readOwn = () => {
    const found = readRelease(gh, repository, tag);
    if (found?.draft)
      fail(
        `${tag} is a draft release, left by an interrupted publication and never public; delete it with 'gh release delete ${tag} --yes --repo ${repository}', then run again`,
      );
    if (found !== null && !found.prerelease)
      fail(
        `${tag} is a release, not a pre-release; a maintainer makes it one with ${prerelease}, then runs again`,
      );
    return found;
  };
  const published = readOwn();
  if (published !== null && tagged === null) fail(`release ${tag} has no tag refs/tags/${tag}`);
  // An unfinished file is removed later by the address it was read at, which
  // names that file and not a later one of the same name.
  const unfinishedOf = (from, name, { state, address }) => {
    const prefix = `https://api.github.com/repos/${repository}/releases/assets/`;
    if (
      typeof address !== "string" ||
      !address.startsWith(prefix) ||
      !/^[0-9]+$/u.test(address.slice(prefix.length))
    )
      fail(`${from} has an unfinished ${name} without the address of it`);
    return { name, state, address };
  };
  // A published file is never replaced: one that is already there must be the
  // same file, and the missing ones are uploaded only when none differs. A
  // file GitHub did not finish storing was never published: it is removed and
  // uploaded again.
  const planRelease = (found) => {
    const pending = [];
    const unfinished = [];
    for (const name of files) {
      const file = found.assets.get(name);
      if (file === undefined) pending.push(name);
      else if (file.state !== UPLOADED) {
        unfinished.push(unfinishedOf(tag, name, file));
        pending.push(name);
      } else if (typeof file.digest !== "string")
        fail(
          `${tag} already has ${name} without a digest to compare; refusing to replace a published file`,
        );
      else if (file.digest !== digests.get(name))
        fail(`${tag} already has a different ${name}; refusing to replace a published file`);
    }
    return { pending, unfinished };
  };
  let own = published === null ? null : planRelease(published);

  // The feeds only move forward: an older run never replaces a newer one.
  // Every feed this run replaces is checked, since a release that failed
  // halfway can leave one feed ahead of another.
  // A feed can be lost by a failed upload (--clobber removes the old file
  // first, and an upload may stop unfinished); a published release cannot, so
  // the newest release tag is the floor as well.
  const readFeeds = () => {
    const found = readRelease(gh, repository, FEEDS);
    if (found === null)
      fail(`the ${FEEDS} release is missing; a maintainer creates it once (desktop/README.md)`);
    if (found.draft)
      fail(
        `the ${FEEDS} release is a draft, which nobody can download; a maintainer publishes it with 'gh release edit ${FEEDS} --draft=false --prerelease --repo ${repository}', then runs again`,
      );
    return found;
  };
  const latest = readFeeds();
  const publishedTags = readPublishedTags(gh, repository);
  const feedFiles = readdirSync(feeds).toSorted();
  let reads = 0;
  // A feed that already holds the bytes to write is left alone, so a rerun
  // of a finished publication does not risk a working feed.
  const planFeeds = (found) => {
    const announced = path.join(work, `announced-${(reads += 1)}`);
    mkdirSync(announced);
    const unfinished = [];
    const current = [];
    for (const name of feedFiles) {
      const file = found.assets.get(name);
      if (file === undefined) continue;
      if (file.state === UPLOADED) current.push(name);
      else unfinished.push(unfinishedOf(FEEDS, name, file));
    }
    if (current.length > 0) {
      const download = gh([
        "release",
        "download",
        FEEDS,
        ...current.flatMap((name) => ["--pattern", name]),
        "--dir",
        announced,
        "--repo",
        repository,
      ]);
      if (download.status !== 0) fail(`cannot read ${FEEDS}: ${said(download)}`);
    }
    try {
      checkFeedsMoveForward(version, announced, publishedTags);
    } catch (error) {
      fail(`the feeds in ${FEEDS} only move forward:\n${error.message}`);
    }
    const stale = feedFiles.filter(
      (name) =>
        !current.includes(name) ||
        !readFileSync(path.join(announced, name)).equals(readFileSync(path.join(feeds, name))),
    );
    return { unfinished, stale };
  };
  let announcing = planFeeds(latest);

  if (dryRun) {
    log(`dry run: would publish ${tag} at ${commit} from attempt ${attempt} of run ${runId} with:`);
    log(sums.trimEnd());
    if (published === null && tagged !== null)
      log(`${tag} exists at the build commit; would create the pre-release on it`);
    if (own !== null) {
      for (const { name, state } of own.unfinished)
        log(
          `${tag} has an unfinished ${name} (state ${state}); would remove it and upload it again`,
        );
      log(
        own.pending.length === 0
          ? `${tag} already holds all of them`
          : `${tag} already exists; would upload ${own.pending.join(", ")}`,
      );
    }
    for (const { name, state } of announcing.unfinished)
      log(`${FEEDS} has an unfinished ${name} (state ${state}), counted as lost; would remove it`);
    if (announcing.stale.length === 0) log(`the feeds in ${FEEDS} already point at it`);
    else {
      log(`and point ${FEEDS} at it:`);
      log(serverFeed.trimEnd());
    }
    return { tag, published: false };
  }

  const write = (args, what) => {
    const done = gh([...args, "--repo", repository]);
    if (done.status !== 0) fail(`${what}: ${said(done)}`);
  };
  // Removes the file only while its address still answers with an unfinished
  // upload; false when it was finished or removed meanwhile.
  const removed = (from, { name, address }) => {
    const now = gh(["api", address]);
    if (now.status !== 0) {
      if (notFound(now)) return false;
      fail(`cannot read the unfinished ${name} in ${from} again: ${said(now)}`);
    }
    let state;
    try {
      ({ state } = JSON.parse(now.stdout));
    } catch (error) {
      fail(`cannot read the unfinished ${name} in ${from} again: ${error.message}`);
    }
    if (state === UPLOADED) return false;
    const done = gh(["api", "-X", "DELETE", address]);
    if (done.status !== 0) {
      if (notFound(done)) return false;
      fail(`cannot remove the unfinished ${name} (state ${state}) from ${from}: ${said(done)}`);
    }
    log(`removed the unfinished ${name} (state ${state}) from ${from}`);
    return true;
  };
  // A file that changed meanwhile makes the plan be made anew from a fresh
  // read, by the same rules; a second change stops the run.
  const clear = (from, plan, replan) => {
    for (let again = false; ; again = true) {
      const changed = plan.unfinished.find((file) => !removed(from, file));
      if (changed === undefined) return plan;
      if (again)
        fail(
          `the unfinished ${changed.name} in ${from} changed meanwhile, also after ${from} was read again; a rerun reads it again`,
        );
      log(`the unfinished ${changed.name} in ${from} changed meanwhile; reading ${from} again`);
      plan = replan();
    }
  };
  const paths = (names) => names.map((name) => path.join(upload, name));
  if (published === null) {
    // GITHUB_TOKEN may not create a release on a commit that changes workflow
    // files (HTTP 403). A maintainer then pushes the tag at the build commit
    // and either creates the pre-release on it or runs this again, which
    // creates it there.
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
  } else {
    own = clear(tag, own, () => {
      const found = readOwn();
      if (found === null) fail(`release ${tag} was deleted meanwhile; a rerun creates it`);
      return planRelease(found);
    });
    if (own.pending.length > 0)
      write(
        ["release", "upload", tag, ...paths(own.pending)],
        `cannot upload ${own.pending.join(", ")} to ${tag}`,
      );
  }

  // The feeds announce only a public pre-release that holds every file.
  const problems = [];
  const after = readRelease(gh, repository, tag);
  const afterTag = readTag(gh, repository, tag);
  if (afterTag !== commit)
    problems.push(afterTag === null ? `there is no tag ${tag}` : `${tag} points at ${afterTag}`);
  if (after === null) problems.push(`there is no release ${tag}`);
  else {
    if (after.draft) problems.push(`${tag} is a draft`);
    else if (!after.prerelease)
      problems.push(`${tag} is not a pre-release; ${prerelease} makes it one`);
    for (const name of files) {
      const found = after.assets.get(name);
      if (found === undefined) problems.push(`${name} is missing`);
      else if (found.state !== UPLOADED)
        problems.push(`${name} is not fully uploaded (state ${found.state})`);
      else if (found.digest !== digests.get(name))
        problems.push(`${name} has the digest ${found.digest}, not ${digests.get(name)}`);
    }
  }
  if (problems.length > 0)
    fail(
      `${tag} does not read back as a published pre-release of the build with every file:\n${problems.join("\n")}\nThe feeds in ${FEEDS} were not touched; a rerun checks the release again`,
    );
  log(`published ${tag}`);
  announcing = clear(FEEDS, announcing, () => planFeeds(readFeeds()));
  if (announcing.stale.length === 0) {
    log(`the feeds in ${FEEDS} already point at ${tag}; nothing uploaded`);
    return { tag, published: true };
  }
  write(
    [
      "release",
      "upload",
      FEEDS,
      ...announcing.stale.map((name) => path.join(feeds, name)),
      "--clobber",
    ],
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
    attempt: required(env, "ATTEMPT"),
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
