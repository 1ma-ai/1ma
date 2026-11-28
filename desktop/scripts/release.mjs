// Publishes one Desktop build as the pre-release desktop/v<version> and then
// points the feeds in the desktop-latest release at it. A dry run goes the
// same way and leaves the writes out, so a publication of the same inputs
// after a passing dry run fails only on what changed in the releases
// meanwhile, on what the dry run could not read because it follows an upload
// into the release of the tag, or on a write GitHub refuses. GitHub has no
// transaction over several calls, so each group of writes acts on a picture
// read right before it, a file is removed only as the object that was judged,
// no upload goes over a name, and what the feeds announce is checked as a
// whole right before the first write to them and in the last read, which
// alone says success.
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

// gh's own refusal of an upload without --clobber onto a name the release
// holds, and GitHub's when the name was taken after gh read the release.
const nameTaken = (done) => {
  const [first, ...rest] = said(done).split("\n");
  return (
    (rest.length === 0 && first.startsWith("asset under the same name already exists: [")) ||
    (first.startsWith("HTTP 422: ") && rest.includes("ReleaseAsset.name already exists"))
  );
};

const UPLOADED = "uploaded";
// GitHub's REST description names the state "open"; its upload endpoint says
// a failed upload may leave an empty file in the state "starter".
const UNFINISHED = new Set(["starter", "open"]);

const what = ({ name, state }) => (state === UPLOADED ? name : `the unfinished ${name}`);

const sha256Of = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

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
    "databaseId,isDraft,isPrerelease,assets",
    "--repo",
    repository,
  ]);
  if (view.status !== 0) {
    if (said(view).includes("release not found")) return null;
    fail(`cannot read release ${tag}: ${said(view)}`);
  }
  let read;
  try {
    read = JSON.parse(view.stdout);
  } catch (error) {
    fail(`cannot read the files of ${tag}: ${error.message}`);
  }
  if (!Number.isInteger(read?.databaseId))
    fail(`cannot read release ${tag}: GitHub names no id of it`);
  try {
    const { databaseId, isDraft, isPrerelease, assets } = read;
    return {
      id: databaseId,
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
  // Holds no feed, for the floor of the published releases alone.
  const noFeeds = path.join(work, "no-feeds");
  for (const folder of [upload, feeds, noFeeds]) mkdirSync(folder);
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
  const readBuild = () => {
    const tagged = readTag(gh, repository, tag);
    if (tagged !== null && tagged !== commit)
      fail(`${tag} points at ${tagged}, not at the build commit ${commit}`);
    const found = readOwn();
    if (found !== null && tagged === null) fail(`release ${tag} has no tag refs/tags/${tag}`);
    return { tagged, found };
  };
  // A file that may be removed is judged with the address it was read at,
  // which names that file and not a later one of the same name. A file in a
  // state GitHub does not name is left to a maintainer.
  const assetAddress = `https://api.github.com/repos/${repository}/releases/assets/`;
  const judge = (from, name, { state, digest, address }) => {
    if (state !== UPLOADED && !UNFINISHED.has(state))
      fail(
        `${from} has ${name} in the state ${state}, which is neither uploaded nor unfinished; a maintainer looks at it, then runs again`,
      );
    const id = typeof address === "string" ? address.slice(assetAddress.length) : "";
    if (typeof address !== "string" || !address.startsWith(assetAddress) || !/^[0-9]+$/u.test(id))
      fail(`${from} has ${name} without the address of it`);
    return { name, state, digest, address, id };
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
        unfinished.push(judge(tag, name, file));
        pending.push(name);
      } else if (typeof file.digest !== "string")
        fail(
          `${tag} already has ${name} without a digest to compare; refusing to replace a published file`,
        );
      else if (file.digest !== digests.get(name))
        fail(`${tag} already has a different ${name}; refusing to replace a published file`);
    }
    return { id: found.id, pending, unfinished };
  };
  const readOwnPlan = () => {
    const { found } = readBuild();
    if (found === null) fail(`release ${tag} was deleted meanwhile; a rerun creates it`);
    return planRelease(found);
  };

  // The feeds only move forward: an older run never replaces a newer one.
  // Every feed this run replaces is checked, since a release that failed
  // halfway can leave one feed ahead of another.
  // A feed can be lost by a failed upload (an upload may stop unfinished, and
  // a feed is removed before it is uploaded again); a published release
  // cannot, so the newest release tag is the floor as well.
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
  const feedFiles = readdirSync(feeds).toSorted();
  const feedDigests = new Map(
    feedFiles.map((name) => [name, `sha256:${sha256File(path.join(feeds, name))}`]),
  );
  // A feed holds what this build announces only when GitHub's checksum of it
  // is the one of the file to write; a feed without a checksum is written
  // again.
  const holds = (name, file) => file.state === UPLOADED && file.digest === feedDigests.get(name);
  // The bytes of an uploaded file, read at its address.
  const readBytes = (from, { name, digest, address }) => {
    const done = gh(["api", "-H", "Accept: application/octet-stream", address]);
    if (done.status !== 0) fail(`cannot read ${name} in ${from}: ${said(done)}`);
    const bytes = Buffer.from(done.stdout, "utf8");
    if (typeof digest === "string" && sha256Of(bytes) !== digest)
      fail(`GitHub gave other bytes for ${name} in ${from} than its checksum ${digest}`);
    return bytes;
  };
  let reads = 0;
  // A feed that already holds the bytes to write is left alone, so a rerun
  // of a finished publication does not risk a working feed.
  const planFeeds = () => {
    const found = readFeeds();
    const announced = path.join(work, `announced-${(reads += 1)}`);
    mkdirSync(announced);
    const replaced = [];
    const stale = [];
    for (const name of feedFiles) {
      const file = found.assets.get(name);
      if (file === undefined) {
        stale.push(name);
        continue;
      }
      const judged = judge(FEEDS, name, file);
      if (judged.state === UPLOADED)
        writeFileSync(path.join(announced, name), readBytes(FEEDS, judged));
      if (!holds(name, file)) {
        replaced.push(judged);
        stale.push(name);
      }
    }
    // Listed after the bytes, so a release published while they were read
    // counts.
    const publishedTags = readPublishedTags(gh, repository);
    try {
      checkFeedsMoveForward(version, announced, publishedTags);
    } catch (error) {
      fail(`the feeds in ${FEEDS} only move forward:\n${error.message}`);
    }
    return { replaced, stale };
  };

  // Removes the judged file only while its address still answers with it;
  // false when it changed or went meanwhile. A dry run reads it the same way
  // and removes nothing. write() runs right before the removal is sent.
  const removed = (from, judged, write) => {
    const { name, state, address } = judged;
    const now = gh(["api", address]);
    if (now.status !== 0) {
      if (notFound(now)) return false;
      fail(`cannot read ${what(judged)} in ${from} again: ${said(now)}`);
    }
    let file;
    try {
      file = JSON.parse(now.stdout);
    } catch (error) {
      fail(`cannot read ${what(judged)} in ${from} again: ${error.message}`);
    }
    if (typeof file !== "object" || file === null || typeof file.state !== "string")
      fail(`cannot read ${what(judged)} in ${from} again: GitHub answered no file at ${address}`);
    if (
      String(file.id) !== judged.id ||
      file.name !== name ||
      file.state !== state ||
      (state === UPLOADED && file.digest !== judged.digest)
    )
      return false;
    write?.();
    if (dryRun) return true;
    const done = gh(["api", "-X", "DELETE", address]);
    if (done.status !== 0) {
      if (notFound(done)) return false;
      fail(`cannot remove ${what(judged)} (state ${state}) from ${from}: ${said(done)}`);
    }
    log(
      state === UPLOADED
        ? `removed ${name} from ${from} to replace it`
        : `removed the unfinished ${name} (state ${state}) from ${from}`,
    );
    return true;
  };
  // An upload never goes over a name: a file that took one meanwhile stays.
  const uploadInto = (from, names, folder, failure) => {
    const done = gh([
      "release",
      "upload",
      from,
      ...names.map((name) => path.join(folder, name)),
      "--repo",
      repository,
    ]);
    if (done.status === 0) return undefined;
    if (nameTaken(done))
      return `a file named as one of ${names.join(", ")} was attached to ${from} meanwhile`;
    return fail(`${failure}: ${said(done)}`);
  };
  // A change met while acting makes the picture be read anew and the plan be
  // made by the same rules; a second change stops the run.
  const settle = (from, plan, picture, act) => {
    for (let again = false; ; again = true) {
      const change = act(plan);
      if (change === undefined) return plan;
      if (again) fail(`${change}, also after ${from} was read again; a rerun reads it again`);
      log(`${change}; reading ${from} again`);
      plan = picture();
    }
  };
  const changed = (from, judgedFiles, write) => {
    const file = judgedFiles.find((judged) => !removed(from, judged, write));
    return file === undefined ? undefined : `${what(file)} in ${from} changed meanwhile`;
  };
  const actOwn = ({ pending, unfinished }) =>
    changed(tag, unfinished) ??
    (dryRun || pending.length === 0
      ? undefined
      : uploadInto(tag, pending, upload, `cannot upload ${pending.join(", ")} to ${tag}`));

  // What the feeds announce is checked as a whole, as late as it can be:
  // the release of the tag is the one this run planned against, public,
  // a pre-release and holding every file, the tag is at the build commit,
  // no published release is newer, and, in the last read, each feed holds
  // what this build announces. A problem with a file of this build is put
  // right by a rerun; any other only by the run of a newer build.
  let releaseId;
  const readAnnouncement = (last) => {
    const problems = [];
    const ofBuild = (text, rerun = false) =>
      problems.push({ text, kind: rerun ? "file" : "release" });
    const found = readRelease(gh, repository, tag);
    if (found === null) ofBuild(`there is no release ${tag}`);
    else {
      releaseId ??= found.id;
      if (found.id !== releaseId)
        ofBuild(
          `${tag} is release ${found.id}, not release ${releaseId} this run checked: it was deleted and created again`,
        );
      if (found.draft) ofBuild(`${tag} is a draft`);
      else if (!found.prerelease)
        ofBuild(`${tag} is not a pre-release; ${prerelease} makes it one`);
      for (const name of files) {
        const file = found.assets.get(name);
        if (file === undefined) ofBuild(`${name} is missing`, true);
        else if (file.state !== UPLOADED)
          ofBuild(`${name} is not fully uploaded (state ${file.state})`, true);
        else if (file.digest !== digests.get(name))
          ofBuild(`${name} has the digest ${file.digest}, not ${digests.get(name)}`);
      }
    }
    const tagged = readTag(gh, repository, tag);
    if (tagged !== commit)
      ofBuild(tagged === null ? `there is no tag ${tag}` : `${tag} points at ${tagged}`);
    try {
      checkFeedsMoveForward(version, noFeeds, readPublishedTags(gh, repository));
    } catch (error) {
      problems.push({ text: error.message, kind: "newer" });
    }
    if (!last) return problems;
    const latest = readFeeds();
    for (const name of feedFiles) {
      const file = latest.assets.get(name);
      const text =
        file === undefined
          ? `${name} is missing`
          : file.state !== UPLOADED
            ? `${name} is not fully uploaded (state ${file.state})`
            : holds(name, file)
              ? undefined
              : `${name} has the digest ${file.digest}, not ${feedDigests.get(name)}`;
      if (text !== undefined) problems.push({ text, kind: "feed" });
    }
    return problems;
  };
  let feedWrites = 0;
  const failOn = (problems, last) => {
    if (problems.length === 0) return;
    const texts = (kinds) =>
      problems.filter(({ kind }) => kinds.includes(kind)).map(({ text }) => text);
    if (!last && feedWrites === 0) {
      const build = texts(["release", "file"]);
      const newer = texts(["newer"]);
      fail(
        [
          ...(build.length === 0
            ? []
            : [
                `${tag} does not read back as a published pre-release of the build with every file:`,
                ...build,
              ]),
          ...(newer.length === 0 ? [] : [`the feeds in ${FEEDS} only move forward:`, ...newer]),
          `The feeds in ${FEEDS} were not touched; a rerun checks the release again`,
        ].join("\n"),
      );
    }
    const announced = problems
      .filter(({ kind }) => kind !== "feed")
      .map(({ text, kind }) =>
        kind === "file"
          ? `${text}; a rerun of this build uploads it and puts the feeds right`
          : `${text}; only the run of a newer build puts the feeds right`,
      );
    const lost = texts(["feed"]);
    fail(
      [
        ...(announced.length === 0
          ? []
          : [`the feeds in ${FEEDS} may now announce ${version} although:`, ...announced]),
        ...(lost.length === 0
          ? []
          : [
              `the feeds in ${FEEDS} do not read back as announcing ${version}:`,
              ...lost,
              "A rerun reads the feeds again and completes them",
            ]),
      ].join("\n"),
    );
  };

  const start = readBuild();
  const first = start.found === null ? null : planRelease(start.found);
  planFeeds();

  // A dry run goes the way a publication goes and leaves the writes out; it
  // cannot read the release of the tag as an upload into it would leave it.
  let own = null;
  if (first !== null) own = settle(tag, readOwnPlan(), readOwnPlan, actOwn);
  else if (!dryRun) {
    // GITHUB_TOKEN may not create a release on a commit that changes workflow
    // files (HTTP 403). A maintainer then pushes the tag at the build commit
    // and either creates the pre-release on it or runs this again, which
    // creates it there.
    const done = gh([
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
      ...files.map((name) => path.join(upload, name)),
      "--repo",
      repository,
    ]);
    if (done.status !== 0) fail(`cannot create the pre-release ${tag}: ${said(done)}`);
  }
  releaseId = own?.id;
  const blind = dryRun && (own === null || own.pending.length > 0);
  if (!blind) {
    failOn(readAnnouncement(false), false);
    if (!dryRun) log(`published ${tag}`);
  }

  const actFeeds = ({ replaced, stale }) => {
    let checked = false;
    const write = () => {
      if (!checked && !blind) failOn(readAnnouncement(false), false);
      checked = true;
      if (!dryRun) feedWrites += 1;
    };
    const change = changed(FEEDS, replaced, write);
    if (change !== undefined || stale.length === 0) return change;
    write();
    return dryRun
      ? undefined
      : uploadInto(FEEDS, stale, feeds, `cannot upload the feeds to ${FEEDS}`);
  };
  const { replaced, stale } = settle(FEEDS, planFeeds(), planFeeds, actFeeds);

  if (dryRun) {
    log(`dry run: would publish ${tag} at ${commit} from attempt ${attempt} of run ${runId} with:`);
    log(sums.trimEnd());
    if (own === null && start.tagged !== null)
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
    if (blind) log(`would read ${tag} back after the upload and check it before the feeds`);
    for (const { name, state } of replaced)
      log(
        state === UPLOADED
          ? `${FEEDS} has a different ${name}; would replace it`
          : `${FEEDS} has an unfinished ${name} (state ${state}), counted as lost; would remove it and upload it again`,
      );
    if (stale.length === 0) log(`the feeds in ${FEEDS} already point at it`);
    else {
      log(`and point ${FEEDS} at it:`);
      log(serverFeed.trimEnd());
    }
    return { tag, published: false };
  }

  failOn(readAnnouncement(true), true);
  log(
    feedWrites === 0
      ? `the feeds in ${FEEDS} already point at ${tag}; nothing uploaded`
      : `${FEEDS} now announces ${version}`,
  );
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
