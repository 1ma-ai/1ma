import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  PAUSED,
  checkRecord,
  end,
  goneText,
  identityOf,
  judge,
  linuxBootId,
  linuxProc,
  pauseBreaks,
  pidExists,
  processTable,
  readOr,
  recordChain,
  recordLines,
  remaining,
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
checks each process again right before each signal.

  bb updates app status --json | node scripts/linux-launcher.mjs paused
      exit 0: at this moment automatic installation is off, nothing is scheduled
      and nothing is being installed. A check that had already begun can still
      schedule an installation, so the runbook waits a minute, switches
      automatic installation off again and reads again. Only reads.
  node scripts/linux-launcher.mjs record --data-dir <dir> --out <new file>
      before the stop: writes down the data folder, the launchers, every process
      below them and the builds they run from (identity and programs, no arguments);
      the commands below take the data folder from this record
  node scripts/linux-launcher.mjs gone --record <file> [--not-ours <pid>]...
      after the stop: exit 0 when nothing may be left; --not-ours sets aside a
      program that runs from the build or lost its parent, once looked at. Only reads.
  node scripts/linux-launcher.mjs end --record <file> [--also <pid>]...
      ends what is still running or was started by it, and the programs given
      with --also that run from the build or lost their parent; then answers as
      gone. Run it from outside the stopped server: it refuses to end itself
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

function pids(values, name) {
  return (values[name] ?? []).map((one) => {
    if (!/^[1-9]\d*$/.test(one)) throw new Error(`--${name} ${one} is not a process number`);
    return Number(one);
  });
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
  if (values["data-dir"] !== undefined)
    throw new Error("--data-dir is not taken here: the record names the data folder");
  const record = json(required(values, "record"));
  if (record === null) throw new Error(`${values.record} does not exist`);
  return checkRecord(record, values.record);
}

function gone(record, notOurs) {
  const { counted, covered } = judge(
    remaining({
      record,
      table: readTable(),
      bootId: linuxBootId(),
      shim: readOr(path.join(record.dataDir, "bb-app-update-shim.json"), null),
      exists: pidExists,
      identity,
    }),
    notOurs,
  );
  if (counted.length > 0) {
    for (const line of counted) console.log(line.text);
    for (const line of covered) console.log(`looked at, not the server's: ${line.text}`);
    return 1;
  }
  for (const line of goneText(record, covered)) console.log(line);
  return 0;
}

async function main([command, ...rest]) {
  const { values } = parseArgs({
    args: rest,
    options: {
      "data-dir": { type: "string" },
      out: { type: "string" },
      record: { type: "string" },
      "not-ours": { type: "string", multiple: true },
      also: { type: "string", multiple: true },
    },
  });
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
  if (command === "gone") return gone(readRecord(values), pids(values, "not-ours"));
  if (command === "end") {
    const record = readRecord(values);
    await end({
      record,
      bootId: linuxBootId(),
      self: process.pid,
      also: pids(values, "also"),
      readTable,
      identity,
      signal,
      sleep,
      log: (line) => console.log(line),
    });
    return gone(record, []);
  }
  if (command === "unlock") {
    const result = unlock({
      record: readRecord(values),
      table: readTable(),
      bootId: linuxBootId(),
      exists: pidExists,
      identity,
    });
    console.log(result.text);
    return result.code;
  }
  throw new Error(USAGE);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
