import {
  experimental_DetailRow as DetailRow,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
  type ExperimentalThreadInfoProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { strings } from "../../strings.js";
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
