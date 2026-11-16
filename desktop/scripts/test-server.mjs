// Starts packed 1ma servers for the checks that run in CI only
// (smoke-builtin-plugins.mjs, check-rollback.mjs).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

const TIMEOUT_MS = 180_000;

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// check() returns { done: true, value } or { done: false, why }; a throw counts
// as not done yet, and its message is reported if time runs out.
export async function until(
  label,
  check,
  deadline = Date.now() + TIMEOUT_MS,
  last = "no answer yet",
) {
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

export function installTarball(tarball, install) {
  const npm = spawnSync(
    "npm",
    ["install", "--prefix", install, "--no-audit", "--no-fund", tarball],
    {
      encoding: "utf8",
    },
  );
  if (npm.status !== 0) throw new Error(`npm install failed:\n${npm.stdout}${npm.stderr}`);
  return {
    bin: (name) => path.join(install, "node_modules", ".bin", name),
    serverDist: path.join(install, "node_modules", "bb-app", "server", "dist"),
  };
}

export async function startServer(installed, dataDir) {
  const [serverPort, daemonPort] = [await freePort(), await freePort()];
  const base = `http://127.0.0.1:${serverPort}`;
  const child = spawn(
    installed.bin("bb-app"),
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
  const bb = (args) => {
    const result = spawnSync(installed.bin("bb"), args, {
      encoding: "utf8",
      env: { ...process.env, BB_SERVER_URL: base },
    });
    if (result.status !== 0) {
      throw new Error(`bb ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
    }
    return result.stdout;
  };
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(15_000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  };
  return { base, get, bb, stop };
}

// The plugins by id once every one of `ids` reports `running`.
export function pluginsRunning(server, ids) {
  return until(`${ids.join(", ")} to run`, async () => {
    const list = (await (await server.get("/api/v1/plugins")).json()).plugins ?? [];
    const byId = new Map(list.map((plugin) => [plugin.id, plugin]));
    const failed = ids.filter(
      (id) => byId.get(id)?.status === "error" && byId.get(id)?.statusDetail !== "not loaded",
    );
    if (failed.length > 0) {
      throw new Error(failed.map((id) => `${id}: ${byId.get(id).statusDetail}`).join("; "));
    }
    const waiting = ids.filter((id) => byId.get(id)?.status !== "running");
    return waiting.length === 0
      ? { done: true, value: byId }
      : {
          done: false,
          why: waiting.map((id) => `${id}=${byId.get(id)?.status ?? "missing"}`).join(", "),
        };
  });
}
