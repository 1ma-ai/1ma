import { z } from "zod";
import type { PullRequest } from "./github/reader.js";
import type { ServerId } from "./observation.js";
import { type RepoPolicy, isWatchedRepo } from "./repos.js";

export const MAX_CLAIMS_PER_CHAT = 20;

export const claimSchema = z
  .object({
    repo: z.string(),
    number: z.number().int().positive(),
    branch: z.string().nullable(),
    claimedAt: z.number(),
  })
  .strict();

export type Claim = z.infer<typeof claimSchema>;

export const claimsMetadataSchema = z.object({
  claims: z.array(claimSchema).max(MAX_CLAIMS_PER_CHAT),
});

export function readClaims(metadata: unknown): Claim[] {
  const parsed = claimsMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.claims : [];
}

export function addClaim(existing: readonly Claim[], claim: Claim): Claim[] {
  const others = existing.filter(
    (item) => !(item.repo === claim.repo && item.number === claim.number),
  );
  return [...others, claim].slice(-MAX_CLAIMS_PER_CHAT);
}

export interface ClaimingChat {
  readonly serverId: ServerId;
  readonly threadId: string;
  readonly projectRepo: string | null;
}

export type ClaimVerdict = { ok: true } | { ok: false; problem: string };

export function checkClaim(
  policy: RepoPolicy,
  chat: ClaimingChat,
  claim: Claim,
  pull: PullRequest,
): ClaimVerdict {
  if (chat.projectRepo !== null && policy.excluded.has(chat.projectRepo)) {
    return { ok: false, problem: "the chat belongs to an excluded project" };
  }
  if (policy.excluded.has(claim.repo)) {
    return { ok: false, problem: "the pull request is in an excluded project" };
  }
  if (chat.projectRepo !== claim.repo) {
    return { ok: false, problem: "the chat's project is not the pull request's repository" };
  }
  if (!isWatchedRepo(policy, claim.repo)) {
    return { ok: false, problem: "the repository is not watched" };
  }
  if (pull.repo !== claim.repo || pull.number !== claim.number) {
    return { ok: false, problem: "the pull request does not match the claim" };
  }
  if (pull.headRepo !== pull.repo) {
    return { ok: false, problem: "the pull request comes from another repository" };
  }
  const accounts = policy.connected.get(claim.repo)?.accounts[chat.serverId] ?? [];
  if (pull.author === null || !accounts.includes(pull.author)) {
    return {
      ok: false,
      problem: `the pull request author is not a GitHub account of the ${chat.serverId} server`,
    };
  }
  if (claim.branch === null || claim.branch !== pull.headRef) {
    return {
      ok: false,
      problem: "the chat was not on the pull request's branch when it claimed it",
    };
  }
  return { ok: true };
}
