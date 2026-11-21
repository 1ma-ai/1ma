import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";

export const STUB_PROVIDER = "acp-stub";
export const STUB_MODEL = "acp-default";
const STUB_PATH = path.resolve(import.meta.dirname, "stub-acp-agent.mjs");

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
  constructor({ name, port, daemonPort, root, packageDir, env = {} }) {
    this.extraEnv = env;
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
      { env: cleanEnv({ HOME: this.home, ...this.extraEnv }), stdio: ["ignore", "pipe", "pipe"] },
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
      timeout: 300_000,
    });
    if (result.status !== 0) {
      throw new Error(
        `[${this.name}] bb ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
      );
    }
    return result.stdout;
  }

  installPlugin(directory) {
    return this.bb(["plugin", "install", directory, "--yes"]);
  }

  configurePlugin(pluginId, key, value) {
    return this.bb(["plugin", "config", pluginId, "set", key, value]);
  }

  // Registers the stub agent as provider acp-stub; the model has to be named
  // explicitly, a server without a provider CLI cannot pick a default one.
  registerStubAgent(stubLog) {
    const agents = [
      {
        id: "stub",
        displayName: "Stub",
        command: process.execPath,
        args: [STUB_PATH],
        env: { E2E_STUB_LOG: stubLog },
      },
    ];
    this.configurePlugin("provider-acp", "customAgents", JSON.stringify(agents));
  }

  bbJson(args) {
    return JSON.parse(this.bb([...args, "--json"]));
  }

  api(method, pathname, body) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        `${this.url}/api/v1${pathname}`,
        {
          method,
          agent: false,
          headers: {
            accept: "application/json",
            connection: "close",
            ...(payload === undefined ? {} : { "content-type": "application/json" }),
          },
          timeout: 30_000,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 0) >= 400) {
              reject(
                new Error(`[${this.name}] ${method} ${pathname} → ${res.statusCode}: ${text}`),
              );
              return;
            }
            resolve(text === "" ? null : JSON.parse(text));
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () =>
        req.destroy(new Error(`[${this.name}] ${method} ${pathname} timed out`)),
      );
      req.on("error", reject);
      req.end(payload);
    });
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
        await this.api("GET", "/threads?limit=1");
        return true;
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

  async createProject(name, root, remoteUrl = null) {
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
    if (remoteUrl !== null) git("remote", "add", "origin", remoteUrl);
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

// Servers of one test run, each with its own port, data directory and log.
export class Fleet {
  constructor({
    root,
    packageDir = path.join(root, "server-package"),
    firstPort = 39886,
    env = {},
  }) {
    this.root = root;
    this.packageDir = packageDir;
    this.firstPort = firstPort;
    this.env = env;
    this.servers = new Map();
  }

  add(name, { env = {} } = {}) {
    if (this.servers.has(name)) throw new Error(`server ${name} already exists`);
    const index = this.servers.size;
    const server = new Server({
      name,
      port: this.firstPort + index,
      daemonPort: this.firstPort + 10 + index,
      root: this.root,
      packageDir: this.packageDir,
      env: { ...this.env, ...env },
    });
    this.servers.set(name, server);
    return server;
  }

  get(name) {
    const server = this.servers.get(name);
    if (server === undefined) throw new Error(`no server ${name}`);
    return server;
  }

  async startAll() {
    const all = [...this.servers.values()];
    for (const server of all) server.start();
    await Promise.all(all.map((server) => server.waitReady()));
  }

  async stop(name) {
    await this.get(name).stop();
  }

  async restart(name) {
    const server = this.get(name);
    await server.stop();
    server.start();
    await server.waitReady();
  }

  async stopAll() {
    await Promise.all([...this.servers.values()].map((server) => server.stop()));
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
