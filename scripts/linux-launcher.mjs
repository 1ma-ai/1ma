import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pauseBreaks, processTable, recordChain, remaining, shown } from "./lib/linux-launcher.mjs";

const USAGE = `Checks around replacing the launcher build of the Linux server
(docs/runbooks/linux-enable-self-update.md). Each command only reads.

  bb updates app status --json | node scripts/linux-launcher.mjs paused
      exit 0: the server will not install an update by itself
  node scripts/linux-launcher.mjs record --data-dir <dir> --out <new file>
      before the stop: writes down the launcher, the server and every process below them
  node scripts/linux-launcher.mjs gone --data-dir <dir> --record <file>
      after the stop: exit 0 when nothing of what was written down is left

Exit 1: the answer is no, the reasons are printed. Exit 2: the check could not be made.`;

function absent(error) {
  return error.code === "ENOENT" || error.code === "ESRCH";
}

function readOr(file, missing) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (absent(error)) return missing;
    throw error;
  }
}

function json(file) {
  const text = readOr(file, null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON`);
  }
}

const proc = {
  list: () =>
    readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(Number),
  stat: (pid) => readOr(`/proc/${pid}/stat`, null),
  cmdline: (pid) => readOr(`/proc/${pid}/cmdline`, null),
};

const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

function real(folder) {
  try {
    return realpathSync(folder);
  } catch (error) {
    if (absent(error)) return folder;
    throw error;
  }
}

function answer(breaks, yes) {
  if (breaks.length === 0) {
    console.log(yes);
    return 0;
  }
  for (const one of breaks) console.log(one);
  return 1;
}

function required(values, name) {
  if (values[name] === undefined) throw new Error(`--${name} is required\n\n${USAGE}`);
  return values[name];
}

function main([command, ...rest]) {
  const { values } = parseArgs({
    args: rest,
    options: {
      "data-dir": { type: "string" },
      out: { type: "string" },
      record: { type: "string" },
    },
  });
  if (command === "paused") {
    let status;
    try {
      status = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      throw new Error("the input is not the JSON of `bb updates app status --json`");
    }
    return answer(pauseBreaks(status), "The server will not install an update by itself.");
  }
  if (command === "record") {
    const dataDir = required(values, "data-dir");
    const record = recordChain({
      shim: json(path.join(dataDir, "bb-app-update-shim.json")),
      runtime: json(path.join(dataDir, "bb-app-runtime.json")),
      table: processTable(proc),
      bootId: bootId(),
      real,
    });
    writeFileSync(required(values, "out"), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    console.log(`Server ${record.version}, launcher process ${record.launcher.pid}.`);
    console.log(`Builds: ${record.folders.join(", ")}`);
    console.log(`${record.processes.length} processes written down:`);
    for (const one of record.processes) console.log(`  ${shown(one)}`);
    return 0;
  }
  if (command === "gone") {
    const dataDir = required(values, "data-dir");
    const record = json(required(values, "record"));
    if (record === null) throw new Error(`${values.record} does not exist`);
    return answer(
      remaining({
        record,
        table: processTable(proc),
        bootId: bootId(),
        shim: json(path.join(dataDir, "bb-app-update-shim.json")),
      }),
      `Nothing of the ${record.processes.length} processes written down is left, nothing runs from ${record.folders.join(" or ")}, and no launcher holds the data folder.`,
    );
  }
  throw new Error(USAGE);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
