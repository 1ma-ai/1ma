// Checks a packed 1ma server the way a new machine gets it: installs the
// tarball into an empty folder, starts it with an empty data folder and asks
// it over HTTP whether the 1ma plugins are built in and serve their files.
// Run in CI only (it starts a server):
//
//   node desktop/scripts/smoke-builtin-plugins.mjs <1ma-server-<version>.tgz>
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EMBEDDED = JSON.parse(
  readFileSync(path.join(repo, "desktop", "embedded-plugins.json"), "utf8"),
);
const TIMEOUT_MS = 120_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function until(label, check, deadline = Date.now() + TIMEOUT_MS, last = "no answer yet") {
  if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}: ${last}`);
  let why = last;
  try {
    const result = await check();
    if (result.done) return result.value;
    why = result.why;
  } catch (error) {
    why = error.message;
  }
  await delay(1_000);
  return until(label, check, deadline, why);
}

const tarball = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node desktop/scripts/smoke-builtin-plugins.mjs <server tarball>");
  process.exit(1);
}
const root = mkdtempSync(path.join(tmpdir(), "1ma-builtin-smoke-"));
const install = path.join(root, "install");
const dataDir = path.join(root, "data");
const npm = spawnSync("npm", ["install", "--prefix", install, "--no-audit", "--no-fund", tarball], {
  encoding: "utf8",
});
if (npm.status !== 0) throw new Error(`npm install failed:\n${npm.stdout}${npm.stderr}`);

const [serverPort, daemonPort] = [await freePort(), await freePort()];
const base = `http://127.0.0.1:${serverPort}`;
const server = spawn(
  path.join(install, "node_modules", ".bin", "bb-app"),
  [
    "--data-dir",
    dataDir,
    "--server-port",
    String(serverPort),
    "--host-daemon-port",
    String(daemonPort),
    "--no-in-app-updates",
  ],
  { env: { ...process.env, BB_LOG_LEVEL: "warn", BB_TELEMETRY: "false" }, stdio: "inherit" },
);

const get = async (route) => {
  const response = await fetch(`${base}${route}`);
  if (!response.ok) throw new Error(`GET ${route}: HTTP ${response.status}`);
  return response;
};

try {
  const plugins = await until("the 1ma plugins to run as built-ins", async () => {
    const list = (await (await get("/api/v1/plugins")).json()).plugins ?? [];
    const byId = new Map(list.map((plugin) => [plugin.id, plugin]));
    const failed = EMBEDDED.filter(
      (id) => byId.get(id)?.status === "error" && byId.get(id)?.statusDetail !== "not loaded",
    );
    if (failed.length > 0)
      throw new Error(failed.map((id) => `${id}: ${byId.get(id).statusDetail}`).join("; "));
    const waiting = EMBEDDED.filter((id) => byId.get(id)?.status !== "running");
    return waiting.length === 0
      ? { done: true, value: byId }
      : {
          done: false,
          why: waiting.map((id) => `${id}=${byId.get(id)?.status ?? "missing"}`).join(", "),
        };
  });
  for (const id of EMBEDDED) {
    const plugin = plugins.get(id);
    if (plugin.source !== `builtin:${id}`)
      throw new Error(`${id} comes from ${plugin.source}, not built in`);
    if (!path.resolve(plugin.rootDir).startsWith(install))
      throw new Error(`${id} loads from ${plugin.rootDir}, outside the installed package`);
    console.log(`${id}@${plugin.version}: running, built in`);
  }
  const assets = await Promise.all(
    [
      ["favicon-32.png", "image/png"],
      ["app-icon-512.png", "image/png"],
      ["icon.svg", "image/svg+xml"],
    ].map(async ([file, type]) => {
      const response = await get(`/api/v1/plugins/1ma-brand/http/${file}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const served = response.headers.get("content-type") ?? "";
      if (!served.startsWith(type) || bytes.length < 100)
        throw new Error(`1ma-brand ${file}: ${served}, ${bytes.length} bytes`);
      return `1ma-brand serves ${file} (${bytes.length} bytes)`;
    }),
  );
  for (const line of assets) console.log(line);
  const catalog = await (await get("/api/v1/settings/themes")).json();
  const theme = (catalog.plugins ?? []).find((entry) =>
    JSON.stringify(entry).includes("1ma-theme"),
  );
  if (theme === undefined) throw new Error("the theme catalog has no 1ma theme");
  const resolved = JSON.stringify(
    await (await get(`/api/v1/settings/themes/${encodeURIComponent(theme.id)}`)).json(),
  );
  if (!/--[a-z][a-z0-9-]*\s*:/u.test(resolved))
    throw new Error(`the 1ma theme resolves without its CSS: ${resolved.slice(0, 300)}`);
  console.log(`the 1ma theme (${theme.id}) resolves with its CSS`);
} finally {
  server.kill("SIGTERM");
  await delay(2_000);
  if (server.exitCode === null) server.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}
