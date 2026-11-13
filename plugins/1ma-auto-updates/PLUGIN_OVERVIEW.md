Keeps provider CLIs and plugins up to date without breaking work in progress.

## What it does

- Installs updates for Codex, Claude Code and the other provider CLIs that
  1ma manages, and compatible plugin updates.
- Installs only after 15 quiet minutes: no turn ran, finished or failed, and
  no thread, background agent or workflow is running.
- While it installs, new messages wait a moment and go out as soon as the
  updates finish, so no turn starts on a half-installed CLI.

## Settings

- **Update provider CLIs** and **Update plugins**, both on by default. Turn
  plugin updates off on a server whose plugins are deployed another way.

## What it reads and changes

It reads the thread list, the machines and their provider CLI status, and the
plugin list. It runs the same updates as `bb updates apply` and
`bb plugin update`, and nothing else.
