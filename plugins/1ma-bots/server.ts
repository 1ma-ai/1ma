import {
  cliCommand,
  defineCli,
  type BbPluginApi,
  type ExperimentalPluginRpcHandlerContext,
  type MessageDispatchHookContext,
  type PluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { agentText, strings } from "./strings.js";
import {
  botNameSchema,
  botRoleSchema,
  botsRpc,
  chatDefaultsSchema,
  type Actor,
  type ChatDefaults,
  type MoveThreadsInput,
} from "./src/contract.js";
import { branchOf, keepsOpen } from "./src/branch.js";
import { BotsError } from "./src/errors.js";
import { botInstructions } from "./src/instructions.js";
import { acceptDelivery, letterTokens, resolveBot, routeLetter } from "./src/letters.js";
import {
  CHAIN_LETTERS_DEFAULT,
  HOUR_MS,
  HOURLY_LETTERS_DEFAULT,
  INSTRUCTIONS_MAX,
  LETTER_MAX,
  MEMORY_MAX,
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
// bb's limit of ids in one call.
const THREAD_IDS_MAX = 200;
// How often a decision is read again when something it may rest on changed meanwhile.
const DECISION_READS_MAX = 5;
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

function pages(threadIds: readonly string[]): string[][] {
  return Array.from({ length: Math.ceil(threadIds.length / THREAD_IDS_MAX) }, (_, page) =>
    threadIds.slice(page * THREAD_IDS_MAX, (page + 1) * THREAD_IDS_MAX),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    sourceThreadId: string | null = null,
  ) => {
    const bound = store.botOfThread(threadId);
    if (bound !== null) return bound;
    const token = metadata ? startToken(metadata) : null;
    if (token === null) return null;
    const claimed = store.claimPendingStart(threadId, token, sourceThreadId);
    if (claimed !== null) changed();
    return claimed;
  };

  const requireBot = (threadId: string): string => {
    const botId = botOf(threadId);
    if (botId === null) throw new BotsError("forbidden", agentText.notABot);
    return botId;
  };

  const showForWork = (threadId: string) => {
    const botId = store.botOfThread(threadId);
    return botId !== null && store.setHidden(botId, false, { kind: "system", id: null });
  };

  // Acts on a reading that nothing observable changed under: acting awaits
  // nothing, so no change fits between the comparison and the act.
  const decide = async <T, R>(read: () => Promise<T>, act: (value: T) => R): Promise<R> => {
    for (let reading = 1; reading <= DECISION_READS_MAX; reading += 1) {
      const seen = store.generation;
      const value = await read();
      if (store.generation === seen) return act(value);
    }
    throw new BotsError("conflict", agentText.keepsChanging);
  };

  type ThreadRow = Awaited<ReturnType<typeof bb.sdk.threads.list>>[number];

  // The rows a bot's tree can show: not archived, deleted or hidden.
  const shownRows = async (threadIds: readonly string[]) => {
    const rows = new Map<string, ThreadRow>();
    for (const page of pages(threadIds))
      for (const row of await bb.sdk.threads.list({ threadIds: page, archived: false }))
        rows.set(row.id, row);
    return rows;
  };

  const branchesOf = async (threadIds: readonly string[]) => {
    const chains = [];
    for (const page of pages(threadIds))
      chains.push(
        ...(await bb.sdk.threads.experimental_listAncestors({ threadIds: page })).threads,
      );
    const shown = await shownRows([...new Set(chains.flatMap((chain) => chain.ancestorIds))]);
    return new Map(
      chains.map(({ threadId, ancestorIds }) => [
        threadId,
        branchOf(
          [threadId, ...ancestorIds],
          (id) => store.botOfThread(id),
          (id) => shown.has(id),
        ),
      ]),
    );
  };

  // The bot's own conversations from this one up to its top in the bot's tree,
  // nearest first.
  const membersAbove = async (threadId: string) =>
    ((await branchesOf([threadId])).get(threadId)?.threadIds ?? []).filter(
      (id) => store.botOfThread(id) !== null,
    );

  // Everything shown under each of these conversations in its bot's tree: the
  // same branches as branchOf, walked down.
  const treesBelow = async (threadIds: readonly string[]) => {
    const trees = [];
    for (const page of pages(threadIds))
      trees.push(
        ...(await bb.sdk.threads.experimental_listDescendants({ threadIds: page })).threads,
      );
    const rows = await shownRows([...new Set(trees.flatMap((tree) => tree.descendantIds))]);
    return new Map(
      trees.map(({ threadId, descendantIds }) => {
        const botId = store.botOfThread(threadId);
        const inTree = new Set([threadId]);
        const below: ThreadRow[] = [];
        for (const id of descendantIds) {
          const row = rows.get(id);
          if (row === undefined || row.parentThreadId === null) continue;
          if (!inTree.has(row.parentThreadId)) continue;
          if ((store.botOfThread(id) ?? botId) !== botId) continue;
          inTree.add(id);
          below.push(row);
        }
        return [threadId, below] as const;
      }),
    );
  };

  // The first open conversation at the top of the bot's tree, in its order; the
  // first done one when all are done.
  const mainThread = async (botId: string): Promise<{ threadId: string; open: boolean } | null> => {
    let firstDone: string | null = null;
    for (const page of pages(store.get(botId).threads.map((member) => member.threadId))) {
      const rows = await shownRows(page);
      const branches = await branchesOf([...rows.keys()]);
      const tops = page.filter((id) => branches.get(id)?.threadIds.length === 1);
      const done = new Set(tops.filter((id) => store.completedAt(id) !== null));
      const below = await treesBelow([...done]);
      for (const threadId of tops) {
        const open =
          !done.has(threadId) ||
          [rows.get(threadId)!, ...(below.get(threadId) ?? [])].some(keepsOpen);
        if (open) return { threadId, open };
        firstDone ??= threadId;
      }
    }
    return firstDone === null ? null : { threadId: firstDone, open: false };
  };

  const reopenBranch = async (threadId: string) => {
    if (store.reopen([threadId])) changed();
    if (store.reopen(await membersAbove(threadId))) changed();
  };

  // Puts conversations beside another one of the same bot, under its parent in
  // the bot's tree when the caller saw that level: all of it, or nothing.
  const moveThreads = async ({ botId, threadIds, target, levelShown }: MoveThreadsInput) => {
    store.orderAfterMove(botId, threadIds, target);
    const shown = await shownRows([...threadIds, target.threadId]);
    const branches = await branchesOf([...threadIds, target.threadId]);
    const parentOf = (threadId: string) => branches.get(threadId)?.threadIds[1] ?? null;
    const { parentThreadId } = target;
    const rows = threadIds.flatMap((id) => shown.get(id) ?? []);
    if (
      rows.length < threadIds.length ||
      !shown.has(target.threadId) ||
      parentOf(target.threadId) !== parentThreadId
    )
      throw new BotsError("conflict", agentText.treeChanged);
    const started: ThreadRow[] = [];
    // A failed update may have been written all the same, so every row this
    // move touched is read again; what somebody else wrote since stays.
    const isBack = async (row: ThreadRow) => {
      const current = await bb.sdk.threads.get({ threadId: row.id });
      if (current.sectionId !== row.sectionId) return false;
      if (current.parentThreadId === row.parentThreadId) return true;
      if (current.parentThreadId !== parentThreadId) return false;
      await bb.sdk.threads.update({
        threadId: row.id,
        parentThreadId: row.parentThreadId,
        sectionId: row.sectionId,
      });
      return true;
    };
    try {
      for (const row of rows) {
        if (!levelShown || parentOf(row.id) === parentThreadId) continue;
        started.push(row);
        await bb.sdk.threads.update({
          threadId: row.id,
          parentThreadId,
          // Without it bb gives a conversation that leaves its parent the parent's section.
          ...(parentThreadId === null && { sectionId: row.sectionId }),
        });
      }
      store.moveThreads(botId, threadIds, target);
    } catch (error) {
      const stuck: ThreadRow[] = [];
      for (const row of started.toReversed())
        if (!(await isBack(row).catch(() => false))) stuck.push(row);
      if (stuck.length === 0) throw error;
      throw new BotsError(
        "conflict",
        agentText.moveNotUndone(
          messageOf(error),
          stuck.map((row) => row.title ?? row.titleFallback ?? row.id),
        ),
      );
    }
  };

  // The end of each bot's latest move, its undoing included; the next one waits for it.
  const moveEnds = new Map<string, Promise<void>>();
  const moveInTurn = async (input: MoveThreadsInput) => {
    const move = (moveEnds.get(input.botId) ?? Promise.resolve()).then(() => moveThreads(input));
    const end = move.catch(() => undefined);
    moveEnds.set(input.botId, end);
    await end;
    if (moveEnds.get(input.botId) === end) moveEnds.delete(input.botId);
    return move;
  };

  bb.agents.configure((ctx) => {
    const botId = botOf(ctx.thread.id, ctx.pluginMetadata, ctx.thread.sourceThreadId);
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
        maxCharacters: MEMORY_MAX,
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
      name: botNameSchema.optional(),
      role: botRoleSchema.optional(),
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
        const ownerTurn = await ownerTurnOf(ctx.threadId);
        const routeTo = (toThreadId: string | null) =>
          routeLetter(
            store,
            { fromThreadId: ctx.threadId, to: input.to, toThreadId, now: now(), ownerTurn },
            limits,
          );
        route = input.threadId
          ? routeTo(input.threadId)
          : await decide(
              () => mainThread(resolveBot(store, input.to)),
              (main) => routeTo(main?.threadId ?? null),
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
      let delivery: string;
      try {
        ({ delivery } = await bb.sdk.threads.send({
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
                token: route.token,
                text: input.text,
              }),
            },
          ],
        }));
      } catch (error) {
        store.record({
          botId: route.fromBotId,
          kind: "letter.failed",
          actor: agent,
          detail: {
            toThreadId: route.toThreadId,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
      if (delivery === "sent") {
        accepted({ threadId: route.toThreadId, texts: [`<<<letter ${route.token}`] });
      }
      return agentText.sent(to.name, route.toThreadId, route.letterNumber, limits.chainLetters);
    },
  });

  // send() confirms immediate delivery; message.dispatched confirms a queued
  // letter, including “Send now”. The dispatch hook runs before bb's waits.
  // Claiming the token once keeps a repeat from showing a bot hidden again.
  const accepted = (args: { threadId: string; texts: readonly string[] }) => {
    const botId = store.botOfThread(args.threadId);
    if (botId === null) return;
    const tokens = letterTokens(args.texts);
    if (tokens.length === 0) return;
    const shown = store.transaction(
      () =>
        acceptDelivery(store, args.threadId, tokens, false) &&
        store.setHidden(botId, false, { kind: "system", id: null }),
    );
    if (shown) changed();
  };

  // The turn now running in a conversation, when the owner started it: the
  // latest turn the provider confirmed (turn/started) and the request bb
  // recorded just before it (client/turn/requested, not rejected). bb records
  // a request only after every dispatch hook and wait let it through, and a
  // message steered into a running turn is recorded after its start, so it
  // never counts as a new turn.
  const ownerTurnOf = async (threadId: string): Promise<number | null> => {
    const rows = await bb.sdk.threads.events.list({
      threadId,
      types: ["turn/started", "client/turn/requested", "client/turn/rejected"],
      order: "desc",
      limit: "50",
    });
    const started = rows.find((row) => row.type === "turn/started");
    if (started === undefined) return null;
    const rejected = new Set(
      rows.flatMap((row) => (row.type === "client/turn/rejected" ? [row.data.requestId] : [])),
    );
    for (const row of rows) {
      if (row.seq >= started.seq || row.type !== "client/turn/requested") continue;
      if (rejected.has(row.data.requestId)) continue;
      return row.data.initiator === "user" && row.data.senderThreadId === null ? started.seq : null;
    }
    return null;
  };

  // Done is cleared by input the provider actually took after the mark (a new
  // turn, or a message steered into the running one), checked when the
  // conversation settles. bb marks a thread active while it still prepares
  // the request, and the provider may refuse it. Done covers the branch, so
  // work in a sub-thread clears the marks above it too.
  const reopenIfTurnStarted = async (threadId: string) => {
    const done = (await membersAbove(threadId)).filter((id) => store.completedAt(id) !== null);
    if (done.length === 0) return;
    const [latest] = await bb.sdk.threads.events.list({
      threadId,
      types: ["turn/started", "turn/input/accepted"],
      order: "desc",
      limit: "1",
    });
    if (latest === undefined) return;
    const reopened = done.filter(
      (id) => latest.createdAt > (store.completedAt(id) ?? latest.createdAt),
    );
    if (store.reopen(reopened)) changed();
  };
  const textsOf = (blocks: ReadonlyArray<{ type: string; text?: string }>) =>
    blocks.flatMap((block) =>
      block.type === "text" && block.text !== undefined ? [block.text] : [],
    );

  const inheritBot = async (thread: MessageDispatchHookContext["thread"]) => {
    const { sourceThreadId } = thread;
    if (
      sourceThreadId === null ||
      store.botOfThread(sourceThreadId) === null ||
      store.hasAssignmentDecision(thread.id) ||
      thread.visibility !== "visible" ||
      (thread.originKind === "fork" && thread.originPluginId === bb.pluginId)
    )
      return;
    const branch = await membersAbove(sourceThreadId);
    if (store.bindContinuation(thread.id, sourceThreadId, branch, false)) changed();
  };
  bb.events.on("thread.created", ({ thread }) => {
    store.noteChange();
    return inheritBot(thread);
  });
  bb.experimental_hooks.on("message.dispatch", async ({ thread }) => {
    try {
      if (thread.status === "pending") await inheritBot(thread);
    } catch (error) {
      bb.log.warn(
        `Could not apply bot assignment before dispatch for ${thread.id}: ${messageOf(error)}`,
      );
    }
    return { action: "proceed" };
  });
  bb.events.on("message.dispatched", ({ entry }) =>
    accepted({ threadId: entry.threadId, texts: textsOf(entry.content) }),
  );
  bb.events.on("thread.archived", () => store.noteChange());
  bb.events.on("thread.unarchived", () => store.noteChange());
  bb.events.on("experimental_thread.parentChanged", () => store.noteChange());
  bb.events.on("thread.idle", ({ thread }) => {
    store.noteChange();
    return reopenIfTurnStarted(thread.id);
  });
  bb.events.on("thread.active", ({ thread }) => {
    store.noteChange();
    if (showForWork(thread.id)) changed();
  });
  bb.events.on("interaction.pending", async ({ thread }) => {
    store.noteChange();
    const updated = store.transaction(() => {
      const shown = showForWork(thread.id);
      const reopened = store.reopen([thread.id]);
      return shown || reopened;
    });
    if (updated) changed();
    await reopenBranch(thread.id);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    store.noteChange();
    return reopenBranch(thread.id);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    store.noteChange();
    store.forgetThread(thread.id);
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
    for (const { id: botId } of store.list()) {
      let seen = store.generation;
      const bot = store.find(botId);
      if (bot === null) continue;
      let main: string | undefined;
      try {
        main = (await mainThread(botId))?.threadId;
      } catch (error) {
        bb.log.warn(`auto-complete skipped ${botId}: ${messageOf(error)}`);
        continue;
      }
      for (const { threadId, completed } of bot.threads) {
        if (completed || threadId === main) continue;
        try {
          const below = (await treesBelow([threadId])).get(threadId) ?? [];
          const busy = below.some(
            (thread) =>
              thread.hasPendingInteraction ||
              thread.pinnedAt !== null ||
              thread.status !== "idle" ||
              thread.queuedWork !== "none" ||
              thread.updatedAt > cutoff,
          );
          if (busy) continue;
          const pending = await bb.sdk.threads.interactions.list({ threadId });
          if (pending.length > 0) continue;
          const thread = await bb.sdk.threads.get({ threadId });
          // Another conversation may be the main one now: the rest of this bot
          // waits for the next pass. The writes below never change the main one.
          if (store.generation !== seen) break;
          if (thread.deletedAt !== null) {
            store.forgetThread(threadId);
            changed();
            seen = store.generation;
            continue;
          }
          if (thread.pinnedAt !== null || thread.status !== "idle") continue;
          if (thread.queuedMessageCount > 0 || thread.updatedAt > cutoff) continue;
          if (store.complete(threadId)) changed();
          seen = store.generation;
        } catch (error) {
          bb.log.warn(`auto-complete skipped ${threadId}: ${messageOf(error)}`);
        }
      }
    }
  });

  // The same rule as the Assign to bot menu, enforced where it is written:
  // only an existing, top-level, unarchived conversation joins a bot.
  const requireAssignable = async (threadId: string) => {
    let thread: Awaited<ReturnType<typeof bb.sdk.threads.get>>;
    try {
      thread = await bb.sdk.threads.get({ threadId });
    } catch {
      throw new BotsError("not_found", agentText.noSuchThread);
    }
    if (thread.deletedAt !== null) throw new BotsError("not_found", agentText.noSuchThread);
    if (thread.parentThreadId !== null || thread.archivedAt !== null) {
      throw new BotsError("invalid", agentText.notAssignable);
    }
  };

  const startIn = async (
    botId: string,
    create: (token: string) => Promise<{ id: string }>,
    sourceThreadId: string | null = null,
  ) => {
    // A failed create keeps its token: the thread may exist anyway, and its
    // first configure still claims it. Old tokens expire in addPendingStart.
    const beside =
      sourceThreadId === null
        ? [(await mainThread(botId))?.threadId].filter((id) => id !== undefined)
        : await membersAbove(sourceThreadId);
    const token = store.addPendingStart(botId, beside);
    const thread = await create(token);
    store.claimPendingStart(thread.id, token, sourceThreadId);
    changed();
    return { threadId: thread.id };
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
    "bots.v1.setHidden": ({ botId, hidden }, ctx) => {
      if (store.setHidden(botId, hidden, actorOf(ctx))) changed();
      return { ok: true as const };
    },
    "bots.v1.reorderBots": ({ botIds }) => {
      store.reorderBots(botIds);
      changed();
      return { ok: true as const };
    },
    "bots.v1.assign": async ({ threadId, botId, place }, ctx) => {
      // Every refusal comes before the write: the sidebar takes a refusal as
      // proof that a dropped conversation did not move.
      if (botId !== null) {
        store.get(botId);
        await requireAssignable(threadId);
      }
      const startedFromBot = store.transaction(() => {
        store.recordAssignmentDecision(threadId);
        if (botId === null) {
          const previous = store.botOfThread(threadId);
          store.unbind(threadId);
          if (previous !== null) {
            store.record({
              botId: previous,
              kind: "thread.unassigned",
              actor: actorOf(ctx),
              detail: { threadId },
            });
          }
          return false;
        }
        const startedFromBot = store.threadInfo(threadId)?.startedFromBot ?? false;
        store.bind(threadId, botId, { startedFromBot, place: place ?? "last" });
        store.record({ botId, kind: "thread.assigned", actor: actorOf(ctx), detail: { threadId } });
        return startedFromBot;
      });
      changed();
      return { botId, startedFromBot };
    },
    "bots.v1.main": ({ botId }) =>
      decide(
        () => mainThread(botId),
        (main) => ({ threadId: main?.open ? main.threadId : null }),
      ),
    "bots.v1.moveThreads": async (input) => {
      await moveInTurn(input);
      changed();
      return { ok: true as const };
    },
    "bots.v1.setCompleted": async ({ threadId, completed }) => {
      if (store.botOfThread(threadId) === null) {
        throw new BotsError("not_found", agentText.notABot);
      }
      if (completed) {
        const asked = store.generation;
        await decide(
          async () => [
            ...((await treesBelow([threadId])).get(threadId) ?? []),
            ...(await bb.sdk.threads.list({ threadIds: [threadId] })),
          ],
          (branch) => {
            const waits = branch.some(
              (thread) =>
                thread.hasPendingInteraction ||
                thread.status === "error" ||
                thread.queuedWork === "failed",
            );
            if (waits) throw new BotsError("conflict", agentText.needsOwner);
            if (store.reopenedSince(threadId, asked))
              throw new BotsError("conflict", agentText.broughtBack);
            store.complete(threadId);
          },
        );
      } else {
        store.reopen(await membersAbove(threadId));
      }
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
      return startIn(
        botId,
        (token) =>
          bb.sdk.threads.fork({
            sourceThreadId: threadId,
            pluginMetadata: { [START_TOKEN]: token },
          }),
        threadId,
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
