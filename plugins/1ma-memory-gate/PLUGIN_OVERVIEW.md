Holds new chat turns in the queue while their machine is short of memory.

## What it does

- Reads every connected machine's memory every 5 seconds: the container's
  limit and working set when the machine runs in one, the machine's own
  available memory, and how long tasks recently waited for memory.
- A new chat turn starts when its machine has enough free memory for one more
  chat (600 MB by default) and memory pressure is under the limit (10%).
  Otherwise it waits in the queue and is tried again in 15 seconds, or
  sooner when a chat finishes.
- A chat that just started holds its share for 45 seconds, until its own
  memory shows in the reading, so several queued chats do not all start on
  the same free memory.
- While fewer chats run on a machine than **Always allow this many chats**
  (1 by default), a new one starts without the memory check: memory held by
  something else never stops the only chat.
- The thread-count limit stays as it is; this adds memory on top of it.

## Limits

- Works on Linux only. On a machine without Linux memory files (macOS,
  Windows) every turn goes ahead, and `bb memory-gate status` says so.
- A running chat is never stopped, and a reply to a running turn never waits.
- **Send now** on a waiting message sends it at once, as everywhere in 1ma.
- Memory used outside the container is seen only through the machine's
  available memory.
- If a machine gives no memory reading for 30 seconds, new turns there go
  ahead unchecked until a reading returns; the log and
  `bb memory-gate status` say so.

## Settings

- **Wait for free memory**, on by default.
- **Memory per chat (MB)**, 600 by default.
- **Memory pressure limit (%)**, 10 by default.
- **Always allow this many chats**, 1 by default.

## What it reads and changes

It reads memory files of the Linux kernel on each machine, the machine list
and the list of running threads. It changes nothing; it only answers whether
a new turn may start now.
