import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseCmdline,
  parseStat,
  pauseBreaks,
  processTable,
  recordChain,
  remaining,
  shown,
} from "./linux-launcher.mjs";

const NODE = "/home/dev/.local/opt/node-v24.22.1-linux-x64/bin/node";
const DATA = "/home/dev/.1ma";
const BOOT = "5f0c2a1e-boot";

const p = (pid, ppid, started, ...argv) => ({ pid, ppid, started: String(started), argv });

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
    shim: { entryPath: entry, pid: 101, startedAt: "2026-11-11T12:39:22.652Z" },
    runtime: {
      entryPath: `${build}/node_modules/bb-app/dist/bb-app.js`,
      pid: 200,
      version: "0.49.1-1ma.123.1",
    },
  };
}

const VERSIONED = "/home/dev/.local/opt/1ma-server-0.49.1-1ma.123.1";
const INSTALLED = `${DATA}/app-versions/0.49.1-1ma.456.1`;
const ownBuild = () => server({ anchor: VERSIONED, build: VERSIONED });
const updated = () => server({ anchor: "/home/dev/.local/opt/1ma-server", build: INSTALLED });

const recorded = (state, real = (folder) => folder) =>
  recordChain({ ...state, bootId: BOOT, real });

const after = (state, table, shim = null) =>
  remaining({ record: recorded(state), table, bootId: BOOT, shim });

const statLine = (pid, state) => `${pid} (node) ${state} 1 ${"0 ".repeat(17)}55 0`;
const behindALink = (folder) => folder.replace("/home/dev/.local/opt", "/mnt/disk/opt");

const outside = (state) => state.table.filter((one) => one.pid === 1 || one.pid === 900);

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
    });
    assert.deepEqual(table, [{ pid: 7, ppid: 1, started: "55", argv: ["node", "x.mjs"] }]);
  });
});

describe("what is written down before the stop", () => {
  it("is the launcher and every process below it, and the two builds they run from", () => {
    const record = recorded(updated());
    assert.deepEqual(
      record.processes.map((one) => one.pid),
      [101, 200, 201, 202, 300, 301],
    );
    assert.deepEqual(record.folders, ["/home/dev/.local/opt/1ma-server", INSTALLED]);
    assert.deepEqual(record.launcher, {
      pid: 101,
      entryPath: "/home/dev/.local/opt/1ma-server/node_modules/.bin/bb-app",
    });
  });

  it("names a build once when the launcher runs its own, and also by the folder a link leads to", () => {
    assert.deepEqual(recorded(ownBuild()).folders, [VERSIONED]);
    assert.deepEqual(recorded(ownBuild(), behindALink).folders, [
      VERSIONED,
      "/mnt/disk/opt/1ma-server-0.49.1-1ma.123.1",
    ]);
  });

  it("is refused when the data folder does not describe the running server", () => {
    const state = updated();
    assert.throws(() => recorded({ ...state, shim: null }), /bb-app-update-shim.json is missing/);
    assert.throws(() => recorded({ ...state, runtime: null }), /bb-app-runtime.json is missing/);
    assert.throws(
      () => recorded({ ...state, shim: { ...state.shim, pid: 77777 } }),
      /launcher process 77777, which is not running/,
    );
    assert.throws(
      () => recorded({ ...state, shim: { ...state.shim, pid: 900 } }),
      /\.bin\/bb-app, which is not what process 900: \/usr\/lib\/claude-desktop\/claude-desktop runs/,
    );
    assert.throws(
      () => recorded({ ...state, runtime: { ...state.runtime, pid: 900 } }),
      /was not started by the launcher 101: two launchers/,
    );
    assert.throws(
      () => recorded({ ...state, runtime: { ...state.runtime, entryPath: "/opt/1ma/bb-app.js" } }),
      /bb-app-runtime.json names "\/opt\/1ma\/bb-app.js", which is not a file inside the node_modules/,
    );
  });
});

describe("what is left after the stop", () => {
  it("shows a process on one line, however long its arguments are", () => {
    const script = `set -e\ncd /tmp\n${"echo step\n".repeat(60)}`;
    const line = shown(p(77, 1, 5, "/bin/bash", "-c", script));
    assert.match(line, /^process 77: \/bin\/bash -c set -e cd \/tmp echo step /);
    assert.equal(line.includes("\n"), false);
    assert.equal(line.length, "process 77: ".length + 241);
    assert.equal(shown(p(78, 1, 5)), "process 78: (no arguments)");
  });

  it("is nothing when the whole chain ended", () => {
    for (const state of [ownBuild(), updated()]) assert.deepEqual(after(state, outside(state)), []);
  });

  it("is the launcher of a build in a folder named after its version, although no port answers", () => {
    const state = ownBuild();
    const left = after(
      state,
      state.table.filter((one) => one.pid !== 201),
      state.shim,
    );
    assert.equal(left.filter((line) => line.startsWith("still running, process ")).length, 5);
    assert.ok(left.some((line) => line.includes("process 101: node ")));
    assert.match(left.at(-1), /still names a running launcher, process 101/);
  });

  it("is a daemon that lost its parent", () => {
    const state = updated();
    const daemon = { ...state.table.find((one) => one.pid === 202), ppid: 1 };
    assert.deepEqual(after(state, [...outside(state), daemon]), [
      `still running, ${shown(daemon)}`,
    ]);
  });

  it("is a process that was written down and does not run from either build", () => {
    const state = updated();
    const agent = { ...state.table.find((one) => one.pid === 301), ppid: 1 };
    assert.deepEqual(after(state, [...outside(state), agent]), [
      "still running, process 301: /home/dev/.local/bin/claude --print",
    ]);
  });

  it("is a worker started between the record and the stop", () => {
    const state = updated();
    const worker = p(
      555,
      1,
      9000,
      NODE,
      "--use-system-ca",
      `${INSTALLED}/node_modules/bb-app/host-daemon/dist/bb-provider-bridge-worker.mjs`,
    );
    assert.deepEqual(after(state, [...outside(state), worker]), [
      `runs from ${INSTALLED}, ${shown(worker)}`,
    ]);
    const binary = p(556, 1, 9001, `${INSTALLED}/node_modules/@bb/tools/bin/rg`, "--files");
    assert.equal(after(state, [...outside(state), binary]).length, 1);
  });

  it("is not a new process that got the number of an ended one", () => {
    const state = updated();
    assert.deepEqual(
      after(state, [...outside(state), p(202, 1, 99999, "/usr/bin/sleep", "60")]),
      [],
    );
  });

  it("is not another program that only names a path inside a build", () => {
    const state = updated();
    const others = [
      p(600, 1, 9100, "/usr/bin/tail", "-f", `${INSTALLED}/build.log`),
      p(601, 1, 9101, "/usr/bin/grep", "-r", "x", "/home/dev/.local/opt/1ma-server/node_modules"),
      p(602, 1, 9102, NODE, "/home/dev/tools/size.mjs", `${INSTALLED}/node_modules/bb-app`),
      p(603, 1, 9103, NODE, "/home/dev/.local/opt/1ma-server-next/node_modules/.bin/bb-app"),
    ];
    assert.deepEqual(after(state, [...outside(state), ...others]), []);
  });

  it("is a launcher that still holds the data folder, and not a file left by an ended one", () => {
    const state = updated();
    assert.deepEqual(after(state, outside(state), { entryPath: "/x/bb-app", pid: 4040 }), []);
    assert.deepEqual(after(state, outside(state), { entryPath: "/x/bb-app", pid: 900 }), [
      "bb-app-update-shim.json still names a running launcher, process 900 (/x/bb-app)",
    ]);
  });

  it("is a file left by the ended launcher whose number another program got: that program is not to be ended", () => {
    const state = updated();
    const other = p(101, 1, 77777, "/usr/bin/sleep", "600");
    const left = after(state, [...outside(state), other], state.shim);
    assert.equal(left.length, 1);
    assert.match(left[0], /^bb-app-update-shim\.json is left by the launcher that ended/);
    assert.match(left[0], /belongs to another program \(process 101: \/usr\/bin\/sleep 600\)/);
    assert.match(left[0], /do not end that program/);
    const rebooted = remaining({
      record: recorded(state),
      table: [{ ...state.table.find((one) => one.pid === 101), argv: ["/usr/bin/sleep", "600"] }],
      bootId: "another-boot",
      shim: state.shim,
    });
    assert.equal(rebooted.length, 1);
    assert.match(rebooted[0], /is left by the launcher that ended/);
  });

  it("is nothing of the written-down processes after the machine restarted", () => {
    const state = updated();
    const left = remaining({
      record: recorded(state),
      table: state.table.map((one) => ({ ...one, argv: ["/usr/bin/sleep", "60"] })),
      bootId: "another-boot",
      shim: null,
    });
    assert.deepEqual(left, []);
  });
});
