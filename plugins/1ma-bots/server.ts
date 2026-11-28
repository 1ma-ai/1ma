import { setImmediate } from "node:timers/promises";
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
  RELEASED_READS,
  tags,
  type Actor,
  type Assignment,
  type AssignInput,
  type BotDetail,
  type BotSummary,
  type ChatDefaults,
  type CreateBotInput,
  type Cursor,
  type MoveThreadsInput,
  type MoveToTopInput,
  type SeenRow,
  type SeenThread,
  type UpdateBotInput,
} from "./src/contract.js";
import { branchOf, keepsOpen } from "./src/branch.js";
import { BotsError } from "./src/errors.js";
import { botInstructions } from "./src/instructions.js";
import {
  acceptDelivery,
  cancelLetters,
  dropSpend,
  letterTokens,
  resolveBot,
  routeLetter,
  waitingLetters,
  type LetterLimits,
  type WaitingLetter,
} from "./src/letters.js";
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
  RETENTION_BATCH,
  RETENTION_BUDGET_MS,
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
// bb's limit of events in one call.
const EVENTS_MAX = 100;
// bb's own notice that a sub-thread was attached to a conversation or detached.
const OWNERSHIP_NOTICES: ReadonlySet<string | undefined> = new Set([
  "ownership-assigned",
  "ownership-removed",
  "ownership-batch",
]);
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
  let releasedWatches = 0;
  const store = new BotStore(db, now, INSTALLATION_OWNER, (tags) => {
    if (releasedWatches > 0) bb.rpc.experimental_invalidateAll();
    else bb.rpc.experimental_invalidate(tags);
  });

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
  // changed since the decision was asked for. A request is refused when changes
  // do not stop; an event has nobody to refuse.
  const decide = async <T, R>(
    read: (reads: Reads) => Promise<T>,
    act: (value: T, changes: readonly string[]) => R | Promise<R>,
    readings = DECISION_READS_MAX,
  ): Promise<R> => {
    const changes = store.watch();
    try {
      for (let reading = 1; reading <= readings; reading += 1) {
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
    "experimental_thread.read",
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
  const membersAbove = async (threadId: string, reads: Reads) =>
    ((await branchesOf([threadId], reads)).get(threadId)?.threadIds ?? []).filter(
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

  // Which of these conversations something in their branch keeps open.
  const keptOpen = async (
    threadIds: readonly string[],
    rows: ReadonlyMap<string, ThreadRow>,
    reads: Reads,
  ): Promise<ReadonlySet<string>> => {
    const below = await treesBelow(threadIds, reads);
    return new Set(
      threadIds.filter((threadId) =>
        [rows.get(threadId), ...(below.get(threadId) ?? [])].some(
          (row) => row !== undefined && keepsOpen(row),
        ),
      ),
    );
  };

  // Where conversations stand in bb and in their bot's tree.
  const standingOf = async (threadIds: readonly string[], reads: Reads) => ({
    branches: await branchesOf(threadIds, reads),
    rows: await rowsOf(threadIds, {}),
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
  const drawnStandingOf = async (threadIds: readonly string[], reads: Reads) => {
    const standing = await standingOf(threadIds, reads);
    const marked = [...standing.branches.values()]
      .flatMap((branch) => branch?.threadIds ?? [])
      .filter(isMarked);
    const ids = [...new Set(marked)];
    return { ...standing, kept: await keptOpen(ids, await shownRows(ids, reads), reads) };
  };
  type DrawnStanding = Awaited<ReturnType<typeof drawnStandingOf>>;

  const isDrawnDone = ({ kept }: DrawnStanding, branch: SeenRow["branch"]) =>
    branch.some(({ threadId }) => isMarked(threadId) && !kept.has(threadId));

  const isDrawnAsSeen = (standing: DrawnStanding, botId: string, seen: SeenRow) =>
    isAsSeen(standing, botId, seen) && isDrawnDone(standing, seen.branch) === seen.shownDone;

  // Each bot's first open conversation at the top of its tree, in its order; the
  // first done one when all are done.
  const mainThreads = async (botIds: readonly string[], reads: Reads = new Set()) => {
    for (const botId of botIds) reads.add(tags.conversations(botId));
    const mains = new Map<string, { threadId: string; open: boolean }>();
    let unread = botIds.map((botId) => ({ botId, after: null as Cursor | null }));
    while (unread.length > 0) {
      const limit = Math.max(1, Math.floor(THREAD_IDS_MAX / unread.length));
      const read = unread.map(({ botId, after }) => {
        // In another order by now: read from its beginning.
        const isCurrent = after === null || after.order === store.orderRevision(botId);
        if (!isCurrent) mains.delete(botId);
        const page = { from: "first" as const, after: isCurrent ? after : null, limit };
        return { botId, ...store.threads(botId, page) };
      });
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
      const kept = await keptOpen([...done], rows, reads);
      const isOpen = (threadId: string) => !done.has(threadId) || kept.has(threadId);
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
    await decide(
      (reads) => membersAbove(threadId, reads),
      (above) => store.reopen(above),
      Infinity,
    );
  };

  // The bot's first conversation under this one in its tree, or at the top.
  const firstUnder = async (botId: string, parentThreadId: string | null, reads: Reads) => {
    reads.add(tags.conversations(botId));
    for (let after: Cursor | null = null; ;) {
      // In another order by now: read from its beginning.
      if (after !== null && after.order !== store.orderRevision(botId)) after = null;
      const { threads, next } = store.threads(botId, {
        from: "first",
        after,
        limit: THREAD_IDS_MAX,
      });
      const page = threads.map((member) => member.threadId);
      const branches = await branchesOf([...(await shownRows(page, reads)).keys()], reads);
      const first = page.find(
        (id) => branches.has(id) && (branches.get(id)?.threadIds[1] ?? null) === parentThreadId,
      );
      if (first !== undefined) return first;
      if (next === null) return null;
      after = next;
    }
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
      (reads) => drawnStandingOf([...threadIds, target.threadId], reads),
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
        if (beside !== null) store.requireMovable(botId, threadIds, beside);
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
      async (reads) => ({
        standing: await drawnStandingOf([thread.threadId], reads),
        first: await firstUnder(botId, thread.branch[1]?.threadId ?? null, reads),
      }),
      ({ standing, first }) => {
        store.get(botId);
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
    return { ok: true as const };
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
      const agent = { kind: "agent" as const, id: ctx.threadId };
      let limits: LetterLimits;
      let route: ReturnType<typeof routeLetter>;
      try {
        const toBotId = resolveBot(store, input.to);
        const values = await settings.get();
        limits = {
          chainLetters: positiveCount(CHAIN_LETTERS_DEFAULT).parse(values.chainLetters),
          hourlyLetters: positiveCount(HOURLY_LETTERS_DEFAULT).parse(values.hourlyLetters),
        };
        const ownerTurn = await ownerTurnOf(ctx.threadId);
        const routeTo = (toThreadId: string | null) =>
          routeLetter(
            store,
            {
              fromThreadId: ctx.threadId,
              to: input.to,
              toBotId,
              toThreadId,
              now: now(),
              ownerTurn,
            },
            limits,
          );
        route = input.threadId
          ? routeTo(input.threadId)
          : await decide(
              (reads) => mainThread(toBotId, reads),
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
  const accepted = (args: { threadId: string; texts: readonly string[] }, at = now()) => {
    const tokens = letterTokens(args.texts);
    if (tokens.length === 0) return;
    store.transaction(() => {
      if (!acceptDelivery(store, args.threadId, tokens, false)) return;
      const botId = store.botOfThread(args.threadId);
      if (botId !== null && (store.hiddenAt(botId) ?? at) <= at) showForWork(args.threadId);
    });
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
  type TurnRequest = Extract<EventRow, { type: "client/turn/requested" }>["data"];

  // The turn now running in a conversation, when the owner started it. Only the
  // provider's acceptance (turn/input/accepted, in the scope of the turn it
  // entered) ties a request bb recorded (client/turn/requested) to a turn:
  // turn/started names no request, and a request may wait while the provider
  // starts and ends a turn on its own (ACP reports agent output after a turn as
  // a new one). The first acceptance in a turn names the request that opened
  // it, if bb recorded that request before the turn started; later ones are
  // messages steered into it. A turn with no such acceptance the provider
  // started on its own: it continues the turn before it. A request nothing has
  // accepted yet is not a turn. bb reads a request stored before targets as
  // new-turn and stores no mark of its version, so a history from before
  // acceptances cannot be told from a request still waiting; its turns read as
  // ones the provider started on its own.
  const ownerTurnOf = async (threadId: string): Promise<number | null> => {
    const firstAcceptedIn = new Map<string, string>();
    const recordedLater = new Set<string>();
    let opened: { seq: number; requestId: string } | null = null;
    for await (const row of eventsOf(threadId, [
      "turn/started",
      "turn/input/accepted",
      "client/turn/requested",
    ])) {
      if (row.type === "turn/input/accepted") {
        firstAcceptedIn.set(JSON.stringify(row.scope), row.data.clientRequestId);
      } else if (row.type === "client/turn/requested") {
        if (row.data.requestId === opened?.requestId) {
          return row.data.initiator === "user" && row.data.senderThreadId === null
            ? opened.seq
            : null;
        }
        recordedLater.add(row.data.requestId);
      } else if (opened === null && isOwnTurnStart(row)) {
        const requestId = firstAcceptedIn.get(JSON.stringify(row.scope));
        if (requestId !== undefined && !recordedLater.has(requestId))
          opened = { seq: row.seq, requestId };
      }
    }
    return null;
  };

  // When the provider last took input into a conversation after `since`: a new
  // turn, or a message steered into the running one. Only its acceptance tells:
  // a request still waiting, or a turn the provider started with no request,
  // is no input. What bb's own notice about a sub-thread started does not
  // count, nor does a retry of that turn.
  const lastInputAfter = async (threadId: string, since: number): Promise<number | null> => {
    const events = eventsOf(threadId, ["turn/input/accepted", "client/turn/requested"]);
    const rows: EventRow[] = [];
    const rowAt = async (index: number) => {
      if (index === rows.length) {
        const older = await events.next();
        if (!older.done) rows.push(older.value);
      }
      return rows[index];
    };
    const requestOf = async (fits: (request: TurnRequest) => boolean) => {
      for (let index = 0; ; index += 1) {
        const row = await rowAt(index);
        if (row === undefined) return undefined;
        if (row.type === "client/turn/requested" && fits(row.data)) return row.data;
      }
    };
    for (let index = 0; ; index += 1) {
      const row = await rowAt(index);
      if (row === undefined || row.createdAt <= since) return null;
      if (row.type !== "turn/input/accepted") continue;
      let request: TurnRequest | undefined = await requestOf(
        ({ requestId }) => requestId === row.data.clientRequestId,
      );
      // Messages sent together are one request with the kind of the first, a
      // retry included. A retry sent alone runs the attempt before it again, or
      // asks to continue it once the provider took it, so it is what that
      // attempt is. Every attempt names the first request and its number.
      while (request?.inputGroups === undefined && request?.retryOfRequestId !== undefined) {
        const origin = request.retryOfRequestId;
        const previous = (request.retryAttempt ?? 2) - 1;
        request = await requestOf((asked) =>
          previous === 1
            ? asked.requestId === origin
            : asked.retryOfRequestId === origin && asked.retryAttempt === previous,
        );
      }
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
    await decide(
      async (reads) => {
        const done = (await membersAbove(threadId, reads)).flatMap((id) => {
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
    // Asked again at the write; since when the conversation is the bot's then.
    joinedAt: () => number | null = now,
  ) => {
    const { sourceThreadId } = thread;
    if (
      sourceThreadId === null ||
      store.botOfThread(sourceThreadId) === null ||
      joinedAt() === null ||
      store.hasAssignmentDecision(thread.id) ||
      thread.visibility !== "visible" ||
      (thread.originKind === "fork" && thread.originPluginId === bb.pluginId)
    )
      return;
    await decide(
      (reads) => membersAbove(sourceThreadId, reads),
      (branch) => {
        const at = joinedAt();
        if (at !== null) store.bindContinuation(thread.id, sourceThreadId, branch, false, at);
      },
      Infinity,
    );
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
  bb.events.on("message.cancelled", ({ entry }) =>
    cancelLetters(store, entry.threadId, letterTokens(textsOf(entry.content))),
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

  // When bb took a waiting letter into a turn.
  const takenAt = async ({ threadId, token, createdAt }: WaitingLetter): Promise<number | null> => {
    for (let beforeSeq: string | undefined; ;) {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        order: "desc",
        limit: String(EVENTS_MAX),
        beforeSeq,
      });
      for (const row of rows) {
        if (row.createdAt < createdAt) return null;
        if (row.type !== "client/turn/requested") continue;
        if (letterTokens(textsOf(row.data.input)).includes(token)) return row.createdAt;
      }
      if (rows.length < EVENTS_MAX) return null;
      beforeSeq = String(rows.at(-1)!.seq);
    }
  };

  // bb tells of a letter its queue gave to a turn and of one the owner removed
  // from the queue, but not while the plugin is not running, and of nothing else.
  // The queue leaves out what it is handing over right now, so a letter is gone
  // when it is neither there nor taken for an hour.
  let missingSince = new Map<string, number>();
  const reconcileLetters = async () => {
    let page = waitingLetters(store, "", THREAD_IDS_MAX);
    if (page.length === 0) return;
    const queued = new Set(
      (await bb.sdk.threads.queue.list()).flatMap((row) => letterTokens(textsOf(row.content))),
    );
    const missing = new Map<string, number>();
    for (; page.length > 0; page = waitingLetters(store, page.at(-1)!.token, THREAD_IDS_MAX))
      for (const letter of page) {
        const { token, threadId } = letter;
        if (queued.has(token)) continue;
        if (await isDeleted(threadId)) {
          store.forgetThread(threadId);
          continue;
        }
        const at = await takenAt(letter);
        const since = missingSince.get(token) ?? now();
        if (at !== null) accepted({ threadId, texts: [`<<<letter ${token}`] }, at);
        else if (now() - since >= HOUR_MS) cancelLetters(store, threadId, [token]);
        else missing.set(token, since);
      }
    missingSince = missing;
  };

  const forgetDeleted = async (
    threadIds: readonly string[],
    rows: ReadonlyMap<string, ThreadRow>,
  ) => {
    for (const threadId of threadIds)
      if (!rows.has(threadId) && (await isDeleted(threadId))) store.forgetThread(threadId);
  };

  // Continuations, each after the one it continues: bb lists them in no order a
  // chain of them could be followed in.
  const reconcileContinuations = async (signal?: AbortSignal) => {
    const continuations = new Map<string, ThreadRow & { sourceThreadId: string }>();
    for (let offset = 0; ; offset += THREAD_IDS_MAX) {
      if (signal?.aborted) return;
      const rows = await bb.sdk.threads.list({ archived: false, limit: THREAD_IDS_MAX, offset });
      for (const row of rows)
        if (row.sourceThreadId !== null)
          continuations.set(row.id, { ...row, sourceThreadId: row.sourceThreadId });
      if (rows.length < THREAD_IDS_MAX) break;
    }
    const settled = new Set<string>();
    for (const last of continuations.values()) {
      const chain = [];
      for (
        let row: typeof last | undefined = last;
        row !== undefined && !settled.has(row.id);
        row = continuations.get(row.sourceThreadId)
      ) {
        settled.add(row.id);
        chain.push(row);
      }
      for (const row of chain.toReversed())
        await inheritBot(row, () => {
          const sourceJoinedAt = store.boundAt(row.sourceThreadId);
          return sourceJoinedAt !== null && row.createdAt >= sourceJoinedAt ? row.createdAt : null;
        });
    }
  };

  // What the events above would have done, for those sent while the plugin was
  // not running.
  const reconcile = async (signal?: AbortSignal) => {
    for (const page of memberPages()) {
      if (signal?.aborted) return;
      const rows = await rowsOfMembers(page);
      await forgetDeleted(
        page.map((member) => member.threadId),
        rows,
      );
      const there = page.flatMap((member) => {
        const row = rows.get(member.threadId);
        return row === undefined ? [] : [{ ...member, row }];
      });
      for (const { threadId, botId, assignment, hiddenAt, row } of there)
        if (
          hiddenAt !== null &&
          row.updatedAt > hiddenAt &&
          (await workedSince(threadId, hiddenAt)) &&
          // Hidden again, or moved to another bot, after that work: so it stays.
          store.hiddenAt(botId) === hiddenAt &&
          isDeepStrictEqual(store.assignmentOf(threadId), { botId, assignment })
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
    for (
      let page = store.strayLinks("", THREAD_IDS_MAX);
      page.length > 0;
      page = store.strayLinks(page.at(-1)!, THREAD_IDS_MAX)
    ) {
      if (signal?.aborted) return;
      await forgetDeleted(page, await rowsOf(page, { includeHidden: true }));
    }
    await reconcileLetters();
    await reconcileContinuations(signal);
  };

  const dropHistory = async (before: number) => {
    const until = now() + RETENTION_BUDGET_MS;
    while (store.dropHistory(before, RETENTION_BATCH) && now() < until) await setImmediate();
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
      .int()
      .min(1)
      .catch(0)
      .parse((await settings.get()).retentionDays);
    if (days > 0) await dropHistory(now() - days * DAY_MS);
    dropSpend(store, now());
    await reconcile();
  });

  // The same rule as the Assign to bot menu, enforced where it is written: only
  // an existing, top-level, unarchived conversation joins a bot. Every refusal
  // comes before the write: the sidebar takes a refusal as proof that a dropped
  // conversation did not move.
  const assign = ({ threadId, botId, place }: AssignInput, seen: Assignment | null, actor: Actor) =>
    decide(
      async (reads) => {
        if (botId === null) return null;
        reads.add(tags.thread(threadId));
        return await bb.sdk.threads.get({ threadId }).catch(() => null);
      },
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
          const startedFromBot = store.members([threadId]).get(threadId)?.startedFromBot ?? false;
          store.bind(threadId, botId, { startedFromBot, place: place ?? "last" });
          store.record({ botId, kind: "thread.assigned", actor, detail: { threadId } });
          return startedFromBot;
        });
        return { botId, startedFromBot };
      },
    );

  const setCompleted = (
    threadId: string,
    completed: boolean,
    requireSeen: (standing: Standing) => void,
  ) =>
    decide(
      async (reads) => ({
        below: completed ? ((await treesBelow([threadId], reads)).get(threadId) ?? []) : [],
        standing: await standingOf([threadId], reads),
      }),
      ({ below, standing }, changes) => {
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
          if (changes.includes(broughtBack(threadId)))
            throw new BotsError("conflict", agentText.broughtBack);
          store.complete(threadId);
        } else {
          store.reopen(branches.get(threadId)?.threadIds ?? []);
        }
        return { ok: true as const };
      },
    );

  // A failed create keeps its token: the thread may exist anyway, and its first
  // configure still claims it. Old tokens expire in addPendingStart.
  const startWith = async (
    token: string,
    create: (token: string) => Promise<{ id: string }>,
    sourceThreadId: string | null = null,
  ) => {
    const thread = await create(token);
    store.claimPendingStart(thread.id, token, sourceThreadId);
    return { threadId: thread.id };
  };

  const create = (input: CreateBotInput, actor: Actor) =>
    store.transaction(() => {
      const created = store.create(input);
      store.record({ botId: created.id, kind: "bot.created", actor });
      return created;
    });

  const update = (input: UpdateBotInput, actor: Actor) => {
    if (input.memory !== undefined) checkMemorySize(input.memory);
    return store.transaction(() => {
      const updated = store.update(input);
      store.record({
        botId: input.botId,
        kind: "bot.updated",
        actor,
        detail: { fields: changedFields(input) },
      });
      return updated;
    });
  };

  bb.rpc.register(botsRpc, {
    "bots.v1.list": () => ({ bots: store.released() }),
    "bots.v1.forThread": ({ threadId }) => {
      const botId = store.botOfThread(threadId);
      if (botId === null) return null;
      return { botId, capabilities: store.get(botId).capabilities };
    },
    "bots.v1.get": ({ botId }) => store.releasedDetail(botId),
    "bots.v2.list": () => ({ bots: store.list() }),
    "bots.v2.forThreads": ({ keys }) => {
      const members = store.members(keys);
      return Object.fromEntries(keys.map((key) => [key, members.get(key) ?? null]));
    },
    "bots.v2.threads": ({ botId, from, after, limit }) => {
      store.get(botId);
      return store.threads(botId, {
        from: from ?? "first",
        after: after ?? null,
        limit: limit ?? THREAD_IDS_MAX,
      });
    },
    "bots.v2.get": ({ botId }) => store.get(botId),
    "bots.v2.instructions": ({ botId }) => ({ text: instructionsOf(store.get(botId)) }),
    "bots.v1.create": (input, ctx) => store.releasedDetail(create(input, actorOf(ctx)).id),
    "bots.v1.update": (input, ctx) => store.releasedDetail(update(input, actorOf(ctx)).id),
    "bots.v2.create": (input, ctx) => create(input, actorOf(ctx)),
    "bots.v2.update": (input, ctx) => update(input, actorOf(ctx)),
    "bots.v1.remove": ({ botId }) => {
      store.remove(botId);
      return { ok: true as const };
    },
    "bots.v1.setHidden": ({ botId, hidden }, ctx) => {
      store.setHidden(botId, hidden, actorOf(ctx));
      return { ok: true as const };
    },
    "bots.v2.mains": async ({ keys }) => {
      const mains = await mainThreads(keys);
      return Object.fromEntries(
        keys.map((key) => {
          const main = mains.get(key);
          return [key, main?.open ? main.threadId : null];
        }),
      );
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
        (reads) => mainThread(botId, reads),
        (main) => store.addPendingStart(botId, main === undefined ? [] : [main.threadId]),
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
        (reads) => mainThread(botId, reads),
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
        (reads) => membersAbove(threadId, reads),
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
      return { ok: true as const };
    },
  });

  // Reads without tags are refreshed only together with all the others.
  for (const method of RELEASED_READS)
    bb.rpc.experimental_whileWatched(method, async (_read, signal) => {
      releasedWatches += 1;
      bb.rpc.experimental_invalidateAll();
      await untilAborted(signal);
      releasedWatches -= 1;
    });

  const facts = (bots: readonly BotSummary[]) => {
    const counts = store.conversationCounts();
    return bots.map(({ id, name, role, capabilities, hidden }) => ({
      id,
      name,
      role,
      capabilities,
      hidden,
      conversations: counts.get(id) ?? 0,
    }));
  };
  const lines = (bots: ReturnType<typeof facts>) =>
    bots.map((bot) =>
      [bot.id, bot.name, bot.role, bot.capabilities.join(","), bot.conversations].join("\t"),
    );

  bb.cli.register(
    defineCli({
      name: bb.pluginId,
      summary: "List 1ma bots",
      description:
        "Public facts about 1ma bots: id, name, role, work areas and number of conversations. Bots write to each other with their bot_message tool.",
      commands: {
        list: cliCommand({
          summary: "List all bots",
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          run(input) {
            const bots = facts(store.list());
            return {
              exitCode: 0,
              stdout: input.options.json ? JSON.stringify(bots) : lines(bots).join("\n"),
            };
          },
        }),
        find: cliCommand({
          summary: `Find bots by name, role or work area; at most ${CLI_ROWS_MAX}`,
          positionals: [
            {
              name: "text",
              description: "Text in the name, role or work areas; any when left out",
            },
          ],
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          run(input) {
            const found = matching(store.list(), input.positionals.text ?? "");
            const bots = facts(found.slice(0, CLI_ROWS_MAX));
            if (input.options.json)
              return { exitCode: 0, stdout: JSON.stringify({ bots, total: found.length }) };
            return {
              exitCode: 0,
              stdout: [
                ...lines(bots),
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
