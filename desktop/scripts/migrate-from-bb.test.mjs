import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  exportBb,
  hostCopyPlan,
  importIntoOneMa,
  parseArgs,
  PI_SESSIONS,
  processesUsing,
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

// A bb data folder with server data (carried by an export) and machine data,
// and next to it the folder of Pi's earlier conversations.
function bbFolder() {
  const from = fresh("bb");
  write(from, "bb.db", "db");
  write(from, "host-id", "host-1\n");
  write(from, "auth.json", '{"credential":"c"}');
  write(from, "thread-storage/thr_1/page.html", "<p>notes</p>");
  write(from, "local-plugins/demo/package.json", "{}");
  write(`${from}-pi`, "thr_1.jsonl", '{"type":"session"}\n');
  write(from, "plugins/automations/data.db", "plugin db");
  write(from, "plugins/browser-automation/host-data/profile/Cookies", "cookies");
  write(from, "plugins/provider-claude-code/bridge-data/session.json", "{}");
  write(from, "plugins/environment-git-worktree/host-data/worktrees/proj/wt/file", "code");
  write(from, "plugins/environment-git-worktree/host-data/state.json", "{}");
  write(
    from,
    "plugins/environment-personal-workspace/host-data/workspaces/thr_1/notes.md",
    "draft",
  );
  write(from, "checkouts/demo/README.md", "cloned");
  write(from, "logs/server.log", "log");
  write(from, "bin/bb", "#!/bin/sh");
  return from;
}

// Stands in for 1ma's bb.js: "server import" writes a database into the data
// folder and prints what the real command prints with --json.
function fakeCli({ sourceDataDir, sourceServerHostId, fail = false }) {
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
if (${JSON.stringify(fail)}) { console.error("This export came from bb 0.50.0; install that version or newer before importing."); process.exit(1); }
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

const noProcesses = () => [];
const importArgs = (from, to, cli, more = []) => ({
  ...parseArgs([
    "import",
    "--from",
    from,
    "--to",
    to,
    "--archive",
    archive(),
    "--cli",
    cli,
    "--pi-sessions",
    `${from}-pi`,
    ...more,
  ]),
  listProcesses: noProcesses,
});

describe("arguments", () => {
  test("each command names what it needs, and a typo stops it", () => {
    assert.throws(() => parseArgs([]), /usage/);
    assert.throws(() => parseArgs(["export"]), /export needs --out/);
    assert.throws(() => parseArgs(["import", "--archive", "a.tar"]), /--cli/);
    assert.throws(() => parseArgs(["import", "--archive"]), /--archive needs a value/);
    assert.throws(() => parseArgs(["import", "--move-asid"]), /unknown argument --move-asid/);
    const options = parseArgs(["import", "--archive", "a.tar", "--cli", "bb.js", "--dry-run"], {});
    assert.equal(options.dryRun, true);
    assert.equal(path.basename(options.from), ".bb");
    assert.equal(path.basename(options.to), ".1ma");
    assert.equal(options.piSessions, path.join(homedir(), ".bb", "pi-bridge-sessions"));
    assert.equal(
      parseArgs(["import", "--archive", "a.tar", "--cli", "bb.js"], {
        BB_PI_BRIDGE_SESSION_DIR: "pi",
      }).piSessions,
      path.resolve("pi"),
    );
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
        "plugins/environment-personal-workspace/host-data",
        "plugins/provider-claude-code/bridge-data",
      ],
    );
  });
});

describe("Pi sessions of a bb older than 0.50", () => {
  // The data directory patch replaces the line naming the home folder where bb
  // kept them with the one where 1ma looks when a session is not in its data.
  const patches = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "patches");
  const patch = readFileSync(
    path.join(
      patches,
      readdirSync(patches).find((name) => name.includes("data-directory")),
    ),
    "utf8",
  );
  const legacyFolder = (sign, root) =>
    new RegExp(
      `^\\${sign}\\s*const legacyFile = join\\(homedir\\(\\), "\\${root}", "([^"]+)", fileName\\);$`,
      "m",
    ).exec(patch)?.[1];
  const bbFolderName = legacyFolder("-", ".bb");
  const oneMaFolderName = legacyFolder("+", ".1ma");

  // 1ma's Pi plugin reads a thread's session from its bridge data, and only
  // when it is missing there from the home folder of an earlier 1ma.
  const sessionOneMaReads = (dataDir, home, file) =>
    [
      path.join(dataDir, "plugins", "provider-pi", "bridge-data", "sessions", file),
      path.join(home, ".1ma", oneMaFolderName, file),
    ].find((candidate) => existsSync(candidate));

  function withEnv(values, action) {
    const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    for (const [key, value] of Object.entries(values))
      if (value === undefined) delete process.env[key];
    try {
      return action();
    } finally {
      for (const [key, value] of Object.entries(before))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  }

  function homeImport(home, { more = [], env = {}, prepare = () => {}, to = fresh("1ma") } = {}) {
    const from = bbFolder();
    prepare(from);
    const cli = fakeCli({ sourceDataDir: from, sourceServerHostId: "host-1" });
    const lines = [];
    const record = withEnv({ HOME: home, BB_PI_BRIDGE_SESSION_DIR: undefined, ...env }, () =>
      importIntoOneMa(
        {
          ...parseArgs([
            "import",
            "--from",
            from,
            "--to",
            to,
            "--archive",
            archive(),
            "--cli",
            cli,
            ...more,
          ]),
          listProcesses: noProcesses,
        },
        (line) => lines.push(line),
      ),
    );
    return { from, to, record, log: lines.join("\n") };
  }

  test("the patch still names both home folders", () => {
    assert.ok(bbFolderName, "the data directory patch no longer names bb's folder of Pi sessions");
    assert.ok(
      oneMaFolderName,
      "the data directory patch no longer names 1ma's folder of Pi sessions",
    );
  });

  test("come from bb's home folder whatever its data folder, and win over another 1ma's", () => {
    const home = fresh("home");
    const file = "thr_legacy-a.1.jsonl";
    write(home, `.bb/${bbFolderName}/${file}`, '{"from":"bb"}\n');
    write(home, `.1ma/${oneMaFolderName}/${file}`, '{"from":"another 1ma"}\n');
    const { to, log } = homeImport(home);
    assert.equal(readFileSync(sessionOneMaReads(to, home, file), "utf8"), '{"from":"bb"}\n');
    assert.match(
      log,
      new RegExp(`Pi's earlier conversations: 1 from ${path.join(home, ".bb", bbFolderName)}`),
    );
  });

  test("come from BB_PI_BRIDGE_SESSION_DIR or the folder given, and never replace a session", () => {
    const home = fresh("home");
    write(home, `.bb/${bbFolderName}/thr_home.jsonl`, "home\n");
    const configured = fresh("pi-configured");
    write(configured, "thr_configured.jsonl", "configured\n");
    write(configured, "thr_kept.jsonl", "earlier\n");
    const fromEnv = homeImport(home, {
      env: { BB_PI_BRIDGE_SESSION_DIR: configured },
      prepare: (from) =>
        write(from, "plugins/provider-pi/bridge-data/sessions/thr_kept.jsonl", "bridge data\n"),
    });
    assert.equal(
      readFileSync(sessionOneMaReads(fromEnv.to, home, "thr_kept.jsonl"), "utf8"),
      "bridge data\n",
    );
    assert.equal(
      readFileSync(sessionOneMaReads(fromEnv.to, home, "thr_configured.jsonl"), "utf8"),
      "configured\n",
    );
    assert.equal(sessionOneMaReads(fromEnv.to, home, "thr_home.jsonl"), undefined);

    const given = fresh("pi-given");
    write(given, "thr_given.jsonl", "given\n");
    const fromOption = homeImport(home, {
      more: ["--pi-sessions", given],
      env: { BB_PI_BRIDGE_SESSION_DIR: configured },
    });
    assert.match(fromOption.log, new RegExp(`Pi's earlier conversations: 1 from ${given}`));
    assert.equal(
      readFileSync(sessionOneMaReads(fromOption.to, home, "thr_given.jsonl"), "utf8"),
      "given\n",
    );
    assert.equal(sessionOneMaReads(fromOption.to, home, "thr_configured.jsonl"), undefined);
  });

  // bb's Pi bridge data can be a link to storage kept elsewhere. The copy keeps
  // the link, so a session written under 1ma's folder would land in that storage.
  const everyFile = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
      .toSorted();

  for (const [linked, there] of [
    ["bridge-data", true],
    ["bridge-data/sessions", true],
    ["bridge-data/sessions", false],
  ])
    test(`are not written through a link out of 1ma's data folder (${linked}${there ? "" : ", its folder missing"})`, () => {
      const home = fresh("home");
      const given = fresh("pi-given");
      write(given, "thr_given.jsonl", "given\n");
      const to = fresh("1ma");
      write(to, "earlier.txt", "earlier 1ma\n");
      let storage;
      const prepare = (from) => {
        storage = path.join(from, "moved-pi-storage");
        if (there) write(storage, "other/thr_other.jsonl", "bb's own\n");
        const link = path.join(from, "plugins/provider-pi", linked);
        mkdirSync(path.dirname(link), { recursive: true });
        symlinkSync(storage, link);
      };
      assert.throws(
        () => homeImport(home, { more: ["--pi-sessions", given, "--move-aside"], prepare, to }),
        (error) => {
          assert.match(error.message, /would be written outside/);
          assert.ok(error.message.includes(storage), error.message);
          assert.match(error.message, /Nothing was written into/);
          return true;
        },
      );
      if (there) assert.deepEqual(everyFile(storage), ["other/thr_other.jsonl"]);
      else assert.equal(existsSync(storage), false);
      assert.equal(readFileSync(path.join(to, "earlier.txt"), "utf8"), "earlier 1ma\n");
    });

  test("are not written through a link whose own folder is reached through a link", () => {
    // The link's text is relative: followed from where the link is named it
    // stays inside 1ma's folder, followed from where the link is it does not.
    const home = fresh("home");
    const given = fresh("pi-given");
    write(given, "thr_given.jsonl", "given\n");
    const to = fresh("1ma");
    write(to, "earlier.txt", "earlier 1ma\n");
    const outside = fresh("pi-storage");
    const bridgeData = path.join(outside, "kept/deep/bridge-data");
    mkdirSync(bridgeData, { recursive: true });
    symlinkSync("../../../store", path.join(bridgeData, "sessions"));
    const prepare = (from) => {
      mkdirSync(path.join(from, "plugins/provider-pi"), { recursive: true });
      symlinkSync(bridgeData, path.join(from, "plugins/provider-pi/bridge-data"));
    };
    assert.throws(
      () => homeImport(home, { more: ["--pi-sessions", given, "--move-aside"], prepare, to }),
      (error) => {
        assert.match(error.message, /would be written outside/);
        assert.ok(error.message.includes(path.join(outside, "store")), error.message);
        return true;
      },
    );
    assert.deepEqual(readdirSync(outside), ["kept"]);
    assert.equal(readFileSync(path.join(to, "earlier.txt"), "utf8"), "earlier 1ma\n");
  });

  test("a folder given for them that cannot exist brings none, one that leads into 1ma's is refused", () => {
    const home = fresh("home");
    const file = fresh("a-file");
    writeFileSync(file, "not a folder");
    const underAFile = path.join(file, "sessions");
    const { record } = homeImport(home, { more: ["--pi-sessions", underAFile] });
    assert.deepEqual(record.piSessions, { from: underAFile, copied: 0, kept: 0 });

    const to = fresh("1ma");
    const link = fresh("pi-link");
    symlinkSync(path.join(to, "not-there-yet"), link);
    assert.throws(
      () => homeImport(home, { more: ["--pi-sessions", link], to }),
      /Pi's earlier conversations in .* must be outside/,
    );
    assert.equal(existsSync(to), false);
  });

  test("a linked folder that already has the session is left as it is", () => {
    const home = fresh("home");
    const given = fresh("pi-given");
    write(given, "thr_given.jsonl", "given\n");
    let storage;
    const { record } = homeImport(home, {
      more: ["--pi-sessions", given],
      prepare: (from) => {
        storage = path.join(from, "moved-pi-storage");
        write(storage, "sessions/thr_given.jsonl", "bb's own\n");
        mkdirSync(path.join(from, "plugins/provider-pi"), { recursive: true });
        symlinkSync(storage, path.join(from, "plugins/provider-pi/bridge-data"));
      },
    });
    assert.deepEqual(record.piSessions, { from: given, copied: 0, kept: 1 });
    assert.deepEqual(everyFile(storage), ["sessions/thr_given.jsonl"]);
    assert.equal(
      readFileSync(path.join(storage, "sessions/thr_given.jsonl"), "utf8"),
      "bb's own\n",
    );
  });

  test("are written through a link that stays inside 1ma's data folder", () => {
    const home = fresh("home");
    const given = fresh("pi-given");
    write(given, "thr_given.jsonl", "given\n");
    const { from, to, record } = homeImport(home, {
      more: ["--pi-sessions", given],
      prepare: (bb) => {
        write(bb, "plugins/provider-pi/bridge-data/store/thr_own.jsonl", "bb's own\n");
        symlinkSync("store", path.join(bb, "plugins/provider-pi/bridge-data/sessions"));
      },
    });
    assert.equal(record.piSessions.copied, 1);
    assert.equal(
      readFileSync(path.join(to, "plugins/provider-pi/bridge-data/store/thr_given.jsonl"), "utf8"),
      "given\n",
    );
    assert.deepEqual(everyFile(path.join(from, "plugins/provider-pi/bridge-data/store")), [
      "thr_own.jsonl",
    ]);
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
    assert.equal(
      readFileSync(path.join(to, PI_SESSIONS, "thr_1.jsonl"), "utf8"),
      '{"type":"session"}\n',
    );
    assert.ok(existsSync(path.join(to, "plugins/browser-automation/host-data/profile/Cookies")));
    assert.ok(existsSync(path.join(to, "plugins/environment-git-worktree/host-data/state.json")));
    assert.ok(!existsSync(path.join(to, "plugins/environment-git-worktree/host-data/worktrees")));
    assert.ok(
      !existsSync(path.join(to, "plugins/environment-personal-workspace/host-data/workspaces")),
    );
    assert.ok(!existsSync(path.join(to, "checkouts")));
    assert.ok(record.sharedWithBb.includes("checkouts"));
    assert.ok(
      record.sharedWithBb.includes("plugins/environment-personal-workspace/host-data/workspaces"),
    );
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
      name.startsWith(`${path.basename(to)}.failed-`),
    );
    assert.ok(kept);
    assert.ok(!existsSync(path.join(path.dirname(to), kept, "host-id")));
  });

  test("a failed import puts the 1ma folder that was moved aside back", () => {
    const from = bbFolder();
    const to = fresh("1ma");
    write(to, "bb.db", "earlier 1ma");
    const cli = fakeCli({ sourceDataDir: from, sourceServerHostId: "host-1", fail: true });
    assert.throws(
      () => importIntoOneMa(importArgs(from, to, cli, ["--move-aside"]), quiet),
      /install that version or newer[\s\S]*is back as it was/,
    );
    assert.equal(readFileSync(path.join(to, "bb.db"), "utf8"), "earlier 1ma");
    const names = readdirSync(path.dirname(to));
    assert.ok(names.some((name) => name.startsWith(`${path.basename(to)}.failed-`)));
    assert.ok(!names.some((name) => name.startsWith(`${path.basename(to)}.before-migration-`)));
  });

  test("a 1ma folder that is a symbolic link is refused: the import would move the link, not the data", () => {
    const from = bbFolder();
    const cli = fakeCli({ sourceDataDir: from, sourceServerHostId: "host-1" });
    for (const [earlier, more] of [
      [["earlier.txt"], ["--move-aside"]],
      [[], []],
    ]) {
      const disk = fresh("other-disk");
      mkdirSync(disk);
      for (const name of earlier) write(disk, name, "earlier 1ma\n");
      const to = fresh("1ma");
      symlinkSync(disk, to);
      assert.throws(
        () => importIntoOneMa(importArgs(from, to, cli, more), quiet),
        (error) => {
          assert.match(error.message, /is a symbolic link to /);
          assert.ok(error.message.includes(`pass --to ${disk}`), error.message);
          return true;
        },
      );
      assert.ok(lstatSync(to).isSymbolicLink());
      assert.deepEqual(readdirSync(disk), earlier);
      assert.deepEqual(
        readdirSync(path.dirname(to)).filter(
          (name) => name.startsWith(`${path.basename(to)}.`) && name !== path.basename(to),
        ),
        [],
      );
    }
  });

  test("an export older than bb's latest work is refused unless confirmed", () => {
    const from = bbFolder();
    const to = fresh("1ma");
    const cli = fakeCli({ sourceDataDir: from, sourceServerHostId: "host-1" });
    const options = importArgs(from, to, cli);
    const later = new Date(Date.now() + 10 * 60_000);
    utimesSync(path.join(from, "thread-storage/thr_1/page.html"), later, later);
    assert.throws(() => importIntoOneMa(options, quiet), /bb wrote files after the export/);
    assert.ok(!existsSync(to));
    importIntoOneMa({ ...options, archiveIsCurrent: true }, quiet);
    assert.ok(existsSync(path.join(to, "bb.db")));
  });

  test("sees a folder inside another one when one path goes through a symbolic link", () => {
    // On a Mac the temporary folder is /var/..., a link to /private/var/...: a
    // folder that exists resolves through the link, one not created yet must too.
    const from = bbFolder();
    const link = `${from}-link`;
    symlinkSync(from, link);
    const cli = fakeCli({ sourceDataDir: from, sourceServerHostId: "host-1" });
    assert.throws(
      () => importIntoOneMa(importArgs(link, path.join(link, "copy"), cli), quiet),
      /two separate folders/,
    );
    assert.throws(
      () => importIntoOneMa(importArgs(path.join(link, "copy", "deeper"), link, cli), quiet),
      /two separate folders/,
    );
  });

  test("refuses folders inside each other and processes still using them", () => {
    const from = bbFolder();
    const cli = fakeCli({ sourceDataDir: from, sourceServerHostId: "host-1" });
    assert.throws(
      () => importIntoOneMa(importArgs(from, path.join(from, "copy"), cli), quiet),
      /two separate folders/,
    );
    assert.throws(
      () => importIntoOneMa(importArgs(from, from, cli), quiet),
      /two separate folders/,
    );
    const to = fresh("1ma");
    const browser = () => [
      {
        pid: 4242,
        ppid: 1,
        command: `chrome --user-data-dir=${from}/plugins/browser-automation/host-data/profile`,
      },
    ];
    assert.throws(
      () => importIntoOneMa({ ...importArgs(from, to, cli), listProcesses: browser }, quiet),
      /4242 chrome/,
    );
    assert.ok(!existsSync(to));
    // The script and the shells that started it may name a file inside the
    // folder on their own command line; they do not count.
    const chain = () => [
      { pid: 500, ppid: 400, command: `node migrate-from-bb.mjs import && cat ${from}/host-id` },
      {
        pid: 400,
        ppid: 1,
        command: `bash -c "node migrate-from-bb.mjs import; cat ${from}/host-id"`,
      },
      ...browser(),
    ];
    assert.deepEqual(
      processesUsing([from], chain, 500).map((found) => found.pid),
      [4242],
    );
    assert.ok(Array.isArray(processesUsing([from])));
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
