import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { strings } from "../strings.js";
import { addClaim, readClaims } from "./claims.js";
import { parsePullRequestUrl, repoFromRemoteUrl } from "./github/names.js";
import { type RepoPolicy, isWatchedRepo } from "./repos.js";

export const CLAIM_TOOL = "sa_claim_pr";

function refuse(text: string): PluginAgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function registerClaimTool(
  bb: BbPluginApi,
  policy: () => RepoPolicy,
  onClaimed: (threadId: string) => void,
  now: () => number = Date.now,
): void {
  bb.agents.registerTool({
    name: CLAIM_TOOL,
    description: strings.claimToolDescription,
    presentation: {
      label: { pending: strings.claimPending, completed: strings.claimCompleted },
      icon: { glyph: "GitPullRequest" },
    },
    parameters: z.object({ url: z.string().min(1).max(300) }).strict(),
    async execute({ url }, ctx) {
      const ref = parsePullRequestUrl(url);
      if (ref === null)
        return refuse("Pass the pull request URL, like https://github.com/owner/name/pull/12.");
      const project = await bb.sdk.projects.get({ projectId: ctx.projectId, signal: ctx.signal });
      const projectRepo = repoFromRemoteUrl(project.gitRemoteUrl);
      const current = policy();
      if (projectRepo !== null && current.excluded.has(projectRepo)) {
        return refuse("This project is excluded from the superagent; nothing was claimed.");
      }
      if (!isWatchedRepo(current, projectRepo) || projectRepo !== ref.repo) {
        return refuse(
          `This chat's project is not ${ref.repo}, a watched repository; nothing was claimed.`,
        );
      }
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId, signal: ctx.signal });
      const branch =
        thread.environmentId === null
          ? null
          : (
              await bb.sdk.environments.get({
                environmentId: thread.environmentId,
                signal: ctx.signal,
              })
            ).branchName;
      const existing = readClaims(
        await bb.sdk.threads.getPluginMetadata({ threadId: ctx.threadId, signal: ctx.signal }),
      );
      await bb.sdk.threads.updatePluginMetadata({
        threadId: ctx.threadId,
        set: {
          claims: addClaim(existing, {
            repo: ref.repo,
            number: ref.number,
            branch,
            claimedAt: now(),
          }),
        },
      });
      onClaimed(ctx.threadId);
      return `Claimed ${ref.repo}#${ref.number} for this chat${branch === null ? "" : ` on branch ${branch}`}. The superagent checks the claim against GitHub on its next pass.`;
    },
  });
}

export function claimSelection(
  policy: RepoPolicy,
  gitRemoteUrl: string | null,
): { tools: string[]; instructions?: string } {
  const repo = repoFromRemoteUrl(gitRemoteUrl);
  if (!isWatchedRepo(policy, repo)) return { tools: [] };
  return { tools: [CLAIM_TOOL], instructions: strings.claimInstruction };
}
