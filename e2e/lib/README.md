# Shared end-to-end library

Helpers for end-to-end suites that run real 1ma servers in GitHub Actions only.
Never start a server, a browser or these tests on the workstation.

These files come from `e2e/superagent` on the `superagent` branch, made generic.
Whichever pull request merges first brings `e2e/lib`; the other one then switches
its tests to it and drops its copy.

- `server-version.txt`: the one pinned 1ma server release both suites install.
- `install-server.mjs`: downloads that release, checks it against `SHA256SUMS`,
  installs it under `$E2E_ROOT/server-package`.
- `servers.mjs`: `Server` (start, graceful stop with SIGTERM, `crash` with
  SIGKILL to the server's whole process group, restart, `bb` CLI, HTTP API with a new
  connection per call, plugin RPC, local plugin install and config, project
  creation), `Fleet` (several servers with their own ports, data directories and
  logs, started, stopped and restarted by name), `waitFor`.
- `stub-acp-agent.mjs`: an ACP agent driven by commands in the message text:
  `[stub:reply text]`, `[stub:wait seconds]`, `[stub:fail text]`,
  `[stub:call tool {json}]` (calls a tool through bb's MCP bridge), `[stub:ask title]` (asks for approval and waits for the owner). It records
  every prompt (joined `text` and the text `parts` as sent), tool list and tool
  result as JSON lines in `$E2E_STUB_LOG`.
  `Server.registerStubAgent(log)` registers it as provider `acp-stub`; name the
  model `acp-default` explicitly.
- `fault-proxy.mjs`: `FaultProxy`, an HTTP proxy in front of one server. It
  passes every request and logs it; the thread create request
  (`POST /api/v1/threads`) is logged with its body and faulted by the mode the
  test sets: `swallow`, `drop-response`, `forward-later`, `delay` (each
  optionally `once`), or `refuse` for every connection.
- `fake-gh/gh`: an optional `gh` for the plugin host's `PATH`, answering
  read-only `gh api` calls (GET, no fields) from the JSON file in
  `E2E_GH_FIXTURES`; `E2E_GH_ALLOW` (a regular expression) narrows the allowed
  paths. With `E2E_GH_LOG` set it logs every answered path and every refused
  call as `REJECTED [args]` or `NOT-API [args]`.

A suite needs `E2E_ROOT` (a scratch directory) and `node e2e/lib/install-server.mjs`
with `GH_TOKEN` set before its tests start.
