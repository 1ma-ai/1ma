import {
  cliCommand,
  defineCli,
  type BbPluginApi,
  type ExperimentalPluginRpcHandlerContext,
  type PluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { agentText, strings } from "./strings.js";
import { botsRpc, chatDefaultsSchema, type Actor, type ChatDefaults } from "./src/contract.js";
import { BotsError } from "./src/errors.js";
import { botInstructions } from "./src/instructions.js";
import { clearChain, routeLetter } from "./src/letters.js";
import {
  CHAIN_LETTERS_DEFAULT,
  HOUR_MS,
  HOURLY_LETTERS_DEFAULT,
  INSTRUCTIONS_MAX,
  LETTER_MAX,
  NAME_MAX,
  ROLE_MAX,
} from "./src/limits.js";
import { appendFact, checkMemorySize, forgetFact, memoryChangeSchema } from "./src/memory.js";
import { BotStore, MIGRATIONS, sha256 } from "./src/store.js";

export const AUTO_COMPLETE_SCHEDULE = "auto-complete";
const START_TOKEN = "startToken";
const SPAWN_FIELDS = [
  "projectId",
  "providerId",
  "model",
  "reasoningLevel",
  "permissionMode",
  "serviceTier",
  "sessionOptions",
  "executionInputSources",
  "environment",
  "input",
  "sendAt",
] as const;
const TOOLS = ["bot_read", "bot_memory_update", "bot_update_identity", "bot_message"] as const;

const positiveCount = (fallback: number) => z.number().int().min(1).max(1000).catch(fallback);

function startToken(metadata: PluginAgentConfigurationContext["pluginMetadata"]): string | null {
  const value = metadata[START_TOKEN];
  return typeof value === "string" ? value : null;
}

function actorOf(ctx: ExperimentalPluginRpcHandlerContext): Actor {
  const caller = ctx.experimental_caller;
  return caller.kind === "plugin"
    ? { kind: "plugin", id: caller.pluginId }
    : { kind: "owner", id: null };
}

function changedFields(input: Record<string, unknown>): string[] {
  return Object.keys(input).filter(
    (key) => key !== "botId" && key !== "expectedRevision" && input[key] !== undefined,
  );
}

function defaultsFrom(request: Record<string, unknown>): ChatDefaults {
  const parsed = chatDefaultsSchema.safeParse({
    projectId: typeof request.projectId === "string" ? request.projectId : null,
    providerId: request.providerId,
    model: request.model,
  });
  return parsed.success ? parsed.data : { projectId: null };
}

export default function botsPlugin(bb: BbPluginApi, now: () => number = Date.now): void {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new BotStore(db, now);

  const settings = bb.settings.define({
    autoCompleteHours: {
      type: "number",
      label: strings.settings.autoCompleteHours,
      description: strings.settings.autoCompleteHoursDescription,
      default: 0,
    },
    chainLetters: {
      type: "number",
      label: strings.settings.chainLetters,
      description: strings.settings.chainLettersDescription,
      default: CHAIN_LETTERS_DEFAULT,
    },
    hourlyLetters: {
      type: "number",
      label: strings.settings.hourlyLetters,
      description: strings.settings.hourlyLettersDescription,
      default: HOURLY_LETTERS_DEFAULT,
    },
  });

  const changed = () => bb.rpc.experimental_invalidateAll();

  const botOf = (
    threadId: string,
    metadata?: PluginAgentConfigurationContext["pluginMetadata"],
  ) => {
    const bound = store.botOfThread(threadId);
    if (bound !== null) return bound;
    const token = metadata ? startToken(metadata) : null;
    if (token === null) return null;
    const claimed = store.claimPendingStart(threadId, token);
    if (claimed !== null) changed();
    return claimed;
  };

  const requireBot = (threadId: string): string => {
    const botId = botOf(threadId);
    if (botId === null) throw new BotsError("forbidden", agentText.notABot);
    return botId;
  };

  const reopen = (threadId: string) => {
    if (store.setCompleted(threadId, false)) changed();
  };

  bb.agents.configure((ctx) => {
    const botId = botOf(ctx.thread.id, ctx.pluginMetadata);
    const bot = botId === null ? null : store.find(botId);
    if (bot === null) return { tools: [], skills: [] };
    return {
      tools: [...TOOLS],
      skills: [agentText.skill],
      instructions: botInstructions(bot, store.list()),
    };
  });

  bb.agents.registerTool({
    name: "bot_read",
    description: agentText.tools.memoryRead,
    instructions: agentText.guidance,
    parameters: z.object({}),
    execute: (_input, ctx) => {
      const bot = store.get(requireBot(ctx.threadId));
      return JSON.stringify({
        id: bot.id,
        name: bot.name,
        role: bot.role,
        instructions: bot.instructions,
        revision: bot.revision,
        memory: bot.memory,
        sha256: bot.memorySha256,
        characters: bot.memory.length,
        maxCharacters: 3000,
      });
    },
  });

  bb.agents.registerTool({
    name: "bot_memory_update",
    description: agentText.tools.memoryUpdate,
    parameters: memoryChangeSchema,
    execute: (change, ctx) => {
      const botId = requireBot(ctx.threadId);
      const bot = store.transaction(() => {
        const current = store.get(botId);
        let next: string;
        if (change.action === "append") next = appendFact(current.memory, change.fact);
        else if (change.action === "forget") next = forgetFact(current.memory, change.fact);
        else {
          checkMemorySize(change.content);
          next = change.content;
        }
        const expected =
          change.action === "overwrite" ? change.expectedSha256 : current.memorySha256;
        if (next === current.memory && change.action !== "overwrite") return current;
        const written = store.writeMemory(botId, next, expected);
        store.record({
          botId,
          kind: "memory.changed",
          actor: { kind: "agent", id: ctx.threadId },
          detail: { action: change.action, characters: written.memory.length },
        });
        return written;
      });
      changed();
      return JSON.stringify({ sha256: sha256(bot.memory), characters: bot.memory.length });
    },
  });

  bb.agents.registerTool({
    name: "bot_update_identity",
    description: agentText.tools.identityUpdate,
    parameters: z.object({
      expectedRevision: z.number().int(),
      name: z.string().trim().min(1).max(NAME_MAX).optional(),
      role: z.string().trim().max(ROLE_MAX).optional(),
      instructions: z.string().max(INSTRUCTIONS_MAX).optional(),
    }),
    execute: (input, ctx) => {
      const botId = requireBot(ctx.threadId);
      const bot = store.transaction(() => {
        const updated = store.update({ botId, ...input });
        store.record({
          botId,
          kind: "bot.updated",
          actor: { kind: "agent", id: ctx.threadId },
          detail: { fields: changedFields(input) },
        });
        return updated;
      });
      changed();
      return JSON.stringify({ revision: bot.revision });
    },
  });

  bb.agents.registerTool({
    name: "bot_message",
    description: agentText.tools.message,
    parameters: z.object({
      to: z.string().min(1),
      text: z.string().min(1).max(LETTER_MAX),
      threadId: z.string().optional(),
    }),
    execute: async (input, ctx) => {
      const values = await settings.get();
      const limits = {
        chainLetters: positiveCount(CHAIN_LETTERS_DEFAULT).parse(values.chainLetters),
        hourlyLetters: positiveCount(HOURLY_LETTERS_DEFAULT).parse(values.hourlyLetters),
      };
      const agent = { kind: "agent" as const, id: ctx.threadId };
      let route: ReturnType<typeof routeLetter>;
      try {
        route = routeLetter(
          store,
          { fromThreadId: ctx.threadId, to: input.to, toThreadId: input.threadId, now: now() },
          limits,
        );
      } catch (error) {
        const fromBotId = store.botOfThread(ctx.threadId);
        if (fromBotId !== null) {
          store.record({
            botId: fromBotId,
            kind: "letter.refused",
            actor: agent,
            detail: {
              to: input.to,
              reason: error instanceof Error ? error.message : String(error),
            },
          });
        }
        throw error;
      }
      store.record({
        botId: route.fromBotId,
        kind: "letter.sent",
        actor: agent,
        detail: {
          toBotId: route.toBotId,
          toThreadId: route.toThreadId,
          chainId: route.chainId,
          number: route.letterNumber,
        },
      });
      changed();
      const from = store.get(route.fromBotId);
      const to = store.get(route.toBotId);
      await bb.sdk.threads.send({
        threadId: route.toThreadId,
        senderThreadId: ctx.threadId,
        mode: "queue-if-active",
        input: [
          {
            type: "text",
            mentions: [],
            text: agentText.letter({
              fromName: from.name,
              fromBotId: from.id,
              fromThreadId: ctx.threadId,
              number: route.letterNumber,
              limit: limits.chainLetters,
              text: input.text,
            }),
          },
        ],
      });
      return agentText.sent(to.name, route.toThreadId, route.letterNumber, limits.chainLetters);
    },
  });

  bb.experimental_hooks.on("message.dispatch", (ctx) => {
    const threadId = ctx.thread.id;
    if (store.botOfThread(threadId) !== null) {
      if (ctx.initiator === "user" && ctx.senderThreadId === null) clearChain(store, threadId);
      reopen(threadId);
    }
    return { action: "proceed" };
  });

  bb.events.on("interaction.pending", ({ thread }) => reopen(thread.id));
  bb.events.on("thread.failed", ({ thread }) => reopen(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => {
    store.unbind(thread.id);
    changed();
  });

  bb.background.schedule(AUTO_COMPLETE_SCHEDULE, "17 * * * *", async () => {
    const hours = z
      .number()
      .min(0)
      .catch(0)
      .parse((await settings.get()).autoCompleteHours);
    if (hours <= 0) return;
    const cutoff = now() - hours * HOUR_MS;
    for (const candidate of store.idleCandidates()) {
      if (candidate.isFirst) continue;
      const thread = await bb.sdk.threads.get({ threadId: candidate.threadId });
      if (thread.pinnedAt !== null || thread.status !== "idle") continue;
      if (thread.queuedMessageCount > 0 || thread.updatedAt > cutoff) continue;
      const pending = await bb.sdk.threads.interactions.list({ threadId: candidate.threadId });
      if (pending.length > 0) continue;
      if (store.setCompleted(candidate.threadId, true)) changed();
    }
  });

  const startIn = async (botId: string, create: (token: string) => Promise<{ id: string }>) => {
    const token = store.addPendingStart(botId);
    try {
      const thread = await create(token);
      store.claimPendingStart(thread.id, token);
      changed();
      return { threadId: thread.id };
    } finally {
      store.dropPendingStart(token);
    }
  };

  bb.rpc.register(botsRpc, {
    "bots.v1.list": () => ({ bots: store.list() }),
    "bots.v1.forThread": ({ threadId }) => {
      const botId = store.botOfThread(threadId);
      if (botId === null) return null;
      return { botId, capabilities: store.get(botId).capabilities };
    },
    "bots.v1.get": ({ botId }) => store.get(botId),
    "bots.v1.create": (input, ctx) => {
      const bot = store.transaction(() => {
        const created = store.create(input);
        store.record({ botId: created.id, kind: "bot.created", actor: actorOf(ctx) });
        return created;
      });
      changed();
      return bot;
    },
    "bots.v1.update": (input, ctx) => {
      if (input.memory !== undefined) checkMemorySize(input.memory);
      const bot = store.transaction(() => {
        const updated = store.update(input);
        store.record({
          botId: input.botId,
          kind: "bot.updated",
          actor: actorOf(ctx),
          detail: { fields: changedFields(input) },
        });
        return updated;
      });
      changed();
      return bot;
    },
    "bots.v1.remove": ({ botId }, ctx) => {
      store.transaction(() => {
        store.remove(botId);
        store.record({ botId, kind: "bot.removed", actor: actorOf(ctx) });
      });
      changed();
      return { ok: true as const };
    },
    "bots.v1.reorderBots": ({ botIds }) => {
      store.reorderBots(botIds);
      changed();
      return { ok: true as const };
    },
    "bots.v1.assign": ({ threadId, botId, place }, ctx) => {
      const previous = store.botOfThread(threadId);
      if (botId === null) {
        store.unbind(threadId);
        if (previous !== null) {
          store.record({
            botId: previous,
            kind: "thread.unassigned",
            actor: actorOf(ctx),
            detail: { threadId },
          });
        }
        changed();
        return { botId: null, startedFromBot: false };
      }
      const current = store.threadInfo(threadId);
      store.bind(threadId, botId, {
        startedFromBot: current?.startedFromBot ?? false,
        place: place ?? "last",
      });
      store.record({ botId, kind: "thread.assigned", actor: actorOf(ctx), detail: { threadId } });
      changed();
      return { botId, startedFromBot: current?.startedFromBot ?? false };
    },
    "bots.v1.reorderThreads": ({ botId, threadIds }) => {
      store.reorderThreads(botId, threadIds);
      changed();
      return { ok: true as const };
    },
    "bots.v1.setCompleted": ({ threadId, completed }) => {
      if (store.botOfThread(threadId) === null) {
        throw new BotsError("not_found", agentText.notABot);
      }
      store.setCompleted(threadId, completed);
      changed();
      return { ok: true as const };
    },
    "bots.v1.startThread": async ({ botId, request }) => {
      store.get(botId);
      const picked = Object.fromEntries(
        SPAWN_FIELDS.filter((field) => field in request).map((field) => [field, request[field]]),
      );
      // The composer's request is validated by the server's own spawn schema.
      const spawnArgs = picked as unknown as Parameters<typeof bb.sdk.threads.spawn>[0];
      const result = await startIn(botId, (token) =>
        bb.sdk.threads.spawn({ ...spawnArgs, pluginMetadata: { [START_TOKEN]: token } }),
      );
      store.saveDefaults(botId, defaultsFrom(request));
      return result;
    },
    "bots.v1.events": ({ botId, limit }) => {
      store.get(botId);
      return { events: store.events(botId, limit ?? 50) };
    },
    "bots.v1.continueInBot": async ({ threadId }) => {
      const botId = store.botOfThread(threadId);
      if (botId === null) throw new BotsError("not_found", agentText.notABot);
      return startIn(botId, (token) =>
        bb.sdk.threads.fork({ sourceThreadId: threadId, pluginMetadata: { [START_TOKEN]: token } }),
      );
    },
  });

  bb.cli.register(
    defineCli({
      name: bb.pluginId,
      summary: "List 1ma bots",
      description:
        "Public facts about 1ma bots: id, name, role, work areas and number of conversations. Bots write to each other with their bot_message tool.",
      commands: {
        list: cliCommand({
          summary: "List bots",
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          run(input) {
            const bots = store.list().map((bot) => ({
              id: bot.id,
              name: bot.name,
              role: bot.role,
              capabilities: bot.capabilities,
              hidden: bot.hidden,
              conversations: bot.threads.length,
            }));
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(bots) };
            return {
              exitCode: 0,
              stdout: bots
                .map((bot) =>
                  [bot.id, bot.name, bot.role, bot.capabilities.join(","), bot.conversations].join(
                    "\t",
                  ),
                )
                .join("\n"),
            };
          },
        }),
      },
    }),
  );
}
