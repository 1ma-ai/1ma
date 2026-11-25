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
  tags,
  type Actor,
  type BotDetail,
  type BotSummary,
  type ChatDefaults,
  type MoveThreadsInput,
} from "./src/contract.js";
import { branchOf, keepsOpen } from "./src/branch.js";
import { BotsError } from "./src/errors.js";
import { botInstructions } from "./src/instructions.js";
import { acceptDelivery, letterTokens, resolveBot, routeLetter } from "./src/letters.js";
import {
  CHAIN_LETTERS_DEFAULT,
  CLI_ROWS_MAX,
  DAY_MS,
  FOUND_MAX,
  HOUR_MS,
  HOURLY_LETTERS_DEFAULT,
  INSTRUCTIONS_MAX,
  LETTER_MAX,
  MEMORY_MAX,
  PEERS_LISTED_MAX,
  RETENTION_DAYS_DEFAULT,
  THREAD_IDS_MAX,
} from "./src/limits.js";
import { appendFact, checkMemorySize, forgetFact, memoryChangeSchema } from "./src/memory.js";
import {
  BotStore,
  INSTALLATION_OWNER,
  MIGRATIONS,
  broughtBack,
  childrenOf,
  leftBot,
  sha256,
  type MemberRow,
} from "./src/store.js";

export const AUTO_COMPLETE_SCHEDULE = "auto-complete";
export const UPKEEP_SCHEDULE = "upkeep";
export const RECONCILE_SERVICE = "reconcile";
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
// How often a decision is read again when something it rests on changed meanwhile.
const DECISION_READS_MAX = 5;
const TOOLS = [
  "bot_read",
  "bot_memory_update",
  "bot_update_identity",
  "bot_find",
  "bot_message",
] as const;

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

function matching(bots: readonly BotSummary[], text: string): BotSummary[] {
  const wanted = text.trim().toLowerCase();
  return bots.filter((bot) =>
    [bot.name, bot.role, ...bot.capabilities].some((field) => field.toLowerCase().includes(wanted)),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const threadNotFoundSchema = z.object({ code: z.literal("thread_not_found") });

const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

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
  const store = new BotStore(db, now, INSTALLATION_OWNER, (tags) =>
    bb.rpc.experimental_invalidate(tags),
  );

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
    retentionDays: {
      type: "number",
      label: strings.settings.retentionDays,
      description: strings.settings.retentionDaysDescription,
      default: RETENTION_DAYS_DEFAULT,
    },
  });

  const botOf = (
    threadId: string,
    metadata?: PluginAgentConfigurationContext["pluginMetadata"],
    sourceThreadId: string | null = null,
  ) => {
    const bound = store.botOfThread(threadId);
    if (bound !== null) return bound;
    const token = metadata ? startToken(metadata) : null;
    return token === null ? null : store.claimPendingStart(threadId, token, sourceThreadId);
  };

  const requireBot = (threadId: string): string => {
    const botId = botOf(threadId);
    if (botId === null) throw new BotsError("forbidden", agentText.notABot);
    return botId;
  };

  const showForWork = (threadId: string) => {
    const botId = store.botOfThread(threadId);
    if (botId !== null) store.setHidden(botId, false, { kind: "system", id: null });
  };

  // The names of everything a decision has read, as the store and the events
  // below name what changes.
  type Reads = Set<string>;

  // Acts on a reading nothing it rests on changed under: acting awaits nothing,
  // so no change fits between the comparison and the act. `changes` is what
  // changed since the decision was asked for.
  const decide = async <T, R>(
    read: (reads: Reads) => Promise<T>,
    act: (value: T, changes: readonly string[]) => R | Promise<R>,
  ): Promise<R> => {
    const changes = store.watch();
    try {
      for (let reading = 1; reading <= DECISION_READS_MAX; reading += 1) {
        const from = changes.length;
        const reads: Reads = new Set();
        const value = await read(reads);
        if (!changes.slice(from).some((change) => reads.has(change))) return act(value, changes);
      }
    } finally {
      store.unwatch(changes);
    }
    throw new BotsError("conflict", agentText.keepsChanging);
  };

  // A thread that comes under another one changes that one's tree.
  const noteThread = (thread: { id: string; parentThreadId: string | null }) =>
    store.noteChange(
      tags.thread(thread.id),
      ...(thread.parentThreadId === null ? [] : [childrenOf(thread.parentThreadId)]),
    );

  // What the readings below take from bb: where a conversation stands (archived,
  // deleted, its parent) and what keepsOpen looks at (status, question, queue).
  // bb has no event for visibility, a pin and a failed queue: those count from
  // the next reading on.
  for (const event of [
    "thread.created",
    "thread.archived",
    "thread.unarchived",
    "thread.deleted",
    "experimental_thread.parentChanged",
    "thread.active",
    "thread.idle",
    "thread.failed",
    "interaction.pending",
  ] as const)
    bb.events.on(event, ({ thread }) => noteThread(thread));
  for (const event of ["message.queued", "message.dispatched", "message.cancelled"] as const)
    bb.events.on(event, ({ entry }) => store.noteChange(tags.thread(entry.threadId)));

  const instructionsOf = (bot: BotDetail) =>
    botInstructions(bot, store.peers(bot, PEERS_LISTED_MAX));

  type ThreadRow = Awaited<ReturnType<typeof bb.sdk.threads.list>>[number];

  const rowsOf = async (
    threadIds: readonly string[],
    filter: { archived?: boolean; includeHidden?: boolean },
  ) => {
    const rows = new Map<string, ThreadRow>();
    for (const page of pages(threadIds))
      for (const row of await bb.sdk.threads.list({ threadIds: page, ...filter }))
        rows.set(row.id, row);
    return rows;
  };

  // The rows a bot's tree can show: not archived, deleted or hidden.
  const shownRows = (threadIds: readonly string[], reads: Reads) => {
    for (const id of threadIds) reads.add(tags.thread(id));
    return rowsOf(threadIds, { archived: false });
  };

  // Every bot's conversations, a page at a time.
  function* memberPages(options?: { open?: true }) {
    for (let after = ""; ;) {
      const page = store.memberPage(after, THREAD_IDS_MAX, options);
      if (page.length === 0) return;
      yield page;
      after = page.at(-1)!.threadId;
    }
  }

  const rowsOfMembers = (members: readonly MemberRow[]) =>
    rowsOf(
      members.map((member) => member.threadId),
      { includeHidden: true },
    );

  const membersIn = (threadIds: readonly string[], reads: Reads) => {
    const members = store.members(threadIds);
    for (const { botId } of members.values()) reads.add(tags.conversations(botId));
    return members;
  };

  const branchesOf = async (threadIds: readonly string[], reads: Reads = new Set()) => {
    for (const id of threadIds) reads.add(tags.thread(id));
    const chains = [];
    for (const page of pages(threadIds))
      chains.push(
        ...(await bb.sdk.threads.experimental_listAncestors({ threadIds: page })).threads,
      );
    const above = [...new Set(chains.flatMap((chain) => chain.ancestorIds))];
    const shown = await shownRows(above, reads);
    const members = membersIn([...threadIds, ...above], reads);
    return new Map(
      chains.map(({ threadId, ancestorIds }) => [
        threadId,
        branchOf(
          [threadId, ...ancestorIds],
          (id) => members.get(id)?.botId ?? null,
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
  const treesBelow = async (threadIds: readonly string[], reads: Reads = new Set()) => {
    const trees = [];
    for (const page of pages(threadIds))
      trees.push(
        ...(await bb.sdk.threads.experimental_listDescendants({ threadIds: page })).threads,
      );
    const inTrees = [...new Set(trees.flatMap((tree) => tree.descendantIds))];
    for (const id of [...threadIds, ...inTrees]) reads.add(childrenOf(id));
    for (const id of threadIds) reads.add(tags.thread(id));
    const rows = await shownRows(inTrees, reads);
    const members = membersIn([...threadIds, ...inTrees], reads);
    return new Map(
      trees.map(({ threadId, descendantIds }) => {
        const botId = members.get(threadId)?.botId;
        const inTree = new Set([threadId]);
        const below: ThreadRow[] = [];
        for (const id of descendantIds) {
          const row = rows.get(id);
          if (row === undefined || row.parentThreadId === null) continue;
          if (!inTree.has(row.parentThreadId)) continue;
          if ((members.get(id)?.botId ?? botId) !== botId) continue;
          inTree.add(id);
          below.push(row);
        }
        return [threadId, below] as const;
      }),
    );
  };

  // Each bot's first open conversation at the top of its tree, in its order; the
  // first done one when all are done.
  const mainThreads = async (botIds: readonly string[], reads: Reads = new Set()) => {
    for (const botId of botIds) reads.add(tags.conversations(botId));
    const mains = new Map<string, { threadId: string; open: boolean }>();
    let unread = botIds.map((botId) => ({ botId, after: null as number | null }));
    while (unread.length > 0) {
      const limit = Math.max(1, Math.floor(THREAD_IDS_MAX / unread.length));
      const read = unread.map(({ botId, after }) => ({
        botId,
        ...store.threads(botId, { from: "first", after, limit }),
      }));
      const rows = await shownRows(
        read.flatMap((page) => page.threads.map((t) => t.threadId)),
        reads,
      );
      const branches = await branchesOf([...rows.keys()], reads);
      const tops = new Set(
        [...rows.keys()].filter((id) => branches.get(id)?.threadIds.length === 1),
      );
      const members = store.members([...tops]);
      const topsOf = new Map(
        read.map(({ botId, threads }) => [
          botId,
          threads.map((t) => t.threadId).filter((id) => tops.has(id)),
        ]),
      );
      // Those marked done ahead of the first that is not: what is under the rest
      // decides nothing.
      const done = new Set(
        [...topsOf.values()].flatMap((ids) => {
          const unmarked = ids.findIndex((id) => !members.get(id)?.completed);
          return unmarked === -1 ? ids : ids.slice(0, unmarked);
        }),
      );
      const below = await treesBelow([...done], reads);
      const isOpen = (threadId: string) =>
        !done.has(threadId) ||
        [rows.get(threadId)!, ...(below.get(threadId) ?? [])].some(keepsOpen);
      unread = read.flatMap(({ botId, next }) => {
        const ids = topsOf.get(botId)!;
        const open = ids.find(isOpen);
        if (open !== undefined) mains.set(botId, { threadId: open, open: true });
        else if (ids[0] !== undefined && !mains.has(botId))
          mains.set(botId, { threadId: ids[0], open: false });
        return open !== undefined || next === null ? [] : [{ botId, after: next }];
      });
    }
    return mains;
  };
  const mainThread = async (botId: string, reads: Reads = new Set()) =>
    (await mainThreads([botId], reads)).get(botId);

  const reopenBranch = async (threadId: string) => {
    store.reopen([threadId]);
    store.reopen(await membersAbove(threadId));
  };

  // Puts conversations beside another one of the same bot, under its parent in
  // the bot's tree when the caller saw that level, or inside another one: all of
  // it, or nothing.
  const moveThreads = ({ botId, sources, target, levelShown }: MoveThreadsInput) => {
    const { placement } = target;
    const beside = placement === "inside" ? null : { threadId: target.threadId, placement };
    const parentThreadId = beside === null ? target.threadId : target.parentThreadId;
    const threadIds = sources.map((source) => source.threadId);
    const titleOf = (row: ThreadRow) => row.title ?? row.titleFallback ?? row.id;
    return decide(
      async (reads) => {
        const drawn = [...threadIds, target.threadId];
        return {
          branches: await branchesOf(drawn, reads),
          rows: await rowsOf(drawn, {}),
        };
      },
      async ({ branches, rows }) => {
        if (beside !== null) store.requireMovable(botId, threadIds, beside);
        const row = (threadId: string) => {
          const found = rows.get(threadId);
          if (found === undefined) throw new BotsError("conflict", agentText.treeChanged);
          return found;
        };
        const stands = (
          place: MoveThreadsInput["target"] | MoveThreadsInput["sources"][number],
        ) => {
          const branch = branches.get(place.threadId);
          const { archivedAt } = row(place.threadId);
          return (
            branch?.botId === botId &&
            (branch.threadIds[1] ?? null) === place.parentThreadId &&
            // bb lets an archived conversation go under another one.
            (archivedAt === null || (beside === null && place !== target))
          );
        };
        const real = (source: MoveThreadsInput["sources"][number]) =>
          row(source.threadId).parentThreadId === source.parentThreadId;
        if (
          ![...sources, target].every(stands) ||
          sources.some((source) => source.real !== real(source))
        )
          throw new BotsError("conflict", agentText.treeChanged);
        const moves = sources.filter(
          (source) => (beside === null || levelShown) && source.parentThreadId !== parentThreadId,
        );
        const outside = moves.find((source) => !source.real);
        if (outside !== undefined)
          throw new BotsError("invalid", agentText.outsideParent(titleOf(row(outside.threadId))));
        const started: ThreadRow[] = [];
        // A failed update may have been written all the same, so every row this
        // move touched is read again; what somebody else wrote since stays.
        const isBack = async (before: ThreadRow) => {
          const read = () => bb.sdk.threads.get({ threadId: before.id });
          let current = await read();
          if (current.parentThreadId === parentThreadId) {
            await bb.sdk.threads.update({
              threadId: before.id,
              parentThreadId: before.parentThreadId,
              ...(before.parentThreadId === null && { sectionId: current.sectionId }),
            });
            current = await read();
          }
          return (
            current.parentThreadId === before.parentThreadId &&
            current.sectionId === before.sectionId
          );
        };
        try {
          for (const source of moves) {
            const before = row(source.threadId);
            started.push(before);
            await bb.sdk.threads.update({
              threadId: before.id,
              parentThreadId,
              // Without it bb gives a conversation that leaves its parent the parent's section.
              ...(parentThreadId === null && { sectionId: before.sectionId }),
            });
          }
          if (beside !== null) store.moveThreads(botId, threadIds, beside);
        } catch (error) {
          const stuck: ThreadRow[] = [];
          for (const before of started.toReversed())
            if (!(await isBack(before).catch(() => false))) stuck.push(before);
          if (stuck.length === 0) throw error;
          throw new BotsError(
            "conflict",
            agentText.moveNotUndone(messageOf(error), stuck.map(titleOf)),
          );
        }
      },
    );
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
      instructions: instructionsOf(bot),
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
      return JSON.stringify({ revision: bot.revision });
    },
  });

  bb.agents.registerTool({
    name: "bot_find",
    description: agentText.tools.find,
    parameters: z.object({ query: z.string() }),
    execute: ({ query }, ctx) => {
      const bot = store.get(requireBot(ctx.threadId));
      const reach = bot.reach === null ? null : new Set(bot.reach);
      const found = matching(store.list(), query).filter(
        ({ id }) => id !== bot.id && (reach === null || reach.has(id)),
      );
      return JSON.stringify({
        bots: found
          .slice(0, FOUND_MAX)
          .map(({ id, name, role, capabilities }) => ({ id, name, role, capabilities })),
        total: found.length,
      });
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
              (reads) => mainThread(resolveBot(store, input.to), reads),
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
    store.transaction(() => {
      if (acceptDelivery(store, args.threadId, tokens, false))
        store.setHidden(botId, false, { kind: "system", id: null });
    });
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
    store.reopen(reopened);
  };
  const textsOf = (blocks: ReadonlyArray<{ type: string; text?: string }>) =>
    blocks.flatMap((block) =>
      block.type === "text" && block.text !== undefined ? [block.text] : [],
    );

  const inheritBot = async (
    thread: Pick<
      MessageDispatchHookContext["thread"],
      "id" | "sourceThreadId" | "visibility" | "originKind" | "originPluginId"
    >,
  ) => {
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
    store.bindContinuation(thread.id, sourceThreadId, branch, false);
  };
  bb.events.on("thread.created", ({ thread }) => inheritBot(thread));
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
  bb.events.on("thread.idle", ({ thread }) => reopenIfTurnStarted(thread.id));
  bb.events.on("thread.active", ({ thread }) => {
    showForWork(thread.id);
  });
  bb.events.on("interaction.pending", async ({ thread }) => {
    store.transaction(() => {
      showForWork(thread.id);
      store.reopen([thread.id]);
    });
    await reopenBranch(thread.id);
  });
  bb.events.on("thread.failed", ({ thread }) => reopenBranch(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => {
    store.forgetThread(thread.id);
  });

  bb.background.schedule(AUTO_COMPLETE_SCHEDULE, "17 * * * *", async () => {
    const hours = z
      .number()
      .min(0)
      .catch(0)
      .parse((await settings.get()).autoCompleteHours);
    if (hours <= 0) return;
    const cutoff = now() - hours * HOUR_MS;
    const isQuiet = (row: ThreadRow) =>
      !row.hasPendingInteraction &&
      row.pinnedAt === null &&
      row.status === "idle" &&
      row.queuedWork === "none" &&
      row.updatedAt <= cutoff;
    for (const page of memberPages({ open: true })) {
      let quiet: typeof page;
      try {
        const rows = await rowsOfMembers(page);
        quiet = page.filter(({ threadId }) => rows.get(threadId) && isQuiet(rows.get(threadId)!));
        const mains = await mainThreads([...new Set(quiet.map((member) => member.botId))]);
        quiet = quiet.filter(({ botId, threadId }) => mains.get(botId)?.threadId !== threadId);
        const below = await treesBelow(quiet.map((member) => member.threadId));
        quiet = quiet.filter(({ threadId }) => (below.get(threadId) ?? []).every(isQuiet));
      } catch (error) {
        bb.log.warn(`auto-complete skipped ${page.length} conversations: ${messageOf(error)}`);
        continue;
      }
      for (const { threadId } of quiet) {
        try {
          await decide(
            async (reads) => {
              const owner = store.botOfThread(threadId);
              if (owner === null) return false;
              if (!((await treesBelow([threadId], reads)).get(threadId) ?? []).every(isQuiet))
                return false;
              if ((await bb.sdk.threads.interactions.list({ threadId })).length > 0) return false;
              const thread = await bb.sdk.threads.get({ threadId });
              if (thread.deletedAt !== null || thread.pinnedAt !== null) return false;
              if (thread.status !== "idle" || thread.queuedMessageCount > 0) return false;
              if (thread.updatedAt > cutoff) return false;
              return (await mainThread(owner, reads))?.threadId !== threadId;
            },
            (forgotten, changes) => {
              if (forgotten && !changes.includes(broughtBack(threadId))) store.complete(threadId);
            },
          );
        } catch (error) {
          bb.log.warn(`auto-complete skipped ${threadId}: ${messageOf(error)}`);
        }
      }
    }
  });

  const isDeleted = async (threadId: string) => {
    try {
      return (await bb.sdk.threads.get({ threadId })).deletedAt !== null;
    } catch (error) {
      if (threadNotFoundSchema.safeParse(error).success) return true;
      throw error;
    }
  };

  const workedSince = async (threadId: string, since: number) => {
    const [started] = await bb.sdk.threads.events.list({
      threadId,
      types: ["turn/started"],
      order: "desc",
      limit: "1",
    });
    if (started !== undefined && started.createdAt > since) return true;
    const pending = await bb.sdk.threads.interactions.list({ threadId });
    return pending.some((interaction) => interaction.createdAt > since);
  };

  // What the events above would have done, for those sent while the plugin was
  // not running.
  const reconcile = async (signal?: AbortSignal) => {
    for (const page of memberPages()) {
      if (signal?.aborted) return;
      const rows = await rowsOfMembers(page);
      for (const { threadId } of page)
        if (!rows.has(threadId) && (await isDeleted(threadId))) store.forgetThread(threadId);
      const there = page.flatMap((member) => {
        const row = rows.get(member.threadId);
        return row === undefined ? [] : [{ ...member, row }];
      });
      for (const { threadId, hiddenAt, row } of there)
        if (
          hiddenAt !== null &&
          row.updatedAt > hiddenAt &&
          (await workedSince(threadId, hiddenAt))
        )
          showForWork(threadId);
      const done = there.flatMap(({ completedAt, row }) =>
        completedAt === null ? [] : [{ completedAt, row }],
      );
      const below = await treesBelow(done.map(({ row }) => row.id));
      for (const { completedAt, row } of done)
        for (const thread of [row, ...(below.get(row.id) ?? [])]) {
          if (thread.hasPendingInteraction || thread.status === "error")
            await reopenBranch(thread.id);
          else if (thread.updatedAt > completedAt) await reopenIfTurnStarted(thread.id);
        }
    }
    for (let offset = 0; !signal?.aborted; offset += THREAD_IDS_MAX) {
      const rows = await bb.sdk.threads.list({ archived: false, limit: THREAD_IDS_MAX, offset });
      for (const row of rows) {
        if (row.sourceThreadId === null) continue;
        const joinedAt = store.boundAt(row.sourceThreadId);
        if (joinedAt !== null && row.createdAt >= joinedAt) await inheritBot(row);
      }
      if (rows.length < THREAD_IDS_MAX) return;
    }
  };

  bb.background.service(RECONCILE_SERVICE, {
    start: async (signal) => {
      await reconcile(signal);
      await untilAborted(signal);
    },
  });

  bb.background.schedule(UPKEEP_SCHEDULE, "47 * * * *", async () => {
    const days = z
      .number()
      .min(0)
      .catch(0)
      .parse((await settings.get()).retentionDays);
    if (days > 0) store.dropHistory(now() - days * DAY_MS);
    await reconcile();
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
    return { threadId: thread.id };
  };

  bb.rpc.register(botsRpc, {
    "bots.v1.list": () => ({ bots: store.list() }),
    "bots.v1.forThread": ({ threadId }) => {
      const botId = store.botOfThread(threadId);
      if (botId === null) return null;
      return { botId, capabilities: store.get(botId).capabilities };
    },
    "bots.v1.forThreads": ({ keys }) => {
      const members = store.members(keys);
      return Object.fromEntries(keys.map((key) => [key, members.get(key) ?? null]));
    },
    "bots.v1.threads": ({ botId, from, after, limit }) => {
      store.get(botId);
      return store.threads(botId, {
        from: from ?? "first",
        after: after ?? null,
        limit: limit ?? THREAD_IDS_MAX,
      });
    },
    "bots.v1.get": ({ botId }) => store.get(botId),
    "bots.v1.instructions": ({ botId }) => ({ text: instructionsOf(store.get(botId)) }),
    "bots.v1.create": (input, ctx) =>
      store.transaction(() => {
        const created = store.create(input);
        store.record({ botId: created.id, kind: "bot.created", actor: actorOf(ctx) });
        return created;
      }),
    "bots.v1.update": (input, ctx) => {
      if (input.memory !== undefined) checkMemorySize(input.memory);
      return store.transaction(() => {
        const updated = store.update(input);
        store.record({
          botId: input.botId,
          kind: "bot.updated",
          actor: actorOf(ctx),
          detail: { fields: changedFields(input) },
        });
        return updated;
      });
    },
    "bots.v1.remove": ({ botId }) => {
      store.remove(botId);
      return { ok: true as const };
    },
    "bots.v1.setHidden": ({ botId, hidden }, ctx) => {
      store.setHidden(botId, hidden, actorOf(ctx));
      return { ok: true as const };
    },
    "bots.v1.reorderBots": ({ botIds }) => {
      store.reorderBots(botIds);
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
          const previous = store.unbind(threadId);
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
        const startedFromBot = store.members([threadId]).get(threadId)?.startedFromBot ?? false;
        store.bind(threadId, botId, { startedFromBot, place: place ?? "last" });
        store.record({ botId, kind: "thread.assigned", actor: actorOf(ctx), detail: { threadId } });
        return startedFromBot;
      });
      return { botId, startedFromBot };
    },
    "bots.v1.main": ({ botId }) =>
      decide(
        (reads) => mainThread(botId, reads),
        (main) => ({ threadId: main?.open ? main.threadId : null }),
      ),
    "bots.v1.mains": async ({ keys }) => {
      const mains = await mainThreads(keys);
      return Object.fromEntries(
        keys.map((key) => {
          const main = mains.get(key);
          return [key, main?.open ? main.threadId : null];
        }),
      );
    },
    "bots.v1.moveThreads": async (input) => {
      await moveInTurn(input);
      return { ok: true as const };
    },
    "bots.v1.setCompleted": async ({ threadId, completed }) => {
      if (store.botOfThread(threadId) === null) throw new BotsError("not_found", agentText.notABot);
      const requireSameAssignment = (changes: readonly string[]) => {
        if (changes.includes(leftBot(threadId)))
          throw new BotsError("conflict", agentText.reassigned);
      };
      if (completed) {
        await decide(
          async (reads) => [
            ...((await treesBelow([threadId], reads)).get(threadId) ?? []),
            ...(await bb.sdk.threads.list({ threadIds: [threadId] })),
          ],
          (branch, changes) => {
            requireSameAssignment(changes);
            const waits = branch.some(
              (thread) =>
                thread.hasPendingInteraction ||
                thread.status === "error" ||
                thread.queuedWork === "failed",
            );
            if (waits) throw new BotsError("conflict", agentText.needsOwner);
            if (changes.includes(broughtBack(threadId)))
              throw new BotsError("conflict", agentText.broughtBack);
            store.complete(threadId);
          },
        );
      } else {
        await decide(
          () => membersAbove(threadId),
          (above, changes) => {
            requireSameAssignment(changes);
            store.reopen(above);
          },
        );
      }
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
          options: {
            find: {
              type: "string",
              description: "Only bots with this text in their name, role or work areas",
            },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          run(input) {
            const found = matching(store.list(), input.options.find ?? "");
            const counts = store.conversationCounts();
            const bots = found.slice(0, CLI_ROWS_MAX).map((bot) => ({
              id: bot.id,
              name: bot.name,
              role: bot.role,
              capabilities: bot.capabilities,
              hidden: bot.hidden,
              conversations: counts.get(bot.id) ?? 0,
            }));
            if (input.options.json)
              return { exitCode: 0, stdout: JSON.stringify({ bots, total: found.length }) };
            return {
              exitCode: 0,
              stdout: [
                ...bots.map((bot) =>
                  [bot.id, bot.name, bot.role, bot.capabilities.join(","), bot.conversations].join(
                    "\t",
                  ),
                ),
                ...(found.length > bots.length
                  ? [strings.moreInList(found.length - bots.length)]
                  : []),
              ].join("\n"),
            };
          },
        }),
      },
    }),
  );
}
