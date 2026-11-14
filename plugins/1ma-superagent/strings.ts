export const strings = {
  roleLabel: "Server role",
  roleDescription:
    "control: this server keeps the work record and watches both servers. executor: this server only lets its chats claim pull requests.",
  linuxServerUrlLabel: "Executor server URL",
  linuxServerUrlDescription:
    "Address of the other 1ma server, for example http://192.0.2.10:38886. Leave empty while there is no second server.",
  mainBotThreadIdLabel: "Main bot chat",
  mainBotThreadIdDescription:
    "Id of the pinned chat that acts as the main bot until the 1ma Bots plugin is installed, for example thr_abc123.",
  passEnabledLabel: "Watch servers every minute",
  passEnabledDescription:
    "Run the reconciliation pass on a one-minute schedule. Turn it off to keep the plugin installed but idle.",
  invalidServerUrl: "Use an http:// or https:// address without a path.",
  invalidThreadId: "Use a chat id that starts with thr_.",
} as const;
