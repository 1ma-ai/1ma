import { useEffect, useState } from "react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteDialog, ConfirmDeleteDialogContent } from "@/components/ui/confirm-delete-dialog";
import { EmptyStatePanel } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { strings } from "../../strings.js";
import { avatarDataUrl } from "../avatar.js";
import { botsRpc, type Appearance, type BotDetail, type BotSummary } from "../contract.js";
import { MEMORY_MAX } from "../limits.js";
import { randomAppearance } from "../appearance.js";

export const PANEL_PATH = "bots";

export type Route =
  | { page: "list" }
  | { page: "new" }
  | { page: "edit"; botId: string }
  | { page: "chat"; botId: string };

export function parseRoute(subPath: string): Route {
  const [first, second] = subPath.split("/").filter((part) => part !== "");
  if (first === undefined) return { page: "list" };
  if (first === "new") return { page: "new" };
  return second === "chat" ? { page: "chat", botId: first } : { page: "edit", botId: first };
}

function BotAvatar({ appearance, size = 32 }: { appearance: Appearance; size?: number }) {
  return <img src={avatarDataUrl(appearance)} width={size} height={size} alt="" className="shrink-0" />;
}

function BotList({ bots }: { bots: readonly BotSummary[] }) {
  const navigate = useBbNavigate();
  const open = (subPath: string) => navigate.toPluginPanel(PANEL_PATH, { subPath });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold">{strings.panelTitle}</h1>
        <Button size="sm" onClick={() => open("new")}>
          {strings.newBot}
        </Button>
      </div>
      {bots.length === 0 ? (
        <EmptyStatePanel>{strings.noBots}</EmptyStatePanel>
      ) : (
        <ul className="flex flex-col">
          {bots.map((bot) => (
            <li key={bot.id}>
              <button
                type="button"
                onClick={() => open(bot.id)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-state-hover"
              >
                <BotAvatar appearance={bot.appearance} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{bot.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {bot.role || bot.capabilities.join(", ")}
                  </span>
                </span>
                {bot.hidden ? (
                  <span className="text-xs text-muted-foreground">{strings.hidden}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Draft {
  name: string;
  role: string;
  capabilities: string;
  instructions: string;
  memory: string;
  appearance: Appearance;
  hidden: boolean;
}

export function parseCapabilities(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part !== ""),
    ),
  ];
}

function draftOf(bot: BotDetail | null): Draft {
  return {
    name: bot?.name ?? "",
    role: bot?.role ?? "",
    capabilities: bot?.capabilities.join(", ") ?? "",
    instructions: bot?.instructions ?? "",
    memory: bot?.memory ?? "",
    appearance: bot?.appearance ?? randomAppearance(),
    hidden: bot?.hidden ?? false,
  };
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function BotEditor({ bot }: { bot: BotDetail | null }) {
  const navigate = useBbNavigate();
  const [draft, setDraft] = useState<Draft>(() => draftOf(bot));
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setDraft(draftOf(bot)), [bot?.id, bot?.revision]);
  const create = useRpcMutation({ contract: botsRpc, method: "bots.v1.create" });
  const update = useRpcMutation({ contract: botsRpc, method: "bots.v1.update" });
  const remove = useRpcMutation({ contract: botsRpc, method: "bots.v1.remove" });
  const pending = create.isPending || update.isPending || remove.isPending;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setError(null);
    const fields = {
      name: draft.name.trim(),
      role: draft.role.trim(),
      capabilities: parseCapabilities(draft.capabilities),
      instructions: draft.instructions,
      appearance: draft.appearance,
    };
    try {
      if (bot === null) {
        const created = await create.mutate(fields);
        navigate.toPluginPanel(PANEL_PATH, { subPath: `${created.id}/chat` });
      } else {
        await update.mutate({
          botId: bot.id,
          expectedRevision: bot.revision,
          ...fields,
          memory: draft.memory,
          hidden: draft.hidden,
        });
      }
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      setError(code === "conflict" ? strings.conflict : String((caught as Error).message));
    }
  };

  return (
    <form
      className="flex max-w-2xl flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-3">
        <BotAvatar appearance={draft.appearance} size={48} />
        <Button type="button" variant="outline" size="sm" onClick={() => set("appearance", randomAppearance())}>
          {strings.randomAppearance}
        </Button>
        {bot ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `${bot.id}/chat` })}
          >
            {strings.newConversation}
          </Button>
        ) : null}
      </div>
      <Field id="bot-name" label={strings.fields.name}>
        <Input id="bot-name" value={draft.name} required maxLength={80} onChange={(event) => set("name", event.target.value)} />
      </Field>
      <Field id="bot-role" label={strings.fields.role} hint={strings.fields.roleHint}>
        <Input id="bot-role" value={draft.role} maxLength={160} onChange={(event) => set("role", event.target.value)} />
      </Field>
      <Field id="bot-capabilities" label={strings.fields.capabilities} hint={strings.fields.capabilitiesHint}>
        <Input
          id="bot-capabilities"
          value={draft.capabilities}
          onChange={(event) => set("capabilities", event.target.value)}
        />
      </Field>
      <Field id="bot-instructions" label={strings.fields.instructions} hint={strings.fields.instructionsHint}>
        <Textarea
          id="bot-instructions"
          rows={8}
          value={draft.instructions}
          onChange={(event) => set("instructions", event.target.value)}
        />
      </Field>
      {bot ? (
        <>
          <Field id="bot-memory" label={`${strings.fields.memory} (${draft.memory.length}/${MEMORY_MAX})`} hint={strings.fields.memoryHint}>
            <Textarea
              id="bot-memory"
              rows={6}
              maxLength={MEMORY_MAX}
              value={draft.memory}
              onChange={(event) => set("memory", event.target.value)}
            />
          </Field>
          <Field id="bot-defaults" label={strings.fields.defaults}>
            <div id="bot-defaults" className="flex items-center gap-2 text-sm text-muted-foreground">
              {bot.defaults
                ? strings.fields.defaultsSaved(
                    [bot.defaults.providerId, bot.defaults.model].filter(Boolean).join(" · ") || "—",
                  )
                : strings.fields.defaultsNone}
              {bot.defaults ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() =>
                    void update.mutate({ botId: bot.id, expectedRevision: bot.revision, clearDefaults: true })
                  }
                >
                  {strings.fields.defaultsReset}
                </Button>
              ) : null}
            </div>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.hidden} onChange={(event) => set("hidden", event.target.checked)} />
            {strings.hide}
          </label>
        </>
      ) : null}
      {error ? <p className="text-sm text-destructive-text">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || draft.name.trim() === ""}>
          {pending ? strings.saving : bot ? strings.save : strings.create}
        </Button>
        <Button type="button" variant="ghost" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>
          {strings.cancel}
        </Button>
        {bot ? (
          <Button
            type="button"
            variant="ghost"
            className="ml-auto text-destructive-text"
            disabled={pending}
            onClick={() => setConfirmRemove(true)}
          >
            {strings.remove}
          </Button>
        ) : null}
      </div>
      {bot ? (
        <ConfirmDeleteDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
          <ConfirmDeleteDialogContent
            title={strings.remove}
            description={strings.removeConfirm}
            confirmLabel={strings.remove}
            pending={remove.isPending}
            onCancel={() => setConfirmRemove(false)}
            onConfirm={() =>
              void remove.mutate({ botId: bot.id }).then(() => navigate.toPluginPanel(PANEL_PATH))
            }
          />
        </ConfirmDeleteDialog>
      ) : null}
    </form>
  );
}

export function BotChat({ bot }: { bot: BotDetail }) {
  const navigate = useBbNavigate();
  const start = useRpcMutation({ contract: botsRpc, method: "bots.v1.startThread" });
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-3">
        <BotAvatar appearance={bot.appearance} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{bot.name}</div>
          <div className="truncate text-xs text-muted-foreground">{bot.role}</div>
        </div>
      </div>
      <NewThreadComposer
        draftKey={`1ma-bots:${bot.id}`}
        defaultProjectId={bot.defaults?.projectId ?? undefined}
        defaultProviderId={bot.defaults?.providerId}
        defaultModel={bot.defaults?.model}
        initialPrompt={bot.threads.length === 0 ? strings.firstPrompt(bot.name) : undefined}
        placeholder={strings.composerPlaceholder(bot.name)}
        onSubmit={async (request) => {
          const { threadId } = await start.mutate({ botId: bot.id, request: { ...request } });
          navigate.toThread(threadId);
        }}
      />
    </div>
  );
}

function BotRoute({ botId, chat }: { botId: string; chat: boolean }) {
  const query = useRpcQuery({ contract: botsRpc, method: "bots.v1.get", input: { botId } });
  if (query.error) return <p className="text-sm text-muted-foreground">{strings.unavailable}</p>;
  if (!query.data) return <p className="text-sm text-muted-foreground">{strings.loading}</p>;
  return chat ? <BotChat bot={query.data} /> : <BotEditor bot={query.data} />;
}

export function BotsPanel({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  const list = useRpcQuery({
    contract: botsRpc,
    method: "bots.v1.list",
    input: {},
    enabled: route.page === "list",
  });
  return (
    <div className="h-full overflow-auto p-6">
      {route.page === "list" ? (
        list.error ? (
          <p className="text-sm text-muted-foreground">{strings.unavailable}</p>
        ) : list.data ? (
          <BotList bots={list.data.bots} />
        ) : (
          <p className="text-sm text-muted-foreground">{strings.loading}</p>
        )
      ) : route.page === "new" ? (
        <BotEditor bot={null} />
      ) : (
        <BotRoute botId={route.botId} chat={route.page === "chat"} />
      )}
    </div>
  );
}
