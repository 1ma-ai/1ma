Keeps one record of the work going on in your chats on two 1ma servers, so
the main bot can tell you what is running, what waits for you and which
server has not been seen.

## What it does

- Watches the chats of this server and of a second 1ma server over its API,
  once a minute and right after a local chat finishes a turn.
- Keeps a work record per chat: state, provider, project, branch.
- Tells apart "no chats" and "the server did not answer": a server that did
  not answer is shown with the time it was last seen.
- Serves the record read-only over RPC (`work.v1.list`, `work.v1.get`,
  `work.v1.waiting`) for the bot and for other views.

## Settings

- **Server role**: `control` keeps the record; `executor` only lets its chats
  claim pull requests.
- **Executor server URL**: the other 1ma server, empty while there is none.
- **Main bot chat**: the pinned chat that acts as the main bot.
- **Watch servers every minute**: on by default.
