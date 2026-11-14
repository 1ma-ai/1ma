// Checking out a bb release and putting the 1ma patch series on it.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function run(cwd, args) {
  return spawnSync("git", ["-c", "user.name=1ma", "-c", "user.email=hello@1ma.ai", ...args], {
    cwd,
    encoding: "utf8",
  });
}

export function git(cwd, args) {
  const result = run(cwd, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

// upstream: { repository, tag, commit, seriesBase? }. seriesBase is the bb
// commit the series was exported on, when the tree is another release (a trial
// of a new bb release). A patch whose context changed can then still land by a
// three-way merge, which needs the files as they were in that commit.
export function checkoutUpstream(out, upstream) {
  mkdirSync(out, { recursive: true });
  git(out, ["init", "--quiet"]);
  git(out, ["remote", "add", "origin", upstream.repository]);
  git(out, [
    "fetch",
    "--quiet",
    "--depth",
    "1",
    "origin",
    `refs/tags/${upstream.tag}:refs/tags/${upstream.tag}`,
  ]);
  const tagged = git(out, ["rev-list", "-n", "1", upstream.tag]);
  if (tagged !== upstream.commit) {
    throw new Error(
      `${upstream.tag} points at ${tagged}, upstream.json pins ${upstream.commit}; refusing a moved tag`,
    );
  }
  if (upstream.seriesBase !== undefined && upstream.seriesBase !== upstream.commit) {
    git(out, ["fetch", "--quiet", "--depth", "1", "origin", upstream.seriesBase]);
  }
  git(out, ["checkout", "--quiet", "--detach", upstream.tag]);
}

function patchFiles(patch) {
  return [...readFileSync(patch, "utf8").matchAll(/^diff --git a\/(\S+) b\//gmu)].map(
    (match) => match[1],
  );
}

// Applies every patch it can. A patch that does not apply is left out and
// reported, and the rest are still tried, so one run lists all the work a new
// bb release needs (a later patch may fail only because an earlier one is out).
export function applySeries(out, patchesDir, log = () => {}) {
  const names = readdirSync(patchesDir)
    .filter((name) => name.endsWith(".patch"))
    .toSorted();
  const applied = [];
  const failed = [];
  for (const name of names) {
    const patch = path.join(patchesDir, name);
    const result = run(out, ["am", "--quiet", "--3way", patch]);
    if (result.status === 0) {
      applied.push(name);
      log(`applied ${name}`);
      continue;
    }
    const conflicted = git(out, ["diff", "--name-only", "--diff-filter=U"])
      .split("\n")
      .filter(Boolean);
    failed.push({
      name,
      files: conflicted.length > 0 ? conflicted : patchFiles(patch),
      message: `${result.stdout}${result.stderr}`.trim(),
    });
    git(out, ["am", "--abort"]);
    log(`did not apply ${name}`);
  }
  return { names, applied, failed };
}

export function describeFailures(failed) {
  return failed
    .map(({ name, files, message }) => {
      const reason = message.split("\n").find((line) => /^error:|CONFLICT/u.test(line)) ?? "";
      return `- ${name}: ${files.join(", ")}${reason ? ` (${reason.trim()})` : ""}`;
    })
    .join("\n");
}
