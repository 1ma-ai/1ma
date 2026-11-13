// The version of a 1ma build is the next patch of the bb release it is built
// on, as a prerelease that names the build's run, the way bb numbers its
// nightly builds: bb 0.49.0 built in run 123, attempt 1, is 0.49.1-1ma.123.1.
// It sorts above that bb release and every earlier 1ma build, and below bb's
// next release, so bb's own version checks keep working.
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const POSITIVE = /^[1-9]\d*$/u;

export function oneMaVersion(bbVersion, runId, runAttempt) {
  const release = RELEASE.exec(bbVersion);
  if (release === null) throw new Error(`${bbVersion} is not a bb release version`);
  for (const [label, value] of [
    ["run id", runId],
    ["run attempt", runAttempt],
  ]) {
    if (!POSITIVE.test(String(value)))
      throw new Error(`${label} must be a positive integer, got ${value}`);
  }
  const [, major, minor, patch] = release;
  return `${major}.${minor}.${BigInt(patch) + 1n}-1ma.${runId}.${runAttempt}`;
}

function parse(version) {
  const match = SEMVER.exec(version);
  if (match === null) throw new Error(`${version} is not a semantic version`);
  return {
    core: [match[1], match[2], match[3]].map((part) => BigInt(part)),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function compareIdentifiers(a, b) {
  const numericA = /^\d+$/u.test(a);
  const numericB = /^\d+$/u.test(b);
  if (numericA && numericB) return BigInt(a) === BigInt(b) ? 0 : BigInt(a) < BigInt(b) ? -1 : 1;
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

// Semantic version precedence: -1, 0 or 1.
export function compareVersions(a, b) {
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index])
      return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const order = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (order !== 0) return order;
  }
  return 0;
}

// Each feed in desktop-latest is replaced separately, so a release that
// failed halfway can leave one ahead of another: a build is checked against
// every feed it would replace, not only one of them.
export function checkFeedsMoveForward(version, folder) {
  const newer = readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      name,
      announced: JSON.parse(readFileSync(path.join(folder, name), "utf8")).version,
    }))
    .filter(({ announced }) => compareVersions(String(announced), version) > 0);
  if (newer.length > 0)
    throw new Error(
      newer
        .map(
          ({ name, announced }) =>
            `desktop-latest already announces ${announced} in ${name}, newer than ${version}`,
        )
        .join("\n"),
    );
  return `${version} is not older than any feed in ${folder}`;
}

const USAGE =
  "usage: node desktop/scripts/version.mjs next <bb version> <run id> <run attempt> | compare <version> <version> | forward <version> <folder with the announced feeds>";

function main([command, ...args]) {
  if (command === "next" && args.length === 3) return oneMaVersion(...args);
  if (command === "compare" && args.length === 2) return String(compareVersions(...args));
  if (command === "forward" && args.length === 2) return checkFeedsMoveForward(...args);
  throw new Error(USAGE);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
