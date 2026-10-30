import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function pluginIdFromPackageName(name) {
  const last = name.split("/").pop() ?? name;
  const stripped = last.startsWith("bb-plugin-") ? last.slice("bb-plugin-".length) : last;
  return stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const errors = [];
const collection = await readJson(".bb/plugins.json");
const marketplace = await readJson("marketplace/marketplace.json");

const manifests = new Map();
const entryResults = await Promise.all(
  collection.plugins.map(async (entry) => {
    if (!entry.source.startsWith("./")) {
      return { entry, error: `collection entry ${entry.name}: source must start with ./` };
    }
    const manifestPath = path.join(root, entry.source, "package.json");
    if (!existsSync(manifestPath)) {
      return {
        entry,
        error: `collection entry ${entry.name}: ${entry.source}/package.json is missing`,
      };
    }
    return { entry, manifest: JSON.parse(await readFile(manifestPath, "utf8")) };
  }),
);
for (const { entry, manifest, error } of entryResults) {
  if (error !== undefined) {
    errors.push(error);
    continue;
  }
  if (!manifest.bb?.server) errors.push(`${entry.source}: manifest has no bb.server entry`);
  if (!manifest.bb?.name || !manifest.bb?.description) {
    errors.push(`${entry.source}: manifest needs bb.name and bb.description`);
  }
  if (!manifest.engines?.bbPluginSdk) {
    errors.push(`${entry.source}: manifest needs engines.bbPluginSdk`);
  }
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (String(spec).startsWith("workspace:")) {
        errors.push(
          `${entry.source}: ${field}.${name} uses workspace:, bb installs plugins with plain npm`,
        );
      }
    }
  }
  manifests.set(entry.source.replace(/^\.\//, ""), manifest);
}

if (
  marketplace.schemaVersion === 2 &&
  marketplace.$schema !== "https://getbb.app/schemas/marketplace-v2.schema.json"
) {
  errors.push("marketplace: schemaVersion 2 requires the marketplace-v2 $schema URL");
}
for (const plugin of marketplace.plugins) {
  const iconUrl = plugin.icon?.url;
  if (typeof iconUrl !== "string" || iconUrl.length === 0) {
    errors.push(`marketplace ${plugin.id}: icon.url is required by bb`);
  } else if (iconUrl.startsWith("./") && !existsSync(path.join(root, "marketplace", iconUrl))) {
    errors.push(`marketplace ${plugin.id}: icon ${iconUrl} does not exist next to the manifest`);
  }

  const git = plugin.source?.git;
  if (!git) {
    errors.push(`marketplace ${plugin.id}: only git sources are expected in this repository`);
    continue;
  }
  const manifest = manifests.get(git.subdir);
  if (!manifest) {
    errors.push(`marketplace ${plugin.id}: subdir ${git.subdir} is not in .bb/plugins.json`);
    continue;
  }
  const expectedId = pluginIdFromPackageName(manifest.name);
  if (plugin.id !== expectedId) {
    errors.push(`marketplace ${plugin.id}: package ${manifest.name} yields id ${expectedId}`);
  }
  const expectedPrefix = `${path.basename(git.subdir)}/`;
  if (git.tagPrefix !== expectedPrefix) {
    errors.push(`marketplace ${plugin.id}: tagPrefix should be ${expectedPrefix}`);
  }
}

if (errors.length > 0) {
  console.error("marketplace check failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(
  `marketplace check passed: ${marketplace.plugins.length} plugins, ${manifests.size} collection entries`,
);
