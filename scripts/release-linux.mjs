import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginId } from "./lib/plugin-id.mjs";
import { deployPlugins, deployable, installedSource, parseArgs } from "./lib/release-linux.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worktree =
  process.env.ONEMA_RELEASE_WORKTREE ?? path.join(homedir(), ".local/share/1ma/release");
const heavy = process.env.ONEMA_HEAVY ?? path.join(homedir(), ".claude/bin/heavy");
const bb = process.env.BB_CLI ?? "bb";
const github = process.env.ONEMA_REPO ?? "1ma-ai/1ma";
const { ref, replaceManaged } = parseArgs(process.argv.slice(2));
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` };

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", env, ...options });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} exited ${result.status}\n${output}`);
  }
  return output;
}

function succeeds(command, commandArgs) {
  return spawnSync(command, commandArgs, { encoding: "utf8", env }).status === 0;
}

run("git", ["-C", repo, "fetch", "--quiet", "origin", "main", "--tags"]);
const resolved = spawnSync("git", ["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`], {
  encoding: "utf8",
  env,
});
const sha = resolved.status === 0 ? resolved.stdout.trim() : "";
const runs = sha
  ? JSON.parse(
      run("gh", [
        "run",
        "list",
        "--repo",
        github,
        "--workflow",
        "ci.yml",
        "--branch",
        "main",
        "--event",
        "push",
        "--commit",
        sha,
        "--limit",
        "1",
        "--json",
        "status,conclusion",
      ]),
    )
  : [];
const refusal = deployable({
  sha,
  onMain:
    sha !== "" && succeeds("git", ["-C", repo, "merge-base", "--is-ancestor", sha, "origin/main"]),
  latestCiRun: runs[0] ?? null,
});
if (refusal !== null) throw new Error(`not deploying ${ref}: ${refusal}`);

if (existsSync(path.join(worktree, ".git"))) {
  const dirty = run("git", [
    "-C",
    worktree,
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]).trim();
  if (dirty.length > 0)
    throw new Error(`release worktree ${worktree} has local changes:\n${dirty}`);
  run("git", ["-C", worktree, "checkout", "--quiet", "--detach", sha]);
} else {
  run("git", ["-C", repo, "worktree", "add", "--detach", worktree, sha]);
}
console.log(`release worktree ${worktree} at ${ref} (${sha.slice(0, 7)}), CI green on main`);

run(heavy, ["--wait", "300", "corepack", "pnpm", "install", "--frozen-lockfile", "--prod"], {
  cwd: worktree,
});
console.log("production dependencies installed inside the heavy queue");

const collection = JSON.parse(readFileSync(path.join(worktree, ".bb/plugins.json"), "utf8"));
const entries = collection.plugins.map((entry) => {
  const directory = path.join(worktree, entry.source);
  const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  return { id: pluginId(manifest.name), directory, version: manifest.version };
});
const blocked = deployPlugins({
  entries,
  replaceManaged,
  log: (line) => console.log(line),
  bb: {
    activeTheme: () => JSON.parse(run(bb, ["theme", "list", "--json"])).active?.themeId ?? null,
    setTheme: (id) => run(bb, ["theme", "set", id]),
    source: (id) => {
      const result = spawnSync(bb, ["plugin", "source", id, "--json"], { encoding: "utf8", env });
      return installedSource(result.status === 0 ? result.stdout : null);
    },
    remove: (id) => run(bb, ["plugin", "remove", id, "--yes"]),
    install: (from) => run(bb, ["plugin", "install", from, "--yes"]),
  },
});
if (blocked.length > 0) {
  console.error(
    `skipped plugins installed from git or npm; rerun with --replace-managed to remove and reinstall them (their settings are deleted):\n  ${blocked.join("\n  ")}`,
  );
  process.exit(2);
}
