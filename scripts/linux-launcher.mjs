import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  PAUSED,
  checkRecord,
  commandOptions,
  end,
  gone,
  identityOf,
  linuxBootId,
  linuxProc,
  pauseBreaks,
  parseToken,
  pidExists,
  processTable,
  readOr,
  recordChain,
  recordLines,
  unlock,
  writeRecord,
} from "./lib/linux-launcher.mjs";

const USAGE = `Checks around replacing the launcher build of the Linux server
(docs/runbooks/linux-enable-self-update.md).

Before a new launcher is started on the data folder, nothing of the stopped
server may still run (it would work on the same data), and bb must not take the
data folder for held (a launcher that finds it held installs no updates). The
server's processes have no group of their own on this machine, so every line
says what its evidence is. Nobody ends a process by number: \`end\` does it, and
checks each process again right before each signal. gone, end and unlock run as
the user the server runs as, not as root; each command takes only its own options.

  bb updates app status --json | node scripts/linux-launcher.mjs paused
      exit 0: at this moment automatic installation is off, nothing is scheduled
      and nothing is being installed. A check that had already begun can still
      schedule an installation, so the runbook waits a minute, switches
      automatic installation off again and reads again. Only reads.
  node scripts/linux-launcher.mjs record --data-dir <dir> --out <new file>
      before the stop: writes down the data folder, the launchers, every process
      below them and the builds they run from (identity and programs, no arguments);
      the commands below take the data folder from this record
  node scripts/linux-launcher.mjs gone --record <file> [--not-ours <pid>@<start>]...
      after the stop: exit 0 when nothing may be left; --not-ours sets aside a
      program that runs from the server's builds or lost its parent, once looked
      at, named by the <pid>@<start> its line prints. Only reads.
  node scripts/linux-launcher.mjs end --record <file> [--also <pid>@<start>]...
      ends what is still running or was started by it, and the programs given
      with --also, by the <pid>@<start> of their line, that run from the
      server's builds or lost their parent; then answers as gone. A program
      whose number now has another start time is refused. Run it from outside
      the stopped server: it refuses to end itself. Exit 2 also when a number
      changed hands between the check and a signal
  node scripts/linux-launcher.mjs unlock --record <file>
      removes bb-app-update-shim.json left by the launcher that ended, whose
      number another program now has

Exit 1: the answer is no, the reasons are printed. Exit 2: the check could not be made.`;

function json(file) {
  const text = readOr(file, null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON`);
  }
}

function real(folder) {
  try {
    return realpathSync(folder);
  } catch (error) {
    if (error.code === "ENOENT") return folder;
    throw error;
  }
}

function required(values, name) {
  if (values[name] === undefined) throw new Error(`--${name} is required\n\n${USAGE}`);
  return values[name];
}

function tokens(values, name) {
  return (values[name] ?? []).map((one) => parseToken(`--${name}`, one));
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

const identity = identityOf(linuxProc);
const readTable = () => processTable(linuxProc);

function readRecord(values) {
  const record = json(required(values, "record"));
  if (record === null) throw new Error(`${values.record} does not exist`);
  return checkRecord(record, values.record);
}

function answer(record, notOurs) {
  const { code, lines } = gone({
    record,
    uid: process.getuid(),
    notOurs,
    table: readTable(),
    bootId: linuxBootId(),
    shim: readOr(path.join(record.dataDir, "bb-app-update-shim.json"), null),
    exists: pidExists,
    identity,
  });
  for (const line of lines) console.log(line);
  return code;
}

async function main([command, ...rest]) {
  const values = commandOptions(command, rest);
  if (values === null) throw new Error(USAGE);
  if (command === "paused") {
    let status;
    try {
      status = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      throw new Error("the input is not the JSON of `bb updates app status --json`");
    }
    const breaks = pauseBreaks(status);
    for (const one of breaks.length === 0 ? [PAUSED] : breaks) console.log(one);
    return breaks.length === 0 ? 0 : 1;
  }
  if (command === "record") {
    const dataDir = realpathSync(path.resolve(required(values, "data-dir")));
    const out = required(values, "out");
    const record = recordChain({
      dataDir,
      shim: readOr(path.join(dataDir, "bb-app-update-shim.json"), null),
      runtime: json(path.join(dataDir, "bb-app-runtime.json")),
      table: readTable(),
      bootId: linuxBootId(),
      real,
    });
    writeRecord(out, record);
    for (const line of recordLines(record)) console.log(line);
    return 0;
  }
  if (command === "gone") return answer(readRecord(values), tokens(values, "not-ours"));
  if (command === "end") {
    const record = readRecord(values);
    const { changedHands } = await end({
      record,
      bootId: linuxBootId(),
      self: process.pid,
      uid: process.getuid(),
      also: tokens(values, "also"),
      readTable,
      identity,
      signal,
      sleep,
      log: (line) => console.log(line),
    });
    const code = answer(record, []);
    if (changedHands.length === 0) return code;
    console.error(
      `the number of process ${changedHands.join(", ")} changed hands between the check and the signal: see the lines above`,
    );
    return 2;
  }
  if (command === "unlock") {
    const result = unlock({
      record: readRecord(values),
      uid: process.getuid(),
      table: readTable(),
      bootId: linuxBootId(),
      exists: pidExists,
      identity,
    });
    console.log(result.text);
    return result.code;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
