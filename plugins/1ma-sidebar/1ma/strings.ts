// Every text 1ma adds to the sidebar, in one place so a translation can be
// added without searching the code.
export const strings = {
  title: "Bots",
  newBot: "New bot",
  unavailable: "Bots are unavailable right now. Conversations are in their projects.",
  newConversation: (name: string) => `New conversation with ${name}`,
  composerPlaceholder: (name: string) => `Message ${name}…`,
  openBot: (name: string) => `Open ${name}`,
  expand: (name: string) => `Expand ${name} conversations`,
  collapse: (name: string) => `Collapse ${name} conversations`,
  botActions: (name: string) => `${name} actions`,
  botSettings: "Bot settings",
  newConversationItem: "New conversation",
  hideBot: "Hide bot",
  showBot: "Show in sidebar",
  hiddenBots: (count: number) => `${count} hidden`,
  mainConversationStatus: (status: string | null) => `Main conversation: ${status ?? "idle"}`,
  othersWorking: (count: number) => `${count} other conversation${count === 1 ? "" : "s"} working`,
  unreadError: "a conversation failed",
  done: (count: number) => `Done: ${count}`,
  settings: {
    showBots: "Show bots",
    showBotsDescription:
      "Show the bots block above the projects when the 1ma Bots plugin is installed. Off, the list is exactly bb's.",
  },
  migratedPreferences: (keys: readonly string[]) =>
    `copied the built-in thread list's preferences: ${keys.join(", ")}`,
} as const;
