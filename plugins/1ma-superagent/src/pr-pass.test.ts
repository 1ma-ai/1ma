import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { GitHubReader, PullRequest } from "./github/reader.js";
import type { Completeness, Executor, ServerId, ThreadMetadataRow } from "./observation.js";
import { runPrPass } from "./pr-pass.js";
import { PrStore } from "./pr-store.js";
import { toPullRequestDto } from "./work-rpc.js";
import { askAboutConflicts, conflictKind } from "./kinds/pr-conflict.js";
import { QuestionStore } from "./questions.js";
import { type RepoPolicy, repoPolicy } from "./repos.js";
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
    createdAt: 0,
    updatedAt: 5_000,
    ...overrides,
  };
}

function claimsOf(number: number, branch = `feature/${number}`, claimedAt = 1) {
  return { claims: [{ repo: "example/app", number, branch, claimedAt }] };
}

function setup(options: {
  threads: Record<ServerId, Array<{ id: string; branch?: string }>>;
  metadata?: Record<string, unknown>;
  pulls: PullRequest[];
  models?: Record<string, string>;
  policy?: RepoPolicy;
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
  const admission = { ok: true, onPull: (_number: number) => {} };
  const github: GitHubReader = {
    async pull(repo, number) {
      reads.push(`pull ${number}`);
      admission.onPull(number);
      const found = options.pulls.find((candidate) => candidate.number === number);
      if (found === undefined) throw new Error(`no ${repo}#${number}`);
      return found;
    },
    async mainHead() {
      throw new Error("not used");
    },
    async recentPulls(_repo, since) {
      reads.push(`recent ${since}`);
      return {
        pulls: options.pulls.filter((candidate) => candidate.updatedAt >= since),
        complete: true,
      };
    },
  };
  const failing = new Set<ServerId>();
  const executor = (serverId: ServerId): Executor =>
    fakeExecutor(serverId, {
      async readMetadata(threadIds): Promise<ThreadMetadataRow[]> {
        if (failing.has(serverId)) throw new Error("metadata batch 2 failed");
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
      policy: options.policy ?? policy,
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
      admitted: () => admission.ok,
    });
  const archive = (serverId: ServerId) =>
    store.applySnapshot(
      serverId,
      { threads: [], environments: [], projects: [] },
      { observedAt: 2, completeness: "complete" },
      null,
    );
  return {
    db,
    store,
    prStore,
    run,
    reads,
    failing,
    archive,
    admission,
    metadata: options.metadata,
  };
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
    expect(prStore.chatModels("example/app", 7)).toEqual([
      {
        providerId: "claude-code",
        model: "claude-opus-5-5",
        firstSeenAt: 10_000,
        lastSeenAt: 10_000,
      },
    ]);
  });

  it("delivers to the one chat on a shared branch that claimed a PR, and never calls its model the provenance", async () => {
    const models: Record<string, string> = { thr_b: "model-before" };
    const { prStore, run } = setup({
      threads: {
        mac: [
          { id: "thr_a", branch: "feature/7" },
          { id: "thr_b", branch: "feature/7" },
        ],
        linux: [],
      },
      metadata: { thr_b: claimsOf(7) },
      pulls: [pull(7, { author: "mac-bot" })],
      models,
    });
    models.thr_b = "model-after";
    await run(10_000);
    const link = prStore.get("example/app", 7);
    expect(link).toMatchObject({ linkKind: "claim", deliveryThreadId: "thr_b" });
    const dto = link === null ? null : toPullRequestDto(link, prStore);
    expect(dto?.link.basis).toBe("claimed by the chat");
    expect(dto?.provenance).toBe("unknown");
    expect(dto?.chatModels).toEqual({
      basis: "claimed by the chat",
      complete: true,
      models: [{ providerId: "claude-code", model: "model-after" }],
    });
  });

  describe("keeps a link it cannot see this pass", () => {
    const linked = () =>
      setup({
        threads: { mac: [], linux: [{ id: "thr_linux", branch: "feature/7" }] },
        metadata: { thr_linux: claimsOf(7) },
        pulls: [pull(7)],
      });
    const expectKept = (prStore: PrStore) =>
      expect(prStore.get("example/app", 7)).toMatchObject({
        linkKind: "claim",
        deliveryThreadId: "thr_linux",
        linkConfirmedAt: 10_000,
      });

    it("when its chat was archived", async () => {
      const t = linked();
      await t.run(10_000);
      t.archive("linux");
      await t.run(20_000);
      expectKept(t.prStore);
    });

    it("when its server did not answer", async () => {
      const t = linked();
      await t.run(10_000);
      await t.run(20_000, { linux: "failed" });
      expectKept(t.prStore);
    });

    it("when reading the chats' metadata partly failed", async () => {
      const t = linked();
      await t.run(10_000);
      t.failing.add("linux");
      await t.run(20_000);
      expectKept(t.prStore);
    });

    describe("from a second chat's claim, and records the conflict", () => {
      const contested = () => {
        const t = setup({
          threads: {
            mac: [],
            linux: [
              { id: "thr_linux", branch: "feature/7" },
              { id: "thr_other", branch: "feature/7" },
            ],
          },
          metadata: { thr_linux: claimsOf(7) },
          pulls: [pull(7)],
        });
        return t;
      };
      const expectContested = (prStore: PrStore) =>
        expect(prStore.get("example/app", 7)).toMatchObject({
          linkKind: "claim",
          deliveryThreadId: "thr_linux",
          linkConfirmedAt: 10_000,
          conflictChat: "linux:thr_other",
        });

      it("when its chat was archived", async () => {
        const t = contested();
        await t.run(10_000);
        if (t.metadata !== undefined) t.metadata.thr_other = claimsOf(7);
        t.store.applySnapshot(
          "linux",
          {
            threads: [threadSummary({ threadId: "thr_other", environmentId: "env_thr_other" })],
            environments: [
              { environmentId: "env_thr_other", projectId: "proj_app", branch: "feature/7" },
            ],
            projects: [{ projectId: "proj_app", gitRemoteUrl: REMOTE }],
          },
          { observedAt: 2, completeness: "complete" },
          null,
        );
        await t.run(20_000);
        expectContested(t.prStore);
        const questions = new QuestionStore(t.db);
        askAboutConflicts(t.prStore, questions, 20_000);
        askAboutConflicts(t.prStore, questions, 21_000);
        const [question] = questions.waiting();
        expect(question?.kind).toBe("pr_conflict");
        expect(questions.waiting()).toHaveLength(1);
        if (question === undefined) throw new Error("no question");
        expect(
          conflictKind(t.prStore, t.store).onAnswer(question, "move:0", 20_500),
        ).toBeUndefined();
        expect(t.prStore.get("example/app", 7)).toMatchObject({
          linkKind: "manual",
          deliveryThreadId: "thr_other",
          conflictChat: null,
        });
      });

      it("when its server did not answer", async () => {
        const t = setup({
          threads: {
            mac: [{ id: "thr_mac", branch: "feature/7" }],
            linux: [{ id: "thr_other", branch: "feature/7" }],
          },
          metadata: { thr_mac: claimsOf(7) },
          pulls: [pull(7, { author: "shared-bot" })],
          policy: repoPolicy(
            [
              {
                repo: "example/app",
                accounts: { mac: ["shared-bot"], linux: ["shared-bot"] },
              },
            ],
            [],
          ),
        });
        await t.run(10_000);
        expect(t.prStore.get("example/app", 7)?.deliveryThreadId).toBe("thr_mac");
        if (t.metadata !== undefined) t.metadata.thr_other = claimsOf(7);
        await t.run(20_000, { mac: "failed" });
        expect(t.prStore.get("example/app", 7)).toMatchObject({
          linkKind: "claim",
          deliveryServerId: "mac",
          deliveryThreadId: "thr_mac",
          linkConfirmedAt: 10_000,
          conflictChat: "linux:thr_other",
        });
      });

      it("but moves it once the linked chat was read without its claim", async () => {
        const t = contested();
        await t.run(10_000);
        if (t.metadata !== undefined) {
          t.metadata.thr_linux = { claims: [] };
          t.metadata.thr_other = claimsOf(7);
        }
        await t.run(20_000);
        expect(t.prStore.get("example/app", 7)).toMatchObject({
          linkKind: "claim",
          deliveryThreadId: "thr_other",
          linkConfirmedAt: 20_000,
          conflictChat: null,
        });
      });
    });

    it("and drops it once its chat was read without the claim", async () => {
      const t = linked();
      await t.run(10_000);
      if (t.metadata !== undefined) t.metadata.thr_linux = { claims: [] };
      await t.run(20_000);
      expect(t.prStore.get("example/app", 7)).toMatchObject({
        linkKind: null,
        deliveryThreadId: null,
      });
    });
  });

  it("hides and stops using a link once its repository is excluded", async () => {
    const { db, prStore, run } = setup({
      threads: { mac: [], linux: [{ id: "thr_linux", branch: "feature/7" }] },
      metadata: { thr_linux: claimsOf(7) },
      pulls: [pull(7)],
    });
    await run(10_000);
    expect(prStore.forThread("linux", "thr_linux")).toHaveLength(1);
    const excluded = new PrStore(db, () => repoPolicy([], ["example/app"]));
    expect(excluded.get("example/app", 7)).toBeNull();
    expect(excluded.all()).toEqual([]);
    expect(excluded.forThread("linux", "thr_linux")).toEqual([]);
  });

  it("refuses a claim made before the pull request was opened", async () => {
    const { prStore, run } = setup({
      threads: { mac: [{ id: "thr_a", branch: "feature/7" }], linux: [] },
      metadata: { thr_a: claimsOf(7, "feature/7", 100) },
      pulls: [pull(7, { author: "mac-bot", createdAt: 200 })],
    });
    await run(10_000);
    expect(prStore.get("example/app", 7)).toMatchObject({
      linkKind: null,
      claimProblem: "the claim is older than the pull request",
    });
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
    expect(prStore.chatModels("example/app", 7)).toEqual([]);
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

  it("keeps the cursor where it was when the batch it covers is dropped", async () => {
    const pulls = [pull(1, { updatedAt: 1_000 })];
    const { prStore, run, admission } = setup({ threads: { mac: [], linux: [] }, pulls });
    await run(10_000);
    prStore.setCursor("example/app", 1_500);
    pulls.push(pull(2, { updatedAt: 2_000 }), pull(3, { updatedAt: 3_000 }));
    admission.onPull = () => {
      admission.ok = false;
    };
    await run(20_000);
    expect(prStore.get("example/app", 2)).toBeNull();
    expect(prStore.cursor("example/app")).toBe(1_500);
    admission.ok = true;
    admission.onPull = () => {};
    await run(30_000);
    expect([prStore.get("example/app", 2)?.number, prStore.get("example/app", 3)?.number]).toEqual([
      2, 3,
    ]);
    expect(prStore.cursor("example/app")).toBe(3_000);
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

describe("a second claim on a linked PR", () => {
  const contested = (others: string[]) => {
    const metadata: Record<string, unknown> = { thr_old: claimsOf(7) };
    const pulls = [pull(7)];
    const t = setup({
      threads: {
        mac: [],
        linux: [
          { id: "thr_old", branch: "feature/7" },
          ...others.map((id) => ({ id, branch: "feature/7" })),
        ],
      },
      metadata,
      pulls,
    });
    const questions = new QuestionStore(t.db);
    const pass = async (now: number, observed: Partial<Record<ServerId, Completeness>> = {}) => {
      await t.run(now, observed);
      askAboutConflicts(t.prStore, questions, now);
    };
    const conflicts = () =>
      questions.waiting().filter((question) => question.kind === "pr_conflict");
    return { ...t, metadata, pulls, questions, pass, conflicts };
  };

  it("keeps the link while the linked chat is read again with its claim, and calls the other a conflict", async () => {
    const t = contested(["thr_new"]);
    await t.pass(10_000);
    t.metadata.thr_new = claimsOf(7);
    await t.pass(20_000, { linux: "failed" });
    await t.pass(30_000);
    expect(t.prStore.get("example/app", 7)).toMatchObject({
      linkKind: "claim",
      deliveryThreadId: "thr_old",
      linkConfirmedAt: 10_000,
      conflictChat: "linux:thr_new",
    });
  });

  it("asks one card over three passes of an unchanged conflict", async () => {
    const t = contested(["thr_new"]);
    await t.pass(10_000);
    t.metadata.thr_new = claimsOf(7);
    await t.pass(20_000);
    const [first] = t.conflicts();
    await t.pass(30_000);
    await t.pass(40_000);
    expect(t.conflicts().map((question) => question.id)).toEqual([first?.id]);
    expect(t.questions.waiting()).toHaveLength(1);
  });

  it("asks again when the same pair conflicts after the first card was cancelled automatically", async () => {
    const t = contested(["thr_new"]);
    await t.pass(10_000);
    t.metadata.thr_new = claimsOf(7);
    await t.pass(20_000);
    const [first] = t.conflicts();
    if (first === undefined) throw new Error("no conflict card");
    delete t.metadata.thr_new;
    await t.pass(30_000);
    expect(t.questions.get(first.id)?.state).toBe("canceled");
    expect(t.conflicts()).toEqual([]);
    t.metadata.thr_new = claimsOf(7);
    await t.pass(40_000);
    expect(t.prStore.get("example/app", 7)).toMatchObject({
      deliveryThreadId: "thr_old",
      conflictChat: "linux:thr_new",
    });
    expect(t.conflicts()).toHaveLength(1);
    expect(t.conflicts()[0]?.id).not.toBe(first.id);
  });

  it("asks one new card when a PR with an unchanged conflict closes and opens again, and refuses the old card", async () => {
    const t = contested(["thr_new"]);
    await t.pass(10_000);
    t.metadata.thr_new = claimsOf(7);
    await t.pass(20_000);
    const [first] = t.conflicts();
    if (first === undefined) throw new Error("no conflict card");
    expect(t.questions.markOpen(first.id, "thr_bot", "tok_1", 20_500)).toBe(true);
    t.pulls[0] = pull(7, { state: "closed", updatedAt: 6_000 });
    await t.pass(30_000);
    expect(t.conflicts()).toEqual([]);
    expect(t.prStore.get("example/app", 7)).toMatchObject({
      conflictChat: null,
      conflictSince: null,
    });
    t.pulls[0] = pull(7, { updatedAt: 7_000 });
    await t.pass(40_000);
    expect(t.prStore.get("example/app", 7)).toMatchObject({
      deliveryThreadId: "thr_old",
      conflictChat: "linux:thr_new",
      conflictSince: 40_000,
    });
    const again = t.conflicts();
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(first.id);
    expect(
      t.questions.answer(
        first.id,
        "tok_1",
        "keep",
        new Map([["pr_conflict", conflictKind(t.prStore, t.store)]]),
        40_500,
      ),
    ).toBe("unknown");
  });

  it("does not ask again while the same conflict goes on after the owner closed the card", async () => {
    const t = contested(["thr_new"]);
    await t.pass(10_000);
    t.metadata.thr_new = claimsOf(7);
    await t.pass(20_000);
    const [first] = t.conflicts();
    if (first === undefined) throw new Error("no conflict card");
    expect(t.questions.markOpen(first.id, "thr_bot", "tok_1", 20_500)).toBe(true);
    t.questions.closeAs(first.id, "tok_1", "dismissed");
    await t.pass(30_000);
    await t.pass(40_000);
    expect(t.conflicts()).toEqual([]);
  });

  it("cancels the card and asks one new card when the participants change", async () => {
    const t = contested(["thr_new", "thr_third"]);
    await t.pass(10_000);
    t.metadata.thr_new = claimsOf(7);
    await t.pass(20_000);
    const [first] = t.conflicts();
    if (first === undefined) throw new Error("no conflict card");
    t.metadata.thr_third = claimsOf(7);
    await t.pass(30_000);
    expect(t.questions.get(first.id)?.state).toBe("canceled");
    const now = t.conflicts();
    expect(now).toHaveLength(1);
    expect(t.prStore.get("example/app", 7)).toMatchObject({
      deliveryThreadId: "thr_old",
      conflictChat: "linux:thr_new,linux:thr_third",
    });
    const options = now[0]?.card.options.map((option) => option.id);
    expect(options).toEqual(["keep", "move:0", "move:1"]);
  });

  it("moves the link only once the linked chat is read without its claim and one other claimant remains", async () => {
    const t = contested(["thr_new", "thr_third"]);
    await t.pass(10_000);
    t.metadata.thr_new = claimsOf(7);
    t.metadata.thr_third = claimsOf(7);
    t.metadata.thr_old = { claims: [] };
    await t.pass(20_000);
    expect(t.prStore.get("example/app", 7)).toMatchObject({
      linkKind: null,
      claimProblem: "claimed by 2 chats",
    });
    delete t.metadata.thr_third;
    await t.pass(30_000);
    expect(t.prStore.get("example/app", 7)).toMatchObject({
      linkKind: "claim",
      deliveryThreadId: "thr_new",
      conflictChat: null,
    });
  });
});
