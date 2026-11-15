import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ghArgs, ghRequestSchema, hostContract } from "./host-contract.js";
import { HOST_SETTINGS_FILE, readTrainJournal } from "./host-journal.js";

let root: string;
let dataDir: string;
let trainDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sa-host-"));
  dataDir = join(root, "host-data");
  trainDir = join(root, "train");
  mkdirSync(dataDir);
  mkdirSync(trainDir);
  writeFileSync(join(trainDir, "journal.jsonl"), '{"event":"merged"}\n');
  mkdirSync(join(root, "secret"));
  writeFileSync(join(root, "secret", "keys.jsonl"), "private\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function configure(settings: unknown) {
  writeFileSync(join(dataDir, HOST_SETTINGS_FILE), JSON.stringify(settings));
}

describe("train journal on the host", () => {
  it("reads only the journal named in the host settings", async () => {
    configure({ trainJournal: join(trainDir, "journal.jsonl") });
    expect(await readTrainJournal(dataDir)).toEqual({
      status: "ok",
      text: '{"event":"merged"}\n',
      truncated: false,
    });
  });

  it("is unconfigured without host settings, whatever the server asks", async () => {
    expect(await readTrainJournal(dataDir)).toEqual({ status: "unconfigured" });
    expect(hostContract.readJournal.input.safeParse({ path: "/etc/passwd" }).success).toBe(false);
  });

  it("refuses a link that leads out of the journal's directory", async () => {
    symlinkSync(join(root, "secret", "keys.jsonl"), join(trainDir, "link.jsonl"));
    configure({ trainJournal: join(trainDir, "link.jsonl") });
    const result = await readTrainJournal(dataDir);
    expect(result).toEqual({
      status: "error",
      message: "train journal resolves outside its directory",
    });
  });

  it("refuses a path that is not a .jsonl file and a journal that is not a regular file", async () => {
    configure({ trainJournal: join(root, "secret", "keys.txt") });
    expect((await readTrainJournal(dataDir)).status).toBe("error");
    execFileSync("mkfifo", [join(trainDir, "pipe.jsonl")]);
    configure({ trainJournal: join(trainDir, "pipe.jsonl") });
    expect(await readTrainJournal(dataDir)).toEqual({
      status: "error",
      message: "train journal is not a regular file",
    });
  });
});

describe("gh on the host", () => {
  it("builds a read request from an operation and typed parameters", () => {
    expect(ghArgs({ op: "pull", repo: "example/app", number: 7 })).toEqual([
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "/repos/example/app/pulls/7",
    ]);
    expect(ghArgs({ op: "mainHead", repo: "example/app" }).at(-1)).toBe(
      "/repos/example/app/commits?sha=main&per_page=1",
    );
  });

  it("accepts no path and no repository that could leave the repository's namespace", () => {
    for (const input of [
      { path: "/user" },
      { op: "pull", repo: "../..", number: 1 },
      { op: "pull", repo: "example/app/pulls", number: 1 },
      { op: "pull", repo: "example/app", number: 1, method: "POST" },
      { op: "recentPulls", repo: "example/app", page: 50 },
      { op: "graphql", repo: "example/app" },
    ])
      expect(ghRequestSchema.safeParse(input).success).toBe(false);
  });
});
