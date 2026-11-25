export interface BotBranch {
  botId: string;
  // The conversation and the ones it is drawn under, up to the top of its bot's tree.
  threadIds: readonly string[];
}

// chain: a conversation and everything above it in bb, nearest first. A
// conversation the bot's tree does not show (archived, deleted, hidden) and
// another bot's conversation end the branch. A sub-thread without its own place
// in a bot belongs to the bot of the nearest conversation above it.
export function branchOf(
  chain: readonly string[],
  botOf: (threadId: string) => string | null,
  isShown: (threadId: string) => boolean,
): BotBranch | null {
  let branch: BotBranch | null = null;
  const drawn: string[] = [];
  for (const [index, threadId] of chain.entries()) {
    const botId = botOf(threadId);
    if (branch !== null && botId !== null && botId !== branch.botId) return branch;
    const ends = index > 0 && !isShown(threadId);
    if (!ends) drawn.push(threadId);
    if (botId !== null) branch = { botId, threadIds: [...drawn] };
    if (ends) return branch;
  }
  return branch;
}
