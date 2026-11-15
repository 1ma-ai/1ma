// Checks going back from a 1ma with built-in plugins (patches 0014, 0015) to
// the last release without them, on one data folder, the way the owner's
// machines would: the older release installs the 1ma plugins from git (Mac)
// and from a release folder (Linux), the new one takes them over, bb's
// artifact GC removes the old checkouts, server/dist/one-ma-rollback.js puts
// the installs back, the older release runs them with their settings and
// secrets, and the new one takes them over again. Run in CI only (it starts
// servers):
//
//   node desktop/scripts/check-rollback.mjs <older server tgz> <new server tgz>
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { installTarball, pluginsRunning, startServer, until } from "./test-server.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EMBEDDED = JSON.parse(
  readFileSync(path.join(repo, "desktop", "embedded-plugins.json"), "utf8"),
);
const FROM_GIT = ["1ma-brand", "1ma-auto-updates"];
const FROM_FOLDER = "1ma-theme";
const COPIES = [...FROM_GIT, FROM_FOLDER];
const SECRET = { plugin: "1ma-brand", key: "probe", value: "kept" };

const [olderTarball, newTarball] = process.argv.slice(2);
if (olderTarball === undefined || newTarball === undefined) {
  console.error(
    "usage: node desktop/scripts/check-rollback.mjs <older server tgz> <new server tgz>",
  );
  process.exit(1);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(path.join(tmpdir(), "1ma-rollback-"));
const dataDir = path.join(root, "data");
const older = installTarball(path.resolve(olderTarball), path.join(root, "older"));
const newer = installTarball(path.resolve(newTarball), path.join(root, "new"));

async function run(label, installed, steps) {
  console.log(`--- ${label}`);
  const server = await startServer(installed, dataDir);
  try {
    await until("the server", async () => ({ done: (await server.get("/api/v1/plugins")).ok }));
    return await steps(server);
  } finally {
    await server.stop();
  }
}

async function settingsOf(server, id) {
  return (await (await server.get(`/api/v1/plugins/${id}/settings`)).json()).values ?? {};
}

function sources(plugins, ids) {
  return Object.fromEntries(ids.map((id) => [id, plugins.get(id)?.source]));
}

function expectBuiltIn(plugins) {
  for (const id of EMBEDDED) {
    check(
      plugins.get(id).source === `builtin:${id}`,
      `${id} is ${plugins.get(id).source}, not built in`,
    );
  }
}

try {
  const installedBefore = await run(
    "older release: install the 1ma plugins as before",
    older,
    async (server) => {
      for (const id of FROM_GIT) {
        server.bb([
          "plugin",
          "install",
          "git:https://github.com/1ma-ai/1ma.git@^0",
          "--subdirectory",
          `plugins/${id}`,
          "--tag-prefix",
          `${id}/`,
          "--yes",
        ]);
      }
      const release = path.join(root, "release");
      mkdirSync(release, { recursive: true });
      const archive = spawnSync("git", ["-C", repo, "archive", "HEAD", `plugins/${FROM_FOLDER}`], {
        maxBuffer: 64 * 1024 * 1024,
      });
      check(archive.status === 0, `git archive failed: ${archive.stderr}`);
      const untar = spawnSync("tar", ["-x", "-C", release], { input: archive.stdout });
      check(untar.status === 0, `tar failed: ${untar.stderr}`);
      const folder = path.join(release, "plugins", FROM_FOLDER);
      writeFileSync(
        path.join(folder, ".1ma-release.json"),
        `${JSON.stringify({ repository: "https://github.com/1ma-ai/1ma", commit: "0".repeat(40) })}\n`,
      );
      server.bb(["plugin", "install", folder, "--yes"]);
      await pluginsRunning(server, ["1ma-auto-updates"]);
      server.bb(["plugin", "config", "1ma-auto-updates", "set", "providers", "false"]);
      server.bb(["plugin", "config", "1ma-auto-updates", "set", "plugins", "false"]);
      const secrets = path.join(dataDir, "plugins", SECRET.plugin, "secrets");
      mkdirSync(secrets, { recursive: true });
      writeFileSync(path.join(secrets, SECRET.key), SECRET.value);
      const plugins = await pluginsRunning(server, COPIES);
      const before = sources(plugins, COPIES);
      for (const id of FROM_GIT) check(before[id].startsWith("git:"), `${id} is ${before[id]}`);
      check(before[FROM_FOLDER].startsWith("path:"), `${FROM_FOLDER} is ${before[FROM_FOLDER]}`);
      console.log("installed:", JSON.stringify(before));
      return before;
    },
  );

  await run("new release: the copies become built in", newer, async (server) => {
    expectBuiltIn(await pluginsRunning(server, EMBEDDED));
    check((await settingsOf(server, "1ma-auto-updates")).providers === false, "a setting was lost");
    const saved = JSON.parse(
      readFileSync(path.join(dataDir, "backups", "before-1ma-builtins", "plugins.json"), "utf8"),
    );
    check(
      JSON.stringify(saved.plugins.map((plugin) => plugin.id).sort()) ===
        JSON.stringify([...COPIES].sort()),
      `the saved installs are ${saved.plugins.map((plugin) => plugin.id).join(", ")}`,
    );
    console.log("built in; saved installs:", saved.plugins.map((plugin) => plugin.id).join(", "));
  });

  const database = new DatabaseSync(path.join(dataDir, "bb.db"));
  const marks = FROM_GIT.map(() => "?").join(", ");
  const artifacts = database
    .prepare(
      `SELECT id, git_checkout_root, path FROM plugin_artifacts WHERE plugin_id IN (${marks})`,
    )
    .all(...FROM_GIT);
  check(artifacts.length > 0, "the git installs left no artifacts to remove");
  for (const artifact of artifacts) {
    rmSync(artifact.git_checkout_root ?? artifact.path, { recursive: true, force: true });
  }
  database.prepare(`DELETE FROM plugin_artifacts WHERE plugin_id IN (${marks})`).run(...FROM_GIT);
  database.close();
  console.log(`--- removed ${artifacts.length} git artifact(s), as bb's GC does a week later`);

  const restore = spawnSync(
    process.execPath,
    [path.join(newer.serverDist, "one-ma-rollback.js"), "--data-dir", dataDir],
    { encoding: "utf8" },
  );
  process.stdout.write(restore.stdout);
  check(restore.status === 0, `one-ma-rollback.js failed:\n${restore.stderr}`);

  await run("older release again, after the restore", older, async (server) => {
    const plugins = await pluginsRunning(server, COPIES);
    const after = sources(plugins, COPIES);
    check(
      JSON.stringify(after) === JSON.stringify(installedBefore),
      `sources ${JSON.stringify(after)} instead of ${JSON.stringify(installedBefore)}`,
    );
    check((await settingsOf(server, "1ma-auto-updates")).providers === false, "a setting was lost");
    const secret = readFileSync(
      path.join(dataDir, "plugins", SECRET.plugin, "secrets", SECRET.key),
      "utf8",
    );
    check(secret === SECRET.value, "the secret was lost");
    console.log(
      "the older release runs the 1ma plugins as installed before, settings and secret kept",
    );
  });

  await run("new release again", newer, async (server) => {
    expectBuiltIn(await pluginsRunning(server, EMBEDDED));
    check((await settingsOf(server, "1ma-auto-updates")).providers === false, "a setting was lost");
    console.log("built in again, settings kept");
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
