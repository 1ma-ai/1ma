import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { GitHubReader, PullRequest } from "./github/reader.js";
import type { Completeness, Executor, ServerId, ThreadMetadataRow } from "./observation.js";
import { runPrPass } from "./pr-pass.js";
import { PrStore } from "./pr-store.js";
import { repoPolicy } from "./repos.js";
import { MIGRATIONS } from "./schema.js";
import { Store } from "./store.js";
import { fakeExecutor, threadSummary } from "./test-helpers.js";

const REMOTE = "https://github.com/example/app.git";
const policy = repoPolicy(
  [{ repo: "example/app", accounts: { mac: ["mac-bot"], linux: ["linux-bot"] } }],
  [],
);

function pull(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: "example/app",
    number,
    state: "open",
    author: "linux-bot",
    headRepo: "example/app",
    headRef: `feature/${number}`,
    headSha: `sha${number}`,
    updatedAt: 5_000,
    ...overrides,
  };
}

function claimsOf(number: number, branch = `feature/${number}`) {
  return { claims: [{ repo: "example/app", number, branch, claimedAt: 1 }] };
}

function setup(options: {
  threads: Record<ServerId, Array<{ id: string; branch?: string }>>;
  metadata?: Record<string, unknown>;
  pulls: PullRequest[];
  models?: Record<string, string>;
}) {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = new Store(db);
  const prStore = new PrStore(db);
  for (const [serverId, threads] of Object.entries(options.threads) as Array<
    [ServerId, Array<{ id: string; branch?: string }>]
  >) {
    for (const thread of threads) {
      const environmentId = `env_${thread.id}`;
      const result = {
        observedAt: 1,
        completeness: "complete" as const,
        items: {
          threads: [threadSummary({ threadId: thread.id, environmentId })],
          environments: [{ environmentId, projectId: "proj_app", branch: thread.branch ?? "main" }],
          projects: [{ projectId: "proj_app", gitRemoteUrl: REMOTE }],
        },
      };
      store.applySnapshot(serverId, result.items, { observedAt: 1, completeness: "partial" }, null);
    }
  }
  const reads: string[] = [];
  const github: GitHubReader = {
    async pull(repo, number) {
      reads.push(`pull ${number}`);
      const found = options.pulls.find((candidate) => candidate.number === number);
      if (found === undefined) throw new Error(`no ${repo}#${number}`);
      return found;
    },
    async recentPulls(_repo, since) {
      reads.push(`recent ${since}`);
      return {
        pulls: options.pulls.filter((candidate) => candidate.updatedAt >= since),
        complete: true,
      };
    },
  };
  const executor = (serverId: ServerId): Executor =>
    fakeExecutor(serverId, {
      async readMetadata(threadIds): Promise<ThreadMetadataRow[]> {
        return threadIds
          .filter((threadId) => options.metadata?.[threadId] !== undefined)
          .map((threadId) => ({ threadId, metadata: options.metadata?.[threadId] }));
      },
      async threadModel(threadId) {
        return options.models?.[threadId] ?? null;
      },
    });
  const run = (now: number, observed: Partial<Record<ServerId, Completeness>> = {}) =>
    runPrPass({
      store,
      prStore,
      github,
      policy,
      executors: new Map([
        ["mac", executor("mac")],
        ["linux", executor("linux")],
      ]),
      observed: new Map([
        ["mac", observed.mac ?? "complete"],
        ["linux", observed.linux ?? "complete"],
      ]),
      now,
      signal: new AbortController().signal,
    });
  return { prStore, run, reads };
}

describe("runPrPass", () => {
  it("links a PR to the one chat that claimed it and records its model as provenance", async () => {
    const { prStore, run } = setup({
      threads: {
        mac: [{ id: "thr_mac", branch: "feature/7" }],
        linux: [{ id: "thr_linux", branch: "feature/7" }],
      },
      metadata: { thr_linux: claimsOf(7) },
      pulls: [pull(7)],
      models: { thr_linux: "claude-opus-5-5" },
    });
    await run(10_000);
    expect(prStore.get("example/app", 7)).toMatchObject({
      linkKind: "claim",
      deliveryServerId: "linux",
      deliveryThreadId: "thr_linux",
      branchHint: "mac:thr_mac,linux:thr_linux",
      provenanceGap: false,
    });
    expect(prStore.provenance("example/app", 7)).toEqual([
      {
        providerId: "claude-code",
        model: "claude-opus-5-5",
        firstSeenAt: 10_000,
        lastSeenAt: 10_000,
      },
    ]);
  });

  it("leaves a PR on a shared branch unlinked when no chat claimed it", async () => {
    const { prStore, run } = setup({
      threads: {
        mac: [
          { id: "thr_a", branch: "feature/7" },
          { id: "thr_b", branch: "feature/7" },
        ],
        linux: [],
      },
      pulls: [pull(7, { author: "mac-bot" })],
    });
    await run(10_000);
    expect(prStore.get("example/app", 7)).toMatchObject({
      linkKind: null,
      deliveryThreadId: null,
      claimProblem: null,
      branchHint: "mac:thr_a,mac:thr_b",
    });
  });

  it("leaves a PR claimed by two chats unlinked", async () => {
    const { prStore, run } = setup({
      threads: { mac: [{ id: "thr_a" }, { id: "thr_b" }], linux: [] },
      metadata: { thr_a: claimsOf(7), thr_b: claimsOf(7) },
      pulls: [pull(7, { author: "mac-bot" })],
    });
    await run(10_000);
    expect(prStore.get("example/app", 7)).toMatchObject({
      linkKind: null,
      claimProblem: "claimed by 2 chats",
    });
  });

  it("keeps the reason a claim was refused", async () => {
    const { prStore, run } = setup({
      threads: { mac: [{ id: "thr_a" }], linux: [] },
      metadata: { thr_a: claimsOf(7) },
      pulls: [pull(7, { author: "linux-bot" })],
    });
    await run(10_000);
    expect(prStore.get("example/app", 7)?.claimProblem).toBe(
      "the pull request author is not a GitHub account of the mac server",
    );
  });

  it("keeps a manual link over a later claim, with unknown provenance", async () => {
    const { prStore, run } = setup({
      threads: { mac: [{ id: "thr_a" }], linux: [{ id: "thr_linux" }] },
      metadata: { thr_linux: claimsOf(7) },
      pulls: [pull(7)],
      models: { thr_linux: "claude-opus-5-5" },
    });
    await run(10_000);
    expect(prStore.setManualLink("example/app", 7, "mac", "thr_a")).toBe(true);
    await run(20_000);
    expect(prStore.get("example/app", 7)).toMatchObject({
      linkKind: "manual",
      deliveryServerId: "mac",
      deliveryThreadId: "thr_a",
    });
    expect(prStore.provenance("example/app", 7)).toEqual([]);
  });

  it("marks a gap in provenance when the delivery server was not observed", async () => {
    const { prStore, run } = setup({
      threads: { mac: [], linux: [{ id: "thr_linux" }] },
      metadata: { thr_linux: claimsOf(7) },
      pulls: [pull(7)],
    });
    await run(10_000);
    expect(prStore.get("example/app", 7)?.provenanceGap).toBe(true);
  });

  it("rereads a known PR by number after it closed, and looks back only from its cursor", async () => {
    const pulls = [pull(7)];
    const { prStore, run, reads } = setup({ threads: { mac: [], linux: [] }, pulls });
    await run(10_000);
    expect(prStore.get("example/app", 7)?.prState).toBe("open");
    pulls[0] = pull(7, { state: "merged", updatedAt: 4_000 });
    await run(20_000);
    expect(reads).toContain("pull 7");
    expect(reads).toContain("recent 5000");
    expect(prStore.get("example/app", 7)?.prState).toBe("merged");
  });
});
