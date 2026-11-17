# Handoff: what has been done and how it works

A document for the agent (or developer) who continues the work. Read it first, then `AGENTS.md`,
`docs/INTEGRATION.md` (what to do on the target machine), `docs/GIGACODE-FACTS.md` (facts about GigaCode and MCP)
and `docs/ARCHITECTURE.md` (the full contract: data, REST, WS, agent tools).

## 1. What it is

A local, lightweight IDE for working with coding agents (GigaCode CLI first of all) and tasks, modelled on Orca:
- agent chats with history: every turn is a headless CLI run with `--resume` of the same session;
- orchestration: a coordinator agent splits work into tasks and starts workers; each worker is a separate chat in the UI;
- a kanban board, an agents board, inbox notifications;
- workspaces (repositories) and git worktrees, each worktree with its own set of tabs (chats, terminals, files, diffs);
- PowerShell terminals (or an agent CLI in TUI mode) with persistent history;
- git: changes, diffs, commit/push, PR, branch switching, porting fixes into release branches;
- integrations over MCP: tasks from onework (the tracker), PRs to sourcecontrol (the code host).

It runs locally on `127.0.0.1`, protected by a token and a Host check; there is no CDN or telemetry. Node ≥ 22; Docker is not needed.

## 2. Stack and layout

- `server/`: Node.js ESM with no build step. `node:http` + `ws` + `@lydell/node-pty`. Storage is JSON in `data/` (atomic writes).
- `web/`: React 19 + Vite + TypeScript; built into `web/dist`, which the server serves. UI copy is in Russian.
- `mcp/harness-mcp.js`: an MCP server (stdio) with orchestration tools, injected into every agent session. It is also a CLI.
- `scripts/`: `mock-agent.js` (a fake GigaCode), `mock-mcp.js` (a fake tracker/code host), `mcp-call.js` (manual MCP calls).
- `skills/harness-orchestration/SKILL.md`: the coordinator/worker protocol for agents.
- `test/`: `node:test`, real git in temp folders with Cyrillic and spaces in the names, fixtures in `test/fixtures/`.

Server modules: `index.js` (HTTP/WS, routes, security), `config.js`, `store.js`, `bus.js`, `launchers.js` (**everything
CLI-specific**), `runner.js` (one turn: spawn, stream, timeouts, kill, reattach), `sessions.js` (sessions, queue, terminals),
`orchestration.js` (agent tools, preambles, worker_done, ports), `tasks.js`, `git.js`, `fs.js`, `registry.js`
(internal sub-agent registry), `mcp-client.js`, `integrations/tasks.js` (onework), `integrations/pr.js` (sourcecontrol).

UI: `views/` (Board, Agents, Inbox, Settings, Chat, Terminal, File, Diff, WorktreeHome), `components/` (Sidebar,
TopBar, WorkspacePanel with Files/Changes, board/TaskCard+TaskDrawer, chat/Composer+MessageItem+WorkersPanel,
pickers/ModelPicker+BranchPicker, ui/ — the component set: Select, Combobox, Popover, Menu, Dialog, Tooltip, controls),
`store.ts` (single store), `ws.ts` (WebSocket with reconnect), `api.ts` (fetch + token), `types.ts` (contract types).

## 3. Key scenarios (how it works inside)

**A chat turn.** `POST /api/sessions/:id/messages` → `sessions.deliver()` → queue → `runner` resolves the launcher
(gigacode: `ROOT\runtime\node\node.exe --max-old-space-size=6144 ROOT\lib\cli-entry.js` + identity env from the shim),
writes `data/runs/<sid>/settings.json` (grades, `chatRecording`, `mcpServers.harness`), spawns without a shell
(detached, stdout/stderr to files), reads NDJSON → `launchers.parse` → normalized events → transcript messages
(upsert by id) → WS `msg`. The CLI's `session_id` goes into `externalSessionId`, and the next turn runs with `--resume`.
`phase: 'starting'` until the first event (GigaCode warms up for 30–60 s). Empty stdout + error → red error with
stderr; stderr after success → ⚠ warning.

**Orchestration.** A session with role `coordinator` gets a preamble (split into tasks, start workers with
`worker_start`, end the turn, wait to be woken). The agent calls the `harness` MCP tools → `POST /api/agent/<tool>` with
the `x-harness-session` header. `worker_start` creates a worker session (child of the coordinator, its own chat, nested in
the sidebar), puts the task into "In progress" and starts the first turn: worker preamble + the task prompt
(`/full-task {taskUrl}{notes}`; a slash command always goes as the first word). The worker finishes with
`worker_done(summary, status)` → task to Review (or back on failure), notification, and delivery of the report to the
coordinator (which wakes it). `ask` → a question to the coordinator/user (with answer buttons). A worker turn ending
without `worker_done` → escalation to the coordinator. Built-in GigaCode sub-agents (`agent` tool) are allowed as
internal helpers; they are shown read-only (stream events with `parent_tool_use_id`, the registry in `{registryDir}`).

**Take into work (the board).** `POST /api/tasks/:id/start` → if a live worker already exists, returns it (`jumped`);
otherwise a worktree `<repo>-worktrees/<KEY>` with branch `feature/<KEY>` from `targets[0]` (develop) → a worker
session with `/full-task <url> <notes>`.

**Ports into a release.** Task targets `["develop", "release/1.54.0"]`. `POST /api/tasks/:id/port {target}` → worktree
from the release branch, branch `feature/<KEY>-rel154`, cherry-pick of only the missing commits
(`git log --cherry-pick --right-only`); a conflict starts a worker that resolves it.

**Commit/PR.** `GET /api/git/suggest` pre-fills the commit (`<KEY> <title>`, the list of files, the worker summary) and
the PR (title ≤ 100 bytes, description ≤ 512 bytes). `POST /api/git/pr` → sourcecontrol `git_create_pull_request`
(project/repository from the remote); an already-open PR for the same branch is returned instead of a new one (a second
one would close the first). PR status (open/merged/review) comes from `git_list_pull_requests`, observe-only.

**Tracker.** `POST /api/tasks/sync` → onework `sbertrack_findIssues` (markdown!) → parse lines → upsert tasks
(dedupe by `externalId`, closed statuses are not imported, a manually chosen column is not overwritten, deleting an
imported task = hide it). The drawer lazily loads the description (`getIssue`), transitions (`getIssueMeta`) and links
(`listLinks`, with subtasks via `decomposition` and the "add subtasks" button). A tracker status change is only an
explicit action (`updateIssueStatus`), never a card drag.

**Terminals.** PTY (`@lydell/node-pty`), PowerShell in UTF-8 by default; history in `data/terms/<sid>.log`
(the last 2 MB), replayed on `term.attach`.

**Harness restart.** Agent turns are not killed: on startup the harness finds live pids and reattaches to their output
files. Terminals are closed. The UI after a restart shows "Server restarted — refresh the page" (new token).

## 4. What has been checked and how

| What | How it was checked |
|---|---|
| Server, orchestration, board, git, ports, branches, registry, MCP client, integrations | `npm test` (70+ tests) on Windows and on Node 22 (Linux) |
| Full chat cycle, `--resume`, harness MCP tools inside the agent | live, with Claude Code as a stand-in for GigaCode (the same headless stream-json mode) |
| UI | by hand in a browser (Playwright screenshots, dark/light, 1280/1600) against a server with the mock agent |
| GigaCode, onework, sourcecontrol | **not live**: the parsers and launch are built from the facts and fixtures reconstructed from them (`test/fixtures/README.md`) |

## 5. What to do on the target machine

Follow `docs/INTEGRATION.md`; the ready prompt is in `docs/SETUP-PROMPT.md`. In short: replace the fixtures with real
samples from `.gigacode-facts`, fill in the local config (models/grades, space, tracker link, workspaces folder),
check GigaCode in a chat, the `mcpServers` merge (`inheritUserMcp` flag), "Sync" from onework, a PR to sourcecontrol on a
test branch, and "Take into work" end to end.

## 6. Known gaps and ideas

- No CI status (sourcecontrol does not provide it; CI is a separate system).
- "Observe and propose" loops (PR review comments, CI) are not implemented: only PR status.
- GigaCode's built-in sub-agents cannot be turned off by a setting; their use is a matter of prompt discipline.
- Effort/speed for models: GigaCode has no such flags; there is a model, a grade and an approval mode.
- The board shows all tasks without sprint/epic grouping; filters are search, repository, hidden.
- No authentication beyond the local token (by design: a single local user).

## 7. Development and debugging

```powershell
npm test                        # all tests
npm run dev                     # server + Vite HMR
node server/index.js --print-config   # resolved paths, launcher, secrets (names only)
node scripts/mcp-call.js <server> --list | <tool> '<json>'
```
The mock agent understands directives in a message: `#spawn <spec>` (worker_start), `#done <summary>`, `#fail`,
`#ask <question> | <option> | ...`, `#crash`, `#silent`, `#slow`, `#raw`. This is the fastest way to check the UI and
orchestration without GigaCode. Rules: `AGENTS.md`.
