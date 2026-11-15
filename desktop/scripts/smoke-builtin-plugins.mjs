// Checks a packed 1ma server the way a new machine gets it: installs the
// tarball into an empty folder, starts it with an empty data folder and asks
// it over HTTP whether the 1ma plugins are built in and serve their files.
// Run in CI only (it starts a server):
//
//   node desktop/scripts/smoke-builtin-plugins.mjs <1ma-server-<version>.tgz>
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installTarball, pluginsRunning, startServer } from "./test-server.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EMBEDDED = JSON.parse(
  readFileSync(path.join(repo, "desktop", "embedded-plugins.json"), "utf8"),
);

const tarball = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node desktop/scripts/smoke-builtin-plugins.mjs <server tarball>");
  process.exit(1);
}
const root = mkdtempSync(path.join(tmpdir(), "1ma-builtin-smoke-"));
const install = path.join(root, "install");
const dataDir = path.join(root, "data");
const server = await startServer(installTarball(tarball, install), dataDir);
const { get } = server;

try {
  const plugins = await pluginsRunning(server, EMBEDDED);
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
  await server.stop();
  rmSync(root, { recursive: true, force: true });
}
