import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function cleanEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("BB_") || key.startsWith("GITHUB_") || key === "GH_TOKEN") continue;
    env[key] = value;
  }
  return { ...env, BB_TELEMETRY: "false", DISABLE_TELEMETRY: "1", ...extra };
}

export class Server {
  constructor({ name, port, daemonPort, root, packageDir }) {
    this.name = name;
    this.port = port;
    this.daemonPort = daemonPort;
    this.url = `http://127.0.0.1:${port}`;
    this.dataDir = path.join(root, name, "data");
    this.home = path.join(root, name, "home");
    this.logFile = path.join(root, `${name}.log`);
    this.packageDir = packageDir;
    this.process = null;
  }

  get bbApp() {
    return path.join(this.packageDir, "node_modules/bb-app/dist/bb-app.js");
  }

  get bbCli() {
    return path.join(this.packageDir, "node_modules/bb-app/dist/bb.js");
  }

  start() {
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.home, { recursive: true });
    const log = createWriteStream(this.logFile, { flags: "a" });
    this.process = spawn(
      process.execPath,
      [
        this.bbApp,
        "--data-dir",
        this.dataDir,
        "--server-bind-host",
        "127.0.0.1",
        "--server-port",
        String(this.port),
        "--host-daemon-port",
        String(this.daemonPort),
        "--no-in-app-updates",
        "--bundled",
      ],
      { env: cleanEnv({ HOME: this.home }), stdio: ["ignore", "pipe", "pipe"] },
    );
    this.process.stdout.pipe(log);
    this.process.stderr.pipe(log);
  }

  async stop() {
    if (this.process === null || this.process.exitCode !== null) return;
    const exited = new Promise((resolve) => this.process.once("exit", resolve));
    this.process.kill("SIGTERM");
    const timer = setTimeout(() => this.process.kill("SIGKILL"), 20_000);
    await exited;
    clearTimeout(timer);
  }

  bb(args, { input } = {}) {
    const result = spawnSync(process.execPath, [this.bbCli, ...args], {
      env: cleanEnv({ HOME: this.home, BB_SERVER_URL: this.url, BB_DATA_DIR: this.dataDir }),
      encoding: "utf8",
      input,
      timeout: 120_000,
    });
    if (result.status !== 0) {
      throw new Error(
        `[${this.name}] bb ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
      );
    }
    return result.stdout;
  }

  bbJson(args) {
    return JSON.parse(this.bb([...args, "--json"]));
  }

  async api(method, pathname, body) {
    const response = await fetch(`${this.url}/api/v1${pathname}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`[${this.name}] ${method} ${pathname} → ${response.status}: ${text}`);
    return text === "" ? null : JSON.parse(text);
  }

  async rpc(pluginId, method, input) {
    const envelope = await this.api("POST", `/plugins/${pluginId}/rpc/${method}`, input);
    if (envelope?.ok !== true)
      throw new Error(`[${this.name}] rpc ${method}: ${JSON.stringify(envelope)}`);
    return envelope.result;
  }

  async waitReady(timeoutMs = 180_000) {
    await waitFor(`${this.name} answers`, timeoutMs, async () => {
      if (this.process?.exitCode !== null)
        throw new Error(`${this.name} exited; see ${this.logFile}`);
      try {
        const response = await fetch(`${this.url}/api/v1/threads?limit=1`);
        return response.ok;
      } catch {
        return false;
      }
    });
    await waitFor(`${this.name} has a connected machine`, timeoutMs, async () => {
      const hosts = await this.api("GET", "/hosts");
      return hosts.some((host) => host.status === "connected");
    });
  }

  async hostId() {
    const hosts = await this.api("GET", "/hosts");
    const host = hosts.find((candidate) => candidate.status === "connected");
    if (host === undefined) throw new Error(`[${this.name}] no connected machine`);
    return host.id;
  }

  async createProject(name, root) {
    mkdirSync(root, { recursive: true });
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    };
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(root, "README.md"), `# ${name}\n`);
    git("add", "README.md");
    git(
      "-c",
      "user.name=e2e",
      "-c",
      "user.email=e2e@example.invalid",
      "commit",
      "-q",
      "-m",
      "init",
    );
    const project = this.bbJson([
      "project",
      "create",
      "--name",
      name,
      "--root",
      root,
      "--machine",
      await this.hostId(),
    ]);
    return project.id;
  }
}

export async function waitFor(label, timeoutMs, check, intervalMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  const attempt = async (lastError) => {
    let error = lastError;
    try {
      const value = await check();
      if (value) return value;
    } catch (caught) {
      error = caught;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}${error ? `: ${error.message}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    return attempt(error);
  };
  return attempt(null);
}
