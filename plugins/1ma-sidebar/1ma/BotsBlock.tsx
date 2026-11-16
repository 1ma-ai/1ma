import { useCallback, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_resolveThreadStatus as resolveThreadStatus,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  experimental_useSidebarNavigation as useSidebarNavigation,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import {
  SIDEBAR_GROUP_TEXT_CLASS,
  SIDEBAR_ROW_BASE_CLASS,
} from "@/components/ui/sidebar-row-classes";
import { ProjectThreadTree } from "../app/list/ProjectRow.js";
import { TopLevelSidebarSection } from "../app/list/TopLevelSidebarSection.js";
import type { ThreadComparator } from "../app/model/project-thread-groups.js";
import { sidebarThreadLifecyclesAtom } from "../app/preferences/atoms.js";
import { BOTS_PLUGIN_ID, botsRpc, type SidebarBot } from "./bots-rpc.js";
import { threadsShownUnderBots } from "./bot-threads.js";
import { strings } from "./strings.js";
import { useSidebarBots } from "./use-bots.js";

interface BotsBlockProps {
  selectedThreadId?: string;
  onProjectSelect?: () => void;
}

export function BotsBlock({ selectedThreadId, onProjectSelect }: BotsBlockProps) {
  const state = useSidebarBots();
  const navigation = useSidebarNavigation();
  const [collapsed, setCollapsed] = useState(false);
  const { panelId } = state;
  if (state.status === "off" || panelId === null) return null;
  const openBotsPage = () => navigation.actions.activate(panelId, { target: "current" });
  const visible = state.bots.filter((bot) => !bot.hidden);
  return (
    <div className="pb-4" data-1ma-bots-block="">
      <TopLevelSidebarSection
        label={strings.title}
        sectionId="1ma-bots"
        collapseControl={{
          isCollapsed: collapsed,
          onToggleCollapsed: () => setCollapsed(!collapsed),
        }}
        actions={
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            aria-label={strings.newBot}
            onClick={openBotsPage}
          >
            <Icon name="Plus" className="size-3.5" />
          </Button>
        }
      >
        {state.status === "unavailable" ? (
          <p className={`px-2 py-1 text-xs ${SIDEBAR_GROUP_TEXT_CLASS}`}>{strings.unavailable}</p>
        ) : (
          visible.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              selectedThreadId={selectedThreadId}
              onProjectSelect={onProjectSelect}
            />
          ))
        )}
      </TopLevelSidebarSection>
    </div>
  );
}

const RUNNING: ReadonlySet<string> = new Set(["starting", "active", "stopping"]);

function useBotThreads(bot: SidebarBot) {
  const lifecycles = useAtomValue(sidebarThreadLifecyclesAtom);
  const { threads } = useSidebarThreads({ experimental_lifecycles: lifecycles });
  return useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const order = new Map(bot.threads.map((thread, index) => [thread.threadId, index]));
    const subtree = (roots: readonly string[]) => {
      const shown = threadsShownUnderBots(
        [
          {
            ...bot,
            hidden: false,
            threads: roots.map((threadId) => ({
              threadId,
              startedFromBot: true,
              completed: false,
            })),
          },
        ],
        threads,
      );
      return threads.filter((thread) => shown.has(thread.id));
    };
    // A done conversation that is working again shows with the open ones; the
    // done mark itself is cleared by 1ma-bots once the turn has really run.
    const isOpen = (item: SidebarBot["threads"][number]) =>
      !item.completed || RUNNING.has(byId.get(item.threadId)?.status ?? "idle");
    const open = bot.threads.filter(isOpen).map((thread) => thread.threadId);
    const done = bot.threads.filter((thread) => !isOpen(thread)).map((thread) => thread.threadId);
    const compare: ThreadComparator = (left: PluginSidebarThread, right: PluginSidebarThread) =>
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.id) ?? Number.MAX_SAFE_INTEGER) || right.createdAt - left.createdAt;
    return {
      first: open.map((id) => byId.get(id)).find((thread) => thread !== undefined) ?? null,
      open: subtree(open),
      done: subtree(done),
      doneCount: done.filter((id) => byId.has(id)).length,
      compare,
    };
  }, [bot, threads]);
}

function BotRow({
  bot,
  selectedThreadId,
  onProjectSelect,
}: {
  bot: SidebarBot;
  selectedThreadId?: string;
  onProjectSelect?: () => void;
}) {
  const navigate = useBbNavigate();
  const { first, open, done, doneCount, compare } = useBotThreads(bot);
  const [expanded, setExpanded] = useState(() =>
    open.some((thread) => thread.id === selectedThreadId),
  );
  const [showDone, setShowDone] = useState(false);
  const [composing, setComposing] = useState(false);
  const [collapsedThreadIds, setCollapsedThreadIds] = useState<Set<string>>(() => new Set());
  const [collapsedEnvironmentIds, setCollapsedEnvironmentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const toggle = useCallback(
    (setter: typeof setCollapsedThreadIds) => (id: string) =>
      setter((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const others = open.filter((thread) => thread.id !== first?.id);
  const status = resolveThreadStatus({
    thread: first,
    hiddenThreads: others,
    hasUnsubmittedDraft: false,
    rowStatus: null,
  });
  const topLevel = open.filter((thread) => bot.threads.some((item) => item.threadId === thread.id));
  return (
    <div className="flex flex-col" data-bot-id={bot.id}>
      <div className={`${SIDEBAR_ROW_BASE_CLASS} group/bot min-h-10 pl-2 hover:bg-sidebar-accent`}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
          onClick={() => {
            if (first) {
              navigate.toThread(first.id);
              onProjectSelect?.();
            } else setComposing(true);
          }}
        >
          <span className="relative shrink-0">
            <img src={bot.avatar} width={28} height={28} alt="" />
            <span className="absolute -right-1 -bottom-1">
              <ThreadStatusGlyph indicator={status.indicator} rowStatus={status.rowStatus} />
            </span>
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-sidebar-foreground">{bot.name}</span>
            {bot.role ? (
              <span className={`block truncate text-xs ${SIDEBAR_GROUP_TEXT_CLASS}`}>
                {bot.role}
              </span>
            ) : null}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover/bot:opacity-100 focus-visible:opacity-100"
          aria-label={strings.newConversation(bot.name)}
          onClick={() => setComposing(true)}
        >
          <Icon name="Plus" className="size-3.5" />
        </Button>
        {topLevel.length > 0 || doneCount > 0 ? (
          <button
            type="button"
            className={`flex items-center gap-0.5 px-1 text-xs ${SIDEBAR_GROUP_TEXT_CLASS}`}
            aria-expanded={expanded}
            aria-label={strings.toggleConversations(bot.name, topLevel.length)}
            onClick={() => setExpanded(!expanded)}
          >
            {topLevel.length}
            <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div className="pl-3">
          <ProjectThreadTree
            threadListState={{ status: "ready", threads: open }}
            compareThreads={compare}
            selectedThreadId={selectedThreadId}
            collapsedThreadIds={collapsedThreadIds}
            collapsedEnvironmentIds={collapsedEnvironmentIds}
            onProjectSelect={onProjectSelect}
            onToggleThreadCollapsed={toggle(setCollapsedThreadIds)}
            onToggleEnvironmentCollapsed={toggle(setCollapsedEnvironmentIds)}
          />
          {doneCount > 0 ? (
            <button
              type="button"
              className={`flex items-center gap-1 py-1 pl-2 text-xs ${SIDEBAR_GROUP_TEXT_CLASS}`}
              aria-expanded={showDone}
              onClick={() => setShowDone(!showDone)}
            >
              <Icon name={showDone ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
              {strings.done(doneCount)}
            </button>
          ) : null}
          {showDone ? (
            <ProjectThreadTree
              threadListState={{ status: "ready", threads: done }}
              compareThreads={compare}
              selectedThreadId={selectedThreadId}
              collapsedThreadIds={collapsedThreadIds}
              collapsedEnvironmentIds={collapsedEnvironmentIds}
              onProjectSelect={onProjectSelect}
              onToggleThreadCollapsed={toggle(setCollapsedThreadIds)}
              onToggleEnvironmentCollapsed={toggle(setCollapsedEnvironmentIds)}
            />
          ) : null}
        </div>
      ) : null}
      <NewBotConversation bot={bot} open={composing} onOpenChange={setComposing} />
    </div>
  );
}

function NewBotConversation({
  bot,
  open,
  onOpenChange,
}: {
  bot: SidebarBot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useBbNavigate();
  const start = useRpcMutation({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.startThread",
  });
  const detail = useRpcQuery({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.get",
    input: { botId: bot.id },
    enabled: open,
  });
  const defaults = detail.data?.defaults ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{strings.newConversation(bot.name)}</DialogTitle>
        {open && !detail.isLoading ? (
          <div className="h-80">
            <NewThreadComposer
              draftKey={`1ma-bots:${bot.id}`}
              defaultProjectId={defaults?.projectId ?? undefined}
              defaultProviderId={defaults?.providerId}
              defaultModel={defaults?.model}
              placeholder={strings.composerPlaceholder(bot.name)}
              onSubmit={async (request) => {
                const { threadId } = await start.mutate({ botId: bot.id, request: { ...request } });
                onOpenChange(false);
                navigate.toThread(threadId);
              }}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
