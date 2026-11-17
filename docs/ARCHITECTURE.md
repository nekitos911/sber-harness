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
  "shell": { "command": "powershell.exe", "args": ["-NoLogo"] },   // non-win default: $SHELL or /bin/bash
  "defaultAgent": "gigacode",
  "worktreeRoot": null,                 // null => <repo>/../<repoName>.worktrees
  "agents": {                           // key = agent id used everywhere (session.agent)
    "gigacode": {
      "launcher": "gigacode",           // which launcher implementation in server/launchers.js
      "label": "GigaCode",
      "command": "gigacode",            // string (resolved via PATH/PATHEXT) or argv array ["node","C:/.../cli.js"]
      "approvalMode": "yolo",           // passed through to the CLI
      "approvalModes": ["plan", "default", "auto-edit", "yolo"],
      "model": null,
      "settingsEnv": "GIGACODE_CLI_SYSTEM_SETTINGS_PATH",  // env var that points CLI to per-session settings.json (VERIFY)
      "settings": { "chatRecording": true },              // merged into per-session settings.json
      "inheritUserMcpFrom": "~/.gigacode/settings.json",  // copy user's mcpServers into per-session settings
      "firstEventTimeoutMs": 30000,
      "env": {}
    },
    "claude": { "launcher": "claude", "label": "Claude Code", "command": "claude", "approvalMode": "acceptEdits",
                "approvalModes": ["default", "acceptEdits", "plan", "bypassPermissions"], "enabled": false },
    "mock":   { "launcher": "mock", "label": "Mock agent (demo)" }
  },
  "agentMcpServers": {},                // extra MCP servers injected into every agent session (gemini/qwen mcpServers format)
  "mcpServers": {                       // console-level MCP clients (the harness itself calls them)
    "tracker": { "enabled": false, "transport": "stdio", "command": "node", "args": ["scripts/mock-mcp.js"], "timeoutMs": 15000 }
    // http: { "transport": "http", "url": "http://...", "headers": {} }
  },
  "mcpSecretsFile": null,               // null => env HARNESS_MCP_SECRETS or <dataDir>/mcp-secrets.json; { "<server>": { "env": {}, "headers": {} } }
  "integrations": {
    "tasks": { "enabled": false, "server": "tracker", "tool": "list_issues", "args": {},
               "itemsPath": "issues",
               "map": { "externalId": "key", "title": "summary", "description": "description", "externalUrl": "url", "status": "status", "priority": "priority" },
               "statusMap": { "Open": "todo", "In Progress": "in_progress", "Review": "review", "Done": "done" } },
    "pr":    { "enabled": false, "server": "tracker", "tool": "create_pull_request",
               "args": { "repo": "{repo}", "source": "{branch}", "target": "{base}", "title": "{title}", "description": "{body}" },
               "urlPath": "url" }                       // base branch: git.defaultBase
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
                                     // default [git.defaultBase]; hotfix example: ["release-1.54.0", "develop"]
  branch: string | null              // work branch of this task (set when a worktree/branch is created or on assign)
  ports: { target: string, branch: string, cwd: string, status: 'clean' | 'conflict' | 'done' | 'failed',
           sessionId: string | null }[]   // deliveries into targets[1..] (cherry-pick)
  assigneeSessionId: string | null   // the worker session currently/last working on it
  externalId: string | null  // id in external tracker (import dedupe key with `source`)
  externalUrl: string | null
  source: string | null      // integration name, e.g. "tracker"
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
  | 'error'     // could not start (bad command, timeout before first event)

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
    status: 'running' | 'ok' | 'error'
  }
  turn: number                 // turn counter within the session
}

interface Notification {
  id: string, at: number, read: boolean,
  kind: 'question' | 'done' | 'failed' | 'escalation' | 'info' | 'error',
  sessionId: string | null, taskId: string | null,
  text: string
}
```

Persistence (`<dataDir>`): `db.json` = `{ seq: {task}, tasks, workspaces, sessions, notifications }`,
`transcripts/<sessionId>.json` = `Message[]`, `terms/<sessionId>.log` = raw terminal output (ring, last 2 MB),
`runs/<sessionId>/settings.json` (+ `mcp.json` for claude), `runs/<sessionId>/stderr.log`, `token`.
Writes are debounced and atomic (write tmp + rename). On startup, sessions with status `running` become `idle`
(chat) or `exited` (terminal) and get a system message "harness restarted".

## Agent launchers (`server/launchers.js`)

```js
/** @typedef {{ prompt: string, session: Session, agentCfg: object, settingsPath: string, mcpConfigPath: string, harnessMcp: {command: string, args: string[], env: Record<string,string>} }} TurnCtx */
/** @typedef {{
 *   id: string,
 *   buildArgs(ctx: TurnCtx): string[],          // argv after the executable; prompt is ONE element
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
  | { type: 'result', text: string | null, isError: boolean }   // end of turn
  | { type: 'meta', raw: unknown }                       // anything unknown; kept in stderr.log only
```

Launchers: `gigacode`, `qwen`, `gemini` (same argv family: `[--resume <id>] -p <prompt> --output-format stream-json
--approval-mode <mode> [--model <m>]`, per-session settings via env var), `claude` (`-p <prompt> --output-format
stream-json --verbose --permission-mode <mode> --mcp-config <file> [--resume <id>]`), `mock`
(`node scripts/mock-agent.js` with the gigacode argv). One shared tolerant normalizer handles both the
Gemini-style (`init/message/tool_use/tool_result/error/result`) and the Claude-style
(`system/assistant/user/result`, `stream_event`) stream-json shapes. Any object with `session_id`/`sessionId`
yields a `session` event.

Executable resolution (runner.js), never through a shell: argv array is used as-is; a string is looked up
in PATH (+PATHEXT on Windows); `.exe` runs directly; npm `.cmd` shims are parsed to `node <entry.js>`;
anything else fails with a clear message telling the user to set `command` as an argv array.

## Turn lifecycle (sessions.js + runner.js)

1. `deliver(sessionId, {from, text})` pushes to the session queue. If the session is not `running`, start a turn.
2. Turn: append `user` message, status `running`, `launcher.prepare()`, spawn, read stdout line by line
   (buffer partial lines, ignore non-JSON lines into stderr.log), apply events to the transcript.
3. No stdout line within `firstEventTimeoutMs` → kill process tree, `error` message with stderr tail, status `error`.
4. Exit: if no `result` event and exit code != 0 → `error` message with stderr tail. Status back to `idle`
   unless the worker already set `done`/`failed`.
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
| `ask` | `question` | like send_message to parent (or user notification `question`); answer arrives as the next message |
| `worker_done` | `summary`, `status: 'done' \| 'failed'` | task → `review` (done) / `todo` (failed) + log; session status done/failed; parent gets a delivery with summary + now-ready tasks; user gets a notification |

`mcp/harness-mcp.js`: stdio MCP server (JSON-RPC 2.0, newline-delimited) implementing `initialize`,
`tools/list` (proxied from `GET /api/agent/tools`), `tools/call` (proxied to `POST /api/agent/<name>`).
Reads `HARNESS_URL`, `HARNESS_TOKEN`, `HARNESS_SESSION_ID` from env; falls back to `<repo>/data/server.json`
(`{url}`) and `<repo>/data/token`. CLI mode: `node mcp/harness-mcp.js call <tool> '<json>'` prints the result.

Every chat session gets the harness MCP server injected (settings.json `mcpServers.harness` or `--mcp-config`).

**Sub-agents exist only through orchestration.** A worker is always a harness session created by
`worker_start` (from a coordinator agent) or by `POST /api/tasks/:id/assign` (from the UI, same code path),
so every sub-agent has its own chat in the UI. Built-in sub-agent tools of the CLIs are disabled where the
CLI allows it (claude: `--disallowedTools Task Agent`; gigacode/qwen/gemini: `agents.<id>.settings` may carry the
CLI's tool-exclude setting, VERIFY on target) and the coordinator/worker preambles forbid them explicitly.
There are no pre-created agents: the Agents board shows only sessions that exist.

Preambles (built in `orchestration.js`, prepended to the first prompt of a session):
- coordinator (`role: 'coordinator'`): you coordinate; split work into tasks (`task_create` with deps),
  start workers with `worker_start`, never use built-in sub-agent tools, after starting workers END YOUR TURN —
  the harness wakes you with each worker report; answer worker questions with `send_message`.
- worker: Task id/title, Session id, Parent id, cwd/branch; do only this task inside cwd; `ask` then end turn
  for questions; finish with `worker_done(summary, status)`; commit changes to the current branch, do not push;
  never use built-in sub-agent tools.

## UI HTTP API (all under `/api`, header `x-harness-token` required)

```
GET    /api/state                         -> { tasks, workspaces, sessions, notifications, agents: [{id,label,launcher,approvalModes,approvalMode,enabled}], shell: {command}, integrations: {tasks: bool, pr: bool} }
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
POST   /api/tasks/:id/start     {agent?}   -> Session   ("Взять в работу": assign with defaults = default agent, worktree 'new' in task's workspace, task prompt template)
POST   /api/tasks/:id/port      {target, agent?} -> { target, branch, cwd, status, sessionId }
POST   /api/tasks/sync                                   -> { imported, updated }   (integrations.tasks)

POST   /api/sessions            {kind, agent?, cwd?, workspaceId?, title?, prompt?, role?, approvalMode?, model?, command?} -> Session
PATCH  /api/sessions/:id        {title?, approvalMode?, model?, autoReport?}            -> Session
DELETE /api/sessions/:id        (stops, removes session + transcript)
GET    /api/sessions/:id/messages                         -> Message[]
POST   /api/sessions/:id/messages {text}                  -> { queued: boolean }
POST   /api/sessions/:id/stop
POST   /api/sessions/:id/restart                          (terminal: respawn; chat: reset status to idle)
GET    /api/sessions/:id/log                              -> { text }   (stderr/raw tail)

GET    /api/git/status?cwd=     -> { branch, upstream, ahead, behind, files: [{ path, x, y, status: 'M'|'A'|'D'|'R'|'?'|'U' }] }
GET    /api/git/diff?cwd=&path= -> { diff }   (unified; path optional = whole tree; untracked files shown as added)
GET    /api/git/log?cwd=&n=     -> [{ hash, subject, author, at }]
GET    /api/git/suggest?cwd=    -> { taskId, key, branch, base,
                                     commit: { title, body },        (prefill for the commit box, user edits before commit)
                                     pr: { title, body, base } }     (prefill for the PR dialog, user edits before create)
POST   /api/git/commit          {cwd, message, paths?}   -> { hash }   (paths absent => all changes; message = title + "\n\n" + body)
POST   /api/git/push            {cwd}                    -> { output }
POST   /api/git/pr              {cwd, title, body, base?} -> { url }   (integrations.pr; 501 if disabled)

GET    /api/fs/list?cwd=&path=  -> [{ name, path, dir: boolean, size }]   (path relative to cwd; '' = root; dirs first; skips .git and node_modules)
GET    /api/fs/file?cwd=&path=  -> { path, content, size, binary: boolean }   (text up to 2 MB; binary => content '')
PUT    /api/fs/file             {cwd, path, content} -> { ok: true }
       (all fs paths are resolved against cwd and must stay inside it, else 400)

GET    /api/mcp/servers         -> [{ name, enabled, transport, ok, error?, problem?, tools: [{name, description}] }]

GET    /api/settings            -> { agents: { <id>: { approvalMode, approvalModes, model, modelGrades: { default?, fast?, review?, explore? }, allowedGrades, taskPromptTemplate } },
                                     defaultAgent, git: {...}, tasks: { refreshSec } }
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
```
Client → server: `{ t: 'term.attach', id }`, `{ t: 'term.detach', id }`, `{ t: 'term.in', id, data }`,
`{ t: 'term.resize', id, cols, rows }`.

## Branches, commits, PRs: naming and prefill

Config (`git` section):
```jsonc
"git": {
  "defaultBase": "develop",
  "branchTemplate": "feature/{key}",            // auto-created branches (worker_start/assign with worktree "new")
  "portBranchTemplate": "{branch}-{target}",    // e.g. feature/JIRA-1234-release-1.54.0
  "commitTitleTemplate": "{key}: {title}",
  "prTitleTemplate": "{key}: {title}"
},
"tasks": {
  "promptTemplate": "{key}: {title}\n\n{description}\n\nTargets: {targets}\nLink: {url}"
  // per agent override: agents.<id>.taskPromptTemplate, e.g. "/full-task {key}" (a custom CLI command
  // that takes the task + its SDD). Vars: {key} {id} {title} {description} {url} {targets} {branch} {repo}
}
```
- Task key `{key}` = `externalId` of the ROOT task (follow parentId up) when it came from the tracker (e.g.
  `JIRA-1234`, the space prefix comes from the tracker), else the root's local id (`T-12`). Subtasks share the
  root's key, so the same branch name `feature/JIRA-1234` is used in every microservice repo.
  Branch names are sanitized (`[^A-Za-z0-9._/-]` → `-`); if the branch already exists in that repo (and isn't
  this task's own branch), suffix `-2`, `-3`…. Auto-created worktree directory is named after the branch.
- New worktree for a task: `git worktree add -b <branch> <dir> <start>` where `<start>` = `targets[0]` if it
  exists locally, else `origin/<targets[0]>`, else HEAD. `task.branch` is stored.
- Worker's first prompt = worker preamble + task prompt rendered from `agents.<id>.taskPromptTemplate` ??
  `tasks.promptTemplate`.

### Multiple target branches (hotfix into release + develop)

Work happens once, on `task.branch` started from `targets[0]`. Each other target gets a port:
`POST /api/tasks/:id/port {target, agent?}` (UI button per target) or agent tool `task_port`:
1. new worktree from `<target>` with branch `portBranchTemplate`;
2. `git cherry-pick -x` of `git rev-list --reverse <targets[0]>..<task.branch>` (fallback to `origin/<targets[0]>`);
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
  last worker summary + `git log <base>..HEAD --oneline` as bullets.
- Worker preamble tells agents: commit messages must start with `{key}: ` and the worker stays on its branch.

## GigaCode launcher: known facts from the target machine (do not "simplify")

- Installed at `C:\Program Files\.gigacode\bin\gigacode.cmd` (default `agents.gigacode.command`).
- Real invocation (no shell, argv array, prompt = one element, `--approval-mode` AFTER the prompt, no invented flags —
  anything else must be confirmed with `--help`):
  new: `<node.exe> --max-old-space-size=6144 <cli-entry.js> -p <prompt> --approval-mode <mode> --output-format stream-json [--model <id>]`
  resume: `<node.exe> --max-old-space-size=6144 <cli-entry.js> --resume <sessionId> -p <text> --approval-mode <mode> --output-format stream-json`
- Agent process env (set only by the runner): `GIGACODE_SYSTEM_SETTINGS_PATH`, `GIGACODE_PACKAGE_IDENTITY`,
  `GIGACODE_PACKAGE_LAUNCHER` (path of the .cmd shim), `MCP_SECRET_<NAME>` for every secret (see Console MCP),
  `HARNESS_URL`, `HARNESS_TOKEN`, `HARNESS_SESSION_ID`.
- If the configured launcher cannot start, show the error and stop. Never fall back to another launcher.
- `agents.gigacode.command` points at the `gigacode.cmd` shim (or PATH name). The shim sits next to its bundled
  runtime: resolve to `<shimDir>/runtime/node/node.exe` + `<shimDir>/lib/cli-entry.js` (fall back to parsing the
  shim text for the entry, then to `process.execPath`). Optional explicit pair `agents.gigacode.node` +
  `agents.gigacode.cliEntry` — both or neither, both must exist; checked BEFORE anything else is created (worktree).
- **Package identity guard**: cli-entry.js requires env `GIGACODE_PACKAGE_IDENTITY` (64 hex) and
  `GIGACODE_PACKAGE_LAUNCHER` (absolute path of the shim). Both are declared inside the shim text as
  `set "GIGACODE_PACKAGE_IDENTITY=<64 hex>"`. Read the shim, extract, pass in env. Missing identity → fail
  immediately with a clear message (otherwise the CLI says "the public launcher and standalone payload identities do not match").
- Per-session settings: env `GIGACODE_SYSTEM_SETTINGS_PATH` → `<dataDir>/runs/<sid>/settings.json`, written as UTF-8.
  It is layered over the user's `~/.gigacode/settings.json` (permissions and the user's own MCP servers come from
  there; the harness never overrides them). Contents, exactly:
  `{ "agents": { "modelGrades": {...}, "allowedGrades": [...] }, "chatRecording": true, "mcpServers": { "harness": {...} } }`
  — `mcpServers` holds ONLY servers the harness deliberately gives the agent (`harness` + `agentMcpServers`).
  Never write `permissions`. Empty grades map is valid. Write failure → session `error` (and a worktree created for
  this start is removed), never a stuck "running".
  Same path on every turn (resume), file removed when the session is deleted.
- Approval modes: `plan | default | auto-edit | auto` (validated against `approvalModes`; unknown → refuse).
- Resume requires `chatRecording: true`, the same cwd and the same settings path. A session never resumes with a
  different cwd, settings path or launcher — refuse explicitly.
- The user's task command: `taskPromptTemplate: "/full-task-ui {taskUrl}{notes}"` (takes the task + its SDD).

### Prompt templates
Single pass with a replacer FUNCTION (task text may contain `$&`, `$'`, `$$`); substituted text is never expanded
again; unknown `{placeholders}` are left as is; a task template without any of `{taskUrl} {key} {id} {description}`
is a config error (agent would start without the task); empty notes are fine.
Vars: `{key} {id} {title} {description} {url} {taskUrl} {targets} {branch} {repo} {notes} {runId} {registryDir}
{settingsPath} {approvalMode}`. `{notes}` = `" " + notes` when the user typed notes at start, else `""`.
`{runId}` = session id, `{registryDir}` = `<dataDir>/runs/<sid>/registry`.

### Run robustness
- Stop = `taskkill /PID <pid> /T /F` (argv array, only our own pid) and the session becomes `stopped` immediately;
  a late `exit` never overwrites `stopped`. The next message resumes normally.
- `POST /api/tasks/:id/start` on a task that already has a live worker returns that session with `jumped: true`
  (no second process, no second worktree). Concurrent starts of the same task → one process.
- stdout: line buffer with a cap (lines > 8 MB are truncated with a marker); non-JSON lines are NOT dropped:
  consecutive ones are shown in the feed as one `system` message (mono). stderr → `runs/<sid>/stderr.log`; its tail
  goes into the error message when the process dies before the first event.
- Usage: `result` events may carry token counts (`stats`/`usage`, `input_token_count`/`output_token_count`) →
  cumulative `session.tokensIn` / `session.tokensOut` (0 when unknown).
- Chat without a repository: cwd = `<dataDir>/chats/<sid>` (created, survives restarts), no worktree.
- Worktrees: reuse the task's worktree in that repo if it exists; removal = `git worktree remove --force` +
  `git worktree prune --expire now`, then the directory: on Windows rename to `.stale-<ts>` first, then
  `fs.rm(..., { recursive, force, maxRetries })`.
- Startup: sessions left `running` become `idle` with a system message ("harness restarted, the turn was interrupted;
  send a message to continue — context is kept by --resume"); orphan locks are cleared.

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
`settledAt` are flagged; tokens default to 0. These rows are separate from harness workers (which are real
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
  tracker; changing tracker status is an explicit action: `POST /api/tasks/:id/tracker-status { status, comment? }`
  → `transitionTask()` in `server/integrations/tasks.js` (501 when `integrations.tasks.transition` is not configured).
- Periodic sync: `integrations.tasks.refreshSec` (0 = off, min 10) while at least one UI client is connected;
  only changed tasks are broadcast (signature = key + status + title). On failure the board keeps the local snapshot
  and `GET /api/state` → `integrations.tasksProblem: { error, at } | null` is shown as a banner ("tracker unavailable,
  showing snapshot from HH:MM"). `limit` goes into the tool args (server-side limit).

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
- Secrets file: `HARNESS_MCP_SECRETS` || `CONSOLE_MCP_SECRETS` || `config.mcpSecretsFile` || `<dataDir>/mcp-secrets.json`.
  Formats: JSON `{ "<name>": "<value>" }`, or text lines `name=value` (`#` comments), or a single bare value
  (no `=`) which means `onework/Authorization`. Names `scope/header` and `scope_header` are equivalent.
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

## Security

- Listen on `config.host` (default 127.0.0.1).
- Reject any HTTP/WS request whose `Host` header is not `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`
  (DNS-rebinding guard). WS also requires `Origin` absent or same host.
- Random token in `<dataDir>/token` (created once). `index.html` is served with
  `<meta name="harness-token" content="...">` injected; every `/api` call and `/ws` needs it.
- No CORS headers. Static files only from `web/dist`. Request bodies capped at 1 MB.
- Secrets for MCP servers only in the secrets file (outside the repo); `data/` and `harness.config.local.json` gitignored.
