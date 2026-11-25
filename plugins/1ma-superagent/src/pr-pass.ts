import { type Claim, type ClaimingChat, checkClaim, readClaims } from "./claims.js";
import { describeError } from "./executors/paging.js";
import { repoFromRemoteUrl } from "./github/names.js";
import type { GitHubReader, PullRequest } from "./github/reader.js";
import type { Completeness, Executor, ServerId } from "./observation.js";
import type { LinkDecision, PrStore } from "./pr-store.js";
import { type RepoPolicy, isWatchedRepo } from "./repos.js";
import type { SeenThread, Store } from "./store.js";

export const FIRST_LOOK_BACK_MS = 7 * 24 * 60 * 60 * 1000;
export const REREAD_CLOSED_MS = 24 * 60 * 60 * 1000;
const HINT_LIMIT = 5;

export interface PrPassDeps {
  readonly store: Store;
  readonly prStore: PrStore;
  readonly github: GitHubReader | null;
  readonly policy: RepoPolicy;
  readonly executors: ReadonlyMap<ServerId, Executor>;
  readonly observed: ReadonlyMap<ServerId, Completeness>;
  readonly now: number;
  readonly signal: AbortSignal;
  readonly admitted: () => boolean;
}

interface Candidate {
  readonly chat: ClaimingChat;
  readonly claim: Claim;
}

interface WatchedThread extends SeenThread {
  readonly serverId: ServerId;
  readonly repo: string;
}

function key(repo: string, number: number): string {
  return `${repo}#${number}`;
}

async function collectClaims(
  deps: PrPassDeps,
  threads: readonly WatchedThread[],
  problems: string[],
) {
  const candidates = new Map<string, Candidate[]>();
  const read = new Set<string>();
  await Promise.all(
    [...deps.executors.values()].map(async (executor) => {
      if ((deps.observed.get(executor.serverId) ?? "failed") === "failed") return;
      const ids = threads
        .filter((thread) => thread.serverId === executor.serverId)
        .map((thread) => thread.threadId);
      if (ids.length === 0) return;
      let rows;
      try {
        rows = await executor.readMetadata(ids, deps.signal);
      } catch (error) {
        problems.push(`${executor.serverId} claims: ${describeError(error)}`);
        return;
      }
      for (const id of ids) read.add(`${executor.serverId}:${id}`);
      const byId = new Map(
        threads.map((thread) => [`${thread.serverId}:${thread.threadId}`, thread]),
      );
      for (const row of rows) {
        const thread = byId.get(`${executor.serverId}:${row.threadId}`);
        if (thread === undefined) continue;
        for (const claim of readClaims(row.metadata)) {
          const list = candidates.get(key(claim.repo, claim.number)) ?? [];
          list.push({
            chat: { serverId: executor.serverId, threadId: row.threadId, projectRepo: thread.repo },
            claim,
          });
          candidates.set(key(claim.repo, claim.number), list);
        }
      }
    }),
  );
  return { candidates, read };
}

export interface CurrentLink {
  readonly chat: string;
  readonly observed: boolean;
  readonly unreadParticipants: readonly string[];
}

const chatKey = (candidate: Candidate) => `${candidate.chat.serverId}:${candidate.chat.threadId}`;

export function decideLink(
  policy: RepoPolicy,
  pull: PullRequest,
  candidates: readonly Candidate[],
  current: CurrentLink | null,
): LinkDecision {
  const verdicts = candidates.map((candidate) => ({
    candidate,
    verdict: checkClaim(policy, candidate.chat, candidate.claim, pull),
  }));
  const valid = verdicts.filter((entry) => entry.verdict.ok);
  const chats = new Set(valid.map((entry) => chatKey(entry.candidate)));
  if (current !== null && (!current.observed || chats.has(current.chat))) {
    const others = [...new Set([...chats, ...current.unreadParticipants])]
      .filter((chat) => chat !== current.chat)
      .toSorted();
    if (others.length > 0) return { kind: "kept", conflict: others.join(",") };
    if (!current.observed) return { kind: "kept", conflict: null };
  }
  const claimants = new Set([...chats, ...(current?.unreadParticipants ?? [])]);
  const only = valid[0];
  if (claimants.size === 1 && chats.size === 1 && only !== undefined) {
    return {
      kind: "claim",
      serverId: only.candidate.chat.serverId,
      threadId: only.candidate.chat.threadId,
    };
  }
  if (claimants.size > 1) return { kind: "none", problem: `claimed by ${claimants.size} chats` };
  const rejected = verdicts.find((entry) => !entry.verdict.ok);
  return {
    kind: "none",
    problem: rejected !== undefined && !rejected.verdict.ok ? rejected.verdict.problem : null,
  };
}

function branchHint(threads: readonly WatchedThread[], pull: PullRequest): string | null {
  const matches = threads
    .filter((thread) => thread.repo === pull.repo && thread.branch === pull.headRef)
    .map((thread) => `${thread.serverId}:${thread.threadId}`);
  if (matches.length === 0) return null;
  return matches.slice(0, HINT_LIMIT).join(",");
}

interface RepoBatch {
  readonly repo: string;
  readonly pulls: readonly PullRequest[];
  readonly cursor: number | null;
}

async function pullsOfRepo(
  deps: PrPassDeps,
  github: GitHubReader,
  repo: string,
  claimed: readonly number[],
  problems: string[],
): Promise<RepoBatch> {
  const found = new Map<number, PullRequest>();
  const since = deps.prStore.cursor(repo) ?? deps.now - FIRST_LOOK_BACK_MS;
  let cursor: number | null = null;
  try {
    const recent = await github.recentPulls(repo, since, deps.signal);
    for (const pull of recent.pulls) found.set(pull.number, pull);
    if (recent.complete) cursor = Math.max(since, ...recent.pulls.map((pull) => pull.updatedAt));
  } catch (error) {
    problems.push(`${repo} recent pull requests: ${describeError(error)}`);
  }
  const reread = new Set([...claimed, ...deps.prStore.toReread(repo, REREAD_CLOSED_MS, deps.now)]);
  await Promise.all(
    [...reread]
      .filter((number) => !found.has(number))
      .map(async (number) => {
        try {
          found.set(number, await github.pull(repo, number, deps.signal));
        } catch (error) {
          problems.push(`${repo}#${number}: ${describeError(error)}`);
        }
      }),
  );
  return { repo, pulls: [...found.values()], cursor };
}

function recordLink(
  deps: PrPassDeps,
  pull: PullRequest,
  candidates: ReadonlyMap<string, readonly Candidate[]>,
  read: ReadonlySet<string>,
  threads: readonly WatchedThread[],
): void {
  const current = deps.prStore.get(pull.repo, pull.number);
  const linked =
    current?.linkKind === "claim" &&
    current.deliveryServerId !== null &&
    current.deliveryThreadId !== null
      ? `${current.deliveryServerId}:${current.deliveryThreadId}`
      : null;
  const decision = decideLink(
    deps.policy,
    pull,
    candidates.get(key(pull.repo, pull.number)) ?? [],
    linked === null
      ? null
      : {
          chat: linked,
          observed: read.has(linked),
          unreadParticipants: (current?.conflictChat?.split(",") ?? []).filter(
            (chat) => !read.has(chat),
          ),
        },
  );
  deps.prStore.record(pull, decision, branchHint(threads, pull), deps.now);
}

function modelReadOf(
  deps: PrPassDeps,
  pull: PullRequest,
  threads: readonly WatchedThread[],
  problems: string[],
): (() => Promise<void>) | null {
  const link = deps.prStore.get(pull.repo, pull.number);
  if (link?.linkKind !== "claim" || pull.state !== "open" || link.deliveryServerId === null)
    return null;
  const serverId = link.deliveryServerId;
  const threadId = link.deliveryThreadId;
  const executor = deps.executors.get(serverId);
  const thread = threads.find(
    (candidate) => candidate.serverId === serverId && candidate.threadId === threadId,
  );
  if (
    executor === undefined ||
    threadId === null ||
    thread === undefined ||
    deps.observed.get(serverId) === "failed"
  ) {
    deps.prStore.markChatModelGap(pull.repo, pull.number);
    return null;
  }
  return () =>
    executor.threadModel(threadId, deps.signal).then(
      (model) => {
        if (!deps.admitted()) return;
        if (model === null) deps.prStore.markChatModelGap(pull.repo, pull.number);
        else
          deps.prStore.observeChatModel(pull.repo, pull.number, thread.providerId, model, deps.now);
      },
      (error: unknown) => {
        if (!deps.admitted()) return;
        deps.prStore.markChatModelGap(pull.repo, pull.number);
        problems.push(`${serverId}:${threadId} model: ${describeError(error)}`);
      },
    );
}

export async function runPrPass(deps: PrPassDeps): Promise<{ problems: string[] }> {
  const problems: string[] = [];
  const { github } = deps;
  if (github === null || deps.policy.connected.size === 0) return { problems };
  const threads: WatchedThread[] = [];
  for (const serverId of deps.executors.keys()) {
    for (const thread of deps.store.threadsSeen(serverId)) {
      const repo = repoFromRemoteUrl(thread.remoteUrl);
      if (isWatchedRepo(deps.policy, repo)) threads.push({ ...thread, serverId, repo });
    }
  }
  const { candidates, read } = await collectClaims(deps, threads, problems);
  const repos = [...deps.policy.connected.keys()];
  const batches = await Promise.all(
    repos.map(async (repo) => {
      const claimed = [...candidates.values()]
        .flat()
        .filter((candidate) => candidate.claim.repo === repo)
        .map((candidate) => candidate.claim.number);
      return pullsOfRepo(deps, github, repo, claimed, problems);
    }),
  );
  if (!deps.admitted()) return { problems };
  const modelReads = deps.prStore.batch(() => {
    for (const batch of batches)
      if (batch.cursor !== null) deps.prStore.setCursor(batch.repo, batch.cursor);
    return batches.flatMap((batch) =>
      batch.pulls.flatMap((pull) => {
        recordLink(deps, pull, candidates, read, threads);
        return modelReadOf(deps, pull, threads, problems) ?? [];
      }),
    );
  });
  await Promise.all(modelReads.map((start) => start()));
  return { problems };
}
