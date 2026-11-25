import { useState } from "react";
import {
  experimental_DetailRow as DetailRow,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
  type ExperimentalThreadInfoProps,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { botInstructions } from "../instructions.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { strings } from "../../strings.js";
import { branchOf } from "../branch.js";
import { botsRpc, type BotSummary, type BotThread } from "../contract.js";

export function findBot(
  bots: readonly BotSummary[],
  threadId: string,
): { bot: BotSummary; thread: BotThread } | null {
  for (const bot of bots) {
    const thread = bot.threads.find((item) => item.threadId === threadId);
    if (thread) return { bot, thread };
  }
  return null;
}

type TreeRow = Pick<PluginSidebarThread, "id" | "parentThreadId" | "isArchived" | "isHidden">;

function isShown(threads: readonly TreeRow[], threadId: string): boolean {
  const row = threads.find((thread) => thread.id === threadId);
  return row !== undefined && !row.isArchived && !row.isHidden;
}

// The conversation and the ones it is drawn under in its bot's tree.
function branchIn(bots: readonly BotSummary[], threads: readonly TreeRow[], threadId: string) {
  const chain: string[] = [];
  for (let id: string | null = threadId; id !== null && !chain.includes(id);) {
    chain.push(id);
    id = threads.find((thread) => thread.id === id)?.parentThreadId ?? null;
  }
  const branch = branchOf(
    chain,
    (id) => findBot(bots, id)?.bot.id ?? null,
    (id) => isShown(threads, id),
  );
  return branch?.threadIds ?? [];
}

// Done covers the branch, so a sub-thread is done with the conversations above
// it in its bot's tree.
export function isDone(
  bots: readonly BotSummary[],
  threads: readonly TreeRow[],
  threadId: string,
): boolean {
  return branchIn(bots, threads, threadId).some((id) => findBot(bots, id)?.thread.completed);
}

// The bot's own conversations shown under the same parent, in its order.
export function shownSiblings(
  bot: BotSummary,
  bots: readonly BotSummary[],
  threads: readonly TreeRow[],
  threadId: string,
): string[] {
  const parentOf = (id: string) => branchIn(bots, threads, id)[1];
  const parentId = parentOf(threadId);
  return bot.threads
    .map((member) => member.threadId)
    .filter((id) => isShown(threads, id) && parentOf(id) === parentId);
}

function InstructionPreview({ bot, bots }: { bot: BotSummary; bots: readonly BotSummary[] }) {
  const [open, setOpen] = useState(false);
  const detail = useRpcQuery({
    contract: botsRpc,
    method: "bots.v1.get",
    input: { botId: bot.id },
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="link" size="sm" className="h-auto p-0">
          {strings.threadBot.preview}
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="sm:max-w-2xl">
        <DialogTitle>{strings.threadBot.instructionsFrom(bot.name)}</DialogTitle>
        <div className="max-h-[60dvh] overflow-y-auto whitespace-pre-wrap break-words text-sm">
          {detail.error
            ? strings.unavailable
            : detail.data
              ? botInstructions(detail.data, bots)
              : strings.loading}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ThreadBotRow({ threadId }: ExperimentalThreadInfoProps) {
  const navigate = useBbNavigate();
  const list = useRpcQuery({ contract: botsRpc, method: "bots.v1.list", input: {} });
  const assign = useRpcMutation({ contract: botsRpc, method: "bots.v1.assign" });
  const continueInBot = useRpcMutation({ contract: botsRpc, method: "bots.v1.continueInBot" });
  const bots = list.data?.bots ?? [];
  if (bots.length === 0) return null;
  const current = findBot(bots, threadId);
  return (
    <DetailRow label={strings.threadBot.title} icon="Bot" align="start">
      <div className="flex min-w-0 flex-col items-start gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-auto px-1 py-0.5">
              {current ? (
                <span className="flex items-center gap-1.5">
                  <img src={current.bot.avatar} width={16} height={16} alt="" />
                  {current.bot.name}
                </span>
              ) : (
                <span className="text-muted-foreground">{strings.threadBot.choose}</span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {bots.map((bot) => (
              <DropdownMenuItem
                key={bot.id}
                disabled={bot.id === current?.bot.id}
                onSelect={() => void assign.mutate({ threadId, botId: bot.id })}
              >
                <img src={bot.avatar} width={16} height={16} alt="" />
                {bot.name}
              </DropdownMenuItem>
            ))}
            {current ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void assign.mutate({ threadId, botId: null })}>
                  {strings.threadBot.none}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {current && <InstructionPreview key={current.bot.id} bot={current.bot} bots={bots} />}
        {current && !current.thread.startedFromBot ? (
          <>
            <p className="text-xs text-muted-foreground">{strings.threadBot.notStartedFromBot}</p>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              disabled={continueInBot.isPending}
              onClick={() =>
                void continueInBot
                  .mutate({ threadId })
                  .then(({ threadId: next }) => navigate.toThread(next))
              }
            >
              {strings.threadBot.continueInBot}
            </Button>
          </>
        ) : null}
      </div>
    </DetailRow>
  );
}
