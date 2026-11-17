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
  dependencies between tasks, "Take into work" in one button (the prompt is configurable, e.g. `/full-task {taskUrl}{notes}`),
  sync from the tracker over MCP.
- **Branches and releases**: base `develop`, branches `feature/<KEY>` from the tracker task key; a task can have
  several target branches (fix in `develop` and in `release/1.54.0`): the work happens once, and the rest are
  ported by cherry-pick, with an agent to resolve conflicts. Commits and PRs are pre-filled from the task (key, title,
  agent report, list of commits) and editable before sending.
- **Microservices**: a task spanning several repositories is split into subtasks, one per repository, with one key
  and one branch name in all of them.
- **Agents board**: who is doing what, statuses, queues, the coordinator → worker hierarchy, assigning a task to an
  existing agent, quick messages, stopping.
- **Terminals**: PowerShell on Windows, `$SHELL` elsewhere, or an interactive agent CLI (`gigacode`) inside the UI, with persistent history.
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

### Linux / macOS

The same commands work in bash/zsh. Nothing platform-specific is configured by default: `shell: null` picks
`$SHELL -l` (UTF-8 locale when none is set) and `agents.gigacode.command: null` picks `gigacode` on `PATH`, else
`~/.gigacode/bin/gigacode`; an executable launcher is run directly with the same arguments (it sets its own identity),
explicit `agents.gigacode.node` + `cliEntry` still win. `node server/index.js --print-config` shows what was chosen and
why. Stop sends SIGTERM to the agent's process group and SIGKILL after 3 s; «open folder» uses `xdg-open` / `open`.
The native terminal module (`@lydell/node-pty`) needs the usual build tools only if no prebuilt binary matches.

### Демо без GigaCode: `npm run demo`

`npm run demo` (= `node server/index.js --demo`, http://127.0.0.1:4778) starts an offline demo: its own data folder
`data-demo/` (gitignored) with two seeded git repositories (`demo-service` with `develop` + `release/1.54.0`,
`ledger-service`) and a few tasks (a hotfix for two target branches, a parent task with subtasks in both repos); the
`mock` agent stands in for GigaCode (it answers `/models`, runs workers, reviews), and the tracker and PR service are
served from `test/fixtures` by `scripts/mock-mcp.js`. Seeding happens once; delete `data-demo/` to start over.

Manual demo in a normal run: **add a workspace** (path to any git repo) → **New chat** → agent `Mock agent`, role
"coordinator" → the message `#spawn create file hello.txt #done`. A worker chat appears and the coordinator receives
the report.

## Configuration

`harness.config.json` holds the defaults (committed). Machine-specific settings go in
`harness.config.local.json` (gitignored, deep-merged on top).

| Key | Purpose |
|---|---|
| `agents.<id>` | agents: `launcher`, `command` (string, argv array or `null` = auto), `approvalMode`, `model`, `settingsEnv`, `settings` |
| `shell` | terminal shell; `null` = auto (PowerShell with a UTF-8 console on Windows, `$SHELL -l` elsewhere) |
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
