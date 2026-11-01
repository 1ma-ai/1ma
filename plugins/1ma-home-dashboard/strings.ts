// Every text this plugin shows, in one place so a translation can be added
// without searching the code. The wording is the owner's.
export const strings = {
  section: "Tasks",
  lanes: { "needs-you": "Needs you", done: "Done", running: "Running" },
  open: (title: string) => `Open ${title}`,
  lastActivity: "Last activity",
  justNow: "just now",
  minutesAgo: (minutes: number) => `${minutes}m ago`,
  hoursAgo: (hours: number) => `${hours}h ago`,
  daysAgo: (days: number) => `${days}d ago`,
  showMore: (count: number) => `Show ${count} more`,
  threadsUnavailable: "Треды 1ma недоступны. Обновите страницу.",
  loading: "Загружаем задачи…",
  focusBoardUnavailable:
    "Статус задач Focus Board недоступен. Включите Focus Board и обновите страницу.",
} as const;
