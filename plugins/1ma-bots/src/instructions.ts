import { agentText } from "../strings.js";
import type { BotDetail, BotSummary } from "./contract.js";

export function botInstructions(
  bot: BotDetail,
  peers: { listed: readonly BotSummary[]; total: number },
): string {
  const parts = [
    agentText.header(bot.name, bot.role),
    agentText.guidance,
    agentText.instructionsTitle,
    bot.instructions.trim() === "" ? agentText.emptyInstructions : bot.instructions.trim(),
    agentText.memoryTitle(bot.memory.length),
    bot.memory.trim() === "" ? agentText.emptyMemory : bot.memory.trim(),
  ];
  const unlisted = peers.total - peers.listed.length;
  if (peers.total > 0) {
    parts.push(
      agentText.othersTitle,
      [
        ...peers.listed.map((other) => agentText.other(other.name, other.id, other.role)),
        ...(unlisted > 0 ? [agentText.othersUnlisted(unlisted)] : []),
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}
