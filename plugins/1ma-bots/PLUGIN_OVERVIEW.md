Give recurring work a named AI coworker: a bot with its own instructions, memory, work areas and conversations.

## What you get

- Bots with a name, role and face, created and edited on the **Bots** page.
- A first conversation in which a new bot asks what its job is and writes its own instructions and key facts.
- Private bot memory, at most 3,000 characters, that the bot keeps up to date itself.
- Work areas such as dev, marketing or accounting. Other plugins read them to give a bot their tools.
- Letters between bots, queued in the recipient's conversation. The owner chooses whom each bot may write to, and an exchange stops after a fixed number of letters.
- A **Bot** row in a conversation's Info tab to assign it to a bot, and an activity log on each bot's page.
- Manual **done** for bot conversations; idle conversations can be marked done automatically if you turn it on.

## How it works

Bot state lives in the plugin's own database on the 1ma server, never in project files. A conversation started from a bot belongs to the bot from its first turn. In a bot's conversations 1ma adds the bot's instructions, memory and the bots it may write to, and gives the agent four tools: `bot_read`, `bot_memory_update`, `bot_update_identity` and `bot_message`.

Other plugins ask `bots.v1.forThread` which bot a conversation belongs to and which work areas it has. The plugin works on its own: without a bots sidebar the regular 1ma panel stays as it is, and without plugins that read work areas the labels simply do nothing.

## Settings

- **Mark idle bot conversations done after (hours)**: 0, off by default.
- **Letters per exchange between bots**: 6 by default. Your own message in a conversation starts a new exchange.
- **Letters per bot per hour**: 20 by default.

## Requirements

1ma 0.49 or newer. No account or external service; your agent provider's normal costs apply.
