import path from "node:path";

/**
 * The checks around replacing the launcher build of the Linux server
 * (docs/runbooks/linux-enable-self-update.md, «Опорная сборка»): that the
 * server will not install an update by itself, and that a stopped server left
 * nothing of its process chain behind.
 *
 * A process is known by its number together with its start time: the number
 * alone is given to another process later, and a name or a path says nothing
 * about a process that lost its parent.
 */

const WAIT =
  "wait until the server answers again, check its version, threads and plugins, switch automatic installation off once more and read the status again";

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

/**
 * The processes of this PID namespace. A process that ends while it is read
 * is left out (`proc.stat` and `proc.cmdline` answer null for it), and so is
 * one that has ended and only waits for its parent to take its exit code.
 */
export function processTable(proc) {
  const table = [];
  for (const pid of proc.list()) {
    const stat = proc.stat(pid);
    const cmdline = proc.cmdline(pid);
    if (stat === null || cmdline === null) continue;
    const parsed = parseStat(stat);
    if (parsed === null) throw new Error(`/proc/${pid}/stat could not be read: ${stat}`);
    const { ended, ...one } = parsed;
    if (!ended) table.push({ ...one, argv: parseCmdline(cmdline) });
  }
  return table;
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
    queue.push(...(children.get(next.pid) ?? []));
  }
  return chain;
}

/**
 * What has to be gone after the stop: the launcher the data folder names, the
 * server it started and every process below them, and the two folders their
 * programs run from.
 *
 * `shim` is the parsed bb-app-update-shim.json, `runtime` the parsed
 * bb-app-runtime.json; `real` resolves links in a path.
 */
export function recordChain({ shim, runtime, table, bootId, real }) {
  const SHIM = "bb-app-update-shim.json";
  const RUNTIME = "bb-app-runtime.json";
  fileWith(SHIM, shim, [
    ["pid", "number"],
    ["entryPath", "string"],
  ]);
  fileWith(RUNTIME, runtime, [
    ["pid", "number"],
    ["entryPath", "string"],
    ["version", "string"],
  ]);
  const launcher = table.find((one) => one.pid === shim.pid);
  if (launcher === undefined)
    throw new Error(
      `${SHIM} names the launcher process ${shim.pid}, which is not running: this file does not describe the running server`,
    );
  if (!launcher.argv.includes(shim.entryPath))
    throw new Error(
      `${SHIM} names ${shim.entryPath}, which is not what ${shown(launcher)} runs: the file does not describe the running server`,
    );
  const chain = descendants(table, launcher);
  if (!chain.some((one) => one.pid === runtime.pid))
    throw new Error(
      `the running server (process ${runtime.pid}, ${RUNTIME}) was not started by the launcher ${shim.pid}: two launchers work on this data folder`,
    );
  const folders = new Set();
  for (const folder of [buildFolder(shim.entryPath, SHIM), buildFolder(runtime.entryPath, RUNTIME)])
    for (const one of [folder, real(folder)]) folders.add(one);
  return {
    bootId,
    version: runtime.version,
    launcher: { pid: launcher.pid, entryPath: shim.entryPath },
    folders: [...folders],
    processes: chain.map(({ pid, started, argv }) => ({ pid, started, argv })),
  };
}

function inside(folder, file) {
  return path.isAbsolute(file) && path.resolve(file).startsWith(`${folder}/`);
}

function isNode(program) {
  return path.basename(program) === "node";
}

/** The file a process runs: the program itself, or the script given to node. */
function programsOf(argv) {
  const [program, ...rest] = argv;
  if (program === undefined) return [];
  const script = isNode(program) ? rest.find((one) => !one.startsWith("-")) : undefined;
  return script === undefined ? [program] : [program, script];
}

const SHOWN = 240;

/** A process on one line: its arguments may hold line breaks and whole scripts. */
export function shown(one) {
  const args = one.argv.join(" ").replace(/\s+/g, " ").trim();
  return `process ${one.pid}: ${args.length > SHOWN ? `${args.slice(0, SHOWN)}…` : args || "(no arguments)"}`;
}

/**
 * What of a recorded chain is still there, one line each; empty when nothing
 * is. `shim` is the parsed bb-app-update-shim.json as it is now, or null when
 * the file is gone.
 *
 * bb takes the data folder for held while the process the file names is
 * alive, whatever that process is. So a file of the recorded launcher counts
 * as left over once another process carries its number.
 */
export function remaining({ record, table, bootId, shim }) {
  const left = [];
  const named = new Set();
  const sameBoot = record.bootId === bootId;
  const recorded = new Map(record.processes.map((one) => [one.pid, one.started]));
  for (const one of table) {
    if (!sameBoot || recorded.get(one.pid) !== one.started) continue;
    named.add(one.pid);
    left.push(`still running, ${shown(one)}`);
  }
  for (const one of table) {
    if (named.has(one.pid)) continue;
    const folder = record.folders.find((each) =>
      programsOf(one.argv).some((file) => inside(each, file)),
    );
    if (folder === undefined) continue;
    named.add(one.pid);
    left.push(`runs from ${folder}, ${shown(one)}`);
  }
  const holder =
    shim !== null && typeof shim === "object"
      ? table.find((one) => one.pid === shim.pid)
      : undefined;
  if (holder === undefined) return left;
  const leftover =
    holder.pid === record.launcher.pid &&
    !(sameBoot && recorded.get(holder.pid) === holder.started);
  left.push(
    leftover
      ? `bb-app-update-shim.json is left by the launcher that ended, and its number ${holder.pid} now belongs to another program (${shown(holder)}): do not end that program. A launcher started now would take the data folder for held and install no updates`
      : `bb-app-update-shim.json still names a running launcher, process ${shim.pid} (${shim.entryPath})`,
  );
  return left;
}
