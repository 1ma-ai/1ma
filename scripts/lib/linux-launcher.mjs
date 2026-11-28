import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

/**
 * The checks around replacing the launcher build of the Linux server
 * (docs/runbooks/linux-enable-self-update.md, «Опорная сборка»).
 *
 * Before a new launcher is started on the data folder, two things must be
 * true: nothing of the stopped server still runs (it would work on the same
 * data), and bb will not take the data folder for held (a launcher that finds
 * it held runs without installing updates). The machine keeps the server's
 * processes in no group of their own (they share the container's), so these
 * checks work from evidence and say of every line what the evidence is. They
 * never tell anyone to end a process by number: `end` does it, and checks the
 * process again right before each signal.
 *
 * A process is known by its number together with its start time: the number
 * alone is given to another process later, and a name or a path says nothing
 * about a process that lost its parent. Every command runs as the server's
 * user: as root, `kill(pid, 0)` answers for any process and a signal reaches
 * any process.
 */

const SHIM = "bb-app-update-shim.json";
const RUNTIME = "bb-app-runtime.json";

const WAIT =
  "wait until the server answers again, check its version, threads and plugins, switch automatic installation off once more and read the status again";

export const PAUSED =
  "At this moment automatic installation is off, nothing is scheduled and nothing is being installed. A check that had already begun can still schedule an installation: that is why the runbook waits a minute, switches automatic installation off again and reads the status again.";

/** Why the server may still install an update by itself; empty when it will not. */
export function pauseBreaks(status) {
  if (status === null || typeof status !== "object" || Array.isArray(status))
    return ["the status is not an object"];
  const breaks = [];
  if (status.autoUpdate !== false)
    breaks.push(
      `automatic installation is not off (autoUpdate is ${JSON.stringify(status.autoUpdate)})`,
    );
  if (status.scheduled !== null)
    breaks.push(
      status.scheduled === undefined
        ? "the status does not say whether an installation is scheduled"
        : `an installation is scheduled (${JSON.stringify(status.scheduled)}): switch automatic installation off once more and read the status again`,
    );
  const phase = status.activity?.phase;
  if (phase !== "idle")
    breaks.push(
      phase === undefined
        ? "the status does not say what the server is doing"
        : `an installation is under way (${phase}) and cannot be cancelled: ${WAIT}`,
    );
  return breaks;
}

/**
 * One line of /proc/<pid>/stat. The name is in brackets and may itself hold
 * spaces and brackets, so the fields are counted from the last closing one.
 */
export function parseStat(text) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 1 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const [state, parent] = rest;
  const ppid = Number(parent);
  const started = rest[19];
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !/^\d+$/.test(started ?? ""))
    return null;
  return { pid, ppid, started, ended: state === "Z" || state === "X" };
}

/** /proc/<pid>/cmdline: the arguments, each ended by a NUL. */
export function parseCmdline(text) {
  const argv = text.split("\0");
  if (argv.at(-1) === "") argv.pop();
  return argv;
}

/** The real user of a process, from /proc/<pid>/status. */
export function parseUid(text) {
  const match = /^Uid:\s+(\d+)/m.exec(text);
  return match === null ? null : Number(match[1]);
}

/**
 * The processes of this PID namespace. A process that ends while it is read
 * is left out (the readers answer null for it), and so is one that has ended
 * and only waits for its parent to take its exit code.
 */
export function processTable(proc) {
  const table = [];
  for (const pid of proc.list()) {
    const stat = proc.stat(pid);
    const cmdline = proc.cmdline(pid);
    const uid = proc.uid(pid);
    if (stat === null || cmdline === null || uid === null) continue;
    const parsed = parseStat(stat);
    if (parsed === null) throw new Error(`/proc/${pid}/stat could not be read: ${stat}`);
    const { ended, ...one } = parsed;
    if (!ended) table.push({ ...one, uid, argv: parseCmdline(cmdline) });
  }
  return table;
}

/** A process's number and start time, also for one that ended and was not collected. */
export function identityOf(proc) {
  return (pid) => {
    const stat = proc.stat(pid);
    return stat === null ? null : parseStat(stat);
  };
}

function absent(error) {
  return error.code === "ENOENT" || error.code === "ESRCH";
}

export function readOr(file, missing, fs = nodeFs) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (absent(error)) return missing;
    throw error;
  }
}

export const linuxProc = {
  list: () =>
    nodeFs
      .readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(Number),
  stat: (pid) => readOr(`/proc/${pid}/stat`, null),
  cmdline: (pid) => readOr(`/proc/${pid}/cmdline`, null),
  uid: (pid) => {
    const status = readOr(`/proc/${pid}/status`, null);
    return status === null ? null : parseUid(status);
  },
};

export const linuxBootId = () =>
  nodeFs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

/** bb's own test of the pid in the shim file: `kill(pid, 0)` succeeds. */
export function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function buildFolder(entryPath, file) {
  const at = entryPath.indexOf("/node_modules/");
  if (!path.isAbsolute(entryPath) || at < 1)
    throw new Error(
      `${file} names ${JSON.stringify(entryPath)}, which is not a file inside the node_modules of a build`,
    );
  return entryPath.slice(0, at);
}

function fileWith(file, value, keys) {
  if (value === null || typeof value !== "object")
    throw new Error(`${file} is missing or could not be read`);
  for (const [key, type] of keys)
    if (typeof value[key] !== type || value[key] === "")
      throw new Error(`${file} does not name ${key}`);
  return value;
}

/**
 * The shim file by bb's rule (`readShimLockFile` in shim-support.ts): JSON
 * with a positive integer `pid` and non-empty strings `entryPath` and
 * `startedAt`. Any other file is no lock for bb, and the next launcher
 * replaces it. Answers `{ lock }`, or `{ wrong }` saying why bb does not
 * accept the file.
 */
export function readShim(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { wrong: "it is not JSON" };
  }
  const named = (key) => typeof value?.[key] === "string" && value[key] !== "";
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !named("entryPath") ||
    !named("startedAt")
  )
    return { wrong: "it does not name the launcher by pid, entryPath and startedAt" };
  return { lock: value };
}

function notAccepted(wrong) {
  return `${SHIM} is not a file bb accepts (${wrong})`;
}

function descendants(table, root) {
  const children = new Map();
  for (const one of table) {
    if (!children.has(one.ppid)) children.set(one.ppid, []);
    children.get(one.ppid).push(one);
  }
  const chain = [];
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    chain.push(next);
    queue.push(
      ...(children.get(next.pid) ?? []).filter((one) => !later(next.started, one.started)),
    );
  }
  return chain;
}

function later(left, right) {
  return BigInt(left) > BigInt(right);
}

function isNode(program) {
  return path.basename(program) === "node";
}

const CODE_OPTION = /^(?:-[a-zA-Z]*[ep]|--(?:eval|print)(?:=|$))/;

/**
 * The node options that take their value as the next argument: what
 * `node --help` prints with a value that must be given (`--name=...`), on
 * Node 24 and, for the ones newer releases dropped, Node 20, with the aliases
 * printed beside them that take the value too.
 */
export const NODE_VALUE_OPTIONS = new Set([
  "-C",
  "-e",
  "-r",
  "--allow-fs-read",
  "--allow-fs-write",
  "--build-snapshot-config",
  "--conditions",
  "--cpu-prof-dir",
  "--cpu-prof-interval",
  "--cpu-prof-name",
  "--debug-port",
  "--diagnostic-dir",
  "--disable-proto",
  "--disable-warning",
  "--dns-result-order",
  "--env-file",
  "--env-file-if-exists",
  "--eval",
  "--experimental-config-file",
  "--experimental-default-type",
  "--experimental-loader",
  "--experimental-package-map",
  "--experimental-policy",
  "--experimental-sea-config",
  "--experimental-test-isolation",
  "--experimental-test-tag-filter",
  "--heap-prof-dir",
  "--heap-prof-interval",
  "--heap-prof-name",
  "--heapsnapshot-near-heap-limit",
  "--heapsnapshot-signal",
  "--icu-data-dir",
  "--import",
  "--input-type",
  "--inspect-port",
  "--inspect-publish-uid",
  "--loader",
  "--localstorage-file",
  "--max-http-header-size",
  "--max-old-space-size-percentage",
  "--network-family-autoselection-attempt-timeout",
  "--openssl-config",
  "--policy-integrity",
  "--redirect-warnings",
  "--report-dir",
  "--report-directory",
  "--report-filename",
  "--report-signal",
  "--require",
  "--run",
  "--secure-heap",
  "--secure-heap-min",
  "--snapshot-blob",
  "--test-concurrency",
  "--test-coverage-branches",
  "--test-coverage-exclude",
  "--test-coverage-functions",
  "--test-coverage-include",
  "--test-coverage-lines",
  "--test-global-setup",
  "--test-isolation",
  "--test-name-pattern",
  "--test-random-seed",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-rerun-failures",
  "--test-shard",
  "--test-skip-pattern",
  "--test-timeout",
  "--title",
  "--tls-cipher-list",
  "--tls-keylog",
  "--trace-event-categories",
  "--trace-event-file-pattern",
  "--trace-require-module",
  "--unhandled-rejections",
  "--use-largepages",
  "--v8-pool-size",
  "--watch-kill-signal",
  "--watch-path",
]);

/**
 * The file a process runs: the program itself, or the script given to node.
 * Code given to node on the command line is an argument, not a script. An
 * option of the table above takes the next argument as its value; one of the
 * form `--name=value`, and any other option, takes none. Not read right: a
 * value option node knows and the table does not (V8 options such as
 * `--stack-size 2000` among them), and a process that changed its own
 * command line (setproctitle).
 */
export function programsOf(argv) {
  const [program, ...rest] = argv;
  if (program === undefined) return [];
  if (!isNode(program)) return [program];
  for (let at = 0; at < rest.length; at += 1) {
    const one = rest[at];
    if (CODE_OPTION.test(one) || one === "-") return [program];
    if (one === "--") return rest[at + 1] === undefined ? [program] : [program, rest[at + 1]];
    if (!one.startsWith("-")) return [program, one];
    if (NODE_VALUE_OPTIONS.has(one)) at += 1;
  }
  return [program];
}

/**
 * What has to be gone after the stop: the outer launcher the shim file names,
 * the inner launcher the runtime file names (the one that starts the server),
 * every process below them, the two folders their programs run from and the
 * folder of every installed version (`<dataDir>/app-versions`: each version in
 * it belongs to this data folder's server). Of a process only its identity
 * and its programs are written down, no argument. A process older than the
 * one its parent number names is not below it: that number was reused.
 *
 * `dataDir` is the absolute data folder, `shim` the text of its
 * bb-app-update-shim.json (null when it is missing), `runtime` its parsed
 * bb-app-runtime.json; `real` resolves links in a path.
 */
export function recordChain({ dataDir, shim, runtime, table, bootId, real }) {
  if (shim === null) throw new Error(`${SHIM} is missing or could not be read`);
  const { lock, wrong } = readShim(shim);
  if (wrong !== undefined)
    throw new Error(`${notAccepted(wrong)}: it does not describe the running server`);
  fileWith(RUNTIME, runtime, [
    ["pid", "number"],
    ["entryPath", "string"],
    ["version", "string"],
  ]);
  const builds = [buildFolder(lock.entryPath, SHIM), buildFolder(runtime.entryPath, RUNTIME)];
  const launcher = table.find((one) => one.pid === lock.pid);
  if (launcher === undefined)
    throw new Error(
      `${SHIM} names the outer launcher, process ${lock.pid}, which is not running: this file does not describe the running server`,
    );
  if (!launcher.argv.includes(lock.entryPath))
    throw new Error(
      `${SHIM} names the outer launcher ${lock.entryPath}, which is not what ${shown(launcher)} runs: the file does not describe the running server`,
    );
  const chain = descendants(table, launcher);
  const inner = chain.find((one) => one.pid === runtime.pid);
  if (inner === undefined)
    throw new Error(
      `${RUNTIME} names the inner launcher that starts the server, process ${runtime.pid}, which the outer launcher ${lock.pid} did not start: two launchers work on this data folder`,
    );
  if (!inner.argv.includes(runtime.entryPath))
    throw new Error(
      `${RUNTIME} names the inner launcher that starts the server ${runtime.entryPath}, which is not what ${shown(inner)} runs: the file does not describe the running server`,
    );
  const folders = new Set();
  for (const folder of [...builds, path.join(dataDir, "app-versions")])
    for (const one of [folder, real(folder)]) folders.add(one);
  return {
    bootId,
    dataDir: real(dataDir),
    version: runtime.version,
    at: table.reduce((newest, one) => (later(one.started, newest) ? one.started : newest), "0"),
    shim,
    launcher: {
      pid: launcher.pid,
      started: launcher.started,
      uid: launcher.uid,
      entryPath: lock.entryPath,
    },
    runtime: { pid: inner.pid, started: inner.started, entryPath: runtime.entryPath },
    folders: [...folders],
    processes: chain.map(({ pid, started, argv }) => ({
      pid,
      started,
      programs: programsOf(argv),
    })),
  };
}

/** The record file is created new and readable by its owner only. */
export function writeRecord(file, record, fs = nodeFs) {
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

const DIGITS = /^\d+$/;
const isText = (value) => typeof value === "string";
const isPid = (value) => Number.isInteger(value) && value > 0;
const isTicks = (value) => isText(value) && DIGITS.test(value);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function wrongIn(record) {
  if (!isObject(record)) return "it is not an object";
  for (const key of ["bootId", "version", "shim", "dataDir"])
    if (!isText(record[key])) return `${key} is not a string`;
  if (!isTicks(record.at)) return "at is not a start time";
  const { launcher, runtime } = record;
  if (
    !isObject(launcher) ||
    !isPid(launcher.pid) ||
    !isTicks(launcher.started) ||
    !Number.isInteger(launcher.uid) ||
    !isText(launcher.entryPath)
  )
    return "launcher is not {pid, started, uid, entryPath}";
  if (
    !isObject(runtime) ||
    !isPid(runtime.pid) ||
    !isTicks(runtime.started) ||
    !isText(runtime.entryPath)
  )
    return "runtime is not {pid, started, entryPath}";
  if (!Array.isArray(record.folders) || !record.folders.every(isText))
    return "folders is not a list of folders";
  if (
    !Array.isArray(record.processes) ||
    !record.processes.every(
      (one) =>
        isObject(one) &&
        isPid(one.pid) &&
        isTicks(one.started) &&
        Array.isArray(one.programs) &&
        one.programs.every(isText),
    )
  )
    return "processes is not a list of {pid, started, programs}";
  return null;
}

/** The record as read from `file`, when it has the shape `record` writes it with. */
export function checkRecord(value, file) {
  const wrong = wrongIn(value);
  if (wrong !== null) throw new Error(`${file} is not a record written by 'record': ${wrong}`);
  return value;
}

/** What `record` prints. */
export function recordLines(record) {
  return [
    `Server ${record.version}, outer launcher process ${record.launcher.pid}, inner launcher process ${record.runtime.pid}.`,
    `Data folder: ${record.dataDir}`,
    `Builds and installed versions: ${record.folders.join(", ")}`,
    `${record.processes.length} processes written down:`,
    ...record.processes.map((one) => `  ${shown(one)}`),
  ];
}

function inside(folder, file) {
  return path.isAbsolute(file) && path.resolve(file).startsWith(`${folder}/`);
}

/** bb's CLI in a build: the `bb` command, its link in `.bin`, and the CLI it hands the work to. */
const CLI = ["bb-app/dist/bb.js", ".bin/bb", "bb-app/host-daemon/dist/bb"].map(
  (file) => `/node_modules/${file}`,
);

/** The folder of `folders` a program of `one` runs from, of bb's CLI only when `cli` is set. */
function folderOf(folders, one, cli = false) {
  return folders.find((each) =>
    programsOf(one.argv).some(
      (file) =>
        inside(each, file) && (!cli || CLI.some((name) => path.resolve(file).endsWith(name))),
    ),
  );
}

/**
 * The processes above `one`, nearest first. The walk stops at a parent
 * younger than the process below it: that number was reused, and it is not
 * the parent.
 */
function parentsOf(byPid, one) {
  const parents = [];
  let below = one;
  for (
    let up = byPid.get(one.ppid);
    up !== undefined && !later(up.started, below.started) && parents.length < byPid.size;
    up = byPid.get(up.ppid)
  ) {
    parents.push(up);
    below = up;
  }
  return parents;
}

const SHOWN = 240;

/** A process on one line, by its programs only: its arguments may hold anything. */
export function shown(one, name = String(one.pid)) {
  const programs = (one.programs ?? programsOf(one.argv)).join(" ").replace(/\s+/g, " ").trim();
  return `process ${name}: ${programs.length > SHOWN ? `${programs.slice(0, SHOWN)}…` : programs || "(no program)"}`;
}

/**
 * How `--also` and `--not-ours` name a process: its number and its start
 * time, as the lines of the two kinds looked at print them.
 */
export const tokenOf = (one) => `${one.pid}@${one.started}`;

export function parseToken(option, text) {
  const match = /^([1-9]\d*)@(\d+)$/.exec(text);
  if (match === null)
    throw new Error(
      `${option} ${text}: a process is named as number@start time; copy it from the line gone printed`,
    );
  return { pid: Number(match[1]), started: match[2] };
}

const CERTAIN = new Set(["recorded", "child"]);
const LOOKED_AT = new Set(["from-build", "orphan"]);
const SET_ASIDE = new Set([...LOOKED_AT, "command"]);
const NOTE = new Set(["shim-ignored"]);

function asServerUser(record, uid) {
  if (uid !== record.launcher.uid)
    throw new Error(
      `this command runs as user ${uid} and the server as user ${record.launcher.uid}: run it as the user the server runs as`,
    );
}

/**
 * The processes of the table that may be the stopped server's, each with what
 * the evidence is. `known` (number to start time) adds processes already
 * established as the server's, whose descendants are then the server's too.
 * The walk up from a process stops at a parent younger than the process
 * below it: that number was reused, and it is not the parent.
 *
 * A process the server did not start that runs bb's CLI from a build, or is
 * below one, is a `bb` command (kind `command`): the server's own calls of the
 * CLI are its children. `command` lists the tokens from the process up to the
 * outermost CLI process above it, the one its text names for `--not-ours`.
 */
export function scan({ record, table, bootId, known = new Map() }) {
  const sameBoot = record.bootId === bootId;
  const recorded = new Map(record.processes.map((one) => [one.pid, one.started]));
  const byPid = new Map(table.map((one) => [one.pid, one]));
  const isRecorded = (one) => sameBoot && recorded.get(one.pid) === one.started;
  const isServers = (one) => isRecorded(one) || known.get(one.pid) === one.started;
  const lines = [];
  for (const one of table) {
    const line = { pid: one.pid, started: one.started };
    if (isRecorded(one)) {
      lines.push({ ...line, kind: "recorded", text: `still running, ${shown(one)}` });
      continue;
    }
    const parents = parentsOf(byPid, one);
    if (parents.some(isServers)) {
      lines.push({
        ...line,
        kind: "child",
        text: `started by the stopped server after the record, ${shown(one)}`,
      });
      continue;
    }
    const upward = [one, ...parents];
    const outermost = upward.findLastIndex((each) => folderOf(record.folders, each, true));
    if (outermost !== -1) {
      const command = upward.slice(0, outermost + 1).map(({ pid, started }) => ({ pid, started }));
      const top = tokenOf(command.at(-1));
      lines.push({
        ...line,
        kind: "command",
        command,
        text: `${outermost === 0 ? `is a bb command run from ${folderOf(record.folders, one, true)}` : `is part of the bb command ${top}`}, ${shown(one, tokenOf(one))}: the stopped server did not start it, so it is not the server's: wait for it to end, or set it aside with gone --not-ours ${top}`,
      });
      continue;
    }
    const folder = folderOf(record.folders, one);
    if (folder !== undefined) {
      lines.push({
        ...line,
        kind: "from-build",
        text: `runs a program from the server's builds in ${folder}, ${shown(one, tokenOf(one))}: it is a piece of the stopped server, unless a launcher was started from this build after the stop`,
      });
      continue;
    }
    if (
      sameBoot &&
      one.ppid === 1 &&
      !later(record.at, one.started) &&
      one.uid === record.launcher.uid
    )
      lines.push({
        ...line,
        kind: "orphan",
        text: `started after the record and lost its parent, ${shown(one, tokenOf(one))}: it may be a program an agent of the stopped server started, or something else on this machine`,
      });
  }
  return lines;
}

/**
 * Whether bb will take the data folder for held, by bb's own rule: while
 * `exists` (kill(pid, 0)) succeeds for the pid in the shim file, whatever that
 * process is, also one that ended and was not collected by its parent; a file
 * bb does not accept holds nothing. `text` is the file as it is now (null when
 * it is missing), `identity` reads the number and start time of a process,
 * ended or not.
 */
export function lockLine({ record, text, table, bootId, exists, identity }) {
  if (text === null) return null;
  const { lock, wrong } = readShim(text);
  if (wrong !== undefined)
    return {
      kind: "shim-ignored",
      text: `${notAccepted(wrong)}: it holds the data folder for no process, and the next launcher replaces it`,
    };
  const { pid } = lock;
  if (!exists(pid)) return null;
  const holder = table.find((one) => one.pid === pid);
  if (text !== record.shim)
    return {
      kind: "lock-other",
      pid,
      text: `${SHIM} was written after the record: another launcher, ${holder === undefined ? `process ${pid}` : shown(holder)}, took the data folder. End or remove nothing until it is known what started it`,
    };
  const now = identity(pid);
  if (now === null) return null;
  if (record.bootId === bootId && now.started === record.launcher.started)
    return {
      kind: "lock-launcher",
      pid,
      started: now.started,
      text: now.ended
        ? `the launcher written down, process ${pid}, has ended and waits for its parent to collect it; until then bb takes the data folder for held: wait and check again`
        : `the launcher written down, process ${pid}, has not ended, and ${SHIM} still names it: it is a still running line too, and \`end\` ends it`,
    };
  return {
    kind: "lock-leftover",
    pid,
    started: now.started,
    text: `${SHIM} is left by the launcher that ended, and its number ${pid} now belongs to another program${holder === undefined ? "" : ` (${shown(holder)})`}: that program is not to be touched. A launcher started now would take the data folder for held and install no updates; \`unlock\` removes the file`,
  };
}

/** Every line of what may be left of the stopped server; empty when nothing is. */
export function remaining({ record, table, bootId, shim, exists, identity }) {
  const lock = lockLine({ record, text: shim, table, bootId, exists, identity });
  return [...scan({ record, table, bootId }), ...(lock === null ? [] : [lock])];
}

const names = (line, token) => line.pid === token.pid && line.started === token.started;

function lookedAt(lines, token, kinds = LOOKED_AT) {
  return lines.find((line) => names(line, token) && kinds.has(line.kind));
}

function notLookedAt(option, token, what) {
  return new Error(
    `${option} ${tokenOf(token)}: no line of ${what} names this process with this start time. The number may belong to another program by now: run gone again and copy from its line`,
  );
}

/**
 * The answer of `gone`: the lines that count, the ones looked at and found
 * not to be the server's (`notOurs`, tokens of lines of a program that runs
 * from the server's builds, lost its parent or is a `bb` command; a token of
 * a `bb` command also sets aside every process below it), and notes that hold
 * nothing.
 */
export function judge(lines, notOurs = []) {
  for (const token of notOurs)
    if (lookedAt(lines, token, SET_ASIDE) === undefined)
      throw notLookedAt(
        "--not-ours",
        token,
        "a program that runs from the server's builds, lost its parent or is a bb command",
      );
  const covered = lines.filter((line) =>
    notOurs.some(
      (token) =>
        lookedAt([line], token) !== undefined ||
        (line.kind === "command" && line.command.some((each) => names(each, token))),
    ),
  );
  return {
    counted: lines.filter((line) => !covered.includes(line) && !NOTE.has(line.kind)),
    covered,
    notes: lines.filter((line) => NOTE.has(line.kind)),
  };
}

/** What `gone` prints when nothing counts. */
export function goneText(record, covered) {
  return [
    `Nothing of the ${record.processes.length} processes written down runs, nothing they started runs, nothing runs from ${record.folders.join(" or ")}, no program of the launcher's user lost its parent since the record${covered.length === 0 ? "" : ` other than the ${covered.length} looked at`}, and bb will not take the data folder for held.`,
    "Not seen by this check: a program outside these folders that had already lost its parent before the record, or one that another process than process 1 adopted.",
    ...covered.map((line) => `looked at, not the server's: ${line.text}`),
  ];
}

/**
 * The answer of `gone` for the user `uid`: `{ code, lines }`, code 0 when
 * nothing may be left and 1 when something is.
 */
export function gone({ record, uid, notOurs = [], table, bootId, shim, exists, identity }) {
  asServerUser(record, uid);
  const { counted, covered, notes } = judge(
    remaining({ record, table, bootId, shim, exists, identity }),
    notOurs,
  );
  const noted = notes.map((line) => line.text);
  if (counted.length === 0) return { code: 0, lines: [...goneText(record, covered), ...noted] };
  return {
    code: 1,
    lines: [
      ...counted.map((line) => line.text),
      ...covered.map((line) => `looked at, not the server's: ${line.text}`),
      ...noted,
    ],
  };
}

/**
 * Ends what is certainly the stopped server's: the processes written down and
 * the ones they started, and the processes of `also` (tokens, number and start
 * time) that this scan finds, with that start time, running from the server's
 * builds or without a parent. SIGTERM to all, the table read again every
 * `step` ms for up to `grace` ms (new processes they start become targets
 * too), then SIGKILL to what is left.
 *
 * Before each signal the process's number and start time are read again, and
 * the signal goes only when they are unchanged. Linux hands numbers out in
 * turn and gives a freed one again when its counter next reaches it, so
 * between that read and the signal sent at once the number changes hands only
 * when the process ends, is collected and the counter stands exactly at its
 * number. Without a pidfd that cannot be excluded; right after each signal the
 * start time is read once more, and a different one is reported, as is every
 * number in `changedHands` of the answer.
 *
 * It refuses, sending nothing, when `self` (the pid of the command) is itself
 * one of the processes it would end, or when `uid` is not the launcher's user;
 * `--also` it refuses for a `bb` command, and for every process while another
 * launcher holds the data folder. When a later read makes the command or a
 * process above it one to end, it stops, sending nothing more.
 *
 * `readTable` reads the process table, `identity` one process, `shim` is the
 * text of bb-app-update-shim.json (null when it is missing) and `exists` bb's
 * test of its pid, `signal(pid, name)` sends, `sleep(ms)` waits, `log` takes a
 * line of what was done.
 */
export async function end({
  record,
  bootId,
  self,
  uid,
  also = [],
  readTable,
  identity,
  shim = null,
  exists,
  signal,
  sleep,
  log,
  grace = 15000,
  step = 250,
}) {
  asServerUser(record, uid);
  const before = readTable();
  const lock = lockLine({ record, text: shim, table: before, bootId, exists, identity });
  if (also.length > 0 && lock?.kind === "lock-other")
    throw new Error(`--also is refused while another launcher holds the data folder: ${lock.text}`);
  const first = scan({ record, table: before, bootId });
  const chosen = new Map();
  for (const token of also) {
    if (lookedAt(first, token, new Set(["command"])) !== undefined)
      throw new Error(
        `--also ${tokenOf(token)}: this process is a bb command or part of one, not the server's; the server's own calls of bb are ended without --also. Wait for it to end, or set it aside with gone --not-ours`,
      );
    if (lookedAt(first, token) === undefined)
      throw notLookedAt(
        "--also",
        token,
        "a program that runs from the server's builds or lost its parent",
      );
    chosen.set(token.pid, token.started);
  }
  const ownTree = new Error(
    `this command was started by the server it would end (process ${self}): run it from outside that server, after the stop`,
  );
  const own = scan({ record, table: before, bootId, known: chosen }).find(
    (line) => line.pid === self && CERTAIN.has(line.kind),
  );
  if (own !== undefined || chosen.has(self)) throw ownTree;
  const targets = new Map();
  const take = (table) => {
    const byPid = new Map(table.map((one) => [one.pid, one]));
    const me = byPid.get(self);
    const mine = new Set([
      self,
      ...(me === undefined ? [] : parentsOf(byPid, me).map((one) => one.pid)),
    ]);
    const fresh = [];
    for (const line of scan({ record, table, bootId, known: targets })) {
      const target = CERTAIN.has(line.kind) || chosen.get(line.pid) === line.started;
      if (!target || targets.get(line.pid) === line.started) continue;
      if (mine.has(line.pid)) throw ownTree;
      targets.set(line.pid, line.started);
      fresh.push(line.pid);
    }
    return fresh;
  };
  const keepRunning = (table) => {
    for (const [pid, started] of targets)
      if (!table.some((one) => one.pid === pid && one.started === started)) targets.delete(pid);
  };
  const changedHands = [];
  const send = (pids, name) => {
    for (const pid of pids) {
      const started = targets.get(pid);
      const now = identity(pid);
      if (now === null || now.ended || now.started !== started) {
        targets.delete(pid);
        log(`process ${pid} has ended or its number belongs to another process: no ${name}`);
        continue;
      }
      signal(pid, name);
      log(`${name} to process ${pid}`);
      const then = identity(pid);
      if (then !== null && then.started !== started) {
        changedHands.push(pid);
        log(
          `process ${pid}: the number changed hands between the check and the signal, the ${name} may have reached another program (started at ${then.started})`,
        );
      }
    }
  };
  send(take(before), "SIGTERM");
  for (let waited = 0; targets.size > 0 && waited < grace; waited += step) {
    await sleep(step);
    const table = readTable();
    keepRunning(table);
    send(take(table), "SIGTERM");
  }
  send([...targets.keys()], "SIGKILL");
  for (let waited = 0; targets.size > 0 && waited < 1000; waited += step) {
    await sleep(step);
    keepRunning(readTable());
  }
  return { changedHands };
}

/**
 * Removes the shim file left by the launcher that ended, and only that file:
 * it is renamed aside first, and deleted only when the renamed file is the
 * one written down. Anything else goes back under its name, without replacing
 * a file that appeared meanwhile. Answers `{ code, text }` when nothing was
 * to be removed or the file is removed; throws when the file changed.
 */
export function unlock({ record, uid, table, bootId, exists, identity, fs = nodeFs }) {
  asServerUser(record, uid);
  const file = path.join(record.dataDir, SHIM);
  const line = lockLine({
    record,
    text: readOr(file, null, fs),
    table,
    bootId,
    exists,
    identity,
  });
  if (line?.kind === "shim-ignored")
    return { code: 1, text: `${line.text}: there is nothing to unlock` };
  if (line?.kind !== "lock-leftover")
    return {
      code: 1,
      text:
        line?.text ?? `${SHIM} holds the data folder for no process: there is nothing to unlock`,
    };
  const aside = path.join(record.dataDir, `${SHIM}.${randomUUID()}`);
  try {
    fs.renameSync(file, aside);
  } catch (error) {
    if (absent(error))
      throw new Error(`${SHIM} disappeared after it was judged: nothing is removed`);
    throw error;
  }
  if (fs.readFileSync(aside, "utf8") === record.shim) {
    fs.unlinkSync(aside);
    return { code: 0, text: `${SHIM} left by the launcher that ended is removed.` };
  }
  try {
    fs.linkSync(aside, file);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `${SHIM} changed after it was judged, and a new one appeared meanwhile: it stays, and the changed file is left beside it as ${aside}`,
      );
    throw error;
  }
  fs.unlinkSync(aside);
  throw new Error(`${SHIM} changed after it was judged: it is back in place, nothing is removed`);
}

const RECORD_OPTION = { record: { type: "string" } };
const COMMANDS = {
  paused: {},
  record: { "data-dir": { type: "string" }, out: { type: "string" } },
  gone: { ...RECORD_OPTION, "not-ours": { type: "string", multiple: true } },
  end: { ...RECORD_OPTION, also: { type: "string", multiple: true } },
  unlock: RECORD_OPTION,
};

/** The options given to `command`, which takes only its own; null when there is no such command. */
export function commandOptions(command, args) {
  if (!Object.hasOwn(COMMANDS, command)) return null;
  const own = COMMANDS[command];
  const { values, tokens } = parseArgs({
    args,
    options: Object.assign({}, ...Object.values(COMMANDS)),
    tokens: true,
  });
  for (const token of tokens)
    if (token.kind === "option" && !Object.hasOwn(own, token.name))
      throw new Error(
        `--${token.name} is not an option of ${command}${
          Object.keys(own).length === 0
            ? ", which takes none"
            : `, which takes ${Object.keys(own)
                .map((name) => `--${name}`)
                .join(" and ")}`
        }`,
      );
  return values;
}
