// Every text 1ma adds to the sidebar, in one place so a translation can be
// added without searching the code.
export const strings = {
  title: "Bots",
  newBot: "New bot",
  unavailable: "Bots are unavailable right now. Conversations are in their projects.",
  newConversation: (name: string) => `New conversation with ${name}`,
  composerPlaceholder: (name: string) => `Message ${name}…`,
  toggleConversations: (name: string, count: number) => `${name}: ${count} conversations`,
  done: (count: number) => `Done: ${count}`,
  settings: {
    showBots: "Show bots",
    showBotsDescription:
      "Show the bots block above the projects when the 1ma Bots plugin is installed. Off, the list is exactly bb's.",
  },
  migratedPreferences: (keys: readonly string[]) =>
    `copied the built-in thread list's preferences: ${keys.join(", ")}`,
} as const;
