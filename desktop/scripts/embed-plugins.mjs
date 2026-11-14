// Puts the 1ma plugins into a prepared bb tree as built-in plugins (patch
// 0014). Run after bb's dependencies are installed and before bb is built:
//
//   node desktop/scripts/embed-plugins.mjs <bb tree>
//
// For each plugin the tracked sources are copied to <bb tree>/.1ma-plugins/
// (outside bb's workspace globs, so bb's lockfile stays as it is), its
// production dependencies come from 1ma's lockfile (pnpm deploy), bb's own
// `prepare-bundled` builds it with this tree's toolchain and SDK, and the
// files its package.json lists (assets, themes) are added to the runtime.
// The result is plugins/<name>/.bundled-runtime, which packages/bundled-plugins
// copies like any other built-in.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const EMBEDDED = JSON.parse(
  readFileSync(path.join(repo, "desktop", "embedded-plugins.json"), "utf8"),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed in ${options.cwd ?? process.cwd()}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

// The names patch 0014 registers, read from the tree it was applied to, so the
// list here and the list in bb cannot drift apart.
export function registeredNames(tree) {
  const source = readFileSync(
    path.join(tree, "apps/server/src/services/plugins/builtin-registry.ts"),
    "utf8",
  );
  const block = /export const ONE_MA_PLUGINS[^=]*=\s*\[([^\]]*)\]/u.exec(source);
  if (block === null) throw new Error("this bb tree has no ONE_MA_PLUGINS (patch 0014)");
  return [...block[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

export function runtimeFiles(pluginDir) {
  const manifest = JSON.parse(readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  if (!Array.isArray(manifest.files)) {
    throw new Error(`${manifest.name} lists no "files"; say which runtime files it needs`);
  }
  return manifest.files;
}

function trackedFiles(dir) {
  return run("git", ["ls-files", "-z", "--", "."], { cwd: dir }).split("\0").filter(Boolean);
}

export function embedPlugin({ tree, name, log = () => {} }) {
  const source = path.join(repo, "plugins", name);
  const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  const staging = path.join(tree, ".1ma-plugins", name);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const file of trackedFiles(source)) {
    mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
    cpSync(path.join(source, file), path.join(staging, file));
  }
  const deployed = path.join(tree, ".1ma-plugins", `${name}.deploy`);
  rmSync(deployed, { recursive: true, force: true });
  run("pnpm", ["--filter", manifest.name, "deploy", "--prod", "--legacy", deployed], { cwd: repo });
  if (existsSync(path.join(deployed, "node_modules"))) {
    cpSync(path.join(deployed, "node_modules"), path.join(staging, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  rmSync(deployed, { recursive: true, force: true });
  run(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      path.join(tree, "packages/plugin-build/src/cli.ts"),
      "prepare-bundled",
    ],
    { cwd: staging },
  );
  const runtime = path.join(staging, ".bundled-runtime");
  for (const entry of runtimeFiles(source)) {
    const from = path.join(staging, entry);
    if (!existsSync(from))
      throw new Error(`${name} lists "${entry}" in files, but it is not there`);
    cpSync(from, path.join(runtime, entry), { recursive: true });
  }
  const target = path.join(tree, "plugins", name, ".bundled-runtime");
  rmSync(path.dirname(target), { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(runtime, target, { recursive: true });
  log(`embedded ${name}@${manifest.version}`);
  return target;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tree = process.argv[2];
  if (!tree) {
    console.error("usage: node desktop/scripts/embed-plugins.mjs <prepared bb tree>");
    process.exit(1);
  }
  const registered = registeredNames(tree);
  if (JSON.stringify(registered) !== JSON.stringify(EMBEDDED)) {
    throw new Error(
      `desktop/embedded-plugins.json lists ${EMBEDDED.join(", ")}, patch 0014 registers ${registered.join(", ")}`,
    );
  }
  for (const name of EMBEDDED) embedPlugin({ tree: path.resolve(tree), name, log: console.log });
}
