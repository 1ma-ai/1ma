import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { requireEnv } from "./servers.mjs";

const version = readFileSync(new URL("./server-version.txt", import.meta.url), "utf8").trim();
const root = requireEnv("E2E_ROOT");
const target = path.join(root, "server-package");
const downloads = path.join(root, "downloads");
mkdirSync(downloads, { recursive: true });
mkdirSync(target, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

const tag = `desktop/v${version}`;
const archive = `1ma-server-${version}.tgz`;
run("gh", [
  "release",
  "download",
  tag,
  "--repo",
  "1ma-ai/1ma",
  "--dir",
  downloads,
  "--pattern",
  archive,
  "--pattern",
  "SHA256SUMS",
  "--clobber",
]);

const sums = readFileSync(path.join(downloads, "SHA256SUMS"), "utf8");
const expected = sums
  .split("\n")
  .map((line) => line.trim().split(/\s+/))
  .find((parts) => parts[1]?.replace(/^\*/, "") === archive)?.[0];
if (expected === undefined) throw new Error(`${archive} is not listed in SHA256SUMS`);
const actual = createHash("sha256")
  .update(readFileSync(path.join(downloads, archive)))
  .digest("hex");
if (actual !== expected) throw new Error(`${archive}: sha256 ${actual}, expected ${expected}`);

writeFileSync(
  path.join(target, "package.json"),
  JSON.stringify({ name: "e2e-1ma-server", private: true }),
);
run("npm", ["install", "--no-audit", "--no-fund", path.join(downloads, archive)], { cwd: target });
console.log(`installed ${archive} (${actual}) into ${target}`);
