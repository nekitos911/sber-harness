# sber-harness

A local, lightweight IDE for working with coding agents and tasks. Inspired by
[Orca](https://github.com/stablyai/orca), built around **GigaCode CLI** and your own services, reached over MCP.

- **Agent chats**: every agent turn runs a CLI in headless mode (`-p`, `stream-json`). The chat shows text,
  reasoning and tool calls; the next message continues the same CLI session (`--resume`).
- **Orchestration as in Orca**: a coordinator agent splits the work into tasks and starts workers through
  `worker_start`. Each worker gets **its own chat**, nested under the coordinator. Workers report with
  `worker_done` or ask with `ask`, and the harness itself wakes the coordinator. Sub-agents are created only through
  orchestration, never through the CLI's built-in tools.
- **Task board** (Jira-like): Backlog / To do / In progress / Review / Done columns, drag-and-drop,
  dependencies between tasks, assigning to an agent with one button, sync from the tracker over MCP.
- **Agents board**: who is doing what, statuses, queues, the coordinator → worker hierarchy, assigning a task to an
  existing agent, quick messages, stopping.
- **Terminals**: PowerShell by default, or an interactive agent CLI (`gigacode`) inside the UI, with persistent history.
- **IDE pieces**: workspaces and git worktrees, a file tree and editor (CodeMirror), diffs, commit, push,
  PR (through the MCP code-hosting service).
- **Local only**: the server listens on `127.0.0.1`, no CDN or telemetry; it is protected by a token and a Host check.

## Quick start

Requirements: Node.js >= 22, git. GigaCode CLI on the target machine (the `mock` agent is enough for a demo).

```powershell
npm install
npm run build
npm start            # http://127.0.0.1:4777
```

`npm run dev` starts the same thing with UI hot reload. `npm test` runs the tests (node:test, on mocks).

Demo without GigaCode: **add a workspace** (path to any git repo) → **New chat** → agent
`Mock agent`, role "coordinator" → the message `#spawn create file hello.txt #done`. A worker chat appears,
the task goes to Review on the board, and the coordinator receives the report.

## Configuration

`harness.config.json` holds the defaults (committed). Machine-specific settings go in
`harness.config.local.json` (gitignored, deep-merged on top).

| Key | Purpose |
|---|---|
| `agents.<id>` | agents: `launcher`, `command` (string or argv array), `approvalMode`, `model`, `settingsEnv`, `settings` |
| `shell` | terminal shell (`powershell.exe -NoLogo` by default) |
| `agentMcpServers` | MCP servers passed to every agent (alongside `harness`) |
| `mcpServers` | MCP servers the harness calls itself (tracker, PRs) |
| `mcpSecretsFile` | file with MCP secrets (outside the repo), or env `HARNESS_MCP_SECRETS` |
| `integrations.tasks` / `integrations.pr` | mapping of the tracker and PR service onto the board and the Changes panel |

Connecting real GigaCode and MCP services: **[docs/INTEGRATION.md](docs/INTEGRATION.md)**.
Ready-made prompt for the agent that will do it: **[docs/SETUP-PROMPT.md](docs/SETUP-PROMPT.md)**.

## How it is built

```
web/ (React UI) ──REST/WS──> server/ (Node, 127.0.0.1)
                               ├─ sessions.js ──spawn──> agent CLI (gigacode -p … --output-format stream-json)
                               │                           └─ MCP "harness" (mcp/harness-mcp.js) ──HTTP──> orchestration.js
                               ├─ PTY terminals (PowerShell / interactive CLI)
                               ├─ git.js, fs.js
                               └─ mcp-client.js ──> tracker / PR service (integrations/)
```

Details (data, API, protocols): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Orchestration protocol for agents:
[skills/harness-orchestration/SKILL.md](skills/harness-orchestration/SKILL.md). Rules for coding agents:
[AGENTS.md](AGENTS.md).
