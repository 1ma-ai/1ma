// A trial of a new bb release: a branch bb-trial/<tag> that changes only
// desktop/upstream.json, and the Desktop and Desktop bb tests runs on it.
// One trial is one bb tag and one exact 1ma patch series. A rerun of the
// watch starts only what is missing: a partly started trial is completed, and
// a changed series replaces the branch.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TRIAL_WORKFLOWS = [
  { file: "desktop.yml", inputs: [] },
  { file: "desktop-tests.yml", inputs: ["-f", "rebrand=false"] },
];

export class GhNotFound extends Error {}

// gh(args) returns stdout; a 404 from the API is a GhNotFound, every other
// failure is an ordinary error that stops the trial.
export function runGh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (/HTTP 404|Not Found/u.test(stderr)) throw new GhNotFound(stderr.trim(), { cause: error });
    throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim() || error.message}`, {
      cause: error,
    });
  }
}

function seriesOf(gh, repo, ref) {
  const listing = JSON.parse(gh(["api", `repos/${repo}/contents/desktop/patches?ref=${ref}`]));
  return listing
    .filter((entry) => entry.name.endsWith(".patch"))
    .map((entry) => `${entry.name}:${entry.sha}`)
    .toSorted()
    .join("\n");
}

function branchHead(gh, repo, branch) {
  try {
    return JSON.parse(gh(["api", `repos/${repo}/branches/${branch}`])).commit.sha;
  } catch (error) {
    if (error instanceof GhNotFound) return null;
    throw error;
  }
}

function pointUpstream(gh, { repo, branch, upstream, tag, commit, log }) {
  const current = JSON.parse(
    gh(["api", `repos/${repo}/contents/desktop/upstream.json?ref=${branch}`]),
  ).sha;
  const content = `${JSON.stringify({ ...upstream, seriesBase: upstream.commit, tag, commit }, null, 2)}\n`;
  gh([
    "api",
    "-X",
    "PUT",
    `repos/${repo}/contents/desktop/upstream.json`,
    "-f",
    `message=Trial: the 1ma patches on bb ${tag} (not for main)`,
    "-f",
    `content=${Buffer.from(content).toString("base64")}`,
    "-f",
    `sha=${current}`,
    "-f",
    `branch=${branch}`,
  ]);
  log(`${branch} points at bb ${tag} (${commit})`);
  return branchHead(gh, repo, branch);
}

export function startTrial({ gh = runGh, repo, mainSha, upstream, tag, commit, log = () => {} }) {
  const branch = `bb-trial/${tag}`;
  const series = seriesOf(gh, repo, mainSha);
  let head = branchHead(gh, repo, branch);
  let fresh = false;
  if (head === null) {
    gh(["api", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${mainSha}`]);
    head = pointUpstream(gh, { repo, branch, upstream, tag, commit, log });
    fresh = true;
  } else if (seriesOf(gh, repo, head) !== series) {
    gh([
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/git/refs/heads/${branch}`,
      "-f",
      `sha=${mainSha}`,
      "-F",
      "force=true",
    ]);
    head = pointUpstream(gh, { repo, branch, upstream, tag, commit, log });
    fresh = true;
    log(`the 1ma patch series changed since the last trial of ${tag}; ${branch} starts again`);
  }
  const started = [];
  for (const workflow of TRIAL_WORKFLOWS) {
    const runs = fresh
      ? []
      : JSON.parse(
          gh([
            "run",
            "list",
            "--repo",
            repo,
            "--branch",
            branch,
            "--workflow",
            workflow.file,
            "--json",
            "headSha",
          ]),
        );
    if (runs.some((run) => run.headSha === head)) continue;
    gh(["workflow", "run", workflow.file, "--repo", repo, "--ref", branch, ...workflow.inputs]);
    started.push(workflow.file);
  }
  log(
    started.length > 0
      ? `started ${started.join(", ")} on ${branch}`
      : `${branch} already has every run`,
  );
  return { branch, head, started };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [tag, commit] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY;
  const mainSha = process.env.GITHUB_SHA;
  if (!tag || !commit || !repo || !mainSha) {
    console.error(
      "usage: GITHUB_REPOSITORY=… GITHUB_SHA=… node desktop/scripts/bb-trial.mjs <tag> <commit>",
    );
    process.exit(1);
  }
  const upstream = JSON.parse(readFileSync(new URL("../upstream.json", import.meta.url), "utf8"));
  const result = startTrial({ repo, mainSha, upstream, tag, commit, log: console.log });
  console.log(`branch=${result.branch}`);
  console.log(`started=${result.started.length > 0}`);
}
