// Checks going back from a 1ma with built-in plugins (patches 0014, 0015) to
// the last release without them, on one data folder, the way the owner's
// machines would: the older release installs the 1ma plugins from git (Mac)
// and from a release folder (Linux); the new one takes them over, adds one
// they did not have and refuses the way back while it runs;
// server/dist/one-ma-rollback.js removes the built-in rows; the older release
// starts, the plugins are installed again and find their settings and
// secrets, the one it never had keeps its secret; the new one takes them over
// again. Run in CI only (it starts servers):
//
//   node desktop/scripts/check-rollback.mjs <older server tgz> <new server tgz>
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installTarball, pluginsRunning, startServer, until } from "./test-server.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EMBEDDED = JSON.parse(
  readFileSync(path.join(repo, "desktop", "embedded-plugins.json"), "utf8"),
);
const FROM_GIT = ["1ma-brand", "1ma-auto-updates"];
const FROM_FOLDER = "1ma-theme";
const COPIES = [...FROM_GIT, FROM_FOLDER];
const NEW_ONLY = "1ma-server-switcher";
const SECRET_KEY = "probe";

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
const releaseFolder = path.join(root, "release", "plugins", FROM_FOLDER);

function rollback() {
  return spawnSync(
    process.execPath,
    [path.join(newer.serverDist, "one-ma-rollback.js"), "--data-dir", dataDir],
    { encoding: "utf8" },
  );
}

function writeSecret(plugin, value) {
  const secrets = path.join(dataDir, "plugins", plugin, "secrets");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(path.join(secrets, SECRET_KEY), value);
}

function readSecret(plugin) {
  return readFileSync(path.join(dataDir, "plugins", plugin, "secrets", SECRET_KEY), "utf8");
}

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

function expectBuiltIn(plugins) {
  for (const id of EMBEDDED) {
    check(
      plugins.get(id).source === `builtin:${id}`,
      `${id} is ${plugins.get(id).source}, not built in`,
    );
  }
}

// As on the owner's machines: the Mac from 1ma's repository, Linux from the
// release folder that release-linux.mjs marks.
async function installCopies(server) {
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
  if (!existsSync(releaseFolder)) {
    const release = path.join(root, "release");
    mkdirSync(release, { recursive: true });
    const archive = spawnSync("git", ["-C", repo, "archive", "HEAD", `plugins/${FROM_FOLDER}`], {
      maxBuffer: 64 * 1024 * 1024,
    });
    check(archive.status === 0, `git archive failed: ${archive.stderr}`);
    const untar = spawnSync("tar", ["-x", "-C", release], { input: archive.stdout });
    check(untar.status === 0, `tar failed: ${untar.stderr}`);
    writeFileSync(
      path.join(releaseFolder, ".1ma-release.json"),
      `${JSON.stringify({ repository: "https://github.com/1ma-ai/1ma", commit: "0".repeat(40) })}\n`,
    );
  }
  server.bb(["plugin", "install", releaseFolder, "--yes"]);
  const plugins = await pluginsRunning(server, COPIES);
  for (const id of FROM_GIT) {
    check(plugins.get(id).source.startsWith("git:"), `${id} is ${plugins.get(id).source}`);
  }
  check(
    plugins.get(FROM_FOLDER).source === `path:${releaseFolder}`,
    `${FROM_FOLDER} is ${plugins.get(FROM_FOLDER).source}`,
  );
  return plugins;
}

try {
  await run("older release: install the 1ma plugins", older, async (server) => {
    await installCopies(server);
    server.bb(["plugin", "config", "1ma-auto-updates", "set", "providers", "false"]);
    server.bb(["plugin", "config", "1ma-auto-updates", "set", "plugins", "false"]);
    writeSecret("1ma-brand", "kept");
    console.log("installed from git and from the release folder; a setting and a secret written");
  });

  await run("new release: the copies become built in", newer, async (server) => {
    expectBuiltIn(await pluginsRunning(server, EMBEDDED));
    check((await settingsOf(server, "1ma-auto-updates")).providers === false, "a setting was lost");
    check(
      existsSync(path.join(dataDir, "backups", "before-1ma-builtins.db")),
      "no database copy before the move",
    );
    writeSecret(NEW_ONLY, "new");
    const refused = rollback();
    check(
      refused.status !== 0 && refused.stderr.includes("1ma is running"),
      `the way back ran next to the server: ${refused.status} ${refused.stdout}${refused.stderr}`,
    );
    expectBuiltIn(await pluginsRunning(server, EMBEDDED));
    console.log("built in; the way back refuses while this server runs, and changed nothing");
  });

  const back = rollback();
  process.stdout.write(back.stdout);
  check(back.status === 0, `one-ma-rollback.js failed:\n${back.stderr}`);

  await run("older release again: install the 1ma plugins again", older, async (server) => {
    const before = (await (await server.get("/api/v1/plugins")).json()).plugins ?? [];
    const left = before.filter((plugin) => EMBEDDED.includes(plugin.id)).map((plugin) => plugin.id);
    check(left.length === 0, `the older release starts with ${left.join(", ")} still installed`);
    await installCopies(server);
    check((await settingsOf(server, "1ma-auto-updates")).providers === false, "a setting was lost");
    check(readSecret("1ma-brand") === "kept", "the secret was lost");
    check(readSecret(NEW_ONLY) === "new", `the secret of ${NEW_ONLY} was lost`);
    console.log(
      "installed again with their settings and secrets; the new-only plugin's secret kept",
    );
  });

  await run("new release again", newer, async (server) => {
    expectBuiltIn(await pluginsRunning(server, EMBEDDED));
    check((await settingsOf(server, "1ma-auto-updates")).providers === false, "a setting was lost");
    check(readSecret(NEW_ONLY) === "new", `the secret of ${NEW_ONLY} was lost`);
    console.log("built in again, settings and secrets kept");
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
