// Moves one computer from bb to 1ma.
//
//   export  (bb running)  turns on bb's "Server move" experiment and writes an
//                         export of the bb server with bb's own CLI. Quit bb
//                         right after it.
//   import  (bb and 1ma stopped)  installs that export into 1ma's data folder
//                         with 1ma's CLI, then copies what an export leaves on
//                         the machine: its identity (host-id, auth.json), thread
//                         files, local plugins and the plugins' machine data.
//
// The export carries the server: the database, settings, attachments, skills,
// theme and installed plugins. 1ma rewrites the plugin paths under ~/.bb at its
// first start. With the same machine identity, threads stay on this computer
// instead of on an offline copy of it.
//
// Working folders stay where bb made them, because the database keeps their
// paths: git worktrees, personal workspaces and projects bb cloned. 1ma works in
// them inside ~/.bb from then on, so ~/.bb must not be deleted while 1ma is
// used. The script itself writes nothing into ~/.bb, and bb's database stays as
// it was at the export.
//
// Runs on Node 22 or newer, or on the 1ma app's own runtime with
// ELECTRON_RUN_AS_NODE=1, so a Mac needs no Node installation.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
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
// Copying these would leave stale duplicates: the database points at the
// originals, and 1ma removes them there when their threads are archived.
export const LEFT_IN_PLACE = [
  "plugins/environment-git-worktree/host-data/worktrees",
  "plugins/environment-personal-workspace/host-data/workspaces",
];
// Everything 1ma keeps working in inside the bb folder, including the
// layouts of older bb versions and projects bb cloned.
export const SHARED_WITH_BB = [...LEFT_IN_PLACE, "checkouts", "worktrees", "personal-workspaces"];
// Files written here after the export mean bb was used after it.
const ACTIVITY = ["thread-storage", "attachments"];
const ACTIVITY_GRACE_MS = 2 * 60_000;
const DAEMON_LOCK = "daemon.lock.lock";
const DAEMON_LOCK_FRESH_MS = 60_000;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "export" && command !== "import")
    throw new Error(
      "usage: migrate-from-bb.mjs export --out <file> | import --archive <file> --cli <1ma bb.js> [--move-aside] [--dry-run] [--archive-is-current]",
    );
  const options = { command, from: null, to: null, out: null, archive: null, cli: null, bb: null };
  const flags = {
    "--move-aside": "moveAside",
    "--dry-run": "dryRun",
    "--archive-is-current": "archiveIsCurrent",
  };
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

function listProcesses() {
  const result = spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot list processes with ps: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
}

// Processes with a file inside one of the folders on their command line:
// plugin workers, a browser profile, a server started by hand. This script
// and the shells that started it are left out: their command line may name
// such a file.
export function processesUsing(dirs, list = listProcesses, self = process.pid) {
  const prefixes = dirs.map((dir) => `${path.resolve(dir)}/`);
  const processes = list();
  const parents = new Map(processes.map(({ pid, ppid }) => [pid, ppid]));
  const own = new Set();
  for (let pid = self; pid > 1 && !own.has(pid); pid = parents.get(pid) ?? 0) own.add(pid);
  return processes.filter(
    ({ pid, command }) => !own.has(pid) && prefixes.some((prefix) => command.includes(prefix)),
  );
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

// Files under the folders that change only when bb is used, written after a
// moment; symbolic links are not followed.
export function writtenAfter(roots, time, limit = 3) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && lstatSync(full).mtimeMs > time) found.push(full);
    }
  };
  for (const root of roots) if (existsSync(root)) visit(root);
  return found;
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function within(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function real(dir) {
  return existsSync(dir) ? realpathSync(dir) : path.resolve(dir);
}

function overlaps(a, b) {
  return within(real(a), real(b)) || within(real(b), real(a));
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
  log("bb's Server move experiment is now on; it only allows exports and moves");
  log(
    "the export holds secrets and is not encrypted: keep it private and delete it once 1ma works",
  );
  log("next: quit bb completely right away, then run the import");
  return exported;
}

function checkBeforeImport(options) {
  const { from, to } = options;
  if (overlaps(from, to)) throw new Error(`${from} and ${to} must be two separate folders`);
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
  const busy = processesUsing([from, to], options.listProcesses);
  if (busy.length > 0)
    throw new Error(
      `these processes still use ${from} or ${to}; quit bb and 1ma completely first:\n${busy.map((found) => `  ${found.pid} ${found.command.slice(0, 160)}`).join("\n")}`,
    );
  const exportedAt = statSync(options.archive).mtimeMs;
  const later = writtenAfter(
    ACTIVITY.map((name) => path.join(from, name)),
    exportedAt + ACTIVITY_GRACE_MS,
  );
  if (later.length > 0 && !options.archiveIsCurrent)
    throw new Error(
      `bb wrote files after the export, so the export misses that work (for example ${later[0]}). Export again right before quitting bb, or pass --archive-is-current if nothing in bb changed since.`,
    );
}

export function importIntoOneMa(options, log = console.log, now = new Date()) {
  const { from, to } = options;
  checkBeforeImport(options);
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
  const shared = SHARED_WITH_BB.filter((relative) => existsSync(path.join(from, relative)));
  log(`bb data: ${from}\n1ma data: ${to}\narchive: ${options.archive}`);
  if (movedAside) log(`move the current ${to} aside to ${movedAside}`);
  log(
    `import the archive with ${options.cli}, then copy from bb: ${plan.map((entry) => entry.relative).join(", ")}`,
  );
  log(`left where they are, 1ma works in them inside ${from}: ${shared.join(", ") || "none here"}`);
  if (options.dryRun) return { plan, movedAside, shared, dryRun: true };

  if (movedAside) renameSync(to, movedAside);
  let record;
  try {
    const imported = JSON.parse(
      run(
        process.execPath,
        [options.cli, "server", "import", options.archive, "--data-dir", to, "--yes", "--json"],
        { ...runtimeEnv(), BB_DATA_DIR: to },
      ),
    );
    const hostId = readFileSync(path.join(from, "host-id"), "utf8").trim();
    if (imported.sourceServerHostId !== hostId || !samePath(imported.sourceDataDir, from))
      throw new Error(
        `the archive was exported from ${imported.sourceDataDir} (machine ${imported.sourceServerHostId}), not from ${from} (machine ${hostId})`,
      );
    copyHost({ from, to, plan });
    record = {
      migratedAt: now.toISOString(),
      from,
      archive: options.archive,
      bbVersion: imported.bbVersion,
      importedEntries: imported.importedEntries.length,
      copied: plan.map((entry) => entry.relative),
      sharedWithBb: shared,
      movedAside,
    };
    writeFileSync(path.join(to, "1ma-migration.json"), `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    const failed = `${to}.failed-${stamp}`;
    if (existsSync(to)) renameSync(to, failed);
    if (movedAside) renameSync(movedAside, to);
    throw new Error(
      `${error.message}\nNothing was written into ${from}. What the import wrote is kept in ${failed}${movedAside ? `, and ${to} is back as it was` : ""}.`,
      { cause: error },
    );
  }
  log(
    `imported ${record.importedEntries} files exported by bb ${record.bbVersion} and copied ${plan.length} machine entries`,
  );
  if (shared.length > 0)
    log(
      `1ma works in ${shared.join(", ")} inside ${from}: do not delete ${from} while you use 1ma`,
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
