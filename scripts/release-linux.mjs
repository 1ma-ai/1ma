import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worktree =
  process.env.ONEMA_RELEASE_WORKTREE ?? path.join(homedir(), ".local/share/1ma/release");
const heavy = process.env.ONEMA_HEAVY ?? path.join(homedir(), ".claude/bin/heavy");
const bb = process.env.BB_CLI ?? "bb";
const args = process.argv.slice(2);
const replaceManaged = args.includes("--replace-managed");
const ref = args.find((arg) => !arg.startsWith("--")) ?? "origin/main";
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` };

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", env, ...options });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} exited ${result.status}\n${output}`);
  }
  return output;
}

function pluginId(packageName) {
  const last = packageName.split("/").pop() ?? packageName;
  const stripped = last.startsWith("bb-plugin-") ? last.slice("bb-plugin-".length) : last;
  return stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function installedSource(id) {
  const result = spawnSync(bb, ["plugin", "source", id, "--json"], { encoding: "utf8", env });
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout).requested;
}

function activeTheme() {
  return JSON.parse(run(bb, ["theme", "list", "--json"])).active?.themeId ?? null;
}

run("git", ["-C", repo, "fetch", "--quiet", "origin", "main", "--tags"]);
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
  run("git", ["-C", worktree, "checkout", "--quiet", "--detach", ref]);
} else {
  run("git", ["-C", repo, "worktree", "add", "--detach", worktree, ref]);
}
const commit = run("git", ["-C", worktree, "rev-parse", "--short", "HEAD"]).trim();
console.log(`release worktree ${worktree} at ${ref} (${commit})`);

run(heavy, ["--wait", "300", "corepack", "pnpm", "install", "--frozen-lockfile", "--prod"], {
  cwd: worktree,
});
console.log("production dependencies installed inside the heavy queue");

const themeBefore = activeTheme();
const collection = JSON.parse(readFileSync(path.join(worktree, ".bb/plugins.json"), "utf8"));
const blocked = [];
for (const entry of collection.plugins) {
  const directory = path.join(worktree, entry.source);
  const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  const id = pluginId(manifest.name);
  const current = installedSource(id);
  if (current !== null && !current.startsWith("path:")) {
    if (!replaceManaged) {
      blocked.push(`${id} (installed from ${current})`);
      continue;
    }
    run(bb, ["plugin", "remove", id, "--yes"]);
    console.log(`${id}: removed managed install ${current}`);
  }
  run(bb, ["plugin", "install", directory, "--yes"]);
  console.log(`${id}@${manifest.version}: installed from ${directory}`);
}

const themeAfter = activeTheme();
if (themeBefore !== null && themeAfter !== themeBefore) {
  run(bb, ["theme", "set", themeBefore]);
  console.log(`theme restored to ${themeBefore}`);
}
if (blocked.length > 0) {
  console.error(
    `skipped plugins installed from git or npm; rerun with --replace-managed to remove and reinstall them (their settings are deleted):\n  ${blocked.join("\n  ")}`,
  );
  process.exit(2);
}
