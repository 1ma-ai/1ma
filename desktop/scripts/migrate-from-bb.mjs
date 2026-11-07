// Moves one computer from bb to 1ma and leaves bb as it was.
//
//   export  (bb running)  turns on bb's "Server move" experiment and writes an
//                         export of the bb server with bb's own CLI.
//   import  (bb and 1ma stopped)  installs that export into 1ma's data folder
//                         with 1ma's CLI, then copies what an export leaves on
//                         the machine: its identity (host-id, auth.json), thread
//                         files, local plugins and the plugins' machine data.
//
// The export carries the server: the database, settings, attachments, skills,
// theme and installed plugins. 1ma rewrites the plugin paths under ~/.bb at its
// first start. With the same machine identity, threads stay on this computer
// instead of on an offline copy of it. Git worktrees stay where they are: the
// database keeps their paths. Nothing in the bb data folder is changed.
//
// Runs on Node 22 or newer, or on the 1ma app's own runtime with
// ELECTRON_RUN_AS_NODE=1, so a Mac needs no Node installation.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_FILES = ["host-id", "auth.json"];
export const HOST_DIRECTORIES = ["thread-storage", "local-plugins"];
export const PLUGIN_HOST_DIRECTORIES = ["host-data", "bridge-data"];
export const LEFT_IN_PLACE = ["plugins/environment-git-worktree/host-data/worktrees"];
const DAEMON_LOCK = "daemon.lock.lock";
const DAEMON_LOCK_FRESH_MS = 60_000;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "export" && command !== "import")
    throw new Error(
      "usage: migrate-from-bb.mjs export --out <file> | import --archive <file> --cli <1ma bb.js> [--move-aside] [--dry-run]",
    );
  const options = { command, from: null, to: null, out: null, archive: null, cli: null, bb: null };
  const flags = { "--move-aside": "moveAside", "--dry-run": "dryRun" };
  const values = {
    "--from": "from",
    "--to": "to",
    "--out": "out",
    "--archive": "archive",
    "--cli": "cli",
    "--bb": "bb",
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (flags[arg]) options[flags[arg]] = true;
    else if (values[arg]) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      options[values[arg]] = path.resolve(value);
      i += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  options.from ??= path.join(homedir(), ".bb");
  options.to ??= path.join(homedir(), ".1ma");
  if (command === "export" && !options.out) throw new Error("export needs --out <file>");
  if (command === "import" && (!options.archive || !options.cli))
    throw new Error("import needs --archive <file> and --cli <path to 1ma's bb.js>");
  return options;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// What still runs from a data folder: the server, as its runtime file says,
// or a machine daemon that keeps its lock fresh.
export function runningFrom(dataDir, now = Date.now()) {
  const found = [];
  const runtimeFile = path.join(dataDir, "bb-app-runtime.json");
  if (existsSync(runtimeFile)) {
    try {
      const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
      if (isAlive(runtime.pid)) found.push(`server pid ${runtime.pid} (${runtime.version})`);
    } catch {
      found.push(`an unreadable ${runtimeFile}`);
    }
  }
  const lock = path.join(dataDir, DAEMON_LOCK);
  if (existsSync(lock) && now - statSync(lock).mtimeMs < DAEMON_LOCK_FRESH_MS)
    found.push(`a machine daemon (${lock} changed in the last minute)`);
  return found;
}

function inPlace(relative) {
  return LEFT_IN_PLACE.some((kept) => relative === kept || relative.startsWith(`${kept}/`));
}

// The parts of a bb data folder that a server export does not carry.
export function hostCopyPlan(from) {
  const entries = [];
  for (const name of HOST_FILES)
    if (existsSync(path.join(from, name))) entries.push({ relative: name, kind: "file" });
  for (const name of HOST_DIRECTORIES)
    if (existsSync(path.join(from, name))) entries.push({ relative: name, kind: "directory" });
  const plugins = path.join(from, "plugins");
  if (existsSync(plugins))
    for (const plugin of readdirSync(plugins, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      for (const child of PLUGIN_HOST_DIRECTORIES) {
        const relative = `plugins/${plugin.name}/${child}`;
        if (existsSync(path.join(from, relative))) entries.push({ relative, kind: "directory" });
      }
    }
  return entries;
}

export function copyHost({ from, to, plan }) {
  for (const { relative } of plan) {
    const target = path.join(to, relative);
    if (existsSync(target))
      throw new Error(`${target} already exists; the import should not have written it`);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(from, relative), target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (source) => !inPlace(path.relative(from, source).split(path.sep).join("/")),
    });
  }
}

// bb's CLI reads BB_* variables first; a terminal inside a bb thread has them
// set for that bb, so the commands get only the ones given here.
function run(command, args, env = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("BB_")),
  );
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...inherited, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${path.basename(command)} ${args.join(" ")} exited ${result.status}\n${result.stdout}${result.stderr}`,
    );
  return result.stdout;
}

const runtimeEnv = () => (process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {});

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function exportBb(options, log = console.log) {
  const bb = options.bb ?? path.join(options.from, "bin", "bb");
  if (!runningFrom(options.from).some((found) => found.startsWith("server pid")))
    throw new Error(
      `no bb server is running from ${options.from}; the export reads a running bb server`,
    );
  if (existsSync(options.out)) throw new Error(`${options.out} already exists`);
  mkdirSync(path.dirname(options.out), { recursive: true });
  const runtime = JSON.parse(readFileSync(path.join(options.from, "bb-app-runtime.json"), "utf8"));
  const env = { BB_DATA_DIR: options.from, BB_SERVER_URL: runtime.serverUrl };
  run(bb, ["settings", "experiment", "serverMove", "true"], env);
  const exported = JSON.parse(run(bb, ["server", "export", "--out", options.out, "--json"], env));
  log(
    `exported the bb server to ${exported.path} (${exported.sizeBytes} bytes, sha256 ${exported.sha256})`,
  );
  log(
    "the export holds secrets and is not encrypted: keep it private and delete it once 1ma works",
  );
  log("next: quit bb completely, then run the import");
  return exported;
}

export function importIntoOneMa(options, log = console.log, now = new Date()) {
  const { from, to } = options;
  if (!existsSync(path.join(from, "bb.db")) || !existsSync(path.join(from, "host-id")))
    throw new Error(`${from} is not a bb data folder (no bb.db or host-id)`);
  if (!existsSync(options.archive)) throw new Error(`${options.archive} does not exist`);
  if (!existsSync(options.cli)) throw new Error(`1ma's CLI is not at ${options.cli}`);
  for (const [name, dir] of [
    ["bb", from],
    ["1ma", to],
  ]) {
    const running = existsSync(dir) ? runningFrom(dir) : [];
    if (running.length > 0)
      throw new Error(`${name} still runs from ${dir}: ${running.join(", ")}. Quit it first.`);
  }
  const stamp = now.toISOString().replaceAll(":", "-");
  let movedAside = null;
  if (existsSync(to) && readdirSync(to).length > 0) {
    if (!options.moveAside)
      throw new Error(
        `${to} is not empty. Rerun with --move-aside to keep it as ${to}.before-migration-<time>, or move it yourself.`,
      );
    movedAside = `${to}.before-migration-${stamp}`;
  }
  const plan = hostCopyPlan(from);
  log(`bb data: ${from}\n1ma data: ${to}\narchive: ${options.archive}`);
  if (movedAside) log(`move the current ${to} aside to ${movedAside}`);
  log(
    `import the archive with ${options.cli}, then copy from bb: ${plan.map((entry) => entry.relative).join(", ")}`,
  );
  log(`left where they are: ${LEFT_IN_PLACE.join(", ")}`);
  if (options.dryRun) return { plan, movedAside, dryRun: true };

  if (movedAside) renameSync(to, movedAside);
  const imported = JSON.parse(
    run(
      process.execPath,
      [options.cli, "server", "import", options.archive, "--data-dir", to, "--yes", "--json"],
      { ...runtimeEnv(), BB_DATA_DIR: to },
    ),
  );
  const hostId = readFileSync(path.join(from, "host-id"), "utf8").trim();
  if (imported.sourceServerHostId !== hostId || !samePath(imported.sourceDataDir, from)) {
    const failed = `${to}.wrong-archive-${stamp}`;
    renameSync(to, failed);
    throw new Error(
      `the archive was exported from ${imported.sourceDataDir} (machine ${imported.sourceServerHostId}), not from ${from} (machine ${hostId}); its import is kept in ${failed}`,
    );
  }
  copyHost({ from, to, plan });
  const record = {
    migratedAt: now.toISOString(),
    from,
    archive: options.archive,
    bbVersion: imported.bbVersion,
    importedEntries: imported.importedEntries.length,
    copied: plan.map((entry) => entry.relative),
    leftInPlace: LEFT_IN_PLACE,
    movedAside,
  };
  writeFileSync(path.join(to, "1ma-migration.json"), `${JSON.stringify(record, null, 2)}\n`);
  log(
    `imported ${record.importedEntries} files exported by bb ${record.bbVersion} and copied ${plan.length} machine entries`,
  );
  log("next: start 1ma. On its first start it finishes the import and rewrites the plugin paths.");
  log(
    `bb connect stays off in 1ma until you run: bb server allow-connect --data-dir ${to} (only once bb is no longer used, or both servers fight over the tunnel)`,
  );
  return record;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.command === "export") exportBb(options);
  else importIntoOneMa(options);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
