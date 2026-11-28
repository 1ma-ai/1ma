import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  NODE_VALUE_OPTIONS,
  checkRecord,
  commandOptions,
  end,
  gone,
  goneText,
  identityOf,
  judge,
  linuxBootId,
  linuxProc,
  parseCmdline,
  parseStat,
  parseToken,
  pauseBreaks,
  processTable,
  programsOf,
  recordChain,
  recordLines,
  remaining,
  scan,
  shown,
  unlock,
  writeRecord,
} from "./linux-launcher.mjs";

const NODE = "/home/dev/.local/opt/node-v24.22.1-linux-x64/bin/node";
const DATA = "/home/dev/.1ma";
const BOOT = "5f0c2a1e-boot";
const UID = 1000;

const p = (pid, ppid, started, ...argv) => ({
  pid,
  ppid,
  started: String(started),
  uid: UID,
  argv,
});

const shimText = (pid, entryPath) =>
  `${JSON.stringify({ entryPath, pid, startedAt: "2026-11-11T12:39:22.652Z" })}\n`;

/** A server started by the launcher of `anchor`, running the build in `build`. */
function server({ anchor, build }) {
  const entry = `${anchor}/node_modules/.bin/bb-app`;
  const table = [
    p(1, 0, 10, "/bin/bash", "/usr/local/bin/start-rdp"),
    p(900, 1, 50, "/usr/lib/claude-desktop/claude-desktop"),
    p(100, 0, 1000, "/usr/sbin/runuser", "-u", "dev", "--", "/usr/bin/env", entry),
    p(101, 100, 1001, "node", entry, "--server-port", "38886"),
    p(
      200,
      101,
      2000,
      NODE,
      `${build}/node_modules/bb-app/dist/bb-app.js`,
      "--server-port",
      "38886",
    ),
    p(201, 200, 2001, NODE, "--use-system-ca", `${build}/node_modules/bb-app/server/dist/index.js`),
    p(
      202,
      200,
      2002,
      NODE,
      "--use-system-ca",
      "--use-env-proxy",
      `${build}/node_modules/bb-app/host-daemon/dist/daemon-bundle.mjs`,
    ),
    p(
      300,
      202,
      3000,
      NODE,
      "--use-system-ca",
      `${build}/node_modules/bb-app/host-daemon/dist/bb-plugin-host-worker.mjs`,
      `${DATA}/plugin-host`,
    ),
    p(301, 300, 3001, "/home/dev/.local/bin/claude", "--print"),
  ];
  return {
    table,
    shim: shimText(101, entry),
    runtime: {
      entryPath: `${build}/node_modules/bb-app/dist/bb-app.js`,
      pid: 200,
      version: "0.49.1-1ma.123.1",
    },
  };
}

const VERSIONED = "/home/dev/.local/opt/1ma-server-0.49.1-1ma.123.1";
const VERSIONS = `${DATA}/app-versions`;
const INSTALLED = `${VERSIONS}/0.49.1-1ma.456.1`;
const ownBuild = () => server({ anchor: VERSIONED, build: VERSIONED });
const updated = () => server({ anchor: "/home/dev/.local/opt/1ma-server", build: INSTALLED });

const recorded = (state, real = (folder) => folder) =>
  recordChain({ dataDir: DATA, ...state, bootId: BOOT, real });

/** What the kernel answers about the numbers of `table`, and of `ended` ones not collected. */
function machine(table, ended = []) {
  const all = [
    ...table.map((one) => ({ ...one, ended: false })),
    ...ended.map((one) => ({ ...one, ended: true })),
  ];
  const find = (pid) => all.find((one) => one.pid === pid);
  return {
    table,
    exists: (pid) => find(pid) !== undefined,
    identity: (pid) => {
      const one = find(pid);
      return one === undefined
        ? null
        : { pid: one.pid, ppid: one.ppid, started: one.started, ended: one.ended };
    },
  };
}

const after = (state, table, shim = null, ended = []) =>
  remaining({ record: recorded(state), bootId: BOOT, shim, ...machine(table, ended) });

const texts = (lines) => lines.map((line) => line.text);
const token = (pid, started) => ({ pid, started: String(started) });
const kinds = (lines) => lines.map((line) => [line.kind, line.pid]);

const statLine = (pid, state) => `${pid} (node) ${state} 1 ${"0 ".repeat(17)}55 0`;
const behindALink = (folder) => folder.replace("/home/dev/.local/opt", "/mnt/disk/opt");

const outside = (state) => state.table.filter((one) => one.pid === 1 || one.pid === 900);

/** `bb thread list` run by the agent on the host: bb's CLI hands the work to the one beside the daemon. */
const bbCommand = () => [
  p(950, 900, 9950, NODE, `${INSTALLED}/node_modules/bb-app/dist/bb.js`, "thread", "list"),
  p(951, 950, 9951, NODE, `${INSTALLED}/node_modules/bb-app/host-daemon/dist/bb`, "thread", "list"),
  p(952, 951, 9952, "/usr/bin/git", "status"),
];

describe("the pause of automatic installation", () => {
  const paused = {
    activity: { phase: "idle" },
    autoUpdate: false,
    available: null,
    blocked: null,
    scheduled: null,
  };

  it("holds when installation is off, nothing is scheduled and nothing is under way", () => {
    assert.deepEqual(pauseBreaks(paused), []);
    assert.deepEqual(pauseBreaks({ ...paused, blocked: { reason: "fetch-failed" } }), []);
  });

  it("sees a scheduled installation although the releases could not be read", () => {
    const breaks = pauseBreaks({
      ...paused,
      blocked: { reason: "fetch-failed", message: "Couldn't check for a newer 1ma release." },
      scheduled: { requestedAt: "2026-11-25T10:00:00.000Z", requiredIdleMs: 900000 },
    });
    assert.equal(breaks.length, 1);
    assert.match(breaks[0], /is scheduled .*requestedAt.*off once more/);
  });

  it("does not hold while an installation prepares or the server restarts into it", () => {
    for (const phase of ["preparing", "restarting"]) {
      const breaks = pauseBreaks({ ...paused, activity: { phase, version: "0.49.1-1ma.456.1" } });
      assert.equal(breaks.length, 1);
      assert.match(breaks[0], new RegExp(`under way \\(${phase}\\) and cannot be cancelled: wait`));
    }
  });

  it("does not hold while automatic installation is on", () => {
    assert.match(
      pauseBreaks({ ...paused, autoUpdate: true })[0],
      /is not off \(autoUpdate is true\)/,
    );
  });

  it("does not take an answer that leaves a field out for a pause", () => {
    assert.equal(pauseBreaks({}).length, 3);
    assert.equal(pauseBreaks({ autoUpdate: false, scheduled: null }).length, 1);
    for (const status of [null, [], "off"]) assert.equal(pauseBreaks(status).length, 1);
  });
});

describe("reading /proc", () => {
  it("counts the fields after a name that holds spaces and brackets", () => {
    const stat = `4242 (tmux: server (1)) S 77 4242 4242 0 -1 4194560 ${"0 ".repeat(8)}20 0 1 0 987654 1 2`;
    assert.deepEqual(parseStat(stat), { pid: 4242, ppid: 77, started: "987654", ended: false });
    assert.equal(parseStat("no brackets here"), null);
  });

  it("keeps an argument with spaces as one argument", () => {
    assert.deepEqual(parseCmdline("node\0/a b/c.mjs\0--x\0"), ["node", "/a b/c.mjs", "--x"]);
  });

  it("leaves out a process that ended, while the table was read or before its parent noticed", () => {
    const table = processTable({
      list: () => [7, 8, 9],
      stat: (pid) => (pid === 8 ? null : statLine(pid, pid === 9 ? "Z" : "S")),
      cmdline: (pid) => (pid === 9 ? "" : "node\0x.mjs\0"),
      uid: () => UID,
    });
    assert.deepEqual(table, [
      { pid: 7, ppid: 1, started: "55", uid: UID, argv: ["node", "x.mjs"] },
    ]);
  });
});

describe("what a process runs", () => {
  it("is the script after the node options, also after options that take a value", () => {
    const script = "/srv/b/node_modules/bb-app/server/dist/index.js";
    for (const options of [
      ["--use-system-ca", "--use-env-proxy"],
      ["--require", "/home/dev/pre.cjs"],
      ["-r", "/home/dev/pre.cjs", "--import=/home/dev/pre.mjs"],
      ["--title", "PRIVATE-VALUE"],
      ["--conditions", "x", "--inspect", "--max-old-space-size=4096"],
      ["--"],
    ])
      assert.deepEqual(programsOf([NODE, ...options, script, "--port", "1"]), [NODE, script]);
    assert.deepEqual(programsOf([NODE, "--title", "PRIVATE-VALUE"]), [NODE]);
    assert.deepEqual(programsOf([NODE, "-C", "x", "-e", "0"]), [NODE]);
    assert.deepEqual(programsOf([NODE, "-", "/x.js"]), [NODE]);
  });

  it("knows every option this node prints with a value that must be given", () => {
    const help = execFileSync(process.execPath, ["--help"], { encoding: "utf8" });
    const needed = [];
    for (const line of help.split("\n")) {
      const head = /^ {2}(-\S.*?)(?: {2}|$)/.exec(line)?.[1];
      const value = head === undefined ? null : /^(.*?[^[])=/.exec(head);
      if (value === null) continue;
      const names = value[1].split(", ");
      needed.push(names.at(-1), ...names.filter((name) => /^-[a-zA-Z]$/.test(name)));
    }
    assert.ok(
      needed.includes("--require") && needed.includes("-r") && needed.includes("--inspect-port"),
    );
    assert.deepEqual(
      needed.filter((name) => !NODE_VALUE_OPTIONS.has(name)),
      [],
    );
  });
});

describe("what is written down before the stop", () => {
  it("is the launchers and every process below them, and the two builds they run from", () => {
    const state = updated();
    const record = recorded(state);
    assert.deepEqual(
      record.processes.map((one) => one.pid),
      [101, 200, 201, 202, 300, 301],
    );
    assert.deepEqual(record.folders, ["/home/dev/.local/opt/1ma-server", INSTALLED, VERSIONS]);
    assert.deepEqual(record.launcher, {
      pid: 101,
      started: "1001",
      uid: UID,
      entryPath: "/home/dev/.local/opt/1ma-server/node_modules/.bin/bb-app",
    });
    assert.deepEqual(record.runtime, {
      pid: 200,
      started: "2000",
      entryPath: `${INSTALLED}/node_modules/bb-app/dist/bb-app.js`,
    });
    assert.equal(record.at, "3001");
    assert.equal(record.shim, state.shim);
    assert.equal(record.dataDir, DATA);
  });

  it("names the data folder by the folder a link leads to, and says it", () => {
    const record = recorded({ ...updated(), dataDir: "/home/dev/.local/opt/data" }, behindALink);
    assert.equal(record.dataDir, "/mnt/disk/opt/data");
    assert.ok(recordLines(record).includes("Data folder: /mnt/disk/opt/data"));
  });

  it("is used only when it has the shape `record` writes", () => {
    const record = JSON.parse(JSON.stringify(recorded(updated())));
    assert.equal(checkRecord(record, "r.json"), record);
    const { at, ...previous } = record;
    assert.equal(at, "3001");
    previous.processes = record.processes.map(({ pid, started }) => ({
      pid,
      started,
      argv: ["node"],
    }));
    assert.throws(
      () => checkRecord(previous, "r.json"),
      /^Error: r\.json is not a record written by 'record': /,
    );
    assert.throws(
      () => checkRecord({ ...record, processes: [{ pid: 1 }] }, "r.json"),
      /r\.json is not a record written by 'record': processes/,
    );
    assert.throws(
      () => checkRecord({ bootId: BOOT, version: "0.49.1", at: "3001" }, "r.json"),
      /r\.json is not a record written by 'record': /,
    );
    for (const value of [null, [], "x"])
      assert.throws(() => checkRecord(value, "r.json"), /is not a record written by 'record'/);
  });

  it("names a build once when the launcher runs its own, and also by the folder a link leads to", () => {
    assert.deepEqual(recorded(ownBuild()).folders, [VERSIONED, VERSIONS]);
    assert.deepEqual(recorded(ownBuild(), behindALink).folders, [
      VERSIONED,
      "/mnt/disk/opt/1ma-server-0.49.1-1ma.123.1",
      VERSIONS,
    ]);
  });

  it("holds the programs of a process and none of its other arguments, in the file and on the screen", () => {
    const state = updated();
    const secret = "Bearer sk-test-7f3a9c";
    state.table.push(
      p(302, 300, 3002, "/bin/sh", "-c", `curl -H 'Authorization: ${secret}' https://x`),
      p(303, 300, 3003, NODE, "--use-system-ca", "-e", `fetch("https://x", "${secret}")`),
      p(304, 300, 3004, NODE, `--eval=${secret}`),
      p(305, 300, 3005, NODE, "/home/dev/tools/run.mjs", `--token=${secret}`),
    );
    const record = recorded(state);
    const out = recordLines(record).join("\n");
    for (const text of [JSON.stringify(record), out]) {
      assert.equal(text.includes("sk-test-7f3a9c"), false);
      assert.equal(text.includes("38886"), false);
    }
    assert.deepEqual(
      record.processes.slice(-4).map((one) => one.programs),
      [["/bin/sh"], [NODE], [NODE], [NODE, "/home/dev/tools/run.mjs"]],
    );
    assert.match(out, /^ {2}process 305: \S+node \/home\/dev\/tools\/run\.mjs$/m);
  });

  it("is a file only its owner can read, also under the usual umask", (t) => {
    const folder = fs.mkdtempSync(path.join(tmpdir(), "p18r8b-record-"));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const umask = process.umask(0o022);
    t.after(() => process.umask(umask));
    const file = path.join(folder, "record.json");
    writeRecord(file, recorded(updated()));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => writeRecord(file, recorded(updated())), /EEXIST/);
  });

  it("is refused when the data folder does not describe the running server", () => {
    const state = updated();
    const entry = "/home/dev/.local/opt/1ma-server/node_modules/.bin/bb-app";
    assert.throws(() => recorded({ ...state, shim: null }), /bb-app-update-shim.json is missing/);
    assert.throws(() => recorded({ ...state, runtime: null }), /bb-app-runtime.json is missing/);
    assert.throws(
      () => recorded({ ...state, shim: "{" }),
      /bb-app-update-shim.json is not a file bb accepts \(it is not JSON\): it does not describe the running server/,
    );
    assert.throws(
      () => recorded({ ...state, shim: shimText(77777, entry) }),
      /names the outer launcher, process 77777, which is not running/,
    );
    assert.throws(
      () => recorded({ ...state, shim: shimText(900, entry) }),
      /\.bin\/bb-app, which is not what process 900: \/usr\/lib\/claude-desktop\/claude-desktop runs/,
    );
    assert.throws(
      () => recorded({ ...state, runtime: { ...state.runtime, pid: 900 } }),
      /names the inner launcher that starts the server, process 900, which the outer launcher 101 did not start: two launchers/,
    );
    assert.throws(
      () => recorded({ ...state, runtime: { ...state.runtime, entryPath: "/opt/1ma/bb-app.js" } }),
      /bb-app-runtime.json names "\/opt\/1ma\/bb-app.js", which is not a file inside the node_modules/,
    );
  });

  it("leaves out a process older than the one its parent number names: that number was reused", () => {
    const state = updated();
    state.table.push(p(850, 202, 1500, "/usr/bin/sleep", "600"));
    assert.equal(
      recorded(state).processes.some((one) => one.pid === 850),
      false,
    );
  });

  it("is refused when the runtime file names a process of the chain that runs another program", () => {
    const state = updated();
    assert.throws(
      () => recorded({ ...state, runtime: { ...state.runtime, pid: 201 } }),
      /bb-app-runtime.json names the inner launcher that starts the server \S+\/dist\/bb-app\.js, which is not what process 201: \S+node \S+\/server\/dist\/index\.js runs/,
    );
  });
});

describe("what is left after the stop", () => {
  it("shows a process on one line by its programs", () => {
    const script = `set -e\ncd /tmp\n${"echo step\n".repeat(60)}`;
    assert.equal(shown(p(77, 1, 5, "/bin/bash", "-c", script)), "process 77: /bin/bash");
    assert.equal(shown(p(78, 1, 5)), "process 78: (no program)");
  });

  it("is nothing when the whole chain ended", () => {
    for (const state of [ownBuild(), updated()]) assert.deepEqual(after(state, outside(state)), []);
  });

  it("is the launcher of a build in a folder named after its version, although no port answers", () => {
    const state = ownBuild();
    const table = state.table.filter((one) => one.pid !== 201);
    const left = after(state, table, state.shim);
    assert.equal(left.filter((line) => line.kind === "recorded").length, 5);
    assert.ok(texts(left).some((line) => line.startsWith("still running, process 101: node ")));
    assert.deepEqual(kinds([left.at(-1)]), [["lock-launcher", 101]]);
    assert.match(left.at(-1).text, /process 101, has not ended/);
  });

  it("is a daemon that lost its parent", () => {
    const state = updated();
    const daemon = { ...state.table.find((one) => one.pid === 202), ppid: 1 };
    assert.deepEqual(texts(after(state, [...outside(state), daemon])), [
      `still running, ${shown(daemon)}`,
    ]);
  });

  it("is a process that was written down and does not run from either build", () => {
    const state = updated();
    const agent = { ...state.table.find((one) => one.pid === 301), ppid: 1 };
    assert.deepEqual(texts(after(state, [...outside(state), agent])), [
      "still running, process 301: /home/dev/.local/bin/claude",
    ]);
  });

  it("is a program started after the record under a surviving worker, whatever it runs", () => {
    const state = updated();
    const worker = state.table.find((one) => one.pid === 300);
    const tool = p(700, 300, 9500, "/usr/bin/python3", "/tmp/job.py");
    const below = p(701, 700, 9501, "/usr/bin/sleep", "60");
    const left = after(state, [...outside(state), { ...worker, ppid: 1 }, tool, below]);
    assert.deepEqual(kinds(left), [
      ["recorded", 300],
      ["child", 700],
      ["child", 701],
    ]);
    assert.equal(
      left[1].text,
      "started by the stopped server after the record, process 700: /usr/bin/python3",
    );
  });

  it("is a worker started between the record and the stop, as one that runs from the build", () => {
    const state = updated();
    const worker = p(
      555,
      1,
      9000,
      NODE,
      "--use-system-ca",
      `${INSTALLED}/node_modules/bb-app/host-daemon/dist/bb-provider-bridge-worker.mjs`,
    );
    const left = after(state, [...outside(state), worker]);
    assert.deepEqual(kinds(left), [["from-build", 555]]);
    assert.equal(
      left[0].text,
      `runs a program from the server's builds in ${INSTALLED}, ${shown(worker, "555@9000")}: it is a piece of the stopped server, unless a launcher was started from this build after the stop`,
    );
    const binary = p(556, 1, 9001, `${INSTALLED}/node_modules/@bb/tools/bin/rg`, "--files");
    assert.deepEqual(kinds(after(state, [...outside(state), binary])), [["from-build", 556]]);
  });

  it("is a bb command, with all it started, when the stopped server did not start it", () => {
    const state = updated();
    const table = [...outside(state), ...bbCommand()];
    const left = after(state, table);
    assert.deepEqual(kinds(left), [
      ["command", 950],
      ["command", 951],
      ["command", 952],
    ]);
    assert.equal(
      left[0].text,
      `is a bb command run from ${INSTALLED}, process 950@9950: ${NODE} ${INSTALLED}/node_modules/bb-app/dist/bb.js: the stopped server did not start it, so it is not the server's: wait for it to end, or set it aside with gone --not-ours 950@9950`,
    );
    assert.match(
      left[1].text,
      /^is part of the bb command 950@9950, process 951@9951: \S+node \S+\/host-daemon\/dist\/bb: .*gone --not-ours 950@9950$/,
    );
    const answer = (notOurs) =>
      gone({
        record: recorded(state),
        uid: UID,
        notOurs,
        bootId: BOOT,
        shim: null,
        ...machine(table),
      });
    assert.equal(answer([]).code, 1);
    const aside = answer([token(950, 9950)]);
    assert.equal(aside.code, 0);
    assert.match(aside.lines[0], /other than the 3 looked at/);
    assert.deepEqual(answer([token(951, 9951)]).lines, [
      left[0].text,
      ...left.slice(1).map((line) => `looked at, not the server's: ${line.text}`),
    ]);
    const direct = p(953, 900, 9953, NODE, `${INSTALLED}/node_modules/bb-app/host-daemon/dist/bb`);
    assert.deepEqual(kinds(after(state, [...outside(state), direct])), [["command", 953]]);
  });

  it("counts a program of an older installed version that lost its parent before the record", () => {
    const state = updated();
    const older = p(
      150,
      1,
      1500,
      NODE,
      "--use-system-ca",
      `${VERSIONS}/0.49.1-1ma.123.1/node_modules/bb-app/host-daemon/dist/daemon-bundle.mjs`,
    );
    const left = after(state, [...outside(state), older]);
    assert.deepEqual(kinds(left), [["from-build", 150]]);
    assert.match(
      left[0].text,
      new RegExp(`^runs a program from the server's builds in ${VERSIONS}, `),
    );
    assert.deepEqual(kinds(judge(left).counted), [["from-build", 150]]);
  });

  it("counts a program started behind a node option that takes a value", () => {
    const state = updated();
    const hidden = p(
      970,
      1,
      1600,
      NODE,
      "--require",
      "/home/dev/preload.cjs",
      `${INSTALLED}/node_modules/bb-app/server/dist/index.js`,
    );
    assert.deepEqual(kinds(after(state, [...outside(state), hidden])), [["from-build", 970]]);
  });

  it("takes a second server started from the same build for one that runs from it, not for a written-down one", () => {
    const state = ownBuild();
    const second = [
      p(4101, 900, 5001, "node", `${VERSIONED}/node_modules/.bin/bb-app`, "--data-dir", "/srv/b"),
      p(4200, 4101, 5002, NODE, `${VERSIONED}/node_modules/bb-app/dist/bb-app.js`),
    ];
    assert.deepEqual(kinds(after(state, [...outside(state), ...second])), [
      ["from-build", 4101],
      ["from-build", 4200],
    ]);
  });

  it("is a program outside both builds that lost its parent after the record", () => {
    const state = updated();
    const acp = p(800, 1, 9800, "/home/dev/.local/share/acp/bin/agent", "--stdio");
    const left = after(state, [...outside(state), acp]);
    assert.deepEqual(kinds(left), [["orphan", 800]]);
    assert.equal(
      left[0].text,
      "started after the record and lost its parent, process 800@9800: /home/dev/.local/share/acp/bin/agent: it may be a program an agent of the stopped server started, or something else on this machine",
    );
    assert.equal(judge(left).counted.length, 1);
  });

  it("is a program that lost its parent and started in the clock tick of the record", () => {
    const state = updated();
    const record = recorded(state);
    const agent = p(960, 1, record.at, "/home/dev/.local/bin/claude");
    assert.deepEqual(kinds(after(state, [...outside(state), agent])), [["orphan", 960]]);
  });

  it("is not a process whose parent number belongs to a younger process", () => {
    const state = updated();
    const worker = { ...state.table.find((one) => one.pid === 300), ppid: 1 };
    const older = p(850, 300, 2500, "/usr/bin/sleep", "600");
    assert.deepEqual(kinds(after(state, [...outside(state), worker, older])), [["recorded", 300]]);
    const known = p(555, 1, 9000, "/usr/bin/xdg-open");
    const before = p(556, 555, 8000, "/usr/bin/sleep");
    const lines = scan({
      record: recorded(state),
      table: [...outside(state), known, before],
      bootId: BOOT,
      known: new Map([[555, "9000"]]),
    });
    assert.deepEqual(kinds(lines), [["orphan", 555]]);
  });

  it("is not a parentless program that started before the record, or one of another user", () => {
    const state = updated();
    const older = p(801, 1, 2500, "/home/dev/.local/share/acp/bin/agent");
    const root = { ...p(802, 1, 9802, "/usr/sbin/cron"), uid: 0 };
    assert.deepEqual(after(state, [...outside(state), older, root]), []);
  });

  it("is not a new process that got the number of an ended one", () => {
    const state = updated();
    assert.deepEqual(
      after(state, [...outside(state), p(202, 900, 99999, "/usr/bin/sleep", "60")]),
      [],
    );
  });

  it("is not another program that only names a path inside a build", () => {
    const state = updated();
    const others = [
      p(600, 900, 9100, "/usr/bin/tail", "-f", `${INSTALLED}/build.log`),
      p(601, 900, 9101, "/usr/bin/grep", "-r", "x", "/home/dev/.local/opt/1ma-server/node_modules"),
      p(602, 900, 9102, NODE, "/home/dev/tools/size.mjs", `${INSTALLED}/node_modules/bb-app`),
      p(603, 900, 9103, NODE, "/home/dev/.local/opt/1ma-server-next/node_modules/.bin/bb-app"),
    ];
    assert.deepEqual(after(state, [...outside(state), ...others]), []);
  });

  it("is nothing of the written-down processes after the machine restarted", () => {
    const state = updated();
    const left = remaining({
      record: recorded(state),
      bootId: "another-boot",
      shim: null,
      ...machine(state.table.map((one) => ({ ...one, argv: ["/usr/bin/sleep", "60"] }))),
    });
    assert.deepEqual(left, []);
  });

  it("sets aside, once looked at, only a program that runs from the build or lost its parent", () => {
    const state = updated();
    const daemon = { ...state.table.find((one) => one.pid === 202), ppid: 1 };
    const fromBuild = p(555, 1, 9000, `${INSTALLED}/node_modules/@bb/tools/bin/rg`);
    const orphan = p(800, 1, 9800, "/usr/bin/xdg-open");
    const lines = after(state, [...outside(state), daemon, fromBuild, orphan]);
    const { counted, covered } = judge(lines, [token(555, 9000), token(800, 9800)]);
    assert.deepEqual(kinds(counted), [["recorded", 202]]);
    assert.deepEqual(kinds(covered), [
      ["from-build", 555],
      ["orphan", 800],
    ]);
    assert.throws(
      () => judge(lines, [token(202, 2002)]),
      /--not-ours 202@2002: no line of a program/,
    );
    assert.throws(() => judge(lines, [token(4242, 1)]), /--not-ours 4242@1/);
    const child = p(700, 202, 9500, "/usr/bin/sleep");
    assert.throws(
      () => judge(after(state, [...outside(state), daemon, child]), [token(700, 9500)]),
      /--not-ours 700/,
    );
    const shim = after(
      state,
      [...outside(state), p(101, 900, 77777, "/usr/bin/sleep")],
      state.shim,
    );
    assert.throws(() => judge(shim, [token(101, 77777)]), /--not-ours 101@77777/);
    const done = judge(after(state, [...outside(state), orphan]), [token(800, 9800)]);
    assert.deepEqual(done.counted, []);
    const text = goneText(recorded(state), done.covered).join("\n");
    assert.match(text, /other than the 1 looked at/);
    assert.match(
      text,
      /Not seen by this check: a program outside these folders that had already lost its parent before the record, or one that another process than process 1 adopted/,
    );
    assert.match(
      text,
      /looked at, not the server's: started after the record and lost its parent, process 800@9800/,
    );
  });
});

describe("whether bb will take the data folder for held", () => {
  it("is held by the launcher written down that ended and waits to be collected", () => {
    const state = updated();
    const launcher = state.table.find((one) => one.pid === 101);
    const left = after(state, outside(state), state.shim, [launcher]);
    assert.deepEqual(kinds(left), [["lock-launcher", 101]]);
    assert.match(
      left[0].text,
      /has ended and waits for its parent to collect it.*wait and check again/,
    );
  });

  it("is held by a file left by the ended launcher whose number another program got: that program is not to be touched", () => {
    const state = updated();
    const other = p(101, 900, 77777, "/usr/bin/sleep", "600");
    const left = after(state, [...outside(state), other], state.shim);
    assert.deepEqual(kinds(left), [["lock-leftover", 101]]);
    assert.match(left[0].text, /^bb-app-update-shim\.json is left by the launcher that ended/);
    assert.match(left[0].text, /belongs to another program \(process 101: \/usr\/bin\/sleep\)/);
    assert.match(left[0].text, /not to be touched.*`unlock` removes the file/);
    const rebooted = remaining({
      record: recorded(state),
      bootId: "another-boot",
      shim: state.shim,
      ...machine([{ ...state.table.find((one) => one.pid === 101), argv: ["/usr/bin/sleep"] }]),
    });
    assert.deepEqual(kinds(rebooted), [["lock-leftover", 101]]);
  });

  it("is held by another launcher when the file was written after the record", () => {
    const state = updated();
    const other = p(4040, 900, 9900, "node", "/srv/other/node_modules/.bin/bb-app");
    const left = after(
      state,
      [...outside(state), other],
      shimText(4040, "/srv/other/node_modules/.bin/bb-app"),
    );
    assert.deepEqual(kinds(left), [["lock-other", 4040]]);
    assert.match(
      left[0].text,
      /written after the record: another launcher, process 4040: node \/srv\/other\/node_modules\/\.bin\/bb-app, took the data folder\. End or remove nothing/,
    );
    const sameNumber = after(
      state,
      [...outside(state), p(101, 900, 9901, "node")],
      shimText(101, "/x/bb-app"),
    );
    assert.deepEqual(kinds(sameNumber), [["lock-other", 101]]);
  });

  it("is not held by a file whose process does not exist", () => {
    const state = updated();
    assert.deepEqual(after(state, outside(state), shimText(4040, "/x/bb-app")), []);
    assert.deepEqual(after(state, outside(state), state.shim), []);
  });

  it("is not held by a file bb does not accept, which the next launcher replaces", () => {
    const state = updated();
    const live = machine([...outside(state), p(4040, 900, 9900, "node", "/srv/other/bb-app")]);
    const noStart = `${JSON.stringify({ entryPath: "/srv/other/bb-app", pid: 4040 })}\n`;
    const unnamed = "it does not name the launcher by pid, entryPath and startedAt";
    for (const [text, wrong] of [
      [noStart, unnamed],
      [state.shim.slice(0, 30), "it is not JSON"],
      [JSON.stringify({ entryPath: "/x", pid: 4040.5, startedAt: "t" }), unnamed],
    ]) {
      const answer = gone({
        record: recorded(state),
        uid: UID,
        bootId: BOOT,
        shim: text,
        ...live,
        table: outside(state),
      });
      assert.equal(answer.code, 0);
      assert.equal(
        answer.lines.at(-1),
        `bb-app-update-shim.json is not a file bb accepts (${wrong}): it holds the data folder for no process, and the next launcher replaces it`,
      );
    }
    assert.throws(
      () => recorded({ ...state, shim: `${JSON.stringify({ entryPath: "/x", pid: 101 })}\n` }),
      /bb-app-update-shim.json is not a file bb accepts \(it does not name the launcher by pid, entryPath and startedAt\): it does not describe the running server/,
    );
  });

  it("names `end` as the step for the launcher written down that has not ended", () => {
    const state = updated();
    const launcher = state.table.find((one) => one.pid === 101);
    const left = after(state, [...outside(state), launcher], state.shim);
    assert.deepEqual(kinds(left), [
      ["recorded", 101],
      ["lock-launcher", 101],
    ]);
    assert.match(left[1].text, /has not ended.*it is a still running line too, and `end` ends it$/);
  });
});

/** A process table that changes as `end` signals and waits. */
function stage(table) {
  const state = { table: [...table], sent: [], log: [], onSleep: [] };
  return {
    state,
    readTable: () => state.table,
    identity: (pid) => machine(state.table).identity(pid),
    signal: (pid, name) => {
      state.sent.push([pid, name]);
      const one = state.table.find((each) => each.pid === pid);
      if (name === "SIGKILL" || !one.ignoresTerm)
        state.table = state.table.filter((each) => each !== one);
    },
    sleep: async () => {
      state.onSleep.shift()?.();
    },
    log: (line) => state.log.push(line),
  };
}

describe("ending what is left", () => {
  it("does not signal a written-down process whose number went to another program before the signal", async () => {
    const state = updated();
    const daemon = { ...state.table.find((one) => one.pid === 202), ppid: 1 };
    const run = stage([...outside(state), daemon]);
    const identity = run.identity;
    run.identity = (pid) => {
      if (pid === 202) run.state.table = [...outside(state), p(202, 900, 99999, "/usr/bin/vim")];
      return identity(pid);
    };
    await end({ record: recorded(state), bootId: BOOT, uid: UID, ...run });
    assert.deepEqual(run.state.sent, []);
    assert.ok(run.state.table.some((one) => one.pid === 202 && one.started === "99999"));
    assert.match(
      run.state.log[0],
      /process 202 has ended or its number belongs to another process: no SIGTERM/,
    );
  });

  it("reports a number that changed hands between the check and the signal", async () => {
    const state = updated();
    const daemon = { ...state.table.find((one) => one.pid === 202), ppid: 1 };
    const run = stage([...outside(state), daemon]);
    const signal = run.signal;
    run.signal = (pid, name) => {
      signal(pid, name);
      run.state.table = [...run.state.table, p(202, 900, 99999, "/usr/bin/vim")];
    };
    const answer = await end({ record: recorded(state), bootId: BOOT, uid: UID, ...run });
    assert.deepEqual(answer, { changedHands: [202] });
    assert.deepEqual(run.state.sent, [[202, "SIGTERM"]]);
    assert.match(
      run.state.log[1],
      /^process 202: the number changed hands between the check and the signal, the SIGTERM may have reached another program \(started at 99999\)$/,
    );
    const quiet = stage([...outside(state), daemon]);
    assert.deepEqual(await end({ record: recorded(state), bootId: BOOT, uid: UID, ...quiet }), {
      changedHands: [],
    });
  });

  it("sends no SIGKILL to a number that went to another program after the SIGTERM", async () => {
    const state = updated();
    const worker = { ...state.table.find((one) => one.pid === 300), ppid: 1, ignoresTerm: true };
    const run = stage([...outside(state), worker]);
    const identity = run.identity;
    run.identity = (pid) =>
      pid === 300 && run.state.sent.length > 0
        ? { pid, ppid: 900, started: "99999", ended: false }
        : identity(pid);
    const answer = await end({ record: recorded(state), bootId: BOOT, uid: UID, grace: 0, ...run });
    assert.deepEqual(run.state.sent, [[300, "SIGTERM"]]);
    assert.deepEqual(answer, { changedHands: [300] });
    assert.match(
      run.state.log.at(-1),
      /process 300 has ended or its number belongs to another process: no SIGKILL/,
    );
  });

  it("refuses, sending nothing, when run as another user than the server's", async () => {
    const state = updated();
    const daemon = { ...state.table.find((one) => one.pid === 202), ppid: 1 };
    const run = stage([...outside(state), daemon]);
    await assert.rejects(
      end({ record: recorded(state), bootId: BOOT, uid: 0, ...run }),
      /run it as the user the server runs as/,
    );
    assert.deepEqual(run.state.sent, []);
  });

  it("ends a written-down process that ignores SIGTERM, and a child it starts while ending", async () => {
    const state = updated();
    const worker = { ...state.table.find((one) => one.pid === 300), ppid: 1, ignoresTerm: true };
    const run = stage([...outside(state), worker]);
    run.state.onSleep.push(() => {
      run.state.table.push({ ...p(710, 300, 9600, "/usr/bin/sleep", "600"), ignoresTerm: true });
    });
    await end({ record: recorded(state), bootId: BOOT, uid: UID, ...run });
    assert.deepEqual(run.state.sent, [
      [300, "SIGTERM"],
      [710, "SIGTERM"],
      [300, "SIGKILL"],
      [710, "SIGKILL"],
    ]);
    assert.deepEqual(run.state.table, outside(state));
  });

  it("ends a program given with --also only when it runs from the build or lost its parent", async () => {
    const state = updated();
    const desktop = p(901, 900, 9700, "/usr/bin/xterm");
    const fromBuild = p(555, 1, 9000, `${INSTALLED}/node_modules/@bb/tools/bin/rg`);
    for (const pid of [901, 900, 4242]) {
      const run = stage([...outside(state), desktop, fromBuild]);
      await assert.rejects(
        end({
          record: recorded(state),
          bootId: BOOT,
          uid: UID,
          also: [token(555, 9000), token(pid, pid === 901 ? 9700 : 50)],
          ...run,
        }),
        new RegExp(`--also ${pid}@\\d+: no line`),
      );
      assert.deepEqual(run.state.sent, []);
    }
    const run = stage([...outside(state), desktop, fromBuild]);
    await end({
      record: recorded(state),
      bootId: BOOT,
      uid: UID,
      also: [token(555, 9000)],
      ...run,
    });
    assert.deepEqual(run.state.sent, [[555, "SIGTERM"]]);
    assert.deepEqual(run.state.table, [...outside(state), desktop]);
  });

  it("ends a program given with --also only while its number has the start time looked at", async () => {
    const state = updated();
    const newcomer = p(600, 1, 9990, `${INSTALLED}/node_modules/@bb/tools/bin/rg`);
    const run = stage([...outside(state), newcomer]);
    await assert.rejects(
      end({ record: recorded(state), bootId: BOOT, uid: UID, also: [token(600, 9000)], ...run }),
      /^Error: --also 600@9000: no line of a program .* with this start time\. The number may belong to another program by now/,
    );
    assert.deepEqual(run.state.sent, []);
    const lines = after(state, [...outside(state), newcomer]);
    assert.throws(() => judge(lines, [token(600, 9000)]), /--not-ours 600@9000: .*start time/);
    assert.deepEqual(kinds(judge(lines, [token(600, 9990)]).covered), [["from-build", 600]]);
  });

  it("refuses, sending nothing, when it was started by the server it would end", async () => {
    const state = updated();
    const worker = { ...state.table.find((one) => one.pid === 300), ppid: 1 };
    const shell = p(720, 300, 9600, "/bin/bash");
    const self = p(721, 720, 9601, NODE, "/home/dev/1ma/scripts/linux-launcher.mjs");
    const run = stage([...outside(state), worker, shell, self]);
    await assert.rejects(
      end({ record: recorded(state), bootId: BOOT, uid: UID, self: 721, ...run }),
      /this command was started by the server it would end \(process 721\): run it from outside that server, after the stop/,
    );
    assert.deepEqual(run.state.sent, []);
    const orphan = p(800, 1, 9800, "/home/dev/.local/share/acp/bin/agent");
    const below = p(801, 800, 9801, NODE, "/home/dev/1ma/scripts/linux-launcher.mjs");
    const second = stage([...outside(state), orphan, below]);
    await assert.rejects(
      end({
        record: recorded(state),
        bootId: BOOT,
        uid: UID,
        also: [token(800, 9800)],
        self: 801,
        ...second,
      }),
      /started by the server it would end \(process 801\)/,
    );
    assert.deepEqual(second.state.sent, []);
    const outsider = p(802, 900, 9802, NODE, "/home/dev/1ma/scripts/linux-launcher.mjs");
    const third = stage([...outside(state), worker, outsider]);
    await end({ record: recorded(state), bootId: BOOT, uid: UID, self: 802, ...third });
    assert.deepEqual(third.state.sent, [[300, "SIGTERM"]]);
  });

  it("refuses --also for a bb command, sending nothing", async () => {
    const state = updated();
    for (const pid of [950, 951]) {
      const run = stage([...outside(state), ...bbCommand()]);
      await assert.rejects(
        end({
          record: recorded(state),
          bootId: BOOT,
          uid: UID,
          also: [token(pid, pid === 950 ? 9950 : 9951)],
          ...run,
        }),
        new RegExp(
          `^Error: --also ${pid}@\\d+: this process is a bb command or part of one, not the server's`,
        ),
      );
      assert.deepEqual(run.state.sent, []);
    }
  });

  it("ends a bb command the stopped server started, without --also", async () => {
    const state = updated();
    const worker = { ...state.table.find((one) => one.pid === 300), ppid: 1 };
    const cli = p(960, 300, 9600, NODE, `${INSTALLED}/node_modules/bb-app/dist/bb.js`, "thread");
    assert.deepEqual(kinds(after(state, [...outside(state), worker, cli])), [
      ["recorded", 300],
      ["child", 960],
    ]);
    const run = stage([...outside(state), worker, cli]);
    await end({ record: recorded(state), bootId: BOOT, uid: UID, ...run });
    assert.deepEqual(run.state.sent, [
      [300, "SIGTERM"],
      [960, "SIGTERM"],
    ]);
  });

  it("ends with --also a worker of an installed version that lost its parent", async () => {
    const state = updated();
    const worker = p(
      555,
      1,
      9000,
      NODE,
      `${INSTALLED}/node_modules/bb-app/host-daemon/dist/bb-plugin-host-worker.mjs`,
    );
    const daemon = p(
      556,
      1,
      9001,
      NODE,
      `${VERSIONS}/0.49.1-1ma.123.1/node_modules/bb-app/host-daemon/dist/daemon-bundle.mjs`,
    );
    const left = after(state, [...outside(state), worker, daemon]);
    assert.deepEqual(kinds(left), [
      ["from-build", 555],
      ["from-build", 556],
    ]);
    for (const line of left) assert.doesNotMatch(line.text, /bb command/);
    const run = stage([...outside(state), worker, daemon]);
    await end({
      record: recorded(state),
      bootId: BOOT,
      uid: UID,
      also: [token(555, 9000), token(556, 9001)],
      ...run,
    });
    assert.deepEqual(run.state.sent, [
      [555, "SIGTERM"],
      [556, "SIGTERM"],
    ]);
  });

  it("refuses every --also while another launcher holds the data folder", async () => {
    const state = updated();
    const launcher = p(4101, 900, 9900, "node", `${VERSIONED}/node_modules/.bin/bb-app`);
    const inner = p(4200, 4101, 9901, NODE, `${INSTALLED}/node_modules/bb-app/dist/bb-app.js`);
    const table = [...outside(state), launcher, inner];
    const shim = shimText(4101, `${VERSIONED}/node_modules/.bin/bb-app`);
    assert.deepEqual(kinds(after(state, table, shim)), [
      ["from-build", 4200],
      ["lock-other", 4101],
    ]);
    const run = stage(table);
    await assert.rejects(
      end({
        record: recorded(state),
        bootId: BOOT,
        uid: UID,
        also: [token(4200, 9901)],
        shim,
        exists: machine(table).exists,
        ...run,
      }),
      /^Error: --also is refused while another launcher holds the data folder: bb-app-update-shim\.json was written after the record/,
    );
    assert.deepEqual(run.state.sent, []);
  });

  it("stops, sending nothing more, when a later read finds the command below what it ends", async () => {
    const state = updated();
    const worker = { ...state.table.find((one) => one.pid === 300), ppid: 1, ignoresTerm: true };
    for (const [self, below] of [
      [802, []],
      [803, [p(803, 802, 9803, NODE, "/home/dev/1ma/scripts/linux-launcher.mjs")]],
    ]) {
      const command = p(802, 900, 9802, self === 802 ? NODE : "/bin/bash");
      const run = stage([...outside(state), worker, command, ...below]);
      run.state.onSleep.push(() => {
        run.state.table = run.state.table.map((one) =>
          one.pid === 802 ? { ...one, ppid: 300 } : one,
        );
      });
      await assert.rejects(
        end({ record: recorded(state), bootId: BOOT, uid: UID, self, ...run }),
        new RegExp(`this command was started by the server it would end \\(process ${self}\\)`),
      );
      assert.deepEqual(run.state.sent, [[300, "SIGTERM"]]);
    }
  });

  it("ends real processes that were written down and leaves one that was not", async (t) => {
    const start = (code) => {
      const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
      return child;
    };
    const ready = async (child) => {
      const [chunk] = await once(child.stdout, "data");
      assert.equal(String(chunk), "ready");
      return child;
    };
    const stays = "setInterval(() => {}, 1000); process.stdout.write('ready')";
    const polite = await ready(start(stays));
    const stubborn = await ready(start(`process.on('SIGTERM', () => {}); ${stays}`));
    const bystander = await ready(start(stays));
    const ours = new Set([polite.pid, stubborn.pid]);
    const identity = identityOf(linuxProc);
    const readTable = () => processTable(linuxProc);
    const table = readTable();
    const record = {
      bootId: linuxBootId(),
      dataDir: tmpdir(),
      at: table.reduce(
        (newest, one) => (BigInt(one.started) > BigInt(newest) ? one.started : newest),
        "0",
      ),
      shim: "",
      launcher: {
        pid: polite.pid,
        started: identity(polite.pid).started,
        uid: process.getuid(),
        entryPath: "",
      },
      runtime: { pid: stubborn.pid, started: identity(stubborn.pid).started, entryPath: "" },
      folders: [],
      processes: [...ours].map((pid) => ({
        pid,
        started: identity(pid).started,
        programs: [process.execPath],
      })),
    };
    const bystanderStarted = identity(bystander.pid).started;
    const exits = [once(polite, "exit"), once(stubborn, "exit")];
    await end({
      record,
      bootId: record.bootId,
      self: process.pid,
      uid: process.getuid(),
      readTable,
      identity,
      signal: (pid, name) => {
        assert.ok(
          ours.has(pid),
          `end signalled process ${pid}, which this test did not write down`,
        );
        process.kill(pid, name);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: () => {},
      grace: 1500,
    });
    assert.deepEqual(await Promise.all(exits), [
      [null, "SIGTERM"],
      [null, "SIGKILL"],
    ]);
    assert.equal(identity(bystander.pid)?.started, bystanderStarted);
    assert.equal(bystander.exitCode, null);
  });
});

describe("removing the shim file left by the launcher that ended", () => {
  const folderWith = (t, text) => {
    const folder = fs.mkdtempSync(path.join(tmpdir(), "p18r8b-unlock-"));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    if (text !== null) fs.writeFileSync(path.join(folder, "bb-app-update-shim.json"), text);
    return folder;
  };
  const leftover = (folder) => {
    const state = updated();
    return {
      record: recorded({ ...state, dataDir: folder }),
      ...machine([...outside(state), p(101, 900, 77777, "/usr/bin/sleep")]),
    };
  };

  it("removes the file that was judged", (t) => {
    const folder = folderWith(t, updated().shim);
    const { record, ...kernel } = leftover(folder);
    const result = unlock({ record, bootId: BOOT, uid: UID, ...kernel });
    assert.equal(result.code, 0);
    assert.deepEqual(fs.readdirSync(folder), []);
  });

  it("puts back a file replaced between the judgement and the rename", (t) => {
    const folder = folderWith(t, updated().shim);
    const { record, ...kernel } = leftover(folder);
    const file = path.join(folder, "bb-app-update-shim.json");
    const replaced = shimText(101, "/srv/other/node_modules/.bin/bb-app");
    const racing = {
      ...fs,
      renameSync: (from, to) => {
        fs.writeFileSync(from, replaced);
        fs.renameSync(from, to);
      },
    };
    assert.throws(
      () => unlock({ record, bootId: BOOT, uid: UID, ...kernel, fs: racing }),
      /changed after it was judged: it is back in place, nothing is removed/,
    );
    assert.deepEqual(fs.readdirSync(folder), ["bb-app-update-shim.json"]);
    assert.equal(fs.readFileSync(file, "utf8"), replaced);
  });

  it("leaves a file that appeared meanwhile and names the changed one beside it", (t) => {
    const folder = folderWith(t, updated().shim);
    const { record, ...kernel } = leftover(folder);
    const file = path.join(folder, "bb-app-update-shim.json");
    const racing = {
      ...fs,
      renameSync: (from, to) => {
        fs.writeFileSync(from, "changed");
        fs.renameSync(from, to);
        fs.writeFileSync(from, "appeared");
      },
    };
    assert.throws(
      () => unlock({ record, bootId: BOOT, uid: UID, ...kernel, fs: racing }),
      /a new one appeared meanwhile: it stays, and the changed file is left beside it as .*bb-app-update-shim\.json\.[0-9a-f-]+$/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "appeared");
    assert.equal(fs.readdirSync(folder).length, 2);
  });

  it("finds nothing to unlock in a file bb does not accept", (t) => {
    const cut = updated().shim.slice(0, 30);
    const folder = folderWith(t, cut);
    const { record, ...kernel } = leftover(folder);
    const result = unlock({ record, bootId: BOOT, uid: UID, ...kernel });
    assert.equal(result.code, 1);
    assert.match(
      result.text,
      /^bb-app-update-shim\.json is not a file bb accepts \(it is not JSON\).*replaces it: there is nothing to unlock$/,
    );
    assert.equal(fs.readFileSync(path.join(folder, "bb-app-update-shim.json"), "utf8"), cut);
  });

  it("refuses, changing nothing, when run as another user than the server's", (t) => {
    const folder = folderWith(t, updated().shim);
    const { record, ...kernel } = leftover(folder);
    assert.throws(
      () => unlock({ record, bootId: BOOT, uid: 0, ...kernel }),
      /runs as user 0 and the server as user 1000: run it as the user the server runs as/,
    );
    assert.deepEqual(fs.readdirSync(folder), ["bb-app-update-shim.json"]);
  });

  it("changes nothing while the launcher written down still runs", (t) => {
    const state = updated();
    const folder = folderWith(t, state.shim);
    const result = unlock({
      record: recorded({ ...state, dataDir: folder }),
      bootId: BOOT,
      uid: UID,
      ...machine(state.table),
    });
    assert.equal(result.code, 1);
    assert.match(result.text, /the launcher written down, process 101, has not ended/);
    assert.equal(fs.readFileSync(path.join(folder, "bb-app-update-shim.json"), "utf8"), state.shim);
  });
});

describe("the command line", () => {
  it("names a process for --also and --not-ours by number and start time only", () => {
    assert.deepEqual(parseToken("--also", "600@9000"), { pid: 600, started: "9000" });
    for (const text of ["600", "600@", "@9000", "0@9", "600@9000x"])
      assert.throws(
        () => parseToken("--also", text),
        new RegExp(
          `^Error: --also ${text}: a process is named as number@start time; copy it from the line gone printed$`,
        ),
      );
  });

  it("takes for each command only its own options", () => {
    assert.deepEqual(
      { ...commandOptions("gone", ["--record", "r", "--not-ours", "1@2", "--not-ours", "3@4"]) },
      {
        record: "r",
        "not-ours": ["1@2", "3@4"],
      },
    );
    assert.throws(
      () => commandOptions("end", ["--record", "r", "--not-ours", "1@2"]),
      /^Error: --not-ours is not an option of end, which takes --record and --also$/,
    );
    assert.throws(
      () => commandOptions("gone", ["--data-dir", "/x"]),
      /--data-dir is not an option of gone/,
    );
    assert.throws(
      () => commandOptions("paused", ["--record", "r"]),
      /--record is not an option of paused, which takes none/,
    );
    assert.throws(() => commandOptions("unlock", ["--record", "r", "--force"]), /--force/);
    assert.equal(commandOptions("kill", []), null);
  });

  it("refuses gone when run as another user than the server's", () => {
    const state = updated();
    assert.throws(
      () =>
        gone({
          record: recorded(state),
          uid: 0,
          bootId: BOOT,
          shim: null,
          ...machine(outside(state)),
        }),
      /runs as user 0 and the server as user 1000: run it as the user the server runs as/,
    );
    assert.equal(
      gone({
        record: recorded(state),
        uid: UID,
        bootId: BOOT,
        shim: null,
        ...machine(outside(state)),
      }).code,
      0,
    );
  });
});
