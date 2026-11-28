import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Tells a workflow whether a pull request touches its paths, so the workflow can
// start on every pull request and still skip its work. A workflow filtered by
// `paths` does not start at all on other pull requests, and a check that never
// reports cannot be required for merging.
//
// The patterns are written as in a workflow's `paths` filter and read by git as
// glob pathspecs. The two agree on `*` and `**`; a `!` pattern excludes. Git
// applies exclusions last, the filter in order, so a `!` pattern may only be
// followed by other `!` patterns.
export function pathspecs(patterns) {
  const specs = [];
  let excluded = false;
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern === "") continue;
    const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    if (/[?[\]+\\!]/u.test(body))
      throw new Error(`"${pattern}": git and the paths filter read this pattern differently`);
    if (pattern.startsWith("!")) {
      excluded = true;
      specs.push(`:(glob,exclude)${body}`);
    } else if (excluded) {
      throw new Error(
        `"${pattern}" follows a ! pattern: the paths filter would include it again, git would not`,
      );
    } else {
      specs.push(`:(glob)${body}`);
    }
  }
  if (!specs.some((spec) => spec.startsWith(":(glob)"))) throw new Error("no paths to look for");
  return specs;
}

// The checkout of a pull request is its merge into the base branch, so the diff
// against the first parent is what the pull request changes.
export function changedFiles(repository, patterns) {
  const git = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  const parents = git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").length - 1;
  if (parents !== 2)
    throw new Error(
      "HEAD is not the merge commit of a pull request (check out the default ref with fetch-depth: 2)",
    );
  return git("diff", "--name-only", "HEAD^1", "HEAD", "--", ...pathspecs(patterns))
    .split("\n")
    .filter((line) => line !== "");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output, PATHS: paths = "" } = process.env;
  const patterns = paths.split("\n");
  pathspecs(patterns);
  const files = event === "pull_request" ? changedFiles(process.cwd(), patterns) : null;
  const changed = files === null || files.length > 0;
  if (files === null) console.log(`${event}: not a pull request, everything runs`);
  else console.log(files.length === 0 ? "no file of these paths changed" : files.join("\n"));
  appendFileSync(output, `changed=${changed}\n`);
}
