import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const BOTS_PLUGIN_ID = "1ma-bots";
export const DEV_CAPABILITY = "dev";

const forThreadOutput = z
  .object({ botId: z.string(), capabilities: z.array(z.string()) })
  .nullable();

export interface BotOrigin {
  readonly threadId: string;
  readonly originPluginId: string | null;
}

export function mayBeMainBot(origin: BotOrigin, mainBotThreadId: string | null): boolean {
  return (
    (mainBotThreadId !== null && origin.threadId === mainBotThreadId) ||
    origin.originPluginId === BOTS_PLUGIN_ID
  );
}

export async function isMainBot(
  bb: BbPluginApi,
  threadId: string,
  mainBotThreadId: string | null,
): Promise<boolean> {
  if (mainBotThreadId !== null && threadId === mainBotThreadId) return true;
  try {
    const bot = await bb.sdk.plugins.callRpc({
      pluginId: BOTS_PLUGIN_ID,
      method: "bots.v1.forThread",
      input: { threadId },
      outputSchema: forThreadOutput,
    });
    return bot !== null && bot.capabilities.includes(DEV_CAPABILITY);
  } catch {
    return false;
  }
}
