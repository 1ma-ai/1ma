export const strings = {
  roleLabel: "Server role",
  roleDescription:
    "control: this server keeps the work record and watches both servers. executor (the default): this server only lets its chats claim pull requests. Choose control on exactly one server.",
  linuxServerUrlLabel: "Executor server URL",
  linuxServerUrlDescription:
    "Address of the other 1ma server, for example http://192.0.2.10:38886. Leave empty while there is no second server.",
  mainBotThreadIdLabel: "Main bot chat",
  mainBotThreadIdDescription:
    "Id of the pinned chat that acts as the main bot until the 1ma Bots plugin is installed, for example thr_abc123.",
  passEnabledLabel: "Watch servers every minute",
  passEnabledDescription:
    "Run the reconciliation pass on a one-minute schedule. Turn it off to keep the plugin installed but idle.",
  reposLabel: "Watched repositories",
  reposDescription:
    'JSON list of the GitHub repositories whose pull requests the superagent follows, with the GitHub accounts each server pushes as: [{"repo": "owner/name", "accounts": {"mac": ["login"], "linux": ["login"]}}].',
  excludedReposLabel: "Excluded projects",
  excludedReposDescription:
    "Repositories (owner/name, separated by commas or spaces) whose chats never get the superagent's instructions or tools and whose claims are refused, even when they are in the watched list.",
  invalidRepos: (problem: string) => `Watched repositories: ${problem}.`,
  invalidServerUrl: "Use an http:// or https:// address without a path.",
  invalidThreadId: "Use a chat id that starts with thr_.",
  claimInstruction:
    "This repository is watched by the 1ma superagent. After you open a pull request here, call sa_claim_pr once with its URL so that review results come back to this chat.",
  claimToolDescription:
    "Tell the 1ma superagent that this chat opened the given pull request, so that review results and questions about it come back here. Call it once per pull request, right after opening it.",
  claimPending: "Claiming the pull request",
  claimCompleted: "Claimed the pull request",
} as const;
