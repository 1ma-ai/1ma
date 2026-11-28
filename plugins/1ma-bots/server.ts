import { isDeepStrictEqual } from "node:util";
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
  type Assignment,
  type AssignInput,
  type ChatDefaults,
  type MoveThreadsInput,
  type MoveToTopInput,
  type SeenRow,
  type SeenThread,
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
// bb's limit of events in one call.
const EVENTS_MAX = 100;
// bb's own notice that a sub-thread was attached to a conversation or detached.
const OWNERSHIP_NOTICES: ReadonlySet<string | undefined> = new Set([
  "ownership-assigned",
  "ownership-removed",
  "ownership-batch",
]);
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
  // nothing, so no change fits between the comparison and the act. A request is
  // refused when changes do not stop; an event has nobody to refuse.
  const decide = async <T, R>(
    read: () => Promise<T>,
    act: (value: T) => R | Promise<R>,
    readings = DECISION_READS_MAX,
  ): Promise<R> => {
    for (let reading = 1; reading <= readings; reading += 1) {
      const seen = store.generation;
      const value = await read();
      if (store.generation === seen) return act(value);
    }
    throw new BotsError("conflict", agentText.keepsChanging);
  };

  // What the readings below take from bb: where a conversation stands (archived,
  // deleted, its parent) and what keepsOpen looks at (status, question, queue).
  // Of the times of update bb tells only that the owner read a conversation. It
  // has no event for visibility, a pin, a failed queue, an answered question and
  // a start that is being prepared: those count from the next reading on.
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
    "message.queued",
    "message.dispatched",
    "message.cancelled",
    "experimental_thread.read",
  ] as const)
    bb.events.on(event, () => store.noteChange());

  type ThreadRow = Awaited<ReturnType<typeof bb.sdk.threads.list>>[number];

  const rowsOf = async (threadIds: readonly string[], filter: { archived?: boolean } = {}) => {
    const rows = new Map<string, ThreadRow>();
    for (const page of pages(threadIds))
      for (const row of await bb.sdk.threads.list({ threadIds: page, ...filter }))
        rows.set(row.id, row);
    return rows;
  };

  // The rows a bot's tree can show: not archived, deleted or hidden.
  const shownRows = (threadIds: readonly string[]) => rowsOf(threadIds, { archived: false });

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

  // Which of these conversations something in their branch keeps open.
  const keptOpen = async (
    threadIds: readonly string[],
    rows: ReadonlyMap<string, ThreadRow>,
  ): Promise<ReadonlySet<string>> => {
    const below = await treesBelow(threadIds);
    return new Set(
      threadIds.filter((threadId) =>
        [rows.get(threadId), ...(below.get(threadId) ?? [])].some(
          (row) => row !== undefined && keepsOpen(row),
        ),
      ),
    );
  };

  // Where conversations stand in bb and in their bot's tree.
  const standingOf = async (threadIds: readonly string[]) => ({
    rows: await rowsOf(threadIds),
    branches: await branchesOf(threadIds),
  });
  type Standing = Awaited<ReturnType<typeof standingOf>>;

  const isMarked = (threadId: string) => store.completedAt(threadId) !== null;

  type SeenPlace = SeenThread["branch"][number];
  const isPlaceAsSeen = (botId: string, { threadId, assignment }: SeenPlace) =>
    isDeepStrictEqual(
      store.assignmentOf(threadId),
      assignment === null ? null : { botId, assignment },
    );

  // Whether a conversation stands where the window showed it: under the same
  // parent in bb and in the tree, and it and the ones above it in the same bot
  // since the same assignment, with the same marks.
  const isAsSeen = ({ rows, branches }: Standing, botId: string, seen: SeenThread) =>
    rows.get(seen.threadId)?.parentThreadId === seen.parentThreadId &&
    isDeepStrictEqual(branches.get(seen.threadId), {
      botId,
      threadIds: seen.branch.map(({ threadId }) => threadId),
    }) &&
    seen.branch.every(
      (place) => isPlaceAsSeen(botId, place) && place.completed === isMarked(place.threadId),
    );

  // The same and what keeps marked branches open.
  const drawnStandingOf = async (threadIds: readonly string[]) => {
    const standing = await standingOf(threadIds);
    const marked = [...standing.branches.values()]
      .flatMap((branch) => branch?.threadIds ?? [])
      .filter(isMarked);
    const ids = [...new Set(marked)];
    return { ...standing, kept: await keptOpen(ids, await shownRows(ids)) };
  };
  type DrawnStanding = Awaited<ReturnType<typeof drawnStandingOf>>;

  const isDrawnDone = ({ kept }: DrawnStanding, branch: SeenRow["branch"]) =>
    branch.some(({ threadId }) => isMarked(threadId) && !kept.has(threadId));

  const isDrawnAsSeen = (standing: DrawnStanding, botId: string, seen: SeenRow) =>
    isAsSeen(standing, botId, seen) && isDrawnDone(standing, seen.branch) === seen.shownDone;

  // The first open conversation at the top of the bot's tree, in its order; the
  // first done one when all are done.
  const mainThread = async (botId: string): Promise<{ threadId: string; open: boolean } | null> => {
    let firstDone: string | null = null;
    for (const page of pages(store.get(botId).threads.map((member) => member.threadId))) {
      const rows = await shownRows(page);
      const branches = await branchesOf([...rows.keys()]);
      const tops = page.filter((id) => branches.get(id)?.threadIds.length === 1);
      const done = new Set(tops.filter(isMarked));
      const kept = await keptOpen([...done], rows);
      for (const threadId of tops) {
        const open = !done.has(threadId) || kept.has(threadId);
        if (open) return { threadId, open };
        firstDone ??= threadId;
      }
    }
    return firstDone === null ? null : { threadId: firstDone, open: false };
  };

  const reopenBranch = async (threadId: string) => {
    if (store.reopen([threadId])) changed();
    const reopened = await decide(
      () => membersAbove(threadId),
      (above) => store.reopen(above),
      Infinity,
    );
    if (reopened) changed();
  };

  // The bot's first conversation under this one in its tree, or at the top.
  const firstUnder = async (botId: string, parentThreadId: string | null) => {
    for (const page of pages(store.get(botId).threads.map((member) => member.threadId))) {
      const branches = await branchesOf([...(await shownRows(page)).keys()]);
      const first = page.find(
        (id) => branches.has(id) && (branches.get(id)?.threadIds[1] ?? null) === parentThreadId,
      );
      if (first !== undefined) return first;
    }
    return null;
  };

  // Puts conversations beside another one of the same bot, under its parent in
  // the bot's tree when the window showed that level, or inside another one: all
  // of it, or nothing.
  const moveThreads = ({ botId, sources, target, levelShown }: MoveThreadsInput) => {
    const { placement } = target;
    const beside = placement === "inside" ? null : { threadId: target.threadId, placement };
    const places = [...sources, target];
    const parentOf = (place: SeenRow) => place.branch[1]?.threadId ?? null;
    const parentThreadId = beside === null ? target.threadId : parentOf(target);
    const threadIds = sources.map((source) => source.threadId);
    const titleOf = (row: ThreadRow) => row.title ?? row.titleFallback ?? row.id;
    const requireSeen = (isSeen: (place: SeenRow) => boolean) => {
      if (!places.every(isSeen)) throw new BotsError("conflict", agentText.treeChanged);
    };
    return decide(
      () => drawnStandingOf([...threadIds, target.threadId]),
      async (standing) => {
        const row = (threadId: string) => standing.rows.get(threadId)!;
        requireSeen(
          (place) =>
            isDrawnAsSeen(standing, botId, place) &&
            // bb lets an archived conversation go under another one.
            (row(place.threadId).archivedAt === null || (beside === null && place !== target)),
        );
        const isLevelShown = places.every(
          ({ branch }) =>
            branch.length === 1 ||
            isDrawnDone(standing, branch.slice(1)) === isDrawnDone(standing, branch),
        );
        if (beside !== null && levelShown !== isLevelShown)
          throw new BotsError("conflict", agentText.treeChanged);
        if (beside !== null) store.orderAfterMove(botId, threadIds, beside);
        const moves = sources.filter(
          (source) => (beside === null || levelShown) && parentOf(source) !== parentThreadId,
        );
        const outside = moves.find((source) => source.parentThreadId !== parentOf(source));
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
          if (beside !== null) {
            requireSeen(({ branch }) => isPlaceAsSeen(botId, branch[0]!));
            store.moveThreads(botId, threadIds, beside);
          }
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

  const moveToTop = ({ botId, thread }: MoveToTopInput) =>
    decide(
      async () => ({
        standing: await drawnStandingOf([thread.threadId]),
        first: await firstUnder(botId, thread.branch[1]?.threadId ?? null),
      }),
      ({ standing, first }) => {
        if (
          !isDrawnAsSeen(standing, botId, thread) ||
          standing.rows.get(thread.threadId)!.archivedAt !== null
        )
          throw new BotsError("conflict", agentText.treeChanged);
        if (first === null || first === thread.threadId) return;
        store.moveThreads(botId, [thread.threadId], { threadId: first, placement: "before" });
      },
    );

  // The end of each bot's latest move, its undoing included; the next one waits for it.
  const moveEnds = new Map<string, Promise<void>>();
  const moveInTurn = async (botId: string, act: () => Promise<void>) => {
    const move = (moveEnds.get(botId) ?? Promise.resolve()).then(act);
    const end = move.catch(() => undefined);
    moveEnds.set(botId, end);
    await end;
    if (moveEnds.get(botId) === end) moveEnds.delete(botId);
    await move;
    changed();
    return { ok: true as const };
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

  type EventRow = Awaited<ReturnType<typeof bb.sdk.threads.events.list>>[number];
  const isTooLarge = (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "event_data_too_large";

  // A conversation's events of these types, newest first. bb refuses a page whose
  // events are together over 8 MiB (a request carries its whole text), so the same
  // page is asked for shorter.
  async function* eventsOf(
    threadId: string,
    types: readonly [EventRow["type"], ...EventRow["type"][]],
  ): AsyncGenerator<EventRow, void> {
    let beforeSeq: string | undefined;
    for (let limit = EVENTS_MAX; ;) {
      let page: EventRow[];
      try {
        page = await bb.sdk.threads.events.list({
          threadId,
          types,
          order: "desc",
          limit: String(limit),
          beforeSeq,
        });
      } catch (error) {
        if (!isTooLarge(error) || limit === 1) throw error;
        limit = Math.ceil(limit / 2);
        continue;
      }
      yield* page;
      if (page.length < limit) return;
      beforeSeq = String(page.at(-1)!.seq);
      limit = Math.min(EVENTS_MAX, limit * 2);
    }
  }

  // A turn of the conversation itself: the provider reports the ones its tool
  // calls run inside it as turns too.
  const isOwnTurnStart = (row: EventRow) =>
    row.type === "turn/started" && row.data.parentToolCallId === undefined;

  // The turn now running in a conversation, when the owner started it: the
  // latest turn the provider confirmed (turn/started) and the request bb
  // recorded just before it (client/turn/requested, not rejected). bb records
  // a request only after every dispatch hook and wait let it through, and a
  // message steered into a running turn is recorded after its start, so it
  // never counts as a new turn.
  const ownerTurnOf = async (threadId: string): Promise<number | null> => {
    let startedAt: number | null = null;
    const rejected = new Set<string>();
    for await (const row of eventsOf(threadId, [
      "turn/started",
      "client/turn/requested",
      "client/turn/rejected",
    ])) {
      if (isOwnTurnStart(row)) startedAt ??= row.seq;
      if (row.type === "client/turn/rejected") rejected.add(row.data.requestId);
      if (row.type !== "client/turn/requested" || startedAt === null) continue;
      if (rejected.has(row.data.requestId)) continue;
      return row.data.initiator === "user" && row.data.senderThreadId === null ? startedAt : null;
    }
    return null;
  };

  // When the provider last took input into a conversation after `since`: a new
  // turn, or a message steered into the running one. What bb's own notice about
  // a sub-thread started does not count, nor does a retry of that turn.
  const lastInputAfter = async (threadId: string, since: number): Promise<number | null> => {
    const events = eventsOf(threadId, [
      "turn/started",
      "turn/input/accepted",
      "client/turn/requested",
      "client/turn/rejected",
    ]);
    const rows: EventRow[] = [];
    const rowAt = async (index: number) => {
      if (index === rows.length) {
        const older = await events.next();
        if (!older.done) rows.push(older.value);
      }
      return rows[index];
    };
    const requestOf = async (fits: (requestId: string, row: EventRow) => boolean) => {
      for (let index = 0; ; index += 1) {
        const row = await rowAt(index);
        if (row === undefined) return undefined;
        if (row.type === "client/turn/requested" && fits(row.data.requestId, row)) return row.data;
      }
    };
    for (let index = 0; ; index += 1) {
      const row = await rowAt(index);
      if (row === undefined || row.createdAt <= since) return null;
      let request: Awaited<ReturnType<typeof requestOf>>;
      if (row.type === "turn/input/accepted") {
        request = await requestOf((requestId) => requestId === row.data.clientRequestId);
      } else if (isOwnTurnStart(row)) {
        const hasOwnInput = rows.some(
          (other) =>
            other.type === "turn/input/accepted" && isDeepStrictEqual(other.scope, row.scope),
        );
        if (hasOwnInput) continue;
        const isTaken = (requestId: string) =>
          rows.some(
            (other) =>
              (other.type === "turn/input/accepted" && other.data.clientRequestId === requestId) ||
              (other.type === "client/turn/rejected" && other.data.requestId === requestId),
          );
        request = await requestOf((requestId, asked) => asked.seq < row.seq && !isTaken(requestId));
      } else continue;
      const origin = request?.retryOfRequestId;
      if (origin !== undefined) request = await requestOf((requestId) => requestId === origin);
      // Messages sent together are one request with the kind of the first.
      const isNotice =
        request?.inputGroups === undefined && OWNERSHIP_NOTICES.has(request?.systemMessageKind);
      if (!isNotice) return row.createdAt;
    }
  };

  // Done is cleared by input the provider actually took after the mark, checked
  // when the conversation settles. bb marks a thread active while it still
  // prepares the request, and the provider may refuse it. Done covers the branch,
  // so work in a sub-thread clears the marks above it too.
  const reopenIfTurnStarted = async (threadId: string) => {
    const reopened = await decide(
      async () => {
        const done = (await membersAbove(threadId)).flatMap((id) => {
          const at = store.completedAt(id);
          return at === null ? [] : [{ id, at }];
        });
        if (done.length === 0) return [];
        const inputAt = await lastInputAfter(threadId, Math.min(...done.map(({ at }) => at)));
        return done.filter(({ at }) => inputAt !== null && inputAt > at).map(({ id }) => id);
      },
      (threadIds) => store.reopen(threadIds),
      Infinity,
    );
    if (reopened) changed();
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
    const bound = await decide(
      () => membersAbove(sourceThreadId),
      (branch) => store.bindContinuation(thread.id, sourceThreadId, branch, false),
      Infinity,
    );
    if (bound) changed();
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
    if (showForWork(thread.id)) changed();
  });
  bb.events.on("interaction.pending", async ({ thread }) => {
    const updated = store.transaction(() => {
      const shown = showForWork(thread.id);
      const reopened = store.reopen([thread.id]);
      return shown || reopened;
    });
    if (updated) changed();
    await reopenBranch(thread.id);
  });
  bb.events.on("thread.failed", ({ thread }) => reopenBranch(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => {
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

  // The same rule as the Assign to bot menu, enforced where it is written: only
  // an existing, top-level, unarchived conversation joins a bot. Every refusal
  // comes before the write: the sidebar takes a refusal as proof that a dropped
  // conversation did not move.
  const assign = ({ threadId, botId, place }: AssignInput, seen: Assignment | null, actor: Actor) =>
    decide(
      async () =>
        botId === null ? null : await bb.sdk.threads.get({ threadId }).catch(() => null),
      (thread) => {
        if (!isDeepStrictEqual(store.assignmentOf(threadId), seen))
          throw new BotsError("conflict", agentText.reassigned);
        if (botId !== null) {
          store.get(botId);
          if (thread === null || thread.deletedAt !== null)
            throw new BotsError("not_found", agentText.noSuchThread);
          if (thread.parentThreadId !== null || thread.archivedAt !== null)
            throw new BotsError("invalid", agentText.notAssignable);
        }
        const startedFromBot = store.transaction(() => {
          store.recordAssignmentDecision(threadId);
          if (botId === null) {
            store.unbind(threadId);
            if (seen !== null) {
              store.record({
                botId: seen.botId,
                kind: "thread.unassigned",
                actor,
                detail: { threadId },
              });
            }
            return false;
          }
          const startedFromBot = store.threadInfo(threadId)?.startedFromBot ?? false;
          store.bind(threadId, botId, { startedFromBot, place: place ?? "last" });
          store.record({ botId, kind: "thread.assigned", actor, detail: { threadId } });
          return startedFromBot;
        });
        changed();
        return { botId, startedFromBot };
      },
    );

  const setCompleted = (
    threadId: string,
    completed: boolean,
    requireSeen: (standing: Standing) => void,
  ) => {
    const asked = store.generation;
    return decide(
      async () => ({
        below: completed ? ((await treesBelow([threadId])).get(threadId) ?? []) : [],
        standing: await standingOf([threadId]),
      }),
      ({ below, standing }) => {
        requireSeen(standing);
        const { rows, branches } = standing;
        if (completed) {
          const waits = [...below, ...rows.values()].some(
            (thread) =>
              thread.hasPendingInteraction ||
              thread.status === "error" ||
              thread.queuedWork === "failed",
          );
          if (waits) throw new BotsError("conflict", agentText.needsOwner);
          if (store.reopenedSince(threadId, asked))
            throw new BotsError("conflict", agentText.broughtBack);
          store.complete(threadId);
        } else {
          store.reopen(branches.get(threadId)?.threadIds ?? []);
        }
        changed();
        return { ok: true as const };
      },
    );
  };

  // A failed create keeps its token: the thread may exist anyway, and its first
  // configure still claims it. Old tokens expire in addPendingStart.
  const startWith = async (
    token: string,
    create: (token: string) => Promise<{ id: string }>,
    sourceThreadId: string | null = null,
  ) => {
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
    "bots.v1.assign": (input, ctx) =>
      assign(input, store.assignmentOf(input.threadId), actorOf(ctx)),
    "bots.v1.setCompleted": ({ threadId, completed }) => {
      const seen = store.assignmentOf(threadId);
      if (seen === null) throw new BotsError("not_found", agentText.notABot);
      return setCompleted(threadId, completed, () => {
        if (!isDeepStrictEqual(store.assignmentOf(threadId), seen))
          throw new BotsError("conflict", agentText.reassigned);
      });
    },
    "bots.v1.startThread": async ({ botId, request }) => {
      const picked = Object.fromEntries(
        SPAWN_FIELDS.filter((field) => field in request).map((field) => [field, request[field]]),
      );
      // The composer's request is validated by the server's own spawn schema.
      const spawnArgs = picked as unknown as Parameters<typeof bb.sdk.threads.spawn>[0];
      const token = await decide(
        () => mainThread(botId),
        (main) => store.addPendingStart(botId, main === null ? [] : [main.threadId]),
      );
      const result = await startWith(token, (startToken) =>
        bb.sdk.threads.spawn({ ...spawnArgs, pluginMetadata: { [START_TOKEN]: startToken } }),
      );
      store.saveDefaults(botId, defaultsFrom(request));
      return result;
    },
    "bots.v1.events": ({ botId, limit }) => {
      store.get(botId);
      return { events: store.events(botId, limit ?? 50) };
    },
    "bots.v2.main": ({ botId }) =>
      decide(
        () => mainThread(botId),
        (main) => ({ threadId: main?.open ? main.threadId : null }),
      ),
    "bots.v2.assign": ({ seen, ...input }, ctx) => assign(input, seen, actorOf(ctx)),
    "bots.v2.setCompleted": ({ botId, thread, completed }) =>
      setCompleted(thread.threadId, completed, (standing) => {
        // A sub-thread without its own place in the bot carries no mark.
        if (store.botOfThread(thread.threadId) !== botId || !isAsSeen(standing, botId, thread))
          throw new BotsError("conflict", agentText.treeChanged);
      }),
    "bots.v2.moveThreads": (input) => moveInTurn(input.botId, () => moveThreads(input)),
    "bots.v2.moveToTop": (input) => moveInTurn(input.botId, () => moveToTop(input)),
    "bots.v2.continueInBot": async ({ threadId, seen }) => {
      const token = await decide(
        () => membersAbove(threadId),
        (branch) => {
          if (!isDeepStrictEqual(store.assignmentOf(threadId), seen))
            throw new BotsError("conflict", agentText.reassigned);
          return store.addPendingStart(seen.botId, branch);
        },
      );
      return startWith(
        token,
        (startToken) =>
          bb.sdk.threads.fork({
            sourceThreadId: threadId,
            pluginMetadata: { [START_TOKEN]: startToken },
          }),
        threadId,
      );
    },
    "bots.v2.reorderBots": ({ botIds, seen }) => {
      store.reorderBots(botIds, seen);
      changed();
      return { ok: true as const };
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
