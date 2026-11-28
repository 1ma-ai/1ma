// plugins/1ma-sidebar/1ma/bots-rpc.ts of 8f7db7d, as released: an installed
// 1ma-sidebar of that version talks to this server so. Do not edit.
import type { PluginRpcMethodContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const BOTS_PLUGIN_ID = "1ma-bots";

const botThread = z.object({
  threadId: z.string(),
  startedFromBot: z.boolean(),
  completed: z.boolean(),
});

export const sidebarBotSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  avatar: z.string(),
  hidden: z.boolean(),
  threads: z.array(botThread),
});
export type SidebarBot = z.infer<typeof sidebarBotSchema>;

const ok = z.object({ ok: z.literal(true) });

// The part of 1ma-bots' bots.v1 contract this sidebar reads and calls.
export const botsRpc = {
  "bots.v1.list": {
    input: z.object({}),
    output: z.object({ bots: z.array(sidebarBotSchema) }),
  },
  "bots.v1.get": {
    input: z.object({ botId: z.string() }),
    output: z.object({
      id: z.string(),
      defaults: z
        .object({
          projectId: z.string().nullable(),
          providerId: z.string().optional(),
          model: z.string().optional(),
        })
        .nullable(),
    }),
  },
  "bots.v1.startThread": {
    input: z.object({ botId: z.string(), request: z.record(z.string(), z.unknown()) }),
    output: z.object({ threadId: z.string() }),
  },
  "bots.v1.setHidden": {
    input: z.object({ botId: z.string(), hidden: z.boolean() }),
    output: ok,
  },
  "bots.v1.setCompleted": {
    input: z.object({ threadId: z.string(), completed: z.boolean() }),
    output: ok,
  },
  "bots.v1.assign": {
    input: z.object({
      threadId: z.string(),
      botId: z.string().nullable(),
      place: z.enum(["first", "last"]).optional(),
    }),
    output: z.object({ botId: z.string().nullable(), startedFromBot: z.boolean() }),
  },
} as const satisfies Record<string, PluginRpcMethodContract>;
