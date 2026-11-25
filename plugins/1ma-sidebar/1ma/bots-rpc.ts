import type { PluginRpcMethodContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const BOTS_PLUGIN_ID = "1ma-bots";

const botThread = z.object({
  threadId: z.string(),
  startedFromBot: z.boolean(),
  completed: z.boolean(),
  assignment: z.string(),
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

const seenAssignment = z.object({ botId: z.string(), assignment: z.string() });

// What the panel showed of a conversation; 1ma-bots refuses an action on what is
// not so any more.
const seenRow = z.object({
  threadId: z.string(),
  // Of the conversation, or of the nearest one above it that has a place in the bot.
  assignment: z.string(),
  parentThreadId: z.string().nullable(),
  // The conversation and the ones it is drawn under, nearest first.
  branch: z.array(z.object({ threadId: z.string(), completed: z.boolean() })),
  shownDone: z.boolean(),
});
export type SeenRow = z.infer<typeof seenRow>;

const ok = z.object({ ok: z.literal(true) });

// The part of 1ma-bots' contract this sidebar reads and calls.
const botsReads = {
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
  "bots.v2.main": {
    input: z.object({ botId: z.string() }),
    output: z.object({ threadId: z.string().nullable() }),
  },
} as const satisfies Record<string, PluginRpcMethodContract>;

// Each has a row in the plan's table of mutating methods.
export const botsWrites = {
  "bots.v1.startThread": {
    input: z.object({ botId: z.string(), request: z.record(z.string(), z.unknown()) }),
    output: z.object({ threadId: z.string() }),
  },
  "bots.v1.setHidden": {
    input: z.object({ botId: z.string(), hidden: z.boolean() }),
    output: ok,
  },
  "bots.v2.moveThreads": {
    input: z.object({
      botId: z.string(),
      sources: z.array(seenRow).min(1),
      target: seenRow.extend({ placement: z.enum(["before", "after", "inside"]) }),
      levelShown: z.boolean(),
    }),
    output: ok,
  },
  "bots.v2.assign": {
    input: z.object({
      threadId: z.string(),
      botId: z.string().nullable(),
      place: z.enum(["first", "last"]).optional(),
      seen: seenAssignment.nullable(),
    }),
    output: z.object({ botId: z.string().nullable(), startedFromBot: z.boolean() }),
  },
} as const satisfies Record<string, PluginRpcMethodContract>;

export const botsRpc = { ...botsReads, ...botsWrites };
