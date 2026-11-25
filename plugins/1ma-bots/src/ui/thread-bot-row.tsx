import { useState } from "react";
import {
  experimental_DetailRow as DetailRow,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
  type ExperimentalThreadInfoProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { strings } from "../../strings.js";
import { botsRpc, type BotSummary } from "../contract.js";
import { BotAvatar } from "./bot-pages.js";

function InstructionPreview({ bot }: { bot: BotSummary }) {
  const [open, setOpen] = useState(false);
  const instructions = useRpcQuery({
    contract: botsRpc,
    method: "bots.v1.instructions",
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
          {instructions.error ? strings.unavailable : (instructions.data?.text ?? strings.loading)}
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
  const member = useRpcKeyedQuery({
    contract: botsRpc,
    method: "bots.v1.forThreads",
    keys: [threadId],
  }).data?.[threadId];
  const bots = list.data?.bots ?? [];
  if (bots.length === 0 || member === undefined) return null;
  const current = bots.find((bot) => bot.id === member?.botId);
  return (
    <DetailRow label={strings.threadBot.title} icon="Bot" align="start">
      <div className="flex min-w-0 flex-col items-start gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-auto px-1 py-0.5">
              {current ? (
                <span className="flex items-center gap-1.5">
                  <BotAvatar appearance={current.appearance} size={16} />
                  {current.name}
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
                disabled={bot.id === current?.id}
                onSelect={() => void assign.mutate({ threadId, botId: bot.id })}
              >
                <BotAvatar appearance={bot.appearance} size={16} />
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
        {current && <InstructionPreview key={current.id} bot={current} />}
        {current && !member?.startedFromBot ? (
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
