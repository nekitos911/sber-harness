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
               "urlPath": "url", "defaultBase": "main" }
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
  workspaceId: string | null
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
| `task_create` | `title`, `description?`, `deps?`, `status?`, `priority?`, `labels?` | new task |
| `task_update` | `id`, `title?`, `description?`, `status?`, `priority?`, `comment?` | updated task (`comment` appends to log) |
| `worker_start` | `task_id?` or `spec` (+`title?`), `agent?`, `worktree?: 'current' \| 'new'`, `branch?`, `model?` | creates worker chat session (child of caller), task → `in_progress`, starts first turn with worker preamble + spec. 409 if the task already has an active worker or deps not done |
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

POST   /api/tasks               {title, description?, status?, priority?, deps?, labels?, workspaceId?} -> Task
PATCH  /api/tasks/:id           partial Task fields (+ comment?)                                   -> Task
DELETE /api/tasks/:id
POST   /api/tasks/:id/move      {status, beforeId?: string|null}   -> Task  (DnD: put before beforeId, or at end)
POST   /api/tasks/:id/assign    {agent?, workspaceId?, cwd?, worktree?: 'current'|'new', sessionId?} -> Session
                                 (sessionId given => deliver the task to that existing session instead of creating one)
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
POST   /api/git/commit          {cwd, message, paths?}   -> { hash }   (paths absent => all changes)
POST   /api/git/push            {cwd}                    -> { output }
POST   /api/git/pr              {cwd, title, body, base?} -> { url }   (integrations.pr; 501 if disabled)

GET    /api/fs/list?cwd=&path=  -> [{ name, path, dir: boolean, size }]   (path relative to cwd; '' = root; dirs first; skips .git and node_modules)
GET    /api/fs/file?cwd=&path=  -> { path, content, size, binary: boolean }   (text up to 2 MB; binary => content '')
PUT    /api/fs/file             {cwd, path, content} -> { ok: true }
       (all fs paths are resolved against cwd and must stay inside it, else 400)

GET    /api/mcp/servers         -> [{ name, enabled, transport, ok, error?, tools: [{name, description}] }]
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

## Security

- Listen on `config.host` (default 127.0.0.1).
- Reject any HTTP/WS request whose `Host` header is not `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`
  (DNS-rebinding guard). WS also requires `Origin` absent or same host.
- Random token in `<dataDir>/token` (created once). `index.html` is served with
  `<meta name="harness-token" content="...">` injected; every `/api` call and `/ws` needs it.
- No CORS headers. Static files only from `web/dist`. Request bodies capped at 1 MB.
- Secrets for MCP servers only in the secrets file (outside the repo); `data/` and `harness.config.local.json` gitignored.
