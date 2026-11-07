import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  exportBb,
  hostCopyPlan,
  importIntoOneMa,
  parseArgs,
  runningFrom,
} from "./migrate-from-bb.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "migrate-from-bb-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (name) => path.join(scratch, `${name}-${(counter += 1)}`);
const quiet = () => {};

function write(root, relative, text = "x") {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), text);
}

// A bb data folder with server data (carried by an export) and machine data.
function bbFolder() {
  const from = fresh("bb");
  write(from, "bb.db", "db");
  write(from, "host-id", "host-1\n");
  write(from, "auth.json", '{"credential":"c"}');
  write(from, "thread-storage/thr_1/page.html", "<p>notes</p>");
  write(from, "local-plugins/demo/package.json", "{}");
  write(from, "plugins/automations/data.db", "plugin db");
  write(from, "plugins/browser-automation/host-data/profile/Cookies", "cookies");
  write(from, "plugins/provider-claude-code/bridge-data/session.json", "{}");
  write(from, "plugins/environment-git-worktree/host-data/worktrees/proj/wt/file", "code");
  write(from, "plugins/environment-git-worktree/host-data/state.json", "{}");
  write(from, "logs/server.log", "log");
  write(from, "bin/bb", "#!/bin/sh");
  return from;
}

// Stands in for 1ma's bb.js: "server import" writes a database into the data
// folder and prints what the real command prints with --json.
function fakeCli({ sourceDataDir, sourceServerHostId }) {
  const cli = `${fresh("cli")}.mjs`;
  writeFileSync(
    cli,
    `import { mkdirSync, writeFileSync } from "node:fs";
const [, , ...args] = process.argv;
if (args[0] !== "server" || args[1] !== "import") process.exit(2);
if (process.env.BB_THREAD_ID !== undefined) process.exit(3);
const dir = args[args.indexOf("--data-dir") + 1];
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/bb.db", "imported");
writeFileSync(dir + "/server-import.json", "{}");
process.stdout.write(JSON.stringify({
  dataDir: dir,
  bbVersion: "0.49.0",
  sourceDataDir: ${JSON.stringify(sourceDataDir)},
  sourceServerHostId: ${JSON.stringify(sourceServerHostId)},
  importedEntries: ["bb.db", "plugins/automations"],
}));
`,
  );
  return cli;
}

function archive() {
  const file = `${fresh("archive")}.tar`;
  writeFileSync(file, "tar");
  return file;
}

const importArgs = (from, to, cli, more = []) =>
  parseArgs(["import", "--from", from, "--to", to, "--archive", archive(), "--cli", cli, ...more]);

describe("arguments", () => {
  test("each command names what it needs, and a typo stops it", () => {
    assert.throws(() => parseArgs([]), /usage/);
    assert.throws(() => parseArgs(["export"]), /export needs --out/);
    assert.throws(() => parseArgs(["import", "--archive", "a.tar"]), /--cli/);
    assert.throws(() => parseArgs(["import", "--archive"]), /--archive needs a value/);
    assert.throws(() => parseArgs(["import", "--move-asid"]), /unknown argument --move-asid/);
    const options = parseArgs(["import", "--archive", "a.tar", "--cli", "bb.js", "--dry-run"]);
    assert.equal(options.dryRun, true);
    assert.equal(path.basename(options.from), ".bb");
    assert.equal(path.basename(options.to), ".1ma");
  });
});

describe("what still runs", () => {
  test("a live server pid or a fresh daemon lock counts; a dead pid or an old lock does not", () => {
    const dir = fresh("running");
    write(dir, "bb-app-runtime.json", JSON.stringify({ pid: 2 ** 22 + 12_345, version: "0.47.1" }));
    assert.deepEqual(runningFrom(dir), []);
    write(dir, "bb-app-runtime.json", JSON.stringify({ pid: process.pid, version: "0.47.1" }));
    assert.match(runningFrom(dir)[0], /server pid/);
    const other = fresh("lock");
    mkdirSync(path.join(other, "daemon.lock.lock"), { recursive: true });
    assert.match(runningFrom(other)[0], /machine daemon/);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(path.join(other, "daemon.lock.lock"), old, old);
    assert.deepEqual(runningFrom(other), []);
  });
});

describe("the machine data an export leaves behind", () => {
  test("is the identity, thread files, local plugins and the plugins' machine folders", () => {
    assert.deepEqual(
      hostCopyPlan(bbFolder()).map((entry) => entry.relative),
      [
        "host-id",
        "auth.json",
        "thread-storage",
        "local-plugins",
        "plugins/browser-automation/host-data",
        "plugins/environment-git-worktree/host-data",
        "plugins/provider-claude-code/bridge-data",
      ],
    );
  });
});

describe("importing into 1ma", () => {
  test("imports with 1ma's CLI, copies the machine data, leaves worktrees and bb alone", () => {
    const from = bbFolder();
    const to = fresh("1ma");
    const cli = fakeCli({ sourceDataDir: from, sourceServerHostId: "host-1" });
    const before = readdirSync(from).toSorted();
    const record = importIntoOneMa(importArgs(from, to, cli), quiet);
    assert.equal(readFileSync(path.join(to, "bb.db"), "utf8"), "imported");
    assert.equal(readFileSync(path.join(to, "host-id"), "utf8"), "host-1\n");
    assert.ok(existsSync(path.join(to, "thread-storage/thr_1/page.html")));
    assert.ok(existsSync(path.join(to, "plugins/browser-automation/host-data/profile/Cookies")));
    assert.ok(existsSync(path.join(to, "plugins/environment-git-worktree/host-data/state.json")));
    assert.ok(!existsSync(path.join(to, "plugins/environment-git-worktree/host-data/worktrees")));
    assert.ok(!existsSync(path.join(to, "logs")));
    assert.ok(!existsSync(path.join(to, "bin")));
    assert.equal(record.bbVersion, "0.49.0");
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(to, "1ma-migration.json"), "utf8")).copied,
      record.copied,
    );
    assert.deepEqual(readdirSync(from).toSorted(), before);
    assert.equal(readFileSync(path.join(from, "bb.db"), "utf8"), "db");
  });

  test("an archive from another bb is set aside, and nothing is copied into it", () => {
    const from = bbFolder();
    const to = fresh("1ma");
    const cli = fakeCli({ sourceDataDir: "/Users/other/.bb", sourceServerHostId: "host-9" });
    assert.throws(() => importIntoOneMa(importArgs(from, to, cli), quiet), /not from/);
    assert.ok(!existsSync(to));
    const kept = readdirSync(path.dirname(to)).find((name) =>
      name.startsWith(`${path.basename(to)}.wrong-archive-`),
    );
    assert.ok(kept);
    assert.ok(!existsSync(path.join(path.dirname(to), kept, "host-id")));
  });

  test("a 1ma folder in use is kept aside only when asked", () => {
    const from = bbFolder();
    const to = fresh("1ma");
    write(to, "bb.db", "sandbox");
    const cli = fakeCli({ sourceDataDir: from, sourceServerHostId: "host-1" });
    assert.throws(() => importIntoOneMa(importArgs(from, to, cli), quiet), /--move-aside/);
    const record = importIntoOneMa(importArgs(from, to, cli, ["--move-aside"]), quiet);
    assert.equal(readFileSync(path.join(record.movedAside, "bb.db"), "utf8"), "sandbox");
    assert.equal(readFileSync(path.join(to, "bb.db"), "utf8"), "imported");
  });

  test("refuses while bb runs, and a dry run changes nothing", () => {
    const from = bbFolder();
    const to = fresh("1ma");
    const cli = fakeCli({ sourceDataDir: from, sourceServerHostId: "host-1" });
    write(from, "bb-app-runtime.json", JSON.stringify({ pid: process.pid, version: "0.49.0" }));
    assert.throws(() => importIntoOneMa(importArgs(from, to, cli), quiet), /bb still runs/);
    rmSync(path.join(from, "bb-app-runtime.json"));
    const planned = importIntoOneMa(importArgs(from, to, cli, ["--dry-run"]), quiet);
    assert.equal(planned.dryRun, true);
    assert.ok(!existsSync(to));
  });

  test("the CLI does not see the BB_ variables of the terminal it runs in", () => {
    const from = bbFolder();
    const to = fresh("1ma");
    const cli = fakeCli({ sourceDataDir: from, sourceServerHostId: "host-1" });
    process.env.BB_THREAD_ID = "thr_outer";
    try {
      importIntoOneMa(importArgs(from, to, cli), quiet);
    } finally {
      delete process.env.BB_THREAD_ID;
    }
    assert.ok(existsSync(path.join(to, "bb.db")));
  });
});

describe("exporting from bb", () => {
  test("needs a running bb, turns on server move and keeps the export bb wrote", () => {
    const from = bbFolder();
    const out = path.join(fresh("export"), "bb-server.tar");
    const calls = path.join(scratch, `calls-${(counter += 1)}.txt`);
    const bb = path.join(from, "bin", "bb");
    writeFileSync(
      bb,
      `#!/bin/sh\necho "$BB_SERVER_URL $*" >> ${JSON.stringify(calls)}\nif [ "$2" = "export" ]; then echo '{"path":"${out}","sizeBytes":3,"sha256":"abc"}'; fi\n`,
    );
    chmodSync(bb, 0o755);
    assert.throws(
      () => exportBb(parseArgs(["export", "--from", from, "--out", out]), quiet),
      /no bb server is running/,
    );
    write(
      from,
      "bb-app-runtime.json",
      JSON.stringify({ pid: process.pid, version: "0.47.1", serverUrl: "http://127.0.0.1:38990" }),
    );
    const exported = exportBb(parseArgs(["export", "--from", from, "--out", out]), quiet);
    assert.equal(exported.sha256, "abc");
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
      "http://127.0.0.1:38990 settings experiment serverMove true",
      `http://127.0.0.1:38990 server export --out ${out} --json`,
    ]);
  });
});
