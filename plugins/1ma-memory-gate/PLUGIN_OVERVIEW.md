Holds new chat turns in the queue while their machine is short of memory.

## What it does

- Reads every connected machine's memory every 5 seconds, each machine on its
  own so a slow one does not hold up the others, and at once when a machine
  connects again: the container's limit and working set when the machine runs
  in one, the machine's own available memory, and how long tasks recently
  waited for memory.
- Finds the container's limit through the process's own group and the groups
  above it, so a limit set on a parent group counts; the group with the least
  room left is the one that applies.
- While fewer chats run or are starting on a machine than **Always allow this
  many chats** (1 by default), a new one starts without the memory check, even
  before the first reading: memory held by something else never stops the
  only chat.
- Otherwise a new chat turn starts when its machine has enough free memory for
  one more chat (600 MB by default) and memory pressure is under the limit
  (10%). If not, it waits in the queue and is tried again in 15 seconds, or
  sooner when a chat finishes. The plugin wakes its own waits at that time,
  even when another plugin holds the same turn.
- A chat it let through holds its share for 45 seconds while it runs, until
  its own memory shows in the reading, so several queued chats do not all
  start on the same free memory. A chat it let through that has not started
  yet holds its share for 10 seconds; if another plugin held that turn, the
  share is free again after that.
- The thread-count limit stays as it is; this adds memory on top of it.

## Limits

- Works on Linux only. On other systems (macOS, Windows) every turn goes
  ahead, and `bb memory-gate status` says so.
- A running chat is never stopped, and a reply to a running turn never waits.
- **Send now** on a waiting message sends it at once, as everywhere in 1ma.
- Memory used outside the container is seen only through the machine's
  available memory.
- If turns on a machine have waited for 30 seconds and the machine has had no
  usable memory reading for 30 seconds, new turns there go ahead unchecked
  until a reading returns. The log says so once when this starts and once when
  readings are back, and `bb memory-gate status` shows it.
- `bb memory-gate status` lists at most 50 machines and counts the rest.

## Settings

- **Wait for free memory**, on by default.
- **Memory per chat (MB)**, 600 by default.
- **Memory pressure limit (%)**, 10 by default.
- **Always allow this many chats**, 1 by default.

## What it reads and changes

It reads memory files of the Linux kernel on each machine, the machine list
and the list of running threads. It changes nothing; it only answers whether
a new turn may start now, and asks bb to try held turns again.
