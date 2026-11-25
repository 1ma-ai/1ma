// Every text 1ma adds to the sidebar, in one place so a translation can be
// added without searching the code.
export const strings = {
  title: "Bots",
  newBot: "New bot",
  unavailable: "Bots are unavailable right now. Conversations are in their projects.",
  newConversation: (name: string) => `New conversation with ${name}`,
  composerPlaceholder: (name: string) => `Message ${name}…`,
  openBot: (name: string) => `Open ${name}`,
  openFailed: (name: string) => `Could not open ${name}`,
  expand: (name: string) => `Expand ${name} conversations`,
  collapse: (name: string) => `Collapse ${name} conversations`,
  botActions: (name: string) => `${name} actions`,
  botSettings: "Bot settings",
  newConversationItem: "New conversation",
  hideBot: "Hide until next activity",
  showBot: "Show in sidebar",
  hiddenBots: (count: number) => `${count} hidden`,
  mainConversationStatus: (status: string | null) => `Main conversation: ${status ?? "idle"}`,
  othersWorking: (count: number) => `${count} other conversation${count === 1 ? "" : "s"} working`,
  unreadError: "a conversation failed",
  dropFirst: (count: number) => (count === 1 ? "Make first" : `Make these ${count} first`),
  dropLast: (count: number) => (count === 1 ? "Add to end" : `Add these ${count} to end`),
  assigned: (name: string, count: number) =>
    count === 1 ? `Moved to ${name}` : `${count} conversations moved to ${name}`,
  assignFailed: (name: string) => `Could not move the conversation to ${name}`,
  partlyAssigned: (name: string, moved: number, total: number) =>
    `Moved ${moved} of ${total} conversations to ${name}`,
  unconfirmedAssigned: (name: string, moved: number, total: number) =>
    `Moved ${moved} of ${total} conversations to ${name}; could not check the rest. Reload the list to see where they are.`,
  reorderFailed: "Could not reorder the conversations",
  open: "Open",
  done: (count: number) => `Done: ${count}`,
  settings: {
    showBots: "Show bots",
    showBotsDescription:
      "Show the bots block above the projects when the 1ma Bots plugin is installed. Off, the standard list is shown.",
  },
  migratedPreferences: (keys: readonly string[]) =>
    `copied the built-in thread list's preferences: ${keys.join(", ")}`,
} as const;
