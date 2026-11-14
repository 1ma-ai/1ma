import { agentText } from "../strings.js";
import type { BotDetail, BotSummary } from "./contract.js";

export function botInstructions(bot: BotDetail, others: readonly BotSummary[]): string {
  const parts = [
    agentText.header(bot.name, bot.role),
    agentText.guidance,
    agentText.instructionsTitle,
    bot.instructions.trim() === "" ? agentText.emptyInstructions : bot.instructions.trim(),
    agentText.memoryTitle(bot.memory.length),
    bot.memory.trim() === "" ? agentText.emptyMemory : bot.memory.trim(),
  ];
  const peers = others.filter((other) => other.id !== bot.id && !other.hidden);
  if (peers.length > 0) {
    parts.push(
      agentText.othersTitle,
      peers.map((other) => agentText.other(other.name, other.id, other.role)).join("\n"),
    );
  }
  return parts.join("\n\n");
}
