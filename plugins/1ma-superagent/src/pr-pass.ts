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
  return candidates;
}

export function decideLink(
  policy: RepoPolicy,
  pull: PullRequest,
  candidates: readonly Candidate[],
): LinkDecision {
  const verdicts = candidates.map((candidate) => ({
    candidate,
    verdict: checkClaim(policy, candidate.chat, candidate.claim, pull),
  }));
  const valid = verdicts.filter((entry) => entry.verdict.ok);
  const chats = new Set(
    valid.map((entry) => `${entry.candidate.chat.serverId}:${entry.candidate.chat.threadId}`),
  );
  if (chats.size === 1 && valid[0] !== undefined) {
    return {
      kind: "claim",
      serverId: valid[0].candidate.chat.serverId,
      threadId: valid[0].candidate.chat.threadId,
    };
  }
  if (chats.size > 1) return { kind: "none", problem: `claimed by ${chats.size} chats` };
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

async function pullsOfRepo(
  deps: PrPassDeps,
  github: GitHubReader,
  repo: string,
  claimed: readonly number[],
  problems: string[],
): Promise<PullRequest[]> {
  const found = new Map<number, PullRequest>();
  const since = deps.prStore.cursor(repo) ?? deps.now - FIRST_LOOK_BACK_MS;
  try {
    const recent = await github.recentPulls(repo, since, deps.signal);
    for (const pull of recent.pulls) found.set(pull.number, pull);
    if (recent.complete) {
      const newest = Math.max(since, ...recent.pulls.map((pull) => pull.updatedAt));
      deps.prStore.setCursor(repo, newest);
    }
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
  return [...found.values()];
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
  const candidates = await collectClaims(deps, threads, problems);
  const repos = [...deps.policy.connected.keys()];
  const pullsByRepo = await Promise.all(
    repos.map(async (repo) => {
      const claimed = [...candidates.values()]
        .flat()
        .filter((candidate) => candidate.claim.repo === repo)
        .map((candidate) => candidate.claim.number);
      return pullsOfRepo(deps, github, repo, claimed, problems);
    }),
  );
  const provenanceReads: Array<Promise<void>> = [];
  for (const pull of pullsByRepo.flat()) {
    const decision = decideLink(
      deps.policy,
      pull,
      candidates.get(key(pull.repo, pull.number)) ?? [],
    );
    deps.prStore.record(pull, decision, branchHint(threads, pull), deps.now);
    const link = deps.prStore.get(pull.repo, pull.number);
    if (link?.linkKind !== "claim" || pull.state !== "open" || link.deliveryServerId === null)
      continue;
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
      deps.prStore.markProvenanceGap(pull.repo, pull.number);
      continue;
    }
    provenanceReads.push(
      executor.threadModel(threadId, deps.signal).then(
        (model) => {
          if (model === null) deps.prStore.markProvenanceGap(pull.repo, pull.number);
          else
            deps.prStore.observeProvenance(
              pull.repo,
              pull.number,
              thread.providerId,
              model,
              deps.now,
            );
        },
        (error: unknown) => {
          deps.prStore.markProvenanceGap(pull.repo, pull.number);
          problems.push(`${serverId}:${threadId} model: ${describeError(error)}`);
        },
      ),
    );
  }
  await Promise.all(provenanceReads);
  return { problems };
}
