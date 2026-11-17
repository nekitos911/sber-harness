# Architecture contract

This file is the single source of truth for module boundaries, data shapes, HTTP/WS API and the
agent-facing orchestration API. Backend (`server/`, `mcp/`) and frontend (`web/`) are built against it.
If you change a shape here, change both sides.

## Goals and hard constraints

- Local only. Server binds `127.0.0.1`. No CDN, no telemetry, no outbound requests from the harness
  itself. The only network traffic is what agent CLIs and configured MCP servers do on their own.
- Node.js >= 22, plain ESM JavaScript on the server (no build step for server). Frontend: React + Vite + TS,
  built into `web/dist` and served by the server.
- Windows first (PowerShell default shell), works on Linux/macOS too.
- Agent CLIs are spawned **without a shell**, prompt is a separate argv element.
- Everything that depends on a concrete agent CLI lives in `server/launchers.js`.
  Everything that depends on concrete external services (task tracker, PR service) lives in
  `server/integrations/`. The rest of the code knows nothing about GigaCode, onework, etc.

## Layout

```
harness.config.json            committed defaults
harness.config.local.json      gitignored overrides (deep-merged on top)
server/
  index.js                     http server: static web/dist, REST router, WS, security (host + token)
  config.js                    load + deep-merge config, resolve dataDir
  store.js                     JSON persistence (db.json, transcripts, terminal logs), atomic writes
  bus.js                       tiny EventEmitter used to broadcast to WS clients
  launchers.js                 AgentLauncher definitions (gigacode, qwen, gemini, claude, mock) + stream-json normalizer
  runner.js                    runs ONE agent turn: resolve exe, spawn, NDJSON line buffer, first-event timeout, kill tree
  sessions.js                  session manager: chat turns + queue (wake), terminal PTYs, status, transcripts
  orchestration.js             agent-facing API: tasks, worker_start, send, ask, worker_done (+ tool schemas)
  tasks.js                     task CRUD, ordering, deps/ready computation, locks
  git.js                       git CLI wrappers: status, diff, commit, push, log, worktrees
  fs.js                        workspace file list/read/write with path-inside-cwd guard
  mcp-client.js                console-level MCP client (stdio + streamable HTTP), per-call timeout
  integrations/
    tasks.js                   importTasks(): external tracker -> board tasks   (INTEGRATION SEAM)
    pr.js                      createPullRequest(): branch -> PR in code host    (INTEGRATION SEAM)
mcp/harness-mcp.js             stdio MCP server exposing orchestration tools to agents; also a CLI
scripts/mock-agent.js          fake stream-json agent CLI (tests + demo without GigaCode)
scripts/mock-mcp.js            fake MCP server (tracker + PR tools) for tests + demo
skills/harness-orchestration/SKILL.md   protocol for coordinator/worker agents
test/                          node:test suites + fixtures
web/                           React UI (Vite root)
data/                          runtime state (gitignored)
```

## Config (`harness.config.json`, overridable by `harness.config.local.json`)

```jsonc
{
  "host": "127.0.0.1",
  "port": 4777,
  "dataDir": "./data",
  "shell": { "command": "powershell.exe",                // non-win default: $SHELL or /bin/bash
             "args": ["-NoLogo", "-NoExit", "-Command", "[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8"] },
  "defaultAgent": "gigacode",
  "workspaces": { "root": null, "repos": [] },          // auto-registered on start
  "worktreeRoot": null,                                  // null => <repoParent>/<repoName>-worktrees
  "git": { ... },                                        // see "Branches, commits, PRs"
  "tasks": { "promptTemplate": "..." },                  // see "Prompt templates"
  "session": { "idleWindowSec": 90 },
  "orchestration": { "workerMayCommit": false },
  "agents": {                                            // key = agent id used everywhere (session.agent)
    "gigacode": {
      "launcher": "gigacode",                            // implementation in server/launchers.js
      "label": "GigaCode",
      "command": "C:/Program Files/.gigacode/bin/gigacode.cmd",   // the shim; see "GigaCode launcher"
      "node": null, "cliEntry": null,                    // optional explicit pair (both or neither)
      "nodeArgs": ["--max-old-space-size=6144"],
      "approvalMode": "auto", "approvalModes": ["plan", "default", "auto-edit", "auto"],
      "model": null,
      "models": [],                                      // model catalogue for the UI dropdown (filled locally)
      "settingsEnv": "GIGACODE_SYSTEM_SETTINGS_PATH",
      "settings": { "agents": { "modelGrades": {}, "allowedGrades": [] }, "chatRecording": true },
      "inheritUserMcp": false,                           // copy ~/.gigacode/settings.json mcpServers into the run file
      "taskPromptTemplate": "/full-task {taskUrl}{notes}",
      "firstEventTimeoutMs": 120000,                     // cold start with ~9 MCP servers takes 30-60 s
      "env": {}
    },
    "claude": { "launcher": "claude", "command": "claude", "approvalMode": "acceptEdits", "enabled": false, ... },
    "mock":   { "launcher": "mock", "label": "Mock agent (demo)", ... }
  },
  "agentMcpServers": {},                  // extra MCP servers injected into every agent run (gemini/qwen mcpServers format)
  "mcpServersFrom": "~/.gigacode/settings.json",   // console MCP servers (config.mcpServers merged over these)
  "mcpServers": { },                      // console-level MCP clients (the harness itself calls them), see "Console MCP"
  "mcpSecretsFile": null,
  "integrations": {
    "tasks": { "enabled": false, "format": "onework-markdown", "server": "onework", "space": "PROJ",
               "tools": { "find": "sbertrack_findIssues", "get": "sbertrack_getIssue", "meta": "sbertrack_getIssueMeta",
                          "transition": "sbertrack_updateIssueStatus", "links": "sbertrack_listLinks", "me": "sbertrack_getUser" },
               "limit": 100, "refreshSec": 0, "urlTemplate": "",            // e.g. "https://<tracker>/swtr/units/all/unit/{key}"
               "statusMap": { "todo": "todo", "development": "in_progress", "qa": "review", "done": "done", ... },
               "priorityMap": { "low": "low", "mid": "medium", "high": "high" },
               "closedStatuses": ["done", "cancelled", "declined"] },
               // format "json" (other providers): "itemsPath", "map", "transition": { "args": {...} } — see server/integrations/tasks.js
    "pr":    { "enabled": false, "server": "sourcecontrol", "tool": "git_create_pull_request",
               "args": { "project": "{project}", "repository": "{repository}", "head": "{branch}", "base": "{base}", "title": "{title}", "body": "{body}" },
               "urlPath": "html_url",
               "listTool": "git_list_pull_requests", "listArgs": { ... "state": "OPEN" }, "listItemsPath": "pulls",
               "limits": { "titleBytes": 100, "bodyBytes": 512 } }
  }
}
```

## Data model (all JSON, ids are strings)

```ts
type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done'

interface Task {
  id: string                 // "T-1", "T-2", ... (monotonic counter in db)
  title: string
  description: string        // markdown
  status: TaskStatus
  order: number              // float; sort ascending within a column
  priority: 'low' | 'medium' | 'high' | null
  deps: string[]             // task ids that must be 'done' before this one is ready
  labels: string[]
  workspaceId: string | null         // the repository this task is done in (one repo per task; multi-repo = subtasks)
  parentId: string | null            // subtask of another task (e.g. one subtask per microservice repo)
  targets: string[]                  // base branches to deliver into; [0] = primary (work happens here), rest = ports
                                     // default [git.defaultBase]; hotfix example: ["develop", "release/1.54.0"] (ports pick only missing commits)
  branch: string | null              // work branch of this task (set when a worktree/branch is created or on assign)
  ports: { target: string, branch: string, cwd: string, status: 'clean' | 'conflict' | 'done' | 'failed',
           sessionId: string | null }[]   // deliveries into targets[1..] (cherry-pick)
  assigneeSessionId: string | null   // the worker session currently/last working on it
  externalId: string | null  // id in external tracker (import dedupe key with `source`)
  externalUrl: string | null
  source: string | null      // integration name, e.g. "onework"
  externalStatus: string | null      // raw tracker status   } see "Board <-> tracker semantics"
  statusManual: boolean              // a human moved the card
  hidden: boolean
  takenAt: number | null
  snapshot: { title, description, externalStatus, at } | null
  log: { at: number, by: string, text: string }[]   // by = "user" | session id | "harness"
  createdAt: number
  updatedAt: number
}

interface Workspace {          // a registered folder, usually a git repo root
  id: string                   // "w_xxxx"
  name: string
  path: string                 // absolute
  isGit: boolean
}
interface Worktree { path: string, branch: string | null, head: string, main: boolean }

type SessionKind = 'chat' | 'terminal'
type SessionStatus =
  'idle'        // chat: waiting for input;  terminal: process alive
  | 'running'   // chat: a turn is in progress
  | 'done'      // worker reported worker_done(status=done)
  | 'failed'    // worker reported failed, or turn crashed
  | 'exited'    // terminal: process exited
  | 'stopped'   // chat: stopped by the user (the next message resumes)
  | 'error'     // could not start (bad command, timeout before first event, no output at all)

interface Session {
  id: string                   // "s_xxxxxx"
  kind: SessionKind
  title: string
  agent: string                // chat: key in config.agents; terminal: "shell" or an agent key (interactive TUI)
  launcherId: string | null    // chat only; frozen at creation, a session never switches CLI
  cwd: string                  // frozen at creation (resume depends on it)
  workspaceId: string | null
  branch: string | null        // informative, refreshed on git ops
  role: 'solo' | 'coordinator' | 'worker'
  parentId: string | null      // coordinator session id for workers
  taskId: string | null
  status: SessionStatus
  externalSessionId: string | null   // CLI session id captured from the stream; used for --resume
  settingsPath: string | null        // per-session settings.json; must stay the same across turns
  model: string | null
  approvalMode: string | null
  autoReport: boolean          // worker: escalate to parent if a turn ends without worker_done
  queued: number               // pending deliveries waiting for the current turn to end
  preview: string              // last ~200 chars of agent text, for boards
  command: string | null       // terminal: initial command typed into the shell (e.g. "gigacode")
  pid: number | null
  phase: 'starting' | 'streaming' | null   // chat turn: spawned without output yet ("starting / waiting for MCP") | output flows
  tokensIn: number             // cumulative over turns, from each run's result usage (0 when unknown)
  tokensOut: number
  createdAt: number
  lastActivityAt: number
}

type MessageKind = 'user' | 'assistant' | 'thought' | 'tool' | 'error' | 'system'
interface Message {
  id: string                   // "m_xxxxxx"; upserted by id (streaming text updates the same message)
  sessionId: string
  at: number
  kind: MessageKind
  text: string                 // markdown for user/assistant/system; plain for error
  from: string | null          // user messages: "user" | sender session id (delivered by orchestration)
  tool: null | {               // kind === 'tool'
    id: string, name: string, input: unknown, output: string | null,
    status: 'running' | 'ok' | 'error',
    progress?: string[]        // built-in sub-agent activity under this call (agent tool): compact lines, last 50
  }
  options?: string[]           // user message carrying a question from `ask`: suggested answers (buttons)
  turn: number                 // turn counter within the session
}

interface Notification {
  id: string, at: number, read: boolean,
  kind: 'question' | 'done' | 'failed' | 'escalation' | 'info' | 'error',
  sessionId: string | null, taskId: string | null,
  text: string,
  options?: string[]           // kind 'question': suggested answers
}
```

Persistence (`<dataDir>`): `db.json` = `{ seq: {task}, tasks, workspaces, sessions, notifications }`,
`transcripts/<sessionId>.json` = `Message[]`, `terms/<sessionId>.log` = raw terminal output (ring, last 2 MB),
`runs/<sessionId>/settings.json` (+ `mcp.json` for claude), `runs/<sessionId>/stderr.log`, `token`.
Writes are debounced and atomic (write tmp + rename). On startup, sessions with status `running` become `idle`
(chat) or `exited` (terminal) and get a system message "harness restarted". System messages starting with `⚠` are
warnings (e.g. stderr of a successful run); a system message "Model: … · MCP: onework ✓, java-lsp ✗" is added once
per session from the CLI's init event.

## Agent launchers (`server/launchers.js`)

```js
/** @typedef {{ prompt: string, session: Session, agentCfg: object, settingsPath: string, mcpConfigPath: string, harnessMcp: {command: string, args: string[], env: Record<string,string>} }} TurnCtx */
/** @typedef {{
 *   id: string,
 *   resolve(agentCfg): { file, args, env },      // executable (+ leading args, env); runs before anything is created
 *   buildArgs(ctx: TurnCtx): string[],          // argv after resolve().args; prompt is ONE element
 *   env(ctx: TurnCtx): Record<string,string>,    // extra env (e.g. settings path var)
 *   prepare(ctx: TurnCtx): void,                 // write per-session settings/mcp config files (idempotent)
 *   parse(line: any, state: object): NormalizedEvent[]   // one parsed NDJSON object -> 0..n events
 * }} AgentLauncher */

type NormalizedEvent =
  | { type: 'session', id: string }                       // CLI session id (for --resume)
  | { type: 'text', text: string, delta: boolean }        // delta=true: append to current assistant msg; false: full message
  | { type: 'thought', text: string, delta: boolean }
  | { type: 'tool_call', id: string, name: string, input: unknown }
  | { type: 'tool_result', id: string, output: string, isError: boolean }
  | { type: 'error', text: string }
  | { type: 'init', model: string | null, mcpServers: { name, status }[] }   // CLI start (system/init)
  | { type: 'result', text: string | null, isError: boolean, tokensIn?, tokensOut? }   // end of turn; usage of the whole run
  | { type: 'meta', raw: unknown }                       // anything unknown; kept in stderr.log only
// text/thought/tool_call/tool_result/error may carry parentToolId: the event belongs to a built-in sub-agent started by
// that tool call (stream-json parent_tool_use_id) and is shown as tool.progress of the parent call, never in the main chat.
// runner.js adds { type: 'raw', text } for each non-JSON stdout line.
```

Launchers: `gigacode`, `qwen`, `gemini` (same argv family: `[--resume <id>] -p <prompt> --approval-mode <mode>
--output-format stream-json [--model <m>]`, per-session settings via env var), `claude` (`-p <prompt> --output-format
stream-json --verbose --permission-mode <mode> [--model] [--resume <id>] --mcp-config <file> --allowedTools mcp__harness
--disallowedTools Task Agent`), `mock` (`node scripts/mock-agent.js` with the gigacode argv). One shared tolerant
normalizer handles the Claude/Qwen style (`system/assistant/user/result`, `stream_event`; GigaCode and claude) and the
Gemini style (`init/message/tool_use/tool_result/error/result`; gemini). Any object with `session_id`/`sessionId`
yields a `session` event. Tokens come from the `result` event only (per-step assistant usage does not add up to it).

Executable resolution (runner.js), never through a shell: argv array is used as-is; a string is looked up
in PATH (+PATHEXT on Windows); `.exe` runs directly; npm `.cmd` shims are parsed to `node <entry.js>`;
anything else fails with a clear message telling the user to set `command` as an argv array.

## Turn lifecycle (sessions.js + runner.js)

1. `deliver(sessionId, {from, text})` pushes to the session queue. If the session is not `running`, start a turn.
2. Turn: append `user` message, status `running` + `phase: 'starting'`, `launcher.prepare()`, spawn, read stdout line by
   line (partial lines buffered, 8 MB cap), `phase: 'streaming'` on the first output, apply events to the transcript.
   First prompt of a CLI session = preamble + text; if the text starts with `/` (slash command, e.g. `/full-task <url>`)
   it is text + "\n\n" + preamble instead, because a slash command only works as the first word.
3. No stdout line within `firstEventTimeoutMs` → kill process tree, `error` message with stderr tail, status `error`.
4. Exit (`phase` back to null): exit != 0 without a `result` → `error` message leading with stderr (a fatal CLI error leaves
   stdout empty); exit 0 without a single event → `error` "exited without any output" + stderr, status `error` (e.g. the
   GigaCode identity check); stderr text after a successful run → `system` message prefixed `⚠` (warning).
   Status back to `idle` unless the worker already set `done`/`failed` (or the user stopped it: `stopped`).
5. Post-turn: if worker with `autoReport` and no `worker_done` during this turn and queue empty →
   escalation delivered to parent (or notification to user if no parent). Then if queue non-empty → next turn.
6. `stop` kills the process tree (`taskkill /T /F` on Windows) and clears the queue.
7. Delivered text from another session is prefixed: `[harness] Message from <title> (<id>):\n<text>`.

Terminal sessions: PTY (`@lydell/node-pty`) running `config.shell`; if `command` set, it is written into the
shell after spawn. Env always includes `HARNESS_URL`, `HARNESS_TOKEN`, `HARNESS_SESSION_ID`.
Output goes to the ring buffer + log file + WS. Deliveries to a terminal session are written as text + `\r`.

## Orchestration (agent-facing API) — `server/orchestration.js`

HTTP: `POST /api/agent/<tool>` with headers `x-harness-token`, `x-harness-session: <caller session id>`
(may be absent → caller is "external", treated like the user), JSON body = tool args → JSON result or
`{ error }` with 4xx. `GET /api/agent/tools` returns `[{ name, description, inputSchema }]` (MCP shape).

| tool | args | effect |
|---|---|---|
| `whoami` | – | caller session: id, role, parentId, taskId, cwd, branch |
| `task_list` | `status?`, `ready?: boolean` | tasks (ready = todo/backlog with all deps done) |
| `task_get` | `id` | task |
| `workspace_list` | – | registered repos `[{ id, name, path, isGit }]` (for multi-repo planning) |
| `task_create` | `title`, `description?`, `deps?`, `status?`, `priority?`, `labels?`, `parent_id?`, `workspace?` (id or name), `targets?` | new task (subtask inherits parent's targets/workspace when omitted) |
| `task_port` | `task_id`, `target`, `agent?` | cherry-pick the task branch into another target branch (see "Multiple target branches") |
| `task_update` | `id`, `title?`, `description?`, `status?`, `priority?`, `comment?` | updated task (`comment` appends to log) |
| `worker_start` | `task_id?` or `spec` (+`title?`), `agent?`, `workspace?`, `worktree?: 'current' \| 'new'`, `branch?`, `model?` | creates worker chat session (child of caller), task → `in_progress`, starts first turn with worker preamble + spec. 409 if the task already has an active worker or deps not done |
| `worker_list` | – | caller's child sessions with status/task/preview |
| `send_message` | `to: <sessionId> \| 'parent' \| 'user'`, `body` | delivers (wakes target) |
| `ask` | `question`, `options?: string[]` | like send_message to parent (or user notification `question`); options go on the delivered message / notification; answer arrives as the next message |
| `worker_done` | `summary`, `status: 'done' \| 'failed'` | task → `review` (done) / `todo` (failed) + log; session status done/failed; parent gets a delivery with summary + now-ready tasks; user gets a notification |

`mcp/harness-mcp.js`: stdio MCP server (JSON-RPC 2.0, newline-delimited) implementing `initialize`,
`tools/list` (proxied from `GET /api/agent/tools`), `tools/call` (proxied to `POST /api/agent/<name>`).
Reads `HARNESS_URL`, `HARNESS_TOKEN`, `HARNESS_SESSION_ID` from env; falls back to `<repo>/data/server.json`
(`{url}`) and `<repo>/data/token`. CLI mode: `node mcp/harness-mcp.js call <tool> '<json>'` prints the result.

Every chat session gets the harness MCP server injected (settings.json `mcpServers.harness` or `--mcp-config`).

**Workers vs built-in helpers.** Parallel task work the user should see goes through `worker_start` (from a
coordinator) or `POST /api/tasks/:id/assign|start` (from the UI, same code path): every worker is a harness session
with its own chat. GigaCode's built-in `agent` tool cannot be disabled and `/full-task` relies on it for review, so it is
allowed for internal helpers (review, exploration); their activity is shown read-only (tool.progress of the parent
call, and the registry below). claude runs with `--disallowedTools Task Agent`. There are no pre-created agents.

Preambles (built in `orchestration.js`, prepended to the first prompt of a session):
- coordinator (`role: 'coordinator'`): you coordinate; split work into tasks (`task_create` with deps), start workers
  with `worker_start`, after starting workers END YOUR TURN — the harness wakes you with each worker report; answer
  worker questions with `send_message`; multi-repo and multi-target rules; built-in agent tool only for helpers.
- worker: Task key/title, Session id, Parent, cwd/branch, base = targets[0]; do only this task inside cwd; stay on the
  branch; `ask` then end turn for questions; finish with `worker_done(summary, status)`. Unless
  `orchestration.workerMayCommit`: do NOT commit/push/merge/create PRs/write to the tracker unless the task says so
  (the user commits from the UI). Commit message format `<KEY> <summary>` (no colon, no feat:/fix:, no Co-authored-by,
  no AI mentions). Port-conflict workers may `git cherry-pick --continue`.
- both: `Registry dir: <registryDir>` — record built-in helper sub-agents there (see the registry section).

## UI HTTP API (all under `/api`, header `x-harness-token` required)

Every text the server generates for people is Russian: system/error messages in transcripts, notifications, task log
entries and the `error` strings of 4xx/5xx answers (code identifiers, flags, paths and git/CLI output stay as they are;
console logs and the agent-facing preambles/tool descriptions stay English).

```
GET    /api/state                         -> { tasks, workspaces, sessions, notifications, agents: [{id,label,launcher,approvalModes,approvalMode,enabled,models,model}],
                                              defaultAgent, shell: {command}, integrations: {tasks: bool, pr: bool, tasksProblem: {error, at} | null} }
POST   /api/workspaces          {path, name?}            -> Workspace
DELETE /api/workspaces/:id
GET    /api/workspaces/:id/worktrees                     -> Worktree[]
POST   /api/workspaces/:id/worktrees {name, base?}       -> Worktree   (branch = name)
DELETE /api/workspaces/:id/worktrees  {path, force?}

POST   /api/tasks               {title, description?, status?, priority?, deps?, labels?, workspaceId?, parentId?, targets?} -> Task
PATCH  /api/tasks/:id           partial Task fields (+ comment?)                                   -> Task
DELETE /api/tasks/:id
POST   /api/tasks/:id/move      {status, beforeId?: string|null}   -> Task  (DnD: put before beforeId, or at end)
POST   /api/tasks/:id/assign    {agent?, workspaceId?, cwd?, worktree?: 'current'|'new', sessionId?} -> Session
                                 (sessionId given => deliver the task to that existing session instead of creating one)
POST   /api/tasks/:id/start     {agent?, notes?} -> Session (+ jumped: true when the task already had a live worker)
                                 ("Взять в работу": default agent, worktree 'new' in task's workspace, task prompt template)
                                 A parent task (has subtasks), or a task without a workspace while ≥ 2 workspaces exist,
                                 starts a COORDINATOR instead (role 'coordinator', taskId = the task, cwd =
                                 workspaces.root, else the common parent folder of the subtasks' repos, else
                                 <dataDir>/chats/<sid>); its preamble carries a plan: the subtasks (id, key, title,
                                 workspace, deps, ready) and "worker_start({task_id, worktree: 'new'}) per ready subtask,
                                 same branch feature/<KEY> in every repo; create missing ones via workspace_list +
                                 task_create({parent_id, workspace})". The task gets in_progress/assignee/takenAt as usual.
                                 integrations.tasks.onStartTransition (transition id, default null): after a new session
                                 for an imported task, transitionTask(…, comment "Взято в работу через harness") — best
                                 effort: a failure adds a ⚠ line to the task log + an error notification, never fails.
POST   /api/tasks/:id/port      {target, agent?} -> { target, branch, cwd, status, sessionId }
POST   /api/tasks/sync                                   -> { imported, updated }   (integrations.tasks)
GET    /api/tasks/:id/external                           -> { key, title, fields: {Status, Priority, …}, description, attributes }
                                 (onework getIssue, parsed; fills an empty task.description)
GET    /api/tasks/:id/transitions                        -> { current, transitions: [{ id, label }] }   (onework getIssueMeta)
POST   /api/tasks/:id/tracker-status {transition, comment?} -> Task   (onework: transition id from /transitions;
                                 "json" format: {status, comment?}); 501 when not configured

POST   /api/sessions            {kind, agent?, cwd?, workspaceId?, title?, prompt?, role?, approvalMode?, model?, command?} -> Session
PATCH  /api/sessions/:id        {title?, approvalMode?, model?, autoReport?}            -> Session
DELETE /api/sessions/:id        (stops, removes session + transcript)
GET    /api/sessions/:id/messages                         -> Message[]
POST   /api/sessions/:id/messages {text}                  -> { queued: boolean }
POST   /api/sessions/:id/stop
POST   /api/sessions/:id/restart                          (terminal: respawn; chat: reset status to idle)
GET    /api/sessions/:id/log                              -> { text }   (stderr/raw tail)
GET    /api/sessions/:id/subagents                        -> { items, problems }   (registry, read-only)

GET    /api/git/status?cwd=     -> { branch, upstream, ahead, behind, files: [{ path, x, y, status: 'M'|'A'|'D'|'R'|'?'|'U' }] }
GET    /api/git/diff?cwd=&path= -> { diff }   (unified; path optional = whole tree; untracked files shown as added)
GET    /api/git/log?cwd=&n=     -> [{ hash, subject, author, at }]
GET    /api/git/branches?cwd=   -> { current, branches: [{ name, remote: boolean, current: boolean, upstream: string|null,
                                     lastCommitAt: number, worktree: string|null }] }
                                 (local refs/heads + origin/* without a local twin; `worktree` = path of the worktree that
                                  has it checked out, if any — such a branch cannot be switched to here)
POST   /api/git/checkout        {cwd, branch, create?: boolean, from?: string} -> { branch }
                                 (create: `git switch -c <branch> <from|HEAD>`; remote-only: `git switch --track origin/<b>`;
                                  409 when a chat session in this cwd is running or the branch is checked out in another
                                  worktree; 400 with git's message on dirty-tree conflicts; refreshes session.branch)
GET    /api/git/suggest?cwd=    -> { taskId, key, branch, base,
                                     commit: { title, body },        (prefill for the commit box, user edits before commit)
                                     pr: { title, body, base } }     (prefill for the PR dialog, user edits before create)
POST   /api/git/commit          {cwd, message, paths?}   -> { hash }   (paths absent => all changes; message = title + "\n\n" + body)
POST   /api/git/push            {cwd}                    -> { output }
POST   /api/git/pr              {cwd, title, body, base?} -> { url, existing }   (integrations.pr; 501 if disabled;
                                 existing: an OPEN PR with the same head+base already existed and is returned instead;
                                 400 with byte counts when title/body exceed integrations.pr.limits — UTF-8 BYTES)

POST   /api/git/pr/decline  { cwd, index } -> { ok: true }   (sourcecontrol decline via integrations.pr.declineTool,
                                 default "git_decline_pull_request" with {project, repository, pullRequestIndex}; feature `pr-decline`)
GET    /api/fs/search?cwd=&q=&limit=  -> [{ path, score }]   (for @-mentions: `git ls-files --cached --others --exclude-standard`
                                 (fallback: recursive walk skipping .git/node_modules), cached per cwd ~10 s, fuzzy subsequence
                                 match on the path with a bonus for basename hits; default limit 30, max 100)
GET    /api/git/pr-status?cwd=  -> { pr: { index, title, state: 'open'|'merged'|'declined', url, mergeable: boolean|null,
                                     reviewers: [{ status }], base, updatedAt } | null, error?: string }
                                 (observe-only, via integrations.pr.listTool for the current branch: OPEN first, else the
                                  most recent MERGED/DECLINED with that head; 501 when integrations.pr is disabled)
GET    /api/fs/list?cwd=&path=  -> [{ name, path, dir: boolean, size }]   (path relative to cwd; '' = root; dirs first; skips .git and node_modules)
GET    /api/fs/file?cwd=&path=  -> { path, content, size, binary: boolean }   (text up to 2 MB; binary => content '')
PUT    /api/fs/file             {cwd, path, content} -> { ok: true }
       (all fs paths are resolved against cwd and must stay inside it, else 400)

GET    /api/mcp/servers         -> [{ name, enabled, transport, ok, error?, problem?, tools: [{name, description}] }]

GET    /api/settings            -> { agents: { <id>: { approvalMode, approvalModes, approvalModeLabels, model, models,
                                     modelGrades: { default?, fast?, review?, explore? }, allowedGrades, taskPromptTemplate,
                                     taskPromptPresets, firstEventTimeoutMs, inheritUserMcp, enabled } },
                                     defaultAgent, git: {...}, tasks: { refreshSec },
                                     integrations: { tasks: { enabled, space, urlTemplate, statusMap, closedStatuses },
                                                     pr: { enabled, limits } } }
                                 Model entries everywhere (config, /api/state agents[].models, /api/settings) are objects
                                 `{ id, label?, context?, description? }` (a plain string in config is normalized to {id}).
GET    /api/agents/:id/info     -> { id, resolved: { ok, command?, node?, entry?, identity: boolean, error? },
                                     seen: { models: string[], slashCommands: string[], mcpServers: [{name, status}],
                                             agents: string[], version: string|null, at: number } | null }
                                 (`seen` is captured from the last `system/init` event of any session of that agent and
                                  persisted in db.agentMeta; `resolved` = launcher resolution like --print-config, no spawn)
PUT    /api/settings            same shape (partial) -> saved into harness.config.local.json (never secrets; approvalMode validated)
                                 modelGrades/allowedGrades map to agents.<id>.settings.agents.{modelGrades,allowedGrades}
POST   /api/notifications/:id/read
POST   /api/notifications/read-all
```

Errors: `{ error: string }` with 4xx/5xx. 404 for unknown ids, 409 for locks/conflicts, 501 for disabled integrations.

## WebSocket `/ws?token=...`

Server → client (JSON per frame):
```
{ t: 'task', task }            { t: 'task.del', id }
{ t: 'session', session }      { t: 'session.del', id }
{ t: 'msg', sessionId, msg }   (upsert by msg.id)
{ t: 'notify', n }             (upsert by n.id)
{ t: 'workspaces', workspaces }
{ t: 'term', id, data }        (only to sockets attached to that terminal)
{ t: 'term.replay', id, data } (full buffer, sent on attach)
{ t: 'subagents', sessionId, items }   (registry rows, while the session runs, on change)
```
Client → server: `{ t: 'term.attach', id }`, `{ t: 'term.detach', id }`, `{ t: 'term.in', id, data }`,
`{ t: 'term.resize', id, cols, rows }`.

## Branches, commits, PRs: naming and prefill

Config (`git` section):
```jsonc
"git": {
  "defaultBase": "develop",
  "branchTemplate": "feature/{key}",            // auto-created branches (worker_start/assign with worktree "new")
  "portBranchTemplate": "{branch}-{targetSlug}",   // feature/PROJ-14822-rel154 for release/1.54.0
  "commitTitleTemplate": "{key} {title}",        // team convention: key, space, summary (no colon, no feat:/fix:)
  "prTitleTemplate": "{key} {title}"
},
"tasks": {
  "promptTemplate": "{key}: {title}\n\n{description}\n\nTarget branches: {targets}\nLink: {taskUrl}{notes}"
  // per agent override: agents.<id>.taskPromptTemplate (gigacode: "/full-task {taskUrl}{notes}"); see "Prompt templates"
}
```
- Task key `{key}` = `externalId` of the ROOT task (follow parentId up) when it came from the tracker (e.g.
  `JIRA-1234`, the space prefix comes from the tracker), else the root's local id (`T-12`). Subtasks share the
  root's key, so the same branch name `feature/JIRA-1234` is used in every microservice repo.
  Branch names are sanitized (`[^A-Za-z0-9._/-]` → `-`); if the branch already exists in that repo (and isn't
  this task's own branch), suffix `-2`, `-3`…. Worktree directories stay short (MAX_PATH):
  `<repoParent>/<repoName>-worktrees/<KEY>` for task worktrees, `…/<branch tail>` otherwise (suffix -2… if taken).
  `{targetSlug}`: `release/x.y.z` → `rel<x><y>` (release/1.54.0 → rel154), anything else → the sanitized target.
- New worktree for a task: `git worktree add -b <branch> <dir> <start>` where `<start>` = `targets[0]` if it
  exists locally, else `origin/<targets[0]>`, else HEAD. `task.branch` is stored.
- Worker's first prompt = worker preamble + task prompt rendered from `agents.<id>.taskPromptTemplate` ??
  `tasks.promptTemplate`.

### Multiple target branches (hotfix into release + develop)

Work happens once, on `task.branch` started from `targets[0]`. Each other target gets a port:
`POST /api/tasks/:id/port {target, agent?}` (UI button per target) or agent tool `task_port`:
1. new worktree from `<target>` with branch `portBranchTemplate`;
2. requires commits on `task.branch` ahead of `targets[0]` (else 409 "commit the work first"); picks only the commits the
   target lacks: `git log --cherry-pick --right-only --no-merges --reverse --format=%H <target>...<task.branch>`
   (none → 409 "already contains every change"), then `git cherry-pick -x` of those;
3. clean → port `status: 'clean'`, log entry; conflict → leave the cherry-pick in progress, port `status: 'conflict'`,
   start a worker session in that worktree (parent = caller/coordinator) with a preamble: resolve conflicts,
   `git cherry-pick --continue`, run checks, `worker_done`. Its `worker_done` sets the port to done/failed.
Result: `{ target, branch, cwd, status, sessionId }`. One PR per target (PR dialog base = that target; cwd = port worktree).

### Multiple repositories (microservices)

One task = one repo (`workspaceId`). A spec touching several repos becomes a parent task with one subtask per repo
(`parentId`, own `workspaceId`, inherits `targets` and key). Coordinators see repos via the `workspace_list` tool and
create subtasks with `task_create({ parent_id, workspace, ... })`; `worker_start` runs the worker in that
subtask's repo (`worktree: 'new'` → branch `feature/<key>` in that repo). A parent task's status is managed by the
coordinator/user; the board shows subtask progress (done/total).
- Which task a cwd belongs to: the task of the session(s) whose cwd equals it, else a task whose key appears in the
  current branch name, else none (`taskId: null`, `key: null`; templates then fall back to the branch name / first
  changed file).
- `commit.title` = `commitTitleTemplate`; `commit.body` = last `worker_done` summary for that task (if any) +
  bullet list of changed files. `pr.title` = `prTitleTemplate`; `pr.body` = task description excerpt + external URL +
  `Target: <base>` + last worker summary + `git log <base>..HEAD --oneline` as bullets; `base` = the port target when cwd
  is a port worktree, else `targets[0]`. PR title/body suggestions are cut to `integrations.pr.limits` (UTF-8 bytes, on a
  code point boundary, with "…"); the create call itself never truncates (400 with byte counts instead).
- Worker preamble tells agents the commit format `<KEY> <summary>` and that the worker stays on its branch.

## GigaCode launcher: known facts from the target machine (do not "simplify")

Authoritative details: `docs/GIGACODE-FACTS.md`; fixtures: `test/fixtures/gigacode.*`.
- Install: `ROOT\bin\gigacode.cmd` (shim, default `agents.gigacode.command`), `ROOT\runtime\node\node.exe` (bundled Node —
  the system Node must not run cli-entry), `ROOT\lib\cli-entry.js`. The shim sets `ROOT=%~dp0..`.
- Resolution (before anything else is created, e.g. a worktree): explicit `agents.gigacode.node` + `cliEntry` (both or
  neither, both must exist) → parsed from the shim (`set "ROOT=…"` + the quoted call line, `%~dp0`/`%ROOT%` expanded) →
  `<shimDir>/../runtime/node/node.exe` + `<shimDir>/../lib/cli-entry.js` → the same under `<shimDir>` → clear error.
  The `.cmd` itself is never spawned (no honest exit codes). Never fall back to another launcher or to the system node.
- argv: `[--max-old-space-size=6144, cli-entry.js, (--resume <id>)?, -p, <prompt>, --approval-mode, <mode>, --output-format, stream-json, (--model <m>)?]`.
- Env (set only by the runner): `GIGACODE_SYSTEM_SETTINGS_PATH`, `GIGACODE_PACKAGE_IDENTITY` (64 hex from the shim's
  `set "GIGACODE_PACKAGE_IDENTITY=…"`; missing → fail immediately), `GIGACODE_PACKAGE_LAUNCHER` (shim path),
  `MCP_SECRET_<NAME>` for every secret, `HARNESS_URL`, `HARNESS_TOKEN`, `HARNESS_SESSION_ID`. Without the identity env the
  CLI writes only to stderr and exits 0 → reported as "exited without any output".
- Per-session settings `<dataDir>/runs/<sid>/settings.json` (UTF-8, same path every turn, removed with the session):
  `{ "agents": { "modelGrades": {...}, "allowedGrades": [...] }, "chatRecording": true, "mcpServers": { harness, ...agentMcpServers } }`.
  Never `permissions`. `inheritUserMcp: true` also copies the user's `~/.gigacode/settings.json` mcpServers (merge vs
  replace is unconfirmed). Write failure → error, and a worktree created for this start is removed.
- Approval modes `plan | default | auto-edit | auto` (validated). Resume needs `chatRecording`, the same cwd, settings
  path and launcher (a changed launcher is refused).
- Stream: Qwen-Code / Claude style; cold start (`system/init`) can take 30–60 s → `firstEventTimeoutMs` 120000 and
  `session.phase: 'starting'` for the UI. Fatal errors: empty stdout + exit 1 + stderr. Warnings: stderr at exit 0.
- Task command: `taskPromptTemplate: "/full-task {taskUrl}{notes}"` — slash commands work only as the first word.

### Prompt templates
Single pass with a replacer FUNCTION (task text may contain `$&`, `$'`, `$$`); substituted text is never expanded
again; unknown `{placeholders}` are left as is; a task template without any of `{taskUrl} {key} {id} {description}`
is a config error (agent would start without the task); empty notes are fine.
Vars: `{key} {id} {title} {description} {url} {taskUrl} {targets} {branch} {repo} {notes} {runId} {registryDir}
{settingsPath} {approvalMode}`. `{taskUrl}` = `externalUrl` (from `integrations.tasks.urlTemplate`) or the key when there is
none. `{notes}` = `" " + notes` when the user typed notes at start, else `""`.
`{runId}` = session id, `{registryDir}` = `<dataDir>/runs/<sid>/registry`.

### Run robustness
- Stop = `taskkill /PID <pid> /T /F` (argv array, only our own pid) and the session becomes `stopped` immediately;
  a late `exit` never overwrites `stopped`. The next message resumes normally.
- `POST /api/tasks/:id/start` on a task that already has a live worker returns that session with `jumped: true`
  (no second process, no second worktree). Concurrent starts of the same task → one process.
- stdout: line buffer with a cap (lines > 8 MB are truncated with a marker); non-JSON lines are NOT dropped:
  consecutive ones are shown in the feed as one `system` message (mono). stderr → `runs/<sid>/stderr.log`; its tail
  goes into the error message when the process dies before the first event.
- Usage: from the `result` event only (`usage` / `stats`) → cumulative `session.tokensIn` / `session.tokensOut` (0 when unknown).
- Ops: one harness per `dataDir` (a live pid in `<dataDir>/server.json` that is not ours → refuse to start); a busy port →
  error naming the port and `netstat -ano | findstr :<port>`; `*.stale-*` folders under `data/` and the worktree roots are
  swept on start (best effort); folders are deleted by renaming to `<dir>.stale-<ts>` first (files held by AV/indexer).
- Chat without a repository: cwd = `<dataDir>/chats/<sid>` (created, survives restarts), no worktree.
- Worktrees: reuse the task's worktree in that repo if it exists; removal = `git worktree remove --force` +
  `git worktree prune --expire now`, then the directory: on Windows rename to `.stale-<ts>` first, then
  `fs.rm(..., { recursive, force, maxRetries })`.
- Startup: sessions left `running` become `idle` with a system message ("harness restarted, the turn was interrupted;
  send a message to continue — context is kept by --resume"); orphan locks are cleared.

## Working with `/full-task` (the user's task command is an orchestrator itself)

`/full-task` (see `docs/GIGACODE-FACTS.md` §4) classifies the task, works in `..\<repo>-worktrees\<task-id>`, never commits,
runs implementer/reviewer sub-agents with cross-model review and writes a ledger + verdict files. The harness aligns:
- Worker preamble for a task started in a harness worktree adds: «Ты уже в рабочем дереве задачи `<cwd>` (ветка
  `<branch>`) — это и есть worktree задачи; не создавай другой. Коммиты/пуш/PR/трекер — только пользователь из UI.
  После финального сообщения твоей команды вызови worker_done с тем же текстом.» (session field `inWorktree: true`: the worker
  started in a linked worktree; the commit sentence is dropped when `orchestration.workerMayCommit`.)
- SDD artifacts viewer: `GET /api/sdd?cwd=` → `{ plans: [{ name, dir, progress: { raw, items: [{ title, status }] },
  verdicts: [{ n, file, status: 'PASS'|'FAIL'|'ESCALATION_REQUIRED'|'INDEPENDENT_VERIFICATION_REQUIRED'|null,
  filesChanged: string[], commands: [{ cmd, result }], openQuestions, implementerModel, reviewerModel, secondReviewModel,
  notes, raw }] }] }` from `<cwd>/.superpowers/sdd/*/progress.md` and `verdicts/task-*.md` (tolerant parser of the
  `key: value` block + list items; unparsed → `raw` only). While a session in that cwd runs, the server polls (3 s) and
  broadcasts `{ t: 'sdd', cwd, plans }` on change.
- `git.excludeFromCommit` (default `[".superpowers/"]`): `GET /api/git/status` marks matching files `service: true`;
  commit-all and the suggested file list skip them (pathspec `:(top,exclude)<pattern>`, so files staged earlier are skipped
  too); explicit `paths` drop them (400 when only service files are left); they are never pushed by the harness.
- Model references check: `GET /api/agents/:id/info` adds `modelRefs: [{ file, model, available }]` from
  `agents.<id>.modelRefsScan` (gigacode default `["~/.gigacode/agents/*.md", "~/.gigacode/commands/*.md"]`; frontmatter
  `model:` and model-id-looking tokens that match the catalogue naming), `available` against the discovered catalogue
  (prefix match tolerates the `-262k` suffix). Read-only; the harness never edits these files.
- Rework (the user's FOLLOW_UP form `/full-task <url> Задача готова, но нужны правки: <text>`):
  `POST /api/tasks/:id/rework { notes, agent? }` (flag `rework`). Prompt = `agents.<id>.reworkPromptTemplate` (gigacode
  `"/full-task {taskUrl} Задача готова, но нужны правки: {notes}"`, generic default `"{key} {title}: нужны правки: {notes}"`;
  `{notes}` is the text as typed, single-pass rendering; settable in /api/settings, must contain `{notes}`). Target: the
  task's non-archived worker (`assigneeSessionId`) → delivered (queued if running; `--resume` continues the CLI
  session); none → a new worker in the task's existing worktree (or the task branch re-checked out, never a new branch)
  with the rework prompt instead of the task prompt; never started (no branch) → 409. Effects: status → in_progress
  (with `board.moveSyncsTracker` the normal move-sync), log «Доработка: <notes>», no notification. Returns the session.

## Sub-agents as chats

### Level 1 — virtual read-only chats from the stream (works with the unchanged `/full-task`)
Every built-in sub-agent call (`agent` / `fork` tool_use in the main stream) becomes a **virtual session**:
`{ id: '<parentSid>~<toolUseId>', kind: 'chat', virtual: true, parentId: <parentSid>, role: 'subagent', agent,
title: '<subagent_type> · <model|grade>', status: running|done|failed, model, cwd: parent's }` — persisted like sessions,
listed in `/api/state`, nested under the parent in the UI. Its transcript is built from events with
`parent_tool_use_id === toolUseId` (text, tool calls/results — the same Message shapes) plus the call's prompt as the
first `user` message and the tool_result as the final assistant message; `GET /api/sessions/<virtualId>/messages` works,
WS `msg` events are emitted for it. `POST …/messages` to a virtual session → 409 «внутренний субагент — писать можно
только в родительский чат». The parent's tool card keeps a link to it (`tool.subSessionId`).

### Automatic: the orchestrator uses harness sub-agents by itself (no manual command)
`orchestration.subagents: "harness" | "builtin"` (default `"harness"`, exposed in /api/settings). In `"harness"` mode:
- The harness MCP server exposes a tool named **`agent`** with the SAME input schema as GigaCode's built-in `agent`
  (`subagent_type`, `prompt`, `model?`, `description?`, plus optional `approvalMode`, `worktree`, `timeoutMin`), so the
  model calls `mcp__harness__agent` exactly like the built-in one. It is `worker_run` with
  `profile = subagent_type`, `spec = prompt` (both names stay as aliases).
- EVERY gigacode/qwen/gemini session in the harness (solo, coordinator, worker, reviewer) gets a short context block in its
  first prompt (after a leading slash command, before otherwise): «Ты работаешь внутри harness. Субагентов запускай
  инструментом mcp__harness__agent с теми же аргументами, что у встроенного agent (subagent_type, prompt, model) —
  встроенный agent не используй: harness откроет каждого субагента отдельным чатом и вернёт тебе его результат так же.»
- The skill `skills/harness-orchestration/SKILL.md` is written so it also works as a GigaCode skill (frontmatter
  `name`/`description` with the trigger "starting a sub-agent inside the harness"); `POST /api/agents/:id/skills/install`
  copies it to `~/.gigacode/skills/harness-orchestration/SKILL.md` only on explicit request; `/api/agents/:id/info` reports
  `skills: { 'harness-orchestration': 'installed' | 'missing' | 'different' }`. The setup prompt asks the target-machine
  agent to install it (with the user's consent).
- If the model still calls the built-in `agent`, Level 1 shows it as a read-only chat — nothing is lost.
- VERIFY on the target: if GigaCode supports PreToolUse-style hooks in settings, `agents.gigacode.agentToolHook` (null by
  default) holds the hook config the harness writes into the run settings.json to deny the built-in `agent` with the hint
  «use mcp__harness__agent» (hard enforcement). Format unknown → not implemented until verified.
`"builtin"` mode: no context block, no harness `agent` tool advertised (worker_run still available).

### Level 2 — real sub-agent sessions via `worker_run` / harness `agent` ("Orca mode")
Agent tool `worker_run { profile?: string, spec: string, model?: string, approvalMode?: string, title?: string,
worktree?: 'current' (default) | 'new', timeoutMin?: number (default 60) }` (and its built-in-compatible alias `agent`):
synchronous drop-in for GigaCode's `agent` tool. Creates an EPHEMERAL worker session (child of the caller, its own chat, no board task); when `profile` is set, reads
`~/.gigacode/agents/<profile>.md` (YAML frontmatter `model`, `approvalMode`, `tools`, `description`; body = role prompt):
model/approvalMode default from the frontmatter (explicit args win), first prompt = role body + «\n\n## Задание\n» + spec +
the short worker preamble (report with worker_done). Returns when the worker calls `worker_done`
(`{ status, summary, sessionId }`), or when its turn ends without it (`{ status: 'no_report', summary: <last assistant
text>, sessionId }`), or on timeout (`{ status: 'timeout', sessionId }`, the worker keeps running). The user may watch,
message and stop that worker; messages from the user are queued into it as usual.
Transport: `POST /api/agent/worker_run` returns `{ sessionId }` immediately; `mcp/harness-mcp.js` then long-polls
`GET /api/agent/worker_wait?sessionId=&timeoutMs=25000` until settled and sends MCP `notifications/progress` (when the
client gave a progressToken) every poll so the tool call is not timed out; the per-session settings.json sets
`mcpServers.harness.timeout = 3600000` (ms).
`commands/full-task-harness.md` (shipped in the repo): a thin wrapper — load `full-task` via the skill tool and follow it
fully, except: every sub-agent dispatch of §6/§8 (and explorers) goes through harness `worker_run` with `profile` = the
agent name and `model` = the model from §8's table instead of the `agent` tool; parallel sub-agents = several
`worker_run` calls in one turn; everything else unchanged; task = `{{args}}`.
`POST /api/agents/:id/commands/install { name: 'full-task-harness' }` copies it to `~/.gigacode/commands/` only on this
explicit request (refuses to overwrite a different existing file without `force`); `/api/agents/:id/info` reports
`commands: { 'full-task-harness': 'installed' | 'missing' | 'different' }`. Preset `/full-task-harness {taskUrl}{notes}`
is added to `taskPromptPresets`.

## Review loop run by the harness (`orchestration.reviewMode: "harness"`)

Does not depend on what the task command (`/full-task`) says. Config:
```jsonc
"orchestration": {
  "reviewMode": "builtin",               // "builtin": the agent's own command reviews (as in the CLI); "harness": below
  "review": { "grade": "review", "approvalMode": "plan", "maxRounds": 2, "agent": null,
              "promptTemplate": "<default reviewer prompt with {key} {title} {description} {branch} {base} {cwd} {round} {previous}>" }
}
```
1. A task worker (not a reviewer, not ephemeral) calls `worker_done(status: 'done')` → instead of finishing, the task's
   `agentState = 'reviewing'` and the harness starts (round 1) or re-uses (round > 1) a REVIEWER session: role `reviewer`,
   parent = the worker, same cwd, `model` = `settings.agents.modelGrades[review.grade]` of the reviewer agent (skipped when
   unknown/unavailable → CLI default), `approvalMode = review.approvalMode` (read-only `plan`), title `Ревью <KEY>`,
   ephemeral (no board task). Its prompt = the rendered `review.promptTemplate` (default: review `git diff <base>...HEAD`
   plus uncommitted changes for the task; list findings with CRITICAL/HIGH/MEDIUM/LOW; end with `worker_done` whose
   summary ends with `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED`). Round > 1 sends «Повторное ревью после
   исправлений» + the previous findings to the same reviewer chat.
2. Reviewer `worker_done` → verdict = explicit `VERDICT:` line, else CHANGES_REQUESTED if the summary contains CRITICAL
   or HIGH, else APPROVED. APPROVED → `agentState = 'approved'`, the worker gets an informational message, the parent
   coordinator (if any) gets the worker's original report + «ревью: APPROVED», the user a notification.
   CHANGES_REQUESTED and round < maxRounds → `agentState = 'changes_requested'`, the findings are delivered to the worker
   («Ревью, раунд n: … Исправь CRITICAL/HIGH и снова вызови worker_done»); round == maxRounds → notification «ревью не
   сошлось за N раундов» with the findings, `agentState = 'changes_requested'`.
3. In this mode the worker preamble says: «Ревью выполняет harness другой моделью после твоего worker_done; пропусти шаги
   внутреннего ревью твоей команды (не запускай встроенных субагентов-ревьюеров)». If the agent reviews internally anyway,
   nothing breaks — the harness review still runs.
4. `reviewMode: "builtin"` = previous behaviour (no harness review; internal sub-agents are only visualised).
Session role `reviewer`; reviewers are nested under their worker in the UI; their transcripts stay.

## Model catalogue that survives renames (no code changes when model ids change)

- Base id: models are compared without the context suffix (`-<n>k|m`): `/models` says `DeepSeek-V4.1-Flash-1017-262k`,
  the CLI and configs `DeepSeek-V4.1-Flash-1017`. `merged()` keeps ONE entry per base id (id = the config id if any,
  else the discovered one; label from the config; `context` from the discovered id); availability, the pinned-model
  check and the grade omission all match by base id. The committed config has no default grades (an unknown grade id
  crashes GigaCode); grades are chosen in Settings from the discovered catalogue.
- Approval modes: `agents.<id>.approvalModeMap` (gigacode/qwen default `{ "auto": "auto-edit" }`, headless GigaCode
  refuses plain `auto` without an action sandbox) is applied to the headless and ACP argv; the session keeps its
  chosen mode and gets `effectiveApprovalMode` (what the CLI ran with). `agents.<id>.autoSandbox`:
  `null | "workspace" | "workspace-offline"` — when set, `auto` is not mapped and the run settings get
  `{ tools: { sandbox } }` (VERIFY: the sandbox restricts tools to the workspace, so includeDirs/worktrees outside the
  cwd may be blocked). Both are in `/api/settings`. `GET /api/agents/:id/info` and `--print-config` add
  `identity: { found, source }` (the shim the identity came from; never the value).

- Sources, merged and deduped by id: (1) **discovered** — the harness runs the agent CLI headless with
  `agents.<id>.modelsDiscovery.prompt` (gigacode default `"/models"`) in `<dataDir>/chats/discovery`, takes the final
  text (`result` / assistant text) and extracts model ids with a tolerant parser (markdown table / list / plain lines;
  token = letters/digits/`.`/`-`, contains a digit and a `-`, 4–80 chars; optional context like `262k`/`128k` nearby) or
  with `modelsDiscovery.pattern` (regex with a capture group) when set; result cached in `db.agentMeta[agent].catalog =
  { models: [{id, context?}], at, error? }`; (2) **seen** — models from `system/init` events; (3) **config**
  `agents.<id>.models` — only labels/descriptions/order (overrides), not the source of truth.
- Each merged entry: `{ id, label?, context?, description?, available: boolean | null }` — `available = false` when a
  fresh discovery exists and the id is not in it (shown greyed «недоступна», never silently dropped); `null` when no
  discovery yet.
- Discovery triggers: lazily when `/api/agents/:id/info` or `/api/state` is requested and the catalogue is older than
  `modelsDiscovery.maxAgeHours` (default 24) — in the background, never blocking the request; `POST /api/agents/:id/models/refresh`
  (UI buttons) → `{ models, at, error? }`; automatically after a turn fails with "is not present in the current backend
  catalogue" (or `modelsDiscovery.missingPattern`). Discovery runs at most one at a time per agent; failures are kept in
  `catalog.error` and shown, never fatal.
- Robust runs: when writing the per-session settings.json, grades whose model is known-unavailable (`available === false`)
  are omitted (the CLI falls back to its default) and a ⚠ system note is added once per session; a session whose `model`
  is known-unavailable gets the error card instead of a doomed spawn only if discovery is fresh — otherwise the turn is
  attempted (the catalogue may be stale). A "model not present" failure produces a Message with
  `action: 'pick-model'` so the UI can offer the picker + «Повторить».
- `/api/agents/:id/info` returns `catalog` (`{ at, error }`) and the merged `models`; `/api/state` agents[].models is the
  merged list. Free-text model ids are always accepted (PATCH session.model, settings).

## GigaCode authorization (first run on a machine)

GigaCode asks to log in through the browser / a link on first use. Behaviour of headless `-p` when not logged in is
NOT confirmed (it may print a URL / device code and wait for the browser callback, or fail). The runner therefore:
- scans stdout non-JSON lines and stderr (before the first JSON event) for an URL on a line that also matches
  `/auth|login|oauth|device|verif|sign.?in|авториз|войд|вход/i` (or the next line has a short code like `ABCD-EFGH`);
- on detection: `session.phase = 'auth'`, a system message `{ kind: 'system', text: '🔑 GigaCode ждёт авторизацию…', link: <url> }`
  (field `link` on Message), a notification `{ kind: 'info', text, sessionId, link }`, `db.agentMeta[agent].auth = 'required'`;
  the first-event timeout is suspended and replaced by `agents.<id>.authTimeoutMs` (default 600000) — after login the run
  continues by itself; a later `system/init` sets `auth = 'ok'`.
- `GET /api/agents/:id/info` adds `auth: 'ok' | 'required' | 'unknown'`.
- Login from the UI: Settings → «Войти в GigaCode» = `POST /api/sessions { kind: 'terminal', agent: 'gigacode', title:
  'Вход в GigaCode', cwd: <dataDir>/chats/login }` — the interactive CLI in a PTY (links clickable via xterm web-links).

## Worktree management and cleanup (Orca-like context menu)

- `GET /api/workspaces/:id/worktrees` items are enriched: `{ path, branch, head, main, dirty: number (changed files),
  ahead: number (commits not in git.defaultBase / the task's targets[0]), taskId: string|null, taskStatus, pr: {state,url}|null,
  sessions: number, running: number, lastActivityAt: number|null, meta: { label?, note?, pinned?: boolean,
  sleeping?: boolean } }` (git data computed in parallel with a short cache; meta from `db.worktreeMeta[path]`).
- Scale (≈10 repos × 10–20 worktrees): the list is cheap by default — one `git worktree list` + meta + session counts +
  task/PR from the db; `dirty`/`ahead` are `null` and `enriched: false` unless `?enrich=1` (or a fresh cache entry
  exists). `GET /api/worktrees/info?path=` enriches one registered worktree. Enrichment: per-path cache 30 s, at most 4
  computations (git processes) at a time; nothing is enriched at startup; the PR refresh walks tasks one at a time.
  `lastActivityAt` = newest of the worktree's sessions' activity, the mtime of its `logs/HEAD` reflog (else `HEAD`) and
  — when enriched or cached — its newest commit time (`git log -1 --format=%ct`); never the index mtime. Every git child
  runs with `GIT_OPTIONAL_LOCKS=0`, so reads (status, diff, log, …) never refresh/rewrite the index. A session's
  `workspaceId` = the git repository whose worktree list contains its cwd (worktrees usually live outside the repo
  folder), else the deepest registered folder; on startup one pass (cached worktree lists) moves existing
  non-archived sessions attached to a folder workspace to the repository that owns their worktree (count logged).
  Every session also has `worktreePath` (the worktree root containing its cwd — a sub-folder included — by longest prefix
  over the registered repositories' worktree lists, case-insensitive on Windows; null at a projects folder or a plain
  folder) and `system: true` for anything under the harness data folder (login terminal, model discovery, default chat
  folders): no workspace, no worktree, never grouped under a project. The startup pass recomputes all three.
  Feature flag `worktree-lazy`.
- `PATCH /api/worktrees/meta { path, label?, note?, pinned?, sleeping? }` → meta. `sleeping: true` stops terminal PTYs
  in that cwd (chat sessions are idle between turns anyway; a running turn is NOT killed — 409 unless `force`).
- `DELETE /api/workspaces/:id/worktrees { path, force?, deleteBranch?: 'no'|'safe'|'force' }`: refuses the main worktree
  (400); refuses with 409 `{ dirty, ahead, running }` when there are uncommitted changes, unpushed/unmerged commits or a
  running turn and `force` is not set; otherwise stops all sessions in that cwd (terminals closed, running turns killed),
  marks them `archived: true` (hidden from the sidebar, transcripts kept; `GET /api/state` still returns them),
  removes the worktree safely (`git worktree remove --force` → `prune --expire now` → rename to `.stale-<ts>` → rm),
  then optionally `git branch -d` (`safe`) / `-D` (`force`); the task keeps its log, `task.branch` is kept for history.
  → `{ removed: true, branchDeleted: boolean, archivedSessions: n }`.
- `POST /api/open { cwd, target: 'explorer' | 'ide' }`: launches the OS file manager (`explorer.exe` / `open` / `xdg-open`)
  or `config.ide = { command, args: ["{path}"] }` (default null → the IDE item is hidden) detached, no shell, path validated
  to be a registered workspace or one of its worktrees.
- Session field `archived: boolean`.

## Runs survive a harness restart

An agent turn is spawned detached (`detached: true`, `windowsHide: true`) with stdout/stderr redirected to files
`runs/<sid>/turn-<n>.out.ndjson` / `.err.txt` (not pipes), and the harness tails the stdout file (fs.watch + poll,
partial-line buffer, byte offset persisted on the session as `turnOffset`). The pid is persisted. On startup, a session
left `running` whose pid is still alive and whose turn file exists is re-attached (tail resumes from the saved offset; a
system note "переподключено после перезапуска" is added); liveness is polled (process.kill(pid, 0)) since a re-attached
process is not our child — the turn ends at the `result` event or when the pid disappears (no result → error from the
.err file tail). If the pid is gone, the remaining file is drained once and the turn finalized. Harness shutdown never
kills agent turns (terminal PTYs are still closed). Stop still kills the tree by pid. Turn files are deleted with the session.

Task field `pr: { index, state, url, updatedAt } | null` is refreshed for tasks that have a `branch` and a workspace when
`integrations.pr.refreshSec` > 0 (min 30) and a UI client is connected; only changes are broadcast.

`GET /api/tasks/:id/external` also returns `links: [{ type, from, to }]` (onework `listLinks`); `decomposition` links whose
`from` is this task are its children. `POST /api/tasks/:id/import-children` imports those child keys (getIssue each) as tasks
with `parentId` = this task and the parent's workspace/targets, deduped by externalId → `{ imported, updated }`.

## Agent-internal sub-agent registry (read-only compatibility)

Some task commands (e.g. `/full-task-ui`) run their own internal sub-agents and write a registry into
`{registryDir}`: `<registryDir>/<agentId>/agent.json` (one object) + `log.jsonl` (append-only events).
The harness only READS it (poll every 2 s while the session is running, on demand otherwise) and shows these as
read-only rows nested under the session (`GET /api/sessions/:id/subagents`, WS `{ t: 'subagents', sessionId, items }`).
`agent.json`: required `id, name, startedAt, state`; `state` ∈ `queued working restarting compacting waiting blocked
idle done failed interrupted unverifiable`; optional `model role parentId worktree lastText lastActivity
activity{tool,since} tokensIn tokensOut settledAt`. Reader rules: broken record → skipped (counted in a
`problems` list, never crash); `working` whose `lastActivity` (or `startedAt` if null) is older than
`session.idleWindowSec` (default 90) → shown as `unverifiable` (file never rewritten); terminal states without
`settledAt` are flagged; tokens default to 0. Timestamps are ISO-8601 strings (epoch numbers accepted). The tail of
`log.jsonl` gives `lastEvent: { ts, event, state, note, tool }` and `lastText` falls back to its `note`. Item fields:
agent.json fields + `flags: string[]` + `lastEvent`. These rows are separate from harness workers (which are real
sessions with their own chats).

## Board ↔ tracker semantics

- Task fields added: `externalStatus: string | null` (raw tracker status), `statusManual: boolean` (set when a
  human moves the card; import then never overwrites `status`), `hidden: boolean`, `takenAt: number | null`,
  `snapshot: { title, description, externalStatus, at } | null` (frozen when taken into work).
- Board = (imported, open, assigned to me) ∪ (taken into work through the harness, kept even if the tracker stops
  returning them) ∪ local tasks, minus `hidden`. Imported tasks whose status is in `integrations.tasks.closedStatuses`
  are not added (existing ones are kept). `DELETE` of an imported task = `hidden: true` (re-import keeps it hidden);
  local tasks are really deleted. Search by key also finds hidden/closed ones; UI has a "show hidden" toggle.
- Column comes from `statusMap(externalStatus)` on import unless `statusManual`. Moving a card NEVER changes the
  tracker; changing tracker status is an explicit action: `GET /api/tasks/:id/transitions` then
  `POST /api/tasks/:id/tracker-status { transition, comment? }` → `transitionTask()` in `server/integrations/tasks.js`.
- onework (`format: "onework-markdown"`): the tools answer MARKDOWN. Import = `tools.find` with
  `{space_code: <space>, assignee: "me", page_size: 100, page_number: n}` while `has_next` (≤ 20 pages, stops at `limit`),
  lines `N. **<KEY>** — <summary> [<status> | <priority>] @<assignee>`; closed statuses filtered on our side; no
  description in the list → `GET /api/tasks/:id/external` fetches it lazily. Tool errors arrive as text
  (`reported tool error`, `{"error":"…"}`) and become errors with the inner message.
### Board columns follow the team workflow (configurable)

The internal statuses stay the 5 semantic values (`backlog todo in_progress review done`); the board shows a configured
subset with team labels and owns the tracker mapping. Default (the user's workflow: take → in progress → testing, and back
for rework):
```jsonc
"board": {
  "columns": [
    { "status": "todo",        "label": "К работе",     "trackerStatuses": ["todo"] },
    { "status": "in_progress", "label": "В работе",     "trackerStatuses": ["development", "to_code_review", "code_review", "discover_issue"] },
    { "status": "review",      "label": "Тестирование", "trackerStatuses": ["qa", "ready_for_ift", "ift", "ready_for_uat"] }
  ],
  "onWorkerDone": "stay",          // "stay": the task keeps its column, card gets an agent badge; "review": move to review
  "moveSyncsTracker": false,       // when true, dropping a card into a column (and "take into work") transitions the tracker
  "columnTransitions": {}          // optional explicit transition id per status, e.g. { "review": "qa" }
}
```
- Statuses not listed in `columns` (backlog, done by default) are hidden behind «Показать все статусы»; the import maps
  tracker statuses through `columns[].trackerStatuses` (this replaces `integrations.tasks.statusMap`, which stays as a
  fallback for unknown statuses → `todo`); closed statuses are not imported as before.
- Agent badge on a task: `task.agentState: 'running' | 'waiting' | 'done' | 'failed' | 'reviewing' | 'approved' |
  'changes_requested' | null` (derived from the assignee session and the harness review loop, broadcast with the task).
  `worker_done` with `onWorkerDone: "stay"` keeps the column (failed no longer moves the task back to todo either).
- Tracker sync on move (opt-in, `moveSyncsTracker`): after a move of an imported task into column C (by the user, or
  in_progress by "take into work" — this supersedes `integrations.tasks.onStartTransition`, kept as an alias), the
  harness loads the task's available transitions (`getIssueMeta`) and picks `columnTransitions[C.status]` if available,
  else the first transition whose TARGET status (the parenthesised status in `- \`id\` → name (\`status\`)`) is in
  `C.trackerStatuses`; calls `updateIssueStatus`; on "no suitable transition" or an error the board move stays, a ⚠ line
  goes to the task log and a notification with the reason is sent (no silent tracker writes, no rollback of the card).
- `/api/settings` exposes and accepts `board` (validated: statuses ∈ the 5 values, unique, ≥ 1 column, labels non-empty).

- Periodic sync: `integrations.tasks.refreshSec` (0 = off, min 10) while at least one UI client is connected;
  only changed tasks are broadcast (signature = key + status + title). On failure the board keeps the local snapshot
  and `GET /api/state` → `integrations.tasksProblem: { error, at } | null` is shown as a banner ("tracker unavailable,
  showing snapshot from HH:MM"). JSON format: `limit` goes into the tool args (server-side limit).
- `integrations.tasks.space` is a space code or an array of them: the sync walks every space (`assignee: "me"`, paged)
  and merges by key; /api/settings accepts both forms (the key stays `space`).
- `POST /api/tasks/import { ref }` (flag `tracker-import`): `ref` = a key (`PROJ-1234`) or any tracker link containing
  one (`/([A-Z][A-Z0-9_]+-\d+)/`) → `tools.get` → upserted as an imported task (deduped by externalId, status via
  columns/statusMap, description from the issue markdown, externalUrl from `urlTemplate`, else the given link), also
  when it is not assigned to me; returns the task. onework-markdown only (else 501).

## Console MCP: servers, secrets and failures
Three separate MCP layers — never mix them:
1. **Console MCP** (the harness itself reads the tracker / creates PRs): server definitions come from
   `config.mcpServers` merged over the `mcpServers` of `config.mcpServersFrom` (default `~/.gigacode/settings.json`,
   env override `CONSOLE_MCP_SETTINGS`; a missing file is fine). Tracker access goes through the `onework` server
   (tools `sbertrack_findIssues`, `sbertrack_listLinks`, `sbertrack_getIssue`, `sbertrack_getIssueMeta`,
   `sbertrack_updateIssueStatus`, `sbertrack_getUser`). Never call the standalone `sbertrack` server for reading
   tasks (it answers 403). PRs go through `sourcecontrol`.
2. **Agent MCP** (what GigaCode sees in its run): only via the per-session settings.json `mcpServers`
   (`harness` + `agentMcpServers`), plus whatever the user has in `~/.gigacode/settings.json`.
3. **Extension mapping**: tool names differ per provider (prefixes), so which tool does find / get / meta /
   transition / links / me is config data (`integrations.tasks.tools`), never hardcoded.

Secrets:
- Server entries in `mcpServersFrom` use the gemini/qwen format: `{ type: "http", url, headers }` or `{ httpUrl }` → http,
  `{ command, args, env }` → stdio.
- Secrets file: `HARNESS_MCP_SECRETS` || `CONSOLE_MCP_SECRETS` || `config.mcpSecretsFile` || `<dataDir>/mcp-secrets.json`.
  Formats: JSON `{ "<name>": "<value>" }`, or text lines `server/Name=value` (`#` comments, split on the first `=`), or a
  single bare value (no `=`) which means `onework/Authorization`. Names `scope/header` and `scope_header` are equivalent.
  A `server/Name` secret goes to THAT server: `headers[Name]` for http, `env[Name]` for stdio.
- Config string values (env, headers, args, url) may reference secrets: `${env:NAME}` (process env, else secret NAME)
  and `$secret:scope/header` / `${secret:scope/header}`. Resolved at call time; never logged, never returned by an API.
- Every secret is also exported to stdio MCP children and agent processes as `MCP_SECRET_<NAME>`
  (`/` → `_`, e.g. `MCP_SECRET_onework_Authorization`).
- A server with a missing secret stays in the list with `problem: "missing secret <name>"`; other servers keep working
  (never a 401 that wipes the whole map).
- stdio servers: connect per call (spawn → initialize → call → close); timeout per call.
- `node server/index.js --print-config` prints the resolved config: paths (and whether they exist), approval modes,
  refresh period, which secrets are present (names only, never values). On startup, any config string that looks
  like a token/password (long high-entropy value under a key like token/secret/password/authorization) is a loud warning.
- `HARNESS_CONFIG` env selects the config file (default `harness.config.json` + `.local`), so work and test
  configs never mix.

## Where a chat runs: projects folder, any folder, extra directories

- **Projects folder** (`workspaces.root`): when null, auto-detected as the deepest common parent of ≥ 2 registered
  workspaces (shown as «Авто» in Settings). It is a first-class *folder workspace* (`{ id, name, path, isGit: false,
  kind: 'root' }`, created/updated on startup) listed first in the sidebar as «Все проекты (<dirname>)». A chat there
  sees every project under it (the CLI's typical "run in the projects folder" usage). Default location for «Новый чат»
  when nothing is selected.
- **Any folder**: `GET /api/fs/dirs?path=` → `{ path, parent, entries: [{ name, path }], roots: string[] }` (Windows:
  drive letters as roots; POSIX: `/` and `~`; directories only; hidden dirs skipped unless `?hidden=1`; token-protected
  like everything else). `POST /api/workspaces { path, kind: 'folder' }` registers it (non-git allowed) and the chat
  starts there. `db.prefs.recentFolders` (last 10) returned by `/api/state` as `recentFolders`.
- **Extra directories** (GigaCode `--include-directories` / `--add-dir`, the headless form of the interactive `/dir add`):
  session field `includeDirs: string[]` (absolute, existing dirs, de-duplicated, excluding cwd and its ancestors).
  The gigacode/qwen/gemini launchers add `--include-directories <dir>` once per dir on EVERY turn (each turn is a new
  process, so changes apply from the next message; claude launcher: `--add-dir <dir>`). Editable via
  `PATCH /api/sessions/:id { includeDirs }`. Auto-fill: a task worker's `includeDirs` = the repos (or existing task
  worktrees) of the other subtasks of the same parent task + the parent task's explicit `includeDirs`; a coordinator at
  the projects folder needs none. Terminal sessions with an agent CLI get the same flags at start.
  `POST /api/sessions` accepts `includeDirs`. Feature flags: `folders`, `include-dirs`.
- Implementation notes: the root workspace's `name` is the folder name (the UI adds «Все проекты»); auto-detection uses
  repository workspaces only (not `kind: 'folder'` ones) and is redone when workspaces are added/removed; a session's
  `workspaceId` is the DEEPEST registered folder containing its cwd. Hidden = names starting with `.` or `$`.
  `recentFolders` is updated by `POST /api/workspaces { kind: 'folder' }` and by `POST /api/sessions` with an explicit
  cwd. The parent task's own extra folders: `PATCH /api/tasks/:id { includeDirs }`. Invalid `includeDirs` from the API →
  400; auto-filled ones that no longer exist are dropped silently.
- `/api/settings` returns and accepts `workspaces: { root, repos }` (root: an existing absolute folder or null = auto;
  repos: string[]) and returns `rootResolved` (the projects folder in use) + `rootAuto`; saving re-registers the
  configured repos, re-runs the projects-folder detection and broadcasts `workspaces`.

## Agent questions and permission requests

**Questions.** (a) harness `ask` (MCP) — already: question + `options`, `waitingFor: 'answer'`, answer delivered as the next
message. (b) The CLI's own structured question tool: tool_use names listed in `agents.<id>.questionTools` (gigacode default
`["ask_user_question", "ask_user", "AskUserQuestion"]`, VERIFY the real name) are normalized to a Message
`{ kind: 'question', question: { id, text, options: [{label, description?}], multiSelect } }` + `waitingFor: 'answer'`;
whatever the CLI returns for that call in headless is hidden; the user's choice is delivered as «Ответ на вопрос «…»: …».
(c) The harness context block tells the agent: «вопросы человеку — через mcp__harness__ask (варианты в options), затем заверши ход».

**Permissions, headless transport (default).** The CLI cannot wait for a confirmation in `-p` mode, so it denies. The
normalizer detects a denied tool call (tool_result `is_error` whose text matches `agents.<id>.denialPattern`, default
`/(requires? (user )?(approval|confirmation)|not allowed|denied|permission|подтвержд|запрещ)/i`, VERIFY real wording) and
emits a Message `{ kind: 'permission', permission: { id, tool, input, reason, transport: 'headless',
options: [{id:'allow_once',label:'Разрешить один раз'}, {id:'allow_session',label:'Разрешать в этой сессии'},
{id:'reject',label:'Запретить'}] } }`, session `waitingFor: 'permission'`. `POST /api/sessions/:id/permission
{ permissionId, optionId, note? }`: allow_once → next turn with approvalMode one step more permissive
(`plan→default→auto-edit→auto`, from `approvalModes` order) for that turn only + message «Разрешаю: выполни <tool> <input
summary>»; allow_session → PATCH session.approvalMode to that mode + same message; reject → message «Не выполняй это
(<tool>); найди другой путь или спроси». The card shows the resolved choice afterwards.
**Superseded on the target (confirmed: `auto` runs as `auto-edit`, which never allows `run_shell_command`, so escalation
has nowhere to go) — headless permissions are an allow-list now:** the denial text `requires permission to use "<tool>"`
gives the tool; the card carries `permission.pattern` (shell → `run_shell_command(<first non-cd command word>)`, e.g.
`cd /d X && git status` → `run_shell_command(git)`; other tools → the tool name), `answered`/`resolved`/`resolvedAt`.
allow_once → a one-turn grant (`session.grantsOnce`, consumed by the next turn); allow_session → `session.allowedTools`
(PATCH `/api/sessions/:id { allowedTools }` edits it); both deliver «Разрешено: повтори <tool> <input summary>» (queued if
the turn still runs). Every headless turn passes `agents.<id>.allowedTools` (Settings «Разрешённые команды») ∪
`session.allowedTools` ∪ the one-turn grants as `agents.<id>.allowedToolsFlag` (gigacode/qwen default `--allowed-tools`,
VERIFY) repeated per entry (`allowedToolsJoin: "comma"` joins them). The approval mode is escalated only for an edit tool
in plan/default mode. A sub-agent's denial is re-emitted in the PARENT chat (`from` = the sub-agent session,
`permission.fromSubSessionId`, text «субагент <type>: <tool>»); the grant applies to the parent's next turn. A repeated
stderr warning is one ⚠ message per session with a `count`; the init MCP statuses are kept as `session.mcpStatus`.

**Permissions, ACP transport (`agents.<id>.transport: "acp"`, VERIFY for GigaCode `--acp`).** One long-lived process per
session (`<cli> --acp [--approval-mode m] [--model m] [--include-directories …]`), JSON-RPC 2.0 over stdio (ndjson):
`initialize` (clientCapabilities fs.read/write true, terminal false) → `session/new {cwd, mcpServers:[harness + agentMcpServers]}`
(or `session/load {sessionId}` when the agent supports loadSession and we have externalSessionId) → per message
`session/prompt {sessionId, prompt:[{type:'text',text}]}`; `session/update` notifications map to the same Messages
(agent_message_chunk → assistant text delta, agent_thought_chunk → thought, tool_call/tool_call_update → tool, plan →
system plan note); `session/request_permission {toolCall, options[{optionId,name,kind}]}` → a `permission` Message with
the agent's options (`transport: 'acp'`), the JSON-RPC request is held until `POST /api/sessions/:id/permission`
answers `{outcome:{outcome:'selected', optionId}}` (or `cancelled` on Stop); `fs/read_text_file` / `fs/write_text_file`
served inside cwd/includeDirs; Stop → `session/cancel`; the process is restarted lazily if it dies (load or new session +
a system note). Same identity/launcher resolution as headless. A mock ACP agent (`scripts/mock-acp-agent.js`) covers tests.
Feature flags: `questions`, `permissions`, `acp`.

Implementation status: questions (a–c), headless permissions and the ACP transport are implemented (flags `questions`,
`permissions`, `acp`; `server/acp.js`, `scripts/mock-acp-agent.js`). ACP notes: the process is spawned with stdio pipes
(it cannot outlive the harness), stderr goes to `runs/<sid>/acp.err.txt`, `initialize` must answer within
`firstEventTimeoutMs`; `session/update` replays during `session/load` are dropped (the transcript already has them); a
failed load or an agent without `loadSession` → `session/new` + a system note; diff content becomes `--- path / +++ path`
with the whole old/new text (no minimal hunks); a Stop marks open ACP cards `resolved: 'cancelled'`; an ACP answer is not a
new message (the agent continues the same prompt) and a late answer → 409. `session.pid` stays null for ACP turns, so
`stalled` does not apply to them. A running ACP turn at a harness restart is `interrupted` (recovery); the next message
starts the process again with `session/load`. Notes: the question card's answer is an ordinary message
(`POST /api/sessions/:id/messages` with «Ответ на вопрос «…»: …»); any delivery to the session clears `waitingFor`
'answer'/'permission'. A permission answer also sets `permission.resolved` (+ `resolvedAt`) on the card; a second answer →
409; `note` is appended to the delivered message. allow_once sets `session.approvalOnce` (consumed by the next turn).
The mock agent has `#deny <tool>` and `#question <q> | <option> | …`.

## CLI session history (sessions started outside the harness)

GigaCode records chats (`chatRecording: true`) — VERIFY location/format; expected Gemini/Qwen-style
`~/.gigacode/tmp/<projectHash>/chats/*.json` (`{ sessionId, projectHash, startTime, lastUpdated, messages: [{ id,
timestamp, type: 'user'|'gemini'|'assistant'|…, content, toolCalls?, thoughts?, model?, tokens? }] }`, projectHash = sha256
of the project root path), or via `gigacode sessions …` (VERIFY subcommands, e.g. a JSON list).
- Config `agents.<id>.history: { dirs: ["~/.gigacode/tmp/*/chats"], command: null }` (glob of chat dirs; or a CLI command
  returning JSON); tolerant reader: any JSON/JSONL file with a session id + messages array; unknown shapes are listed with
  `raw: true` (title from the file name) instead of failing.
- `GET /api/history?cwd=` → `[{ id, agent, cwd, title (first user message, 80 chars), startedAt, updatedAt, messages,
  model, file, linkedSessionId }]` for sessions whose project path (from the record, or projectHash = sha256(path) of the
  cwd and its worktree root) matches; cached by file mtime; `GET /api/history/:agent/:id/messages` → Messages (same
  shapes as transcripts; user/assistant/thought/tool, read-only).
- `POST /api/history/:agent/:id/continue { cwd }` → creates (or returns the existing linked) harness chat session with
  `externalSessionId = id`, that cwd and agent, transcript pre-filled from the history (marked imported), so the next
  message runs `--resume <id>`; `linkedSessionId` is set. Feature flag `cli-history`.
- Implementation (`server/history.js`): `dirs` globs allow `*` in any folder segment; `*.json`/`*.jsonl` files are read;
  a record's own `cwd`/`projectRoot` wins over the hash; the hash is checked for the cwd and its main worktree (on
  Windows with both drive-letter cases); a JSON record without `projectHash` uses its `<hash>/chats` folder name. CLI
  `info`/`error` entries are skipped; thoughts `{ subject, description }` become one thought message each; tool calls use
  `displayName`/`args`/`resultDisplay`. Imported messages carry `imported: true` and turn 0; the chat gets `historyId`.
  `history.command` (a CLI listing) is accepted in the config but not run yet — waiting for the real `gigacode sessions`
  output (VERIFY, GIGACODE-FACTS open question 12).

## Session activity states (what the UI shows)

Session gains `lastEventAt: number | null` (last stdout event of the current turn), `waitingFor: 'answer' | 'auth' | null`
(set when the session called `ask` and no reply was delivered yet, or phase auth), and `stalled: boolean` (server-side:
running AND phase !== 'auth' AND no event for `session.stallSec` (default 300, in /api/settings) while the pid is alive;
re-evaluated every 15 s; flips are broadcast). Derived UI state, in priority order:
`waiting_answer` (waitingFor) → `stalled` → `starting` (phase starting/auth) → `running` → `error`/`failed` → `stopped` →
`done` (worker_done done) → `exited` (terminal) → `idle` (turn finished, ready for the next message).
Implementation: `waitingFor` may also be `'permission'` (headless denial card); `/api/settings` exposes and accepts
`session: { stallSec }` (integer ≥ 30); the re-check period is `session.stallCheckSec` (config only, default 15); any event
clears `stalled`; `lastEventAt` is not broadcast on its own (it rides on the next session frame). Feature flag `activity`.
- The turn ends for the user at `result`, not at process exit (GigaCode lingers for many seconds after `result`: MCP
  servers shutting down, chat recording, telemetry): status → idle (or done/failed as before), phase null,
  `turnClosing: true` while the process is still alive; the post-turn logic (auto-report escalation, review loop) runs
  then. The process stays tracked: a queued message waits for its exit, at most `agents.<id>.exitGraceMs` (default 8000)
  after `result`, then the tree is killed (guarded, killReason `post_result_linger`) and the next turn starts; the
  linger duration is logged to `runs/<sid>/stderr.log`. Stop on a lingering process only ends it (no «Остановлено»).
- `lastEventKind`: `text_delta` | `assistant_final` | `thought` | `tool_running` | `tool_done` | `result` (session frames
  are sent when it changes) — the UI says «Завершает ход…» instead of «Пишет ответ».

## Nothing is lost on restart (harness, browser, PC)

Durable state (all in `<dataDir>`, atomic writes):
- `db.json` + rotating `db.json.bak` (last good copy, written before each replace); on startup a corrupt/unparsable
  `db.json` is replaced by the `.bak` with a notification «восстановлено из резервной копии»; transcripts likewise
  (`<sid>.json` + `.bak`). Debounce ≤ 250 ms; flush on every turn end, on shutdown, and synchronously on SIGINT/SIGTERM.
- Session delivery queue is persisted (`session.queue: [{ id, from, text, at }]`, not only a count); after a restart,
  queued deliveries of idle sessions are sent, those of re-attached running sessions wait for the turn end as before.
- Re-attach identity: at spawn the harness records `pidStartedAt` (Windows: process creation time via
  `Get-CimInstance Win32_Process` / `wmic` fallback; Linux: `/proc/<pid>/stat` starttime + boot time; macOS: `ps -o lstart=`);
  implementation: the stamp at spawn is `Date.now()` on Windows/macOS (equal to the creation time within the tolerance, no
  PowerShell per turn) and the `/proc` value on Linux (same clock on both sides); the OS query runs only on startup and
  before a Stop of a re-attached turn (cached 10 s);
  on startup a `running` session is re-attached only if the pid exists AND its start time matches (±2 s); otherwise the turn
  is finalized from the remaining output file (or marked interrupted with a system note) — a reused pid is never adopted
  and never killed. Stop on a re-attached session re-checks identity before killing. What orchestration already handled in
  the turn (`worker_done` → `session.turnFlags`) is persisted, so a re-attached turn is never reported twice.
- Single-instance lock: a live pid in `server.json` is a conflict only if `GET <url>/api/health` (new, unauthenticated,
  returns `{ ok, pid, dataDir }`) answers from that pid within 1 s; otherwise the lock is stale and taken over.
- Orchestration waits: `worker_run`/`agent` waits are stateless on the server (the worker session persists `parentId`,
  `waiter: true`, and its `report: { status, summary, at }`); `mcp/harness-mcp.js` keeps long-polling `worker_wait` with
  backoff across server restarts until the overall timeout, so the orchestrator's tool call survives a harness restart.
  Every `worker_done` stores `session.report` (it replaced `runResult`). Agent runs get `HARNESS_SERVER_JSON`: harness-mcp
  reads the current URL from it on every call (a restarted harness may listen elsewhere); no file = harness down → retry
  (`HARNESS_RETRY_MS`, default 2 min; only requests that never reached the server are repeated, worker_wait always).
- Review loop / ports state (`task.review: { round, reviewerSessionId, verdicts[] }`, `task.ports[]`) persisted; a reviewer
  that finished while the harness was down is picked up on startup (its report is in the transcript/report field).
- Terminals: history persists (`terms/<sid>.log`); PTY processes cannot outlive the server, so on startup every terminal
  that was alive is respawned automatically in the same cwd (system line «— перезапуск harness: новая сессия терминала —»
  appended to its log); a terminal whose initial command was an agent CLI with a continue flag is respawned with it
  (`agents.<id>.continueArgs`, gigacode default `["-c"]`). `terminal.autoRespawn` (default true). A plain shell's own
  initial `command` is not re-run (it may have side effects). Feature flag `health`.
- UI: drafts (composer per session, commit title/body per cwd, PR dialog per cwd+base, task drawer edits) persist in
  localStorage (try/catch, cleared on send/commit); open screens/tabs/panels/scroll per worktree persist as now.

## Nothing looks frozen (git prompts, network timeouts, progress)

- Every git child gets `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=` and `GIT_SSH_COMMAND` = the
  existing one or `ssh -o BatchMode=yes -o ConnectTimeout=15`. Network operations (push) run with
  `-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=<networkTimeoutSec>` (git aborts stalled HTTP itself), in their own
  process group on POSIX, settle on 'exit' (a surviving `git-remote-http` may keep the pipes open) with a hard deadline
  5 s after the kill; POSIX kill = SIGTERM to the group, SIGKILL to the group 3 s later. They are killed (whole tree) after
  `git.networkTimeoutSec` (default 120) → 504 «Нет ответа от удалённого репозитория за N с»; a credentials/ssh-key
  failure → 401 «Git требует авторизацию — выполните push в терминале этого рабочего дерева» (+ git's text).
- Progress without API changes: a request with header `x-job-id: <8–64 chars [\w-]>` runs as a job; the server sends
  WS `{ t: 'job', id, title, step: null, at }` at once, `{ t: 'job', id, title, step, progress?: { done, total }, at }` at
  meaningful steps and a final `{ t: 'job', id, title, done: true, error?, at }`. Titled operations: tracker sync (per
  page), take into work (agent check → worktree → session), rework, port (worktree → cherry-pick 0/n…n/n → conflict
  worker), PR create (existing PR lookup → create), push, checkout, worktree removal (sessions i/n → git), models refresh,
  import children (per child). Steps of background work after the response are dropped.
- Event loop: SDD polling is async; transcripts are serialized per message (a streaming update re-serializes one message,
  not the whole transcript) and `.bak` copies are refreshed at most every 10 s; registry polling reads only small files.

## Images and large tool outputs in chats

- `GET /api/fs/raw?cwd=&path=` (flag `fs-raw`) streams an image for a thumbnail: png/jpg/jpeg/gif/webp/svg only (else
  400), ≤ 10 MB (413), the path (relative or absolute) must resolve inside `cwd` or an `includeDirs` entry of a session
  in that cwd (same symlink-aware guard as the file routes; outside → 400). Token via `x-harness-token` or `?token=`
  (an `<img src>` sends no headers). Headers: `etag` + `last-modified` (`If-None-Match` → 304), `cache-control: private,
  no-cache`, `x-content-type-options: nosniff`; svg also `content-security-policy: sandbox`.
- The transcript keeps every tool output whole; `GET /api/sessions/:id/messages` returns `tool.output` cut to 64 K
  characters with `tool.outputTruncated: true`; `GET /api/sessions/:id/messages/:mid/output` → `{ output }` (full).

## Tidying up sessions

- `PATCH /api/sessions/:id { archived: boolean, stop?: boolean, title? }`: archiving a working session (a running turn or
  a live terminal) → 409 unless `stop: true` (stop, then archive); archived sessions stay in `/api/state` with
  `archived: true, archivedAt`; unarchive is allowed; virtual sub-agent sessions follow their parent.
- `sessions.autoArchiveDays` (default 7, 0 = off, in /api/settings as `sessions: { autoArchiveDays }`): on startup and
  hourly, chats that are idle (not running, `waitingFor` null, not `interrupted`, no in-progress task assigned, not a
  coordinator with live workers) and exited terminals whose `lastActivityAt` is older than N days are archived.
- `DELETE /api/sessions/:id` refuses a working session (409) unless `?force=1`; it also removes the virtual children and
  the run files.

## Auto-fill: repository suggestion, readable task log, PR decline

- `task.suggestedWorkspaceId` (flag `task-suggest`), recomputed on every create/update/import while `workspaceId` is
  empty (else null): one repository workspace → it; else a repository whose name or folder name appears as a token in
  the title/description/cached tracker attributes (`task.externalFields` from the last `GET /api/tasks/:id/external`:
  Component/Компонент/Repository/Репозиторий/Сервис/Service), exact first, then the `-service` stem in either direction
  (`payments` ↔ `payments-service`); else `db.prefs.lastWorkspaceBySpace[<key prefix>]` (written when a task of that
  space is taken into work). `POST /api/tasks/:id/start` uses `workspaceId ?? suggestedWorkspaceId` and records it.
- Task log entries: `{ at, by, type, text, data? }`, `type` ∈ created, imported, status, started, agent_done,
  agent_failed, review, rework, port, pr_created, tracker_transition, comment; `text` is human Russian without session ids
  or paths («Взята в работу: GigaCode, ветка feature/T-10», «Агент закончил», «PR #562 в develop создан»); ids, summaries,
  verdicts are in `data`. Old entries have no `type` (show their `text`).
- `POST /api/git/pr/decline { cwd, index }` (flag `pr-decline`) → `integrations.pr.declineTool` (default
  `git_decline_pull_request`) with `integrations.pr.declineArgs` (default `{ project, repository, pullRequestIndex }`,
  project/repository from origin), then the task's PR status is refreshed. Imported tasks are recognized by `task.source`.

### Session recovery after a restart
- On startup, every chat session that was `running` and could NOT be re-attached (pid gone / identity mismatch) gets
  `interrupted: { at, reason: 'harness_restart' | 'reboot' | 'crash', lastActivity: string|null }` (reason: `reboot` when
  the OS boot time is newer than the turn's start, `crash` when the previous harness did not shut down cleanly
  (`server.json` left behind), else `harness_restart`; `lastActivity` = last tool/step summary of the interrupted turn);
  status becomes `idle` with the existing system note; one notification `{ kind: 'recovery', text: 'Прервано сессий: N' }`.
- `GET /api/recovery` → `{ sessions: [{ id, title, cwd, taskId, role, reason, at, lastActivity }], message }` (only
  `interrupted` and not dismissed); `POST /api/recovery/resume { sessionIds, message? }` → delivers the message to each
  (normal queue; continues the same CLI session via --resume), clears `interrupted`; `POST /api/recovery/dismiss
  { sessionIds }` clears it without sending. Config `recovery: { autoResume: false, message: "Был перезапуск, твой
  предыдущий ход прервался. Продолжи с того места, где остановился — сначала проверь текущее состояние рабочего дерева." }`
  (in /api/settings); `autoResume: true` resumes all on startup (coordinators after their workers). Feature flag `recovery`.
- Implementation: a turn whose saved pid is not adopted but whose file already has the `result` (it finished while the
  harness was down) is NOT interrupted. Any delivery to the session clears `interrupted` (it was continued). The turn
  start for `reboot` is `pidStartedAt` (else `lastActivityAt`); boot time = now − `os.uptime()`. `lastActivity` = the last
  tool call («name input…») of the transcript, else the start of the last answer. The notification is sent once per
  startup, after the identity checks.

## Feature flags (client/server version skew)

`GET /api/state` returns `features: string[]` — the optional API groups this server implements, e.g. `sdd`, `subagents`,
`virtual-sessions`, `worker-run`, `pr-status`, `branches`, `fs-search`, `agent-info`, `models-refresh`, `tracker-links`,
`worktree-meta`, `open`, `board-columns`, `review-loop`, `skills-install`, `demo`, `health`. The UI calls an optional endpoint only
when its flag is present (otherwise the feature is hidden or shows «недоступно в этой версии сервера») — no 404 noise.
A server adds a flag in the same commit that adds the route; a test asserts every flag has a route.

## Cross-platform (Windows, Linux, macOS)

- No platform-specific defaults in `harness.config.json`: `shell: null` and `agents.gigacode.command: null` mean "auto":
  - shell: win32 → `powershell.exe -NoLogo -NoExit -Command [Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`;
    others → `$SHELL` (fallback `/bin/bash`, then `/bin/sh`) with `-l`; env `LANG`/`LC_ALL` default to `C.UTF-8` when unset.
  - gigacode command: win32 → `C:/Program Files/.gigacode/bin/gigacode.cmd` if it exists, else `gigacode` on PATH (+PATHEXT);
    others → `gigacode` on PATH, else `~/.gigacode/bin/gigacode`.
  An explicit value always wins; `--print-config` shows the resolved choice and why.
- GigaCode launcher on POSIX: if the resolved command is an executable file that is not a `.cmd`, it is spawned directly
  (no shell; a shebang script sets its own identity env and exit codes are honest) with the same argv after the
  executable; `nodeArgs`/`cliEntry` resolution and identity parsing are Windows-only unless `node`+`cliEntry` are set
  explicitly. Fallback parser for sh shims (`ROOT=…`, `export GIGACODE_PACKAGE_IDENTITY=…`, `"$ROOT/runtime/node/bin/node"`)
  is used only when the direct spawn is not possible. VERIFY the real Linux install layout on a Linux machine.
- Process control: Windows `taskkill /PID <pid> /T /F`; POSIX `process.kill(-pid, SIGTERM)` then `SIGKILL` after 3 s
  (on POSIX agent turns, ACP agents and git network ops are spawned `detached` = own process group). Open folder:
  `explorer.exe` / `open` / `xdg-open`.
- Windows: NO child is ever spawned `detached` (one helper, `spawnOptions()` in runner.js, used by every spawn/execFile):
  DETACHED_PROCESS makes Windows ignore CREATE_NO_WINDOW (`windowsHide`), and GigaCode's own console children (MCP stdio
  servers, the shell tool, node) then each pop up a visible console window. A non-detached child with `windowsHide` gets
  its own hidden console inherited by all its descendants; it is still a separate console (Ctrl+C in the harness
  terminal does not reach it) and it outlives the harness (Node never kills children on Windows), so turns still
  survive a harness restart.
- Never signal a pid that may have been reused (Windows hands pids out again within milliseconds; a stray
  `taskkill /T` or `process.kill` killed agents and git runs of other sessions): a turn kill records `res.killReason`
  ('stop' | 'first_event_timeout' | 'auth_timeout') BEFORE signalling and skips a child that already exited, so the
  turn reports that reason, not the exit code; the first-event timer re-reads the output files before deciding;
  children that exit on stdin EOF (MCP stdio servers, ACP agents) are only tree-killed if still running 2 s later
  (`endChild`); node-pty's Windows `kill()` delayed `process.kill(shellPid)` fallback is disabled (`killPty`,
  patches the private `_getConsoleProcessList`; re-check on a node-pty upgrade) — closing the pseudoconsole ends the
  attached processes.
- Paths always via `path`; `~` expanded; worktree/stale cleanup identical; tests run on Windows and Linux (Node ≥ 22).
- UI: shortcuts use Ctrl on Windows/Linux and ⌘ on macOS (labels adapt); font stacks include Linux fallbacks
  (`"Inter","Ubuntu","Cantarell","Noto Sans"` / `"JetBrains Mono","DejaVu Sans Mono","Noto Sans Mono"`).
- Implementation notes: `config.shell` = `{ command, args, reason }` (a PowerShell setting on Linux/macOS also means
  auto); the terminal gets `LANG`/`LC_ALL=C.UTF-8` only when NEITHER is set. On POSIX a `.cmd` shim is still resolved the
  Windows way (bundled node + cli-entry + identity), anything else executable runs directly. `--print-config` shows
  `shell.reason` and `agents.<id>.command: { command, reason }`. git network operations run in their own process group
  on POSIX so the timeout kills their remote helpers too.
- Settings: `PUT /api/settings { agents: { <id>: { command, node, cliEntry } } }` — `command`: path, argv array or
  `null` (auto); `node` + `cliEntry`: both paths or both null; saved to `harness.config.local.json`. `GET /api/settings`
  returns them with `resolved` (the same `{ ok, command, node, entry, identity: boolean }` as
  `GET /api/agents/:id/info`), so «Проверить» works right after saving.

## Security

- Listen on `config.host` (default 127.0.0.1).
- Reject any HTTP/WS request whose `Host` header is not `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`
  (DNS-rebinding guard). WS also requires `Origin` absent or same host.
- Random token in `<dataDir>/token` (created once). `index.html` is served with
  `<meta name="harness-token" content="...">` injected; every `/api` call and `/ws` needs it.
- No CORS headers. Static files only from `web/dist`. Request bodies capped at 1 MB.
- Secrets for MCP servers only in the secrets file (outside the repo); `data/` and `harness.config.local.json` gitignored.
