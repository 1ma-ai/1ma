Keeps provider CLIs and plugins up to date without breaking work in progress.

## What it does

- Installs updates for Codex, Claude Code and the other provider CLIs that
  1ma manages, and compatible updates of 1ma's own plugins.
- Installs only after 15 quiet minutes, and only while nothing runs: no
  thread (archived and hidden ones included), background agent, background
  command or workflow.
- Installs one update at a time and checks again before each one; if work
  started meanwhile, it leaves the remaining updates for the next pass.
- While an update installs, new messages wait and go out as soon as it
  finishes. Send now still sends at once, as everywhere in 1ma; the waiting
  message warns that it may meet a half-installed CLI.

## Settings

- **Update provider CLIs** and **Update 1ma plugins**, both on by default.
  Turn plugin updates off on a server whose plugins are deployed another way.
- **Update plugins from other sources**, off by default: those updates
  arrive without 1ma's review.

## What it reads and changes

It reads the thread list, the machines and their provider CLI status, and the
plugin list. It runs the same updates as `bb updates apply` and
`bb plugin update`, and nothing else.
