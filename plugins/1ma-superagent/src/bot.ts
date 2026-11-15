import { repoFromRemoteUrl } from "./github/names.js";
import { type RepoPolicy, isExcludedRepo } from "./repos.js";

export interface BotCall {
  readonly threadId: string;
  readonly projectId: string;
  readonly signal: AbortSignal;
}

export type BotGate = (call: BotCall) => Promise<boolean>;

export function isBotChat(
  thread: { readonly threadId: string; readonly gitRemoteUrl: string | null },
  mainBotThreadId: string | null,
  policy: RepoPolicy,
): boolean {
  return (
    mainBotThreadId !== null &&
    thread.threadId === mainBotThreadId &&
    !isExcludedRepo(policy, repoFromRemoteUrl(thread.gitRemoteUrl))
  );
}
