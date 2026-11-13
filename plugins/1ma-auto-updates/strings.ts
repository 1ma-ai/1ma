export const strings = {
  providersLabel: "Update provider CLIs",
  providersDescription:
    "Install updates for Codex, Claude Code and other provider CLIs that 1ma manages, only while nothing runs: no turn, background agent, background command or workflow.",
  pluginsLabel: "Update 1ma plugins",
  pluginsDescription:
    "Install compatible updates of plugins from 1ma's own repository, only while nothing runs. Turn this off on a server whose plugins are deployed another way.",
  otherPluginsLabel: "Update plugins from other sources",
  otherPluginsDescription:
    "Also install updates of plugins that do not come from 1ma's repository. Off by default: such an update arrives without 1ma's review.",
  holdReason: (update: string) =>
    `1ma is installing an update (${update}). This message goes out as soon as it finishes; sending it now may meet a half-installed tool.`,
} as const;
