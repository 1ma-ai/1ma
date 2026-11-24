#!/usr/bin/env node
// Copies a forkable built-in plugin out of a bb checkout the way bb's own
// fork check does (scripts/check-plugin-forks.mjs at the same commit): the
// plugin directory, the registry items it imports, a tsconfig with `@/*` at
// `./*` and a package.json without workspace packages. The bb helpers are
// loaded from the checkout itself, so the copy follows that bb release.
//
// usage: node scripts/fork-bb-plugin.mjs --bb <bb checkout> --plugin <name> --out <empty dir>
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const COPY_EXCLUDED = new Set(["node_modules", "dist", ".bundled-runtime", ".turbo"]);

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) {
    throw new Error(
      "usage: node scripts/fork-bb-plugin.mjs --bb <bb checkout> --plugin <name> --out <empty dir>",
    );
  }
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sourceFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (COPY_EXCLUDED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:tsx?|mts|cts)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

const bb = resolve(option("bb"));
const plugin = option("plugin");
const out = resolve(option("out"));
if (existsSync(out) && (await readdir(out)).length > 0) {
  throw new Error(`${out} is not empty`);
}

const fork = await import(pathToFileURL(join(bb, "scripts/lib/plugin-fork.mjs")).href);
const { SHIMMED_TYPE_PACKAGES } = await import(
  pathToFileURL(join(bb, "packages/plugin-build/src/runtime-shims.mjs")).href
);

const source = join(bb, "plugins", plugin);
await mkdir(out, { recursive: true });
await cp(source, out, {
  recursive: true,
  filter: (path) =>
    !relative(source, path)
      .split(/[\\/]/u)
      .some((segment) => COPY_EXCLUDED.has(segment)),
});

const specifiers = new Set();
for (const file of await sourceFiles(out)) {
  for (const specifier of fork.registryAliasImports(await readFile(file, "utf8"))) {
    specifiers.add(specifier);
  }
}
const registryDir = join(bb, "packages/plugin-registry/r");
const registryItems = await Promise.all(
  (await readdir(registryDir))
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .map((name) => readJson(join(registryDir, name))),
);
const items = fork.registryItemsForImports(specifiers, registryItems);
for (const item of items) {
  for (const file of item.files) {
    await mkdir(dirname(join(out, file.target)), { recursive: true });
    await writeFile(join(out, file.target), file.content);
  }
}
const [registryManifest, appManifest, sdkManifest] = await Promise.all(
  [
    "packages/plugin-registry/package.json",
    "apps/app/package.json",
    "packages/plugin-sdk/package.json",
  ].map((path) => readJson(join(bb, path))),
);
const packages = fork.registryPackages(items, {
  shimmedPackages: new Set(SHIMMED_TYPE_PACKAGES),
  versions: {
    ...registryManifest.devDependencies,
    ...appManifest.devDependencies,
    ...appManifest.dependencies,
  },
});

const tsconfig = await readJson(join(source, "tsconfig.json"));
await writeFile(
  join(out, "tsconfig.json"),
  `${JSON.stringify(fork.forkPluginTsconfig(tsconfig), null, 2)}\n`,
);
const manifest = await readJson(join(source, "package.json"));
const workspaceBins = new Map();
for (const entry of await readdir(join(bb, "packages"), { withFileTypes: true })) {
  const path = join(bb, "packages", entry.name, "package.json");
  if (!entry.isDirectory() || !existsSync(path)) continue;
  const { name, bin } = await readJson(path);
  workspaceBins.set(
    name,
    typeof bin === "string" ? [name.split("/").pop()] : Object.keys(bin ?? {}),
  );
}
const forked = fork.forkPluginPackageJson(manifest, {
  sdkSpecifier: sdkManifest.version,
  workspaceBinsByPackage: workspaceBins,
  registryDependencies: packages,
});
await writeFile(join(out, "package.json"), `${JSON.stringify(forked.manifest, null, 2)}\n`);

console.log(`copied plugins/${plugin} to ${out}`);
console.log(`registry items: ${items.map((item) => item.name).join(", ")}`);
console.log(`@get-bb/plugin-sdk ${sdkManifest.version}`);
if (forked.droppedDevDependencies.length > 0) {
  console.log(`dropped workspace tooling: ${forked.droppedDevDependencies.join(", ")}`);
}
if (forked.droppedScripts.length > 0) {
  console.log(`dropped scripts: ${forked.droppedScripts.join(", ")}`);
}
