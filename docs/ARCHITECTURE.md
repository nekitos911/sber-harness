# Архитектурный контракт

Этот файл — единственный источник истины о границах модулей, формах данных, HTTP/WS API и
API оркестрации для агентов. Бэкенд (`server/`, `mcp/`) и фронтенд (`web/`) строятся по нему.
Если вы меняете форму данных здесь, меняйте обе стороны.

## Цели и жёсткие ограничения

- Только локально. Сервер слушает `127.0.0.1`. Никакого CDN, телеметрии и исходящих запросов от самого
  harness. Единственный сетевой трафик — то, что агентские CLI и настроенные MCP-серверы делают сами.
- Node.js >= 22, чистый ESM JavaScript на сервере (сборки для сервера нет). Фронтенд: React + Vite + TS,
  собирается в `web/dist` и раздаётся сервером.
- Сначала Windows (оболочка по умолчанию — PowerShell), но работает и на Linux/macOS.
- Агентские CLI запускаются **без оболочки**, промпт — отдельный элемент argv.
- Всё, что зависит от конкретного агентского CLI, живёт в `server/launchers.js`.
  Всё, что зависит от конкретных внешних сервисов (трекер задач, сервис пулл-реквестов (PR)), живёт в
  `server/integrations/`. Остальной код ничего не знает о GigaCode, onework и т. д.

## Структура

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

## Конфигурация (`harness.config.json`, переопределяется через `harness.config.local.json`)

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
      // taskPromptTemplate / freePromptTemplate / reworkPromptTemplate: not set — the task goes as its text;
      // a person's own command (e.g. "/full-task {taskUrl}{notes}") goes into harness.config.local.json (the first-run setup does it)
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
               "closedStatuses": ["done", "closed", "cancelled", "canceled", "declined", "resolved", "rejected"] },
               // format "json" (other providers): "itemsPath", "map", "transition": { "args": {...} } — see server/integrations/tasks.js
    "pr":    { "enabled": false, "server": "sourcecontrol", "tool": "git_create_pull_request",
               "args": { "project": "{project}", "repository": "{repository}", "head": "{branch}", "base": "{base}", "title": "{title}", "body": "{body}" },
               "urlPath": "html_url",
               "listTool": "git_list_pull_requests", "listArgs": { ... "state": "OPEN" }, "listItemsPath": "pulls",
               "limits": { "titleBytes": 100, "bodyBytes": 512 } }
  }
}
```

## Модель данных (всё в JSON, id — строки)

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

Хранение (`<dataDir>`): `db.json` = `{ seq: {task}, tasks, workspaces, sessions, notifications }`,
`transcripts/<sessionId>.json` = `Message[]`, `terms/<sessionId>.log` = сырой вывод терминала (кольцевой буфер, последние 2 МБ),
`runs/<sessionId>/settings.json` (+ `mcp.json` для claude), `runs/<sessionId>/stderr.log`, `token`.
Запись отложенная и атомарная (запись во временный файл + переименование). При старте сессии со статусом `running` становятся `idle`
(чат) или `exited` (терминал) и получают системное сообщение «harness restarted». Системные сообщения, начинающиеся с `⚠`, —
предупреждения (например, stderr успешного запуска); системное сообщение «Model: … · MCP: onework ✓, java-lsp ✗» добавляется один раз
на сессию из init-события CLI.

## Агентские лаунчеры (`server/launchers.js`)

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
  | { type: 'usage', contextTokens, input, output, cacheRead }   // the context after one model step (assistant.message.usage)
  | { type: 'result', text: string | null, isError: boolean, tokensIn?, tokensOut? }   // end of turn; usage of the whole run
  | { type: 'meta', raw: unknown }                       // anything unknown; kept in stderr.log only
// text/thought/tool_call/tool_result/error may carry parentToolId: the event belongs to a built-in sub-agent started by
// that tool call (stream-json parent_tool_use_id) and is shown as tool.progress of the parent call, never in the main chat.
// runner.js adds { type: 'raw', text } for each non-JSON stdout line.
```

Лаунчеры: `gigacode`, `qwen`, `gemini` (одно семейство argv: `[--resume <id>] -p <prompt> --approval-mode <mode>
--output-format stream-json [--model <m>]`, настройки сессии передаются через переменную окружения), `claude` (`-p <prompt> --output-format
stream-json --verbose --permission-mode <mode> [--model] [--resume <id>] --mcp-config <file> --allowedTools mcp__harness
--disallowedTools Task Agent`), `mock` (`node scripts/mock-agent.js` с argv как у gigacode). Один общий терпимый
нормализатор обрабатывает стиль Claude/Qwen (`system/assistant/user/result`, `stream_event` — живые дельты текста и рассуждений;
безголовый GigaCode запускается с `partialMessagesFlag` (необязательный: `agents.gigacode.partialMessagesFlag: "--include-partial-messages"`;
по умолчанию выключен — когда он был включён на целевой машине, вызовы инструментов приходили без аргументов), а CLI, который
отвергает его до любого вывода, запоминается в `agentMeta.<id>.partialUnsupported`, и тот же ход запускается заново без него; GigaCode и claude)
и стиль Gemini (`init/message/tool_use/tool_result/error/result`; gemini). Любой объект с `session_id`/`sessionId`
порождает событие `session`. Токены берутся только из события `result` (usage по шагам ассистента в сумме с ним не сходится).

Разрешение исполняемого файла (runner.js) — никогда через оболочку: массив argv используется как есть; строка ищется
в PATH (+PATHEXT в Windows); `.exe` запускается напрямую; npm-шимы `.cmd` разбираются в `node <entry.js>`;
всё остальное завершается понятным сообщением с просьбой задать `command` массивом argv.

## Жизненный цикл хода (sessions.js + runner.js)

1. `deliver(sessionId, {from, text})` кладёт сообщение в очередь сессии. Если сессия не `running`, начинается ход.
2. Ход: добавляется сообщение `user`, статус `running` + `phase: 'starting'`, `launcher.prepare()`, запуск процесса, чтение stdout
   построчно (неполные строки буферизуются, лимит 8 МБ), `phase: 'streaming'` при первом выводе, события применяются к транскрипту.
   Первый промпт сессии CLI = преамбула + текст; если текст начинается с `/` (слэш-команда, например `/full-task <url>`),
   то вместо этого текст + "\n\n" + преамбула, потому что слэш-команда работает только как первое слово.
3. Нет ни одной строки stdout за `firstEventTimeoutMs` → убивается дерево процессов, сообщение `error` «Нет вывода за N с — ход остановлен.»
   с хвостом stderr, статус `error`. `session.errorKind` (при статусе `error`): `'not_started'`, пока ни один ход
   сессии не выдал событие (`session.everStarted`; только тогда UI пишет «Агент не запустился. Проверьте команду…»),
   иначе `'turn'`; в остальных случаях null. Коды выхода читаются со знаком: 4294967295 / -1 → «Процесс агента завершён
   принудительно (код -1)».
4. Выход (`phase` снова null): код != 0 без `result` → сообщение `error`, начинающееся со stderr (фатальная ошибка CLI оставляет
   stdout пустым); код 0 без единого события → `error` "exited without any output" + stderr, статус `error` (например, проверка
   идентичности GigaCode); текст stderr после успешного запуска → сообщение `system` с префиксом `⚠` (предупреждение).
   Статус возвращается в `idle`, если исполнитель (worker) уже не выставил `done`/`failed` (или пользователь не остановил его: `stopped`).
5. После хода: если это исполнитель с `autoReport`, за этот ход не было `worker_done` и очередь пуста →
   эскалация доставляется родительскому агенту (с подсказкой для агента: send_message / worker_inspect / worker_retry),
   а без родителя — пользователю; никогда — для собственного уточнения пользователя (ход после первого, все сообщения которого
   пришли от пользователя). На сессию не больше одного открытого (непрочитанного) уведомления об эскалации: повтор обновляет его `text`,
   `at` и `count`; обычный текст «Агент <KEY> закончил ход без отчёта — откройте чат, чтобы продолжить или принять
   результат» (или «…остановился с ошибкой…»), `actions: ['open', 'rework', 'accept']` (`['open']` без задачи).
   Затем, если очередь не пуста → следующий ход.
6. `stop` убивает дерево процессов (`taskkill /T /F` в Windows) и очищает очередь.
7. Текст, доставленный из другой сессии, получает префикс: `[harness] Message from <title> (<id>):\n<text>`.

Терминальные сессии: PTY (`@lydell/node-pty`) запускает `config.shell`; если задан `command`, он записывается в
оболочку после запуска. В окружении всегда есть `HARNESS_URL`, `HARNESS_TOKEN`, `HARNESS_SESSION_ID`.
Вывод идёт в кольцевой буфер + файл журнала + WS. Доставки в терминальную сессию записываются как текст + `\r`.

## Оркестрация (API для агентов) — `server/orchestration.js`

HTTP: `POST /api/agent/<tool>` с заголовками `x-harness-token`, `x-harness-session: <id сессии вызывающего>`
(может отсутствовать → вызывающий «внешний» и обрабатывается как пользователь), тело JSON = аргументы инструмента → результат JSON или
`{ error }` с 4xx. `GET /api/agent/tools` возвращает `[{ name, description, inputSchema }]` (формат MCP).

| инструмент | аргументы | действие |
|---|---|---|
| `whoami` | – | сессия вызывающего: id, role, parentId, taskId, cwd, branch |
| `task_list` | `status?`, `ready?: boolean` | задачи (ready = todo/backlog, у которых все зависимости выполнены) |
| `task_get` | `id` | задача |
| `workspace_list` | – | зарегистрированные репозитории `[{ id, name, path, isGit }]` (для планирования по нескольким репозиториям) |
| `task_create` | `title`, `description?`, `deps?`, `status?`, `priority?`, `labels?`, `parent_id?`, `workspace?` (id или имя), `targets?` | новая задача (подзадача наследует targets/workspace родителя, если они не указаны) |
| `task_port` | `task_id`, `target`, `agent?` | cherry-pick ветки задачи в другую целевую ветку (см. «Несколько целевых веток») |
| `task_update` | `id`, `title?`, `description?`, `status?`, `priority?`, `comment?` | обновлённая задача (`comment` дописывается в журнал) |
| `worker_start` | `task_id?` или `spec` (+`title?`, `task?: true`), `agent?`, `workspace?`, `worktree?: 'current' \| 'new'`, `branch?`, `model?` | создаёт чат-сессию исполнителя (дочернюю к вызывающему), задача → `in_progress`, запускает первый ход с преамбулой исполнителя + spec. 409, если у задачи уже есть активный исполнитель или зависимости не выполнены. `spec` без `task_id` НЕ создаёт задачу на доске (если не указано `task: true` или нет вызывающей сессии): постоянный дочерний исполнитель (`taskId: null`), который отчитывается перед вызывающим; название = `title` или первая строка spec; worker_retry работает и для него. Если агент не указал размещение — выбирается автоматически: `current`, когда вызывающий работает в репозитории задачи (`caller.workspaceId` = workspace задачи), иначе `new-top-level` в workspace задачи (для не-git workspace — его папка); нет workspace → `current`. `current` запускает исполнителя там, где работает вызывающий (`caller.worktreePath || caller.cwd`), но никогда в основной рабочей копии репозитория; ЯВНЫЙ `current` с задачей (или `workspace`) в другом репозитории → 400 с советом использовать `new-top-level`. Результат содержит `placement` (`"new-top-level (auto)"`, если выбрано автоматически) |
| `worker_list` | – | дочерние сессии вызывающего со статусом/задачей/preview |
| `send_message` | `to: <sessionId> \| 'parent' \| 'user'`, `body` | доставляет (будит адресата) |
| `ask` | `question`, `options?: string[]` | как send_message родителю (или уведомление `question` пользователю); options попадают в доставленное сообщение / уведомление; ответ приходит следующим сообщением |
| `worker_done` | `summary`, `status: 'done' \| 'failed'` | задача → `review` (done) / `todo` (failed) + запись в журнал; статус сессии done/failed; родитель получает доставку с summary и теперь готовыми задачами; пользователь получает уведомление |

`mcp/harness-mcp.js`: stdio MCP-сервер (JSON-RPC 2.0, строки через перевод строки), реализует `initialize`,
`tools/list` (проксируется из `GET /api/agent/tools`), `tools/call` (проксируется в `POST /api/agent/<name>`).
Читает `HARNESS_URL`, `HARNESS_TOKEN`, `HARNESS_SESSION_ID` из окружения; запасной вариант — `<repo>/data/server.json`
(`{url}`) и `<repo>/data/token`. Режим CLI: `node mcp/harness-mcp.js call <tool> '<json>'` печатает результат.

В каждую чат-сессию внедряется MCP-сервер harness (`mcpServers.harness` в settings.json или `--mcp-config`).

**Исполнители и встроенные помощники.** Параллельная работа над задачами, которую должен видеть пользователь, идёт через `worker_start` (от
координатора) или `POST /api/tasks/:id/assign|start` (из UI, тот же путь в коде): каждый исполнитель — это сессия harness
со своим чатом. Встроенный инструмент `agent` GigaCode нельзя отключить, а `/full-task` опирается на него для ревью, поэтому он
разрешён для внутренних помощников (ревью, разведка); их активность показывается только для чтения (tool.progress родительского
вызова и реестр ниже). claude запускается с `--disallowedTools Task Agent`. Заранее созданных агентов нет.

Преамбулы (строятся в `orchestration.js`, добавляются перед первым промптом сессии):
- координатор (`role: 'coordinator'`): вы координируете; разбейте работу на задачи (`task_create` с deps), запускайте исполнителей
  через `worker_start`, после их запуска ЗАВЕРШИТЕ СВОЙ ХОД — harness разбудит вас с каждым отчётом исполнителя; на вопросы
  исполнителей отвечайте через `send_message`; правила для нескольких репозиториев и нескольких целевых веток; встроенный инструмент agent — только для помощников.
- исполнитель (worker): ключ/название задачи, id сессии, родитель, cwd/ветка, base = targets[0]; делайте только эту задачу внутри cwd; оставайтесь на
  ветке; для вопросов `ask`, затем завершите ход; завершайте через `worker_done(summary, status)`. Если не включено
  `orchestration.workerMayCommit`: НЕ делайте commit/push/merge, не создавайте PR (пулл-реквесты) и не пишите в трекер, пока задача этого не требует
  (пользователь коммитит из UI). Формат сообщения коммита `<KEY> <summary>` (без двоеточия, без feat:/fix:, без Co-authored-by,
  без упоминаний ИИ). Исполнители конфликтов переноса могут выполнять `git cherry-pick --continue`.
- обе: `Registry dir: <registryDir>` — туда записываются встроенные субагенты-помощники (см. раздел о реестре).

## HTTP API для UI (всё под `/api`, обязателен заголовок `x-harness-token`)

Весь текст, который сервер генерирует для людей, — на русском: системные сообщения и сообщения об ошибках в транскриптах, уведомления, записи журнала
задач и строки `error` в ответах 4xx/5xx (идентификаторы кода, флаги, пути и вывод git/CLI остаются как есть;
консольные логи и преамбулы/описания инструментов для агентов остаются на английском).

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

GET    /api/git/status?cwd=     -> { branch, upstream, ahead, behind, files: [{ path, x, y, status: 'M'|'A'|'D'|'R'|'?'|'U',
                                     staged: boolean (index side changed), added, removed (lines; null = binary/too big),
                                     service? }], totals: { added, removed } (non-service files), webUrl: string|null }
                                 (one `git diff HEAD --numstat`; an untracked file's lines count as added — ≤ 200 files of
                                  ≤ 1 MB; webUrl = integrations.pr.webUrlTemplate ({project} {repository} {branch}, default ""
                                  → null) for a code-host origin only)
POST   /api/git/stage           {cwd, paths | all: true} -> { ok }   (git add -A -- <paths>; all = everything minus
                                                                       git.excludeFromCommit; paths must be inside cwd)
POST   /api/git/unstage         {cwd, paths | all: true} -> { ok }   (git restore --staged; before the first commit git rm --cached)
POST   /api/git/discard         {cwd, paths, confirm: true} -> { ok } (400 without confirm; 409 while a chat in that worktree
                                 runs; tracked → git restore --source=HEAD --staged --worktree; untracked / just added →
                                 the file is deleted (files only, inside cwd). Feature `git-stage`.)
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
POST   /api/git/commit          {cwd, message, paths?, staged?, push?, via?} -> { hash, push? }   (paths absent => all changes;
                                 staged: true = only the index (no git add; 400 when nothing is staged); push: true = then
                                 git push like /api/git/push (its { summary, output } in push); via "agent" → see «Commit /
                                 push / PR through the agent»: one instruction for staged/paths and push, RESULT <hash> <branch>,
                                 the job result { ok, hash, branch }; message = title + "\n\n" + body)
POST   /api/git/push            {cwd}                    -> { summary, output }  (summary: «Отправлено в origin/<b>» |
                                                             «Новая ветка <b> в origin» | «Уже в origin/<b> — нечего отправлять»; output = raw git)
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
GET    /api/prs?scope=mine|tracked&refresh=1 -> { me, items: [{ workspaceId, repo, project, index, title, state, url,
                                     head, base, author, reviewers: [{ name, status }], mergeable, updatedAt, createdAt,
                                     taskId, taskKey, sessionId, byAgent }], errors: [{ repo, error }], at }
                                 (feature `prs-mine`; every registered git repository with a parseable origin, listTool
                                  { project, repository, state: 'OPEN', author: me, page: 1, limit: 100 } — a server that
                                  rejects `author` is asked without it — and the items' pr_creator/author must be me;
                                  me = integrations.pr.meTool (default git_get_user, args {}, login|username|name, cached
                                  24 h, VERIFY the args/shape); 4 repositories at a time, per-repo errors collected; the
                                  whole answer cached 3 min, refresh=1 bypasses, refreshed every integrations.pr.refreshSec
                                  while a UI client is connected. taskId/taskKey: a task of that repo whose branch (or
                                  task.worktrees branch) is the head, else whose key (externalId or id) is a token in the
                                  head name; sessionId/byAgent: the head is a worktree createdBy 'agent' (its session) or
                                  the task has an assignee. scope=tracked: every author, only heads that are task
                                  branches or worktrees of the repo.)
                                 integrations.pr.enabled: true | false | "auto" (default): "auto" = on when a console MCP
                                 server named integrations.pr.server exists (and, once its tools were listed, offers
                                 `tool`); /api/settings shows `{ enabled, active }`, /api/state integrations.pr = active.
GET    /api/fs/list?cwd=&path=  -> [{ name, path, dir: boolean, size }]   (path relative to cwd; '' = root; dirs first; skips .git and node_modules)
GET    /api/fs/file?cwd=&path=  -> { path, content, size, binary: boolean }   (text up to 2 MB; binary => content '')
PUT    /api/fs/file             {cwd, path, content} -> { ok: true }
       (all fs paths are resolved against cwd and must stay inside it, else 400)

DELETE /api/sessions/:id/queue/:qid -> Session: a queued message taken back (404 once the agent got it); the session's
                                    `queue` [{ id, from, text, at, recorded? }] is what the composer lists
POST   /api/sessions/:id/queue/send  -> Session: a queue left after a failed start goes now (409 when empty)
POST   /api/sessions/:id/attachments?name=  (raw bytes, any type, ≤10 MB) -> { path }: a file attached with the
                                    composer's «+» (the system file dialog: the browser gives bytes, never a path) or a
                                    pasted screenshot, saved as <stamp>-<name> in <dataDir>/runs/<id>/attachments (the
                                    name sanitized, never leaving the folder); the turn whose message mentions that folder
                                    gets it in includeDirs (ACP: fs roots)
GET    /api/mcp/servers         -> [{ name, enabled, transport, ok, error?, problem?, tools: [{name, description}] }]
GET    /api/integrations/check  -> { tasks: Check, pr: Check, servers: string[] }   // флаг integrations-check
POST   /api/checks/run { workspaceId, command } -> { ok, code, output, ms, timedOut }   // флаг checks: «Проверить сейчас» в папке проекта
POST   /api/sessions/:id/revive  -> Session   // флаг revive: «Повторить» — продолжить оборвавшийся чат сейчас (409, если он работает)
POST   /api/fs/pick-folder { title?, initial? } -> { path | null }   // флаг pick-folder: системное окно выбора папки на этой машине; null — отмена
       // Check = { server, found, ok, missing: string[], error? }: найден ли MCP-сервер трекера / PR (конфиг харнесса или
       // ~/.gigacode/settings.json агента), отвечает ли, есть ли у него инструменты, которые вызывает харнесс
       // (tasks.tools.find/get, pr.tool). Сервер меняется в PUT /api/settings: integrations.tasks.server / integrations.pr.server.
                                    (only the servers the harness calls: integrations.tasks/pr.server and its own
                                    config.mcpServers — servers that come only from mcpServersFrom are not started)

GET    /api/settings            -> { agents: { <id>: { approvalMode, approvalModes, approvalModeLabels, model, models,
                                     modelGrades: { default?, fast?, review?, explore? }, allowedGrades, taskPromptTemplate,
                                     taskPromptPresets, freePromptTemplate, firstEventTimeoutMs, inheritUserMcp, enabled } },
                                     defaultAgent, git: {...}, tasks: { refreshSec }, user: { setupDone: boolean },
                                     integrations: { tasks: { enabled, space, urlTemplate, statusMap, closedStatuses },
                                                     pr: { enabled, limits } } }
                                 Model entries everywhere (config, /api/state agents[].models, /api/settings) are objects
                                 `{ id, label?, context?, description? }` (a plain string in config is normalized to {id}).
                                 `user.setupDone` — первичная настройка пройдена или пропущена (GET/PUT); `agents.<id>.freePromptTemplate`
                                 редактируется (null или строка с `{text}`): промпт для предложения вместо задачи на «Главной».
GET    /api/agents/:id/info     -> { id, resolved: { ok, command?, node?, entry?, identity: boolean, error? },
                                     seen: { models: string[], slashCommands: string[], mcpServers: [{name, status}],
                                             agents: string[], version: string|null, at: number } | null,
                                     userCommands: string[] }
                                 (`userCommands` — имена собственных слэш-команд пользователя (`<commandsDir>/<name>.md|.toml`) и навыков
                                  (`<skillsDir>/<name>/SKILL.md`); собственные команды/навыки harness (`full-task-harness`,
                                  `harness-orchestration`) не входят; их предлагает первичная настройка)
                                 (`seen` is captured from the last `system/init` event of any session of that agent and
                                  persisted in db.agentMeta; `resolved` = launcher resolution like --print-config, no spawn)
PUT    /api/settings            same shape (partial) -> saved into harness.config.local.json (never secrets; approvalMode validated)
                                 modelGrades/allowedGrades map to agents.<id>.settings.agents.{modelGrades,allowedGrades}
POST   /api/notifications/:id/read
POST   /api/notifications/read-all
```

Ошибки: `{ error: string }` с 4xx/5xx. 404 для неизвестных id, 409 для блокировок/конфликтов, 501 для отключённых интеграций.

## WebSocket `/ws?token=...`

Сервер → клиент (JSON в каждом кадре):
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
Клиент → сервер: `{ t: 'term.attach', id }`, `{ t: 'term.detach', id }`, `{ t: 'term.in', id, data }`,
`{ t: 'term.resize', id, cols, rows }`.

## Ветки, коммиты, PR: именование и предзаполнение

Конфигурация (раздел `git`):
```jsonc
"git": {
  "defaultBase": "develop",
  "branchTemplate": "feature/{key}",            // auto-created branches (worker_start/assign with worktree "new")
  "portBranchTemplate": "{branch}-{targetSlug}",   // feature/PROJ-14822-rel154 for release/1.54.0
  "commitTitleTemplate": "{key} {title}",        // team convention: key, space, summary (no colon, no feat:/fix:)
  "prTitleTemplate": "{key} {title}"
},
"tasks": {
  "promptTemplate": "{key}: {title}\n\n{description}\n\nСсылка: {taskUrl}{notes}"
  // per agent override: agents.<id>.taskPromptTemplate (e.g. a person's "/full-task {taskUrl}{notes}", set in the local config); see "Prompt templates"
}
```
- Ключ задачи `{key}` = `externalId` КОРНЕВОЙ задачи (поднимаясь по parentId), если она пришла из трекера (например,
  `JIRA-1234`, префикс пространства берётся из трекера), иначе локальный id корня (`T-12`). Подзадачи используют
  ключ корня, поэтому одно и то же имя ветки `feature/JIRA-1234` применяется в каждом репозитории микросервисов.
  Имена веток очищаются (`[^A-Za-z0-9._/-]` → `-`); если ветка в этом репозитории уже существует (и это не
  собственная ветка этой задачи), добавляется суффикс `-2`, `-3`…. Каталоги рабочего дерева (worktree) остаются короткими (MAX_PATH):
  `<repoParent>/<repoName>-worktrees/<KEY>` для рабочих деревьев задач, `…/<хвост ветки>` в остальных случаях (суффикс -2…, если занято).
  `{targetSlug}`: `release/x.y.z` → `rel<x><y>` (release/1.54.0 → rel154), всё остальное → очищенная целевая ветка.
- Новое рабочее дерево для задачи: `git worktree add -b <branch> <dir> <start>`, где `<start>` = `targets[0]`, если
  она есть локально, иначе `origin/<targets[0]>`, иначе HEAD. `task.branch` сохраняется.
- Первый промпт исполнителя = преамбула исполнителя + промпт задачи, построенный из `agents.<id>.taskPromptTemplate` ??
  `tasks.promptTemplate`.

### Несколько целевых веток (хотфикс в release + develop)

Работа выполняется один раз, в `task.branch`, начатой от `targets[0]`. Для каждой остальной целевой ветки делается перенос:
`POST /api/tasks/:id/port {target, agent?}` (кнопка в UI для каждой целевой ветки) или агентский инструмент `task_port`:
1. новое рабочее дерево от `<target>` с веткой `portBranchTemplate`;
2. нужны коммиты в `task.branch` впереди `targets[0]` (иначе 409 «сначала закоммитьте работу»); переносятся только коммиты, которых нет в
   целевой ветке: `git log --cherry-pick --right-only --no-merges --reverse --format=%H <target>...<task.branch>`
   (нет таких → 409 «уже содержит все изменения»), затем `git cherry-pick -x` этих коммитов;
3. чисто → перенос получает `status: 'clean'`, запись в журнале; конфликт → cherry-pick остаётся незавершённым, перенос получает `status: 'conflict'`,
   в этом рабочем дереве запускается сессия исполнителя (родитель = вызывающий/координатор) с преамбулой: разрешить конфликты,
   `git cherry-pick --continue`, выполнить проверки, `worker_done`. Его `worker_done` переводит перенос в done/failed.
Результат: `{ target, branch, cwd, status, sessionId }`. Один пулл-реквест (PR) на целевую ветку (base в диалоге PR = эта ветка; cwd = рабочее дерево переноса).

### Несколько репозиториев (микросервисы)

Одна задача = один репозиторий (`workspaceId`). Спецификация, затрагивающая несколько репозиториев, становится родительской задачей с одной подзадачей на репозиторий
(`parentId`, собственный `workspaceId`, наследует `targets` и ключ). Координаторы видят репозитории через инструмент `workspace_list` и
создают подзадачи через `task_create({ parent_id, workspace, ... })`; `worker_start` запускает исполнителя в репозитории
подзадачи (`worktree: 'new'` → ветка `feature/<key>` в этом репозитории). Статусом родительской задачи управляют
координатор/пользователь; доска показывает прогресс подзадач (выполнено/всего).
- К какой задаче относится cwd: задача сессии (сессий), у которых cwd совпадает с ним, иначе задача, ключ которой встречается в
  имени текущей ветки, иначе никакая (`taskId: null`, `key: null`; тогда шаблоны используют имя ветки / первый
  изменённый файл).
- `commit.title` = `commitTitleTemplate`; `commit.body` = последний summary `worker_done` для этой задачи (если есть) +
  маркированный список изменённых файлов. `pr.title` = `prTitleTemplate`; `pr.body` = фрагмент описания задачи + внешний URL +
  `Target: <base>` + последний summary исполнителя + `git log <base>..HEAD --oneline` маркированным списком; `base` = целевая ветка переноса, когда cwd —
  рабочее дерево переноса, иначе `targets[0]`. Предложения заголовка/тела PR обрезаются до `integrations.pr.limits` (UTF-8 байты, по
  границе кодовой точки, с «…»); сам вызов создания никогда не обрезает (вместо этого 400 с числом байтов).
- Преамбула исполнителя сообщает агентам формат коммита `<KEY> <summary>` и что исполнитель остаётся на своей ветке.

## Лаунчер GigaCode: известные факты с целевой машины (не «упрощать»)

Авторитетные подробности: `docs/GIGACODE-FACTS.md`; фикстуры: `test/fixtures/gigacode.*`.
- Установка: `ROOT\bin\gigacode.cmd` (шим, `agents.gigacode.command` по умолчанию), `ROOT\runtime\node\node.exe` (встроенный Node —
  системный Node не должен запускать cli-entry), `ROOT\lib\cli-entry.js`. Шим задаёт `ROOT=%~dp0..`.
- Разрешение (до создания чего-либо ещё, например рабочего дерева): явные `agents.gigacode.node` + `cliEntry` (оба или
  ни одного, оба должны существовать) → разбор из шима (`set "ROOT=…"` + строка вызова в кавычках, `%~dp0`/`%ROOT%` раскрываются) →
  `<shimDir>/../runtime/node/node.exe` + `<shimDir>/../lib/cli-entry.js` → то же под `<shimDir>` → понятная ошибка.
  Сам `.cmd` никогда не запускается (нет честных кодов выхода). Никогда не переключаться на другой лаунчер или на системный node.
- argv: `[--max-old-space-size=6144, cli-entry.js, (--resume <id>)?, -p, <prompt>, --approval-mode, <mode>, --output-format, stream-json, (--model <m>)?]`.
- Окружение (задаётся только runner): `GIGACODE_SYSTEM_SETTINGS_PATH`, `GIGACODE_PACKAGE_IDENTITY` (64 hex из
  `set "GIGACODE_PACKAGE_IDENTITY=…"` шима; нет → сразу ошибка), `GIGACODE_PACKAGE_LAUNCHER` (путь к шиму),
  `MCP_SECRET_<NAME>` для каждого секрета, `HARNESS_URL`, `HARNESS_TOKEN`, `HARNESS_SESSION_ID`. Без окружения identity
  CLI пишет только в stderr и завершается с кодом 0 → сообщается как «exited without any output».
- Настройки сессии `<dataDir>/runs/<sid>/settings.json` (UTF-8, один и тот же путь на каждом ходе, удаляется вместе с сессией):
  `{ "agents": { "modelGrades": {...}, "allowedGrades": [...] }, "chatRecording": true, "mcpServers": { harness, ...agentMcpServers } }`.
  Никогда `permissions`. `inheritUserMcp: true` дополнительно копирует mcpServers из пользовательского `~/.gigacode/settings.json` (слияние или
  замена — не подтверждено). Ошибка записи → error, и рабочее дерево, созданное для этого запуска, удаляется.
- Режимы подтверждения `plan | default | auto-edit | auto` (проверяются). Для возобновления нужны `chatRecording`, тот же cwd, путь к
  настройкам и лаунчер (смена лаунчера отвергается).
- Поток: стиль Qwen-Code / Claude; холодный старт (`system/init`) может занимать 30–60 с → `firstEventTimeoutMs` 120000 и
  `session.phase: 'starting'` для UI. Фатальные ошибки: пустой stdout + код 1 + stderr. Предупреждения: stderr при коде 0.
- Команда задачи: по умолчанию не задана (задача уходит текстом, `tasks.promptTemplate`); своя команда, например
  `taskPromptTemplate: "/full-task {taskUrl}{notes}"`, задаётся в `harness.config.local.json` (это делает мастер первого запуска) —
  слэш-команды работают только как первое слово.

### Шаблоны промптов
Один проход с заменяющей ФУНКЦИЕЙ (текст задачи может содержать `$&`, `$'`, `$$`); подставленный текст больше не раскрывается;
неизвестные `{плейсхолдеры}` остаются как есть; шаблон задачи без единого из `{taskUrl} {key} {id} {description}`
считается ошибкой конфигурации (агент запустился бы без задачи); пустые notes допустимы.
Переменные: `{key} {id} {title} {description} {url} {taskUrl} {targets} {branch} {repo} {notes} {runId} {registryDir}
{settingsPath} {approvalMode}`. `{taskUrl}` = `externalUrl` (из `integrations.tasks.urlTemplate`) или ключ, если
его нет. `{notes}` = `" " + notes`, когда пользователь ввёл заметки при запуске, иначе `""`.
`{runId}` = id сессии, `{registryDir}` = `<dataDir>/runs/<sid>/registry`.

### Надёжность запусков
- Остановка = `taskkill /PID <pid> /T /F` (массив argv, только наш собственный pid), и сессия сразу становится `stopped`;
  запоздалый `exit` никогда не перезаписывает `stopped`. Следующее сообщение возобновляет работу как обычно.
- `POST /api/tasks/:id/start` для задачи, у которой уже есть живой исполнитель, возвращает эту сессию с `jumped: true`
  (ни второго процесса, ни второго рабочего дерева). Одновременные запуски одной задачи → один процесс.
- stdout: построчный буфер с лимитом (строки > 8 МБ обрезаются с маркером); не-JSON строки НЕ отбрасываются:
  идущие подряд показываются в ленте как одно сообщение `system` (моноширинное). stderr → `runs/<sid>/stderr.log`; его хвост
  попадает в сообщение об ошибке, когда процесс умирает до первого события.
- Usage: только из события `result` (`usage` / `stats`) → накопительные `session.tokensIn` / `session.tokensOut` (0, если неизвестно).
- Эксплуатация: один harness на `dataDir` (живой pid в `<dataDir>/server.json`, не наш → отказ запускаться); занятый порт →
  ошибка с названием порта и `netstat -ano | findstr :<port>`; папки `*.stale-*` в `data/` и корнях рабочих деревьев
  удаляются при старте (по возможности); папки удаляются сначала переименованием в `<dir>.stale-<ts>` (файлы удерживаются антивирусом/индексатором).
- Чат без репозитория: cwd = `<dataDir>/chats/<sid>` (создаётся, переживает перезапуски), без рабочего дерева.
- Рабочие деревья: рабочее дерево задачи в этом репозитории переиспользуется, если существует; удаление = `git worktree remove --force` +
  `git worktree prune --expire now`, затем каталог: в Windows сначала переименование в `.stale-<ts>`, затем
  `fs.rm(..., { recursive, force, maxRetries })`.
- Запуск: сессии, оставшиеся `running`, становятся `idle` с системным сообщением («harness restarted, the turn was interrupted;
  send a message to continue — context is kept by --resume»); потерянные блокировки снимаются.

## Работа с `/full-task` (команда задачи пользователя сама является оркестратором)

`/full-task` (см. `docs/GIGACODE-FACTS.md` §4) классифицирует задачу, работает в `..\<repo>-worktrees\<task-id>`, никогда не коммитит,
запускает субагентов-реализаторов и ревьюеров с перекрёстным ревью по разным моделям и пишет журнал + файлы вердиктов. harness подстраивается:
- Преамбула исполнителя для задачи, запущенной в рабочем дереве harness, добавляет: «Ты уже в рабочем дереве задачи `<cwd>` (ветка
  `<branch>`) — это и есть worktree задачи; не создавай другой. Коммиты/пуш/PR/трекер — только пользователь из UI.
  После финального сообщения твоей команды вызови worker_done с тем же текстом.» (поле сессии `inWorktree: true`: исполнитель
  запущен в связанном рабочем дереве; фраза про коммиты опускается при `orchestration.workerMayCommit`.)
- Просмотр SDD-артефактов: `GET /api/sdd?cwd=&sessionId=` → `{ plans: [{ name, dir, modifiedAt, progress: { raw, items: [{ title, status }], total, done },
  verdicts: [{ n, file, status: 'PASS'|'FAIL'|'ESCALATION_REQUIRED'|'INDEPENDENT_VERIFICATION_REQUIRED'|null,
  filesChanged: string[], commands: [{ cmd, result }], openQuestions, implementerModel, reviewerModel, secondReviewModel,
  notes, raw }] }] }` из `<cwd>/.superpowers/sdd/*/progress.md` и `verdicts/task-*.md` (терпимый разбор блока
  `key: value` и элементов списка; неразобранное → только `raw`). С `sessionId` — только планы этой сессии: название плана
  содержит ключ её задачи, либо файлы прогресса/вердиктов плана изменились после `createdAt` сессии (старый журнал
  другого запуска в корне проектов не показывается); без него — все планы (кнопка панели «показать все»). Статус элемента
  берётся только из явного маркера (`[x]`/`[ ]`/`[~]`, ✅/❌/⏳, `status: DONE|PASS|FAIL|…`); `done` — это
  число выполненных элементов, либо null, если ни у одного элемента нет маркера (`total` = число элементов; тогда UI не показывает дробь).
  Пока сессия работает, сервер опрашивает (раз в 3 с) и при изменении рассылает `{ t: 'sdd', cwd, sessionId, plans }` (планы
  этой сессии).
- `git.excludeFromCommit` (по умолчанию `[".superpowers/", ".gigacode/tmp/"]`): `GET /api/git/status` помечает подходящие файлы `service: true`;
  commit-all и предлагаемый список файлов их пропускают (pathspec `:(top,exclude)<pattern>`, поэтому ранее добавленные в индекс файлы тоже
  пропускаются); явные `paths` их отбрасывают (400, если остались только служебные файлы); harness их никогда не отправляет.
- Проверка ссылок на модели: `GET /api/agents/:id/info` добавляет `modelRefs: [{ file, model, available }]` из
  `agents.<id>.modelRefsScan` (по умолчанию для gigacode `["~/.gigacode/agents/*.md", "~/.gigacode/commands/*.md"]`; frontmatter
  `model:` и токены, похожие на id моделей по именованию каталога), `available` — по обнаруженному каталогу
  (сравнение по префиксу допускает суффикс `-262k`). Только чтение; harness никогда не правит эти файлы.
- Названия чатов: чат, созданный без `title` (`session.autoTitle`), берёт первую строку первого сообщения пользователя
  (≤ 60 символов, ведущий `/` отбрасывается: «/full-task PROJ-1» → «full-task PROJ-1»); PATCH с title это прекращает.
- `GET /api/tasks/:id/rework-preview?notes=&agent=` → `{ text, agent, sessionId }`: именно то сообщение, которое доработка
  отправила бы сейчас (её исполнителю или исполнителю, которого она запустила бы), так что предпросмотр в UI равен отправленному тексту.
- Доработка (форма FOLLOW_UP пользователя `/full-task <url> Задача готова, но нужны правки: <text>`):
  `POST /api/tasks/:id/rework { notes, agent? }` (флаг `rework`). Промпт = `agents.<id>.reworkPromptTemplate` (со своей
  командой — `"/full-task {taskUrl} Задача готова, но нужны правки: {notes}"`, по умолчанию `"{key} {title}: нужны правки: {notes}"`;
  `{notes}` — текст как введён, отрисовка за один проход; задаётся в /api/settings, должен содержать `{notes}`; значение по умолчанию
  лаунчера gigacode — форма /full-task даже без значения в конфиге). `/api/settings` → `agents.<id>.reworkPromptPresets`:
  сначала действующее значение по умолчанию, затем `agents.<id>.reworkPromptPresets` из конфига, затем общий шаблон
  (без дублей); PUT принимает `reworkPromptPresets` (строки с `{notes}`). Адресат: неархивный
  исполнитель задачи (`assigneeSessionId`) → доставляется (в очередь, если он работает; `--resume` продолжает сессию
  CLI); нет такого → новый исполнитель в существующем рабочем дереве задачи (или заново извлечённой ветке задачи, но никогда не новая ветка)
  с промптом доработки вместо промпта задачи; никогда не запускалась (нет ветки) → 409. Эффекты: статус → in_progress
  (при `board.moveSyncsTracker` обычная синхронизация перемещения), запись в журнале «Доработка: <notes>», без уведомления. Возвращает сессию.

## Субагенты как чаты

### Уровень 1 — виртуальные чаты только для чтения из потока (работает с неизменным `/full-task`)
Каждый вызов встроенного субагента (`agent` / `fork` tool_use в основном потоке) становится **виртуальной сессией**:
`{ id: '<parentSid>~<toolUseId>', kind: 'chat', virtual: true, parentId: <parentSid>, role: 'subagent', agent,
title: '<subagent_type> · <model|grade>', status: running|done|failed, model, cwd: parent's }` — сохраняется так же, как сессии,
перечисляется в `/api/state`, во вложении под родителем в UI. Её транскрипт строится из событий с
`parent_tool_use_id === toolUseId` (текст, вызовы/результаты инструментов — те же формы Message) плюс промпт вызова как
первое сообщение `user` и tool_result как финальное сообщение ассистента; `GET /api/sessions/<virtualId>/messages` работает,
для неё отправляются WS-события `msg`. `POST …/messages` в виртуальную сессию → 409 «внутренний субагент — писать можно
только в родительский чат». Карточка инструмента родителя хранит ссылку на неё (`tool.subSessionId`).

### Автоматически: оркестратор сам использует субагентов harness (без ручной команды)
`orchestration.subagents: "harness" | "builtin"` (по умолчанию `"harness"`, отдаётся в /api/settings). В режиме `"harness"`:
- MCP-сервер harness предоставляет инструмент **`agent`** с ТОЙ ЖЕ входной схемой, что у встроенного `agent` GigaCode
  (`subagent_type`, `prompt`, `model?`, `description?`, плюс необязательные `approvalMode`, `worktree`, `timeoutMin`), так что
  модель вызывает `mcp__harness__agent` так же, как встроенный. Это `worker_run` с
  `profile = subagent_type`, `spec = prompt` (оба имени остаются псевдонимами).
- КАЖДАЯ сессия gigacode/qwen/gemini в harness (одиночная, координатор, исполнитель, ревьюер) получает короткий контекстный блок в
  первом промпте (после ведущей слэш-команды, иначе в начале): «Ты работаешь внутри harness. Субагентов запускай
  инструментом mcp__harness__agent с теми же аргументами, что у встроенного agent (subagent_type, prompt, model) —
  встроенный agent не используй: harness откроет каждого субагента отдельным чатом и вернёт тебе его результат так же.»
- Навык `skills/harness-orchestration/SKILL.md` написан так, что работает и как навык GigaCode (frontmatter
  `name`/`description` с триггером "starting a sub-agent inside the harness"); `POST /api/agents/:id/skills/install`
  копирует его в `~/.gigacode/skills/harness-orchestration/SKILL.md` только по явному запросу; `/api/agents/:id/info` сообщает
  `skills: { 'harness-orchestration': 'installed' | 'missing' | 'different' }`. Промпт настройки просит агента на целевой машине
  установить его (с согласия пользователя).
- Если модель всё же вызывает встроенный `agent`, Уровень 1 показывает его как чат только для чтения — ничего не теряется.
- ПРОВЕРИТЬ на целевой машине: если GigaCode поддерживает хуки типа PreToolUse в настройках, `agents.gigacode.agentToolHook` (по
  умолчанию null) хранит конфигурацию хука, которую harness записывает в settings.json запуска, чтобы запретить встроенный `agent` с подсказкой
  «use mcp__harness__agent» (жёсткое принуждение). Формат неизвестен → не реализовано до проверки.
Режим `"builtin"`: без контекстного блока, без объявления инструмента `agent` harness (worker_run по-прежнему доступен).

### Уровень 2 — настоящие сессии субагентов через `worker_run` / `agent` harness («режим Orca»)
Агентский инструмент `worker_run { profile?: string, spec: string, model?: string, approvalMode?: string, title?: string,
worktree?: 'current' | 'new' (опущено = авто: 'new', когда `workspace` — другой репозиторий, иначе 'current'; явный
'current' в другом репозитории → 400; результат содержит `placement`, например "new (auto)"), timeoutMin?: number (по умолчанию 60) }` (и его совместимый со встроенным псевдоним `agent`):
синхронная замена встроенного инструмента `agent` GigaCode. Создаёт ВРЕМЕННУЮ сессию исполнителя (дочернюю к вызывающему, со своим чатом, без задачи на доске; название
«<profile> · <description или первая строка spec, ≤ 50>», как для чатов встроенных субагентов); если задан `profile`, читает
`~/.gigacode/agents/<profile>.md` (YAML-frontmatter `model`, `approvalMode`, `tools`, `description`; тело = промпт роли):
model/approvalMode по умолчанию берутся из frontmatter (явные аргументы приоритетнее), первый промпт = тело роли + «\n\n## Задание\n» + spec +
короткая преамбула исполнителя (отчитаться через worker_done). Возвращает управление, когда исполнитель вызывает `worker_done`
(`{ status, summary, sessionId }`), или когда его ход заканчивается без этого (`{ status: 'no_report', summary: <последний текст
ассистента>, sessionId }`), или по таймауту (`{ status: 'timeout', sessionId }`, исполнитель продолжает работать). Пользователь может наблюдать за этим исполнителем,
писать ему и останавливать его; сообщения от пользователя ставятся ему в очередь как обычно.
Транспорт: `POST /api/agent/worker_run` сразу возвращает `{ sessionId }`; затем `mcp/harness-mcp.js` длинным опросом вызывает
`GET /api/agent/worker_wait?sessionId=&timeoutMs=25000`, пока исполнитель не завершится, и на каждом опросе отправляет MCP `notifications/progress` (когда
клиент передал progressToken), чтобы вызов инструмента не истёк по таймауту; settings.json сессии задаёт
`mcpServers.harness.timeout = 3600000` (мс).
`commands/full-task-harness.md` (поставляется в репозитории): тонкая обёртка — загрузить `full-task` через инструмент навыков и выполнять его
полностью, кроме: каждый запуск субагента из §6/§8 (и разведчиков) идёт через `worker_run` harness с `profile` = именем
агента и `model` = моделью из таблицы §8 вместо инструмента `agent`; параллельные субагенты = несколько
вызовов `worker_run` за один ход; всё остальное без изменений; задача = `{{args}}`.
`POST /api/agents/:id/commands/install { name: 'full-task-harness' }` копирует её в `~/.gigacode/commands/` только по этому
явному запросу (отказывается перезаписывать другой существующий файл без `force`); `/api/agents/:id/info` сообщает
`commands: { 'full-task-harness': 'installed' | 'missing' | 'different' }`. Пресет `/full-task-harness {taskUrl}{notes}`
добавляется в `taskPromptPresets`.

### Очистка субагентов и глубина

- `orchestration.subagentRetention`: `"archive"` (по умолчанию) | `"keep"`; `orchestration.maxSubagentDepth` (по умолчанию 1); оба в
  /api/settings. Помощник в том же рабочем дереве (worker_run / `agent` harness в рабочем дереве вызывающего) временный: как только
  он завершился (done/failed/stopped/no_report) и его результат доставлен, он архивируется (`archived`, `archivedAt`; по id
  всё ещё открывается) — работающий ход, когда его процесс завершается. Чат встроенного (виртуального) субагента остаётся рядом с родителем
  (боковая панель, панель исполнителей, доска агентов в дорожке родителя), пока не закончится ход родителя, затем он архивируется
  (как в Orca); панель перечисляет только неархивные. При `init` CLI, у которого в `mcp_servers` нет подключённого `harness`, получает
  одноразовую заметку «⚠ MCP-сервер harness …» в чате (там нет субагентов harness и вопросов). Его открытые
  вопросы/карточки разрешений (и его карточки, повторно выданные в родителе) закрываются как «отменено». Помощник на пределе глубины
  не может запускать помощников: worker_run/agent → 409 «Субагенты не запускают своих субагентов: выполни это сам или верни запрос
  оркестратору», его контекстный блок говорит то же, а в его tools/list нет `agent` (tools/list строится для каждой вызывающей сессии).
- Дочерний исполнитель в ДРУГОМ рабочем дереве или репозитории (`worktree: "new"`, аргумент `workspace` или другой корень рабочих деревьев)
  получает `persistent: true`: никогда не архивируется автоматически, его глубина сбрасывается в 0 (он может запускать собственных помощников в том же рабочем дереве), он отчитывается
  через worker_done как обычно. Исполнителей задач, координаторов и ревьюеров это не касается.

### Исполнители в стиле Orca: размещение, осмотр, повторы, группы

- Дочерний исполнитель, запущенный через worker_run/agent, получает `awaitedBy` = вызывающий. Его `ask` тогда не ставит сообщение в очередь за
  заблокированным вызовом вызывающего: он выставляет `pendingQuestion`, и ожидание возвращает `{ status: "asked", summary: "Субагент спрашивает: …
Ответь ему: send_message to <id>…" }`; дочерний остаётся живым (`waitingFor: answer`, не считается завершённым как no_report), а его
  результат позже доходит до вызывающего сообщением («Result (done): …», `askedParent`). Если за 60 с вопрос не подобран (вызов
  истёк по таймауту), он уходит как обычный вопрос в очереди.
- Режим подтверждения дочернего исполнителя: аргумент, иначе из его профиля, иначе режим ВЫЗЫВАЮЩЕГО (помощники координатора с «Полный доступ»
  тоже работают с полным доступом — по ACP harness сам отвечает на их запросы).
- Профиль `plan` запускается как `default` + `readOnly` (белый список `READ_ONLY_ALLOWED_TOOLS`: git status/diff/log/show…,
  dir/type/rg): режим plan в GigaCode отказывается от инструментов harness («Plan mode is active. The tool "mcp__harness__worker_done"
  cannot be executed because it modifies the system»). tools/list помечает не изменяющие инструменты `annotations.readOnlyHint`.
- Панель исполнителей чата перечисляет каждого неархивного дочернего, пока идёт ход чата; после него — только тех, кто ещё
  работает или ждёт (завершённый в своём рабочем дереве остаётся в боковой панели неархивированным).

- `worker_start(..., worktree: current | new-child | new-top-level, name?, workspace?)` (`new` = `new-child`): new-child = новое
  рабочее дерево репозитория вызывающего (`<repo>-worktrees/<name>`, ветка по ключу задачи), `meta.parentWorktree` = рабочее дерево
  вызывающего (UI вкладывает его под него); new-top-level = новое рабочее дерево в репозитории `workspace` (без него 400). Оба варианта
  дают `persistent` исполнителя и добавляют его рабочее дерево в `includeDirs` вызывающего (убирается при удалении этого рабочего дерева);
  `meta.label` = name. `worker_run` / `agent` принимают `name` для `worktree: "new"` (папка и ветка = name).
- `worker_inspect { session_id }` (только собственные потомки, иначе 403): `{ status, state, title, cwd, branch, dirty, ahead,
  diffStat (git diff --stat относительно base + число неотслеживаемых), lastAssistant (2000 символов), report, waitingFor, updatedAt }`.
  Элементы `worker_list` добавляют `worktreePath`, `persistent`. `worker_stop { session_id }` → `{ stopped: true }` или
  `{ stopped: false, status: "stop_unknown" }`. `worker_retry { session_id, worktree? }` заново запускает ту же задачу (spec) в
  том же размещении (цепочка `retryOf`); 3 неудачных запуска в цепочке → 409 «Задача <key>: 3 неудачных запуска — сообщи
  пользователю» + уведомление. Группы `send_message`: `@all` (неархивные потомки), `@idle` (те, что не работают),
  `@worktree:<path>` (каждый чат в этом рабочем дереве, включая координаторов) → `{ delivered: [ids] }`.
- Эскалации координатору содержат причину остановки (последняя ошибка) и инструменты, которые можно использовать (send_message / worker_inspect /
  worker_stop + worker_retry / сообщить пользователю).
- Элементы списка рабочих деревьев: `createdBy: user | agent | external` (db.worktreeMeta[path].createdBy: создание из UI / «Взять в работу» →
  user; worker_start/worker_run/agent/port из сессии агента → agent + `createdBySession`; связанные рабочие деревья, запущенные от корня →
  agent; всё остальное → external) и `detached`. Неудавшиеся операции с рабочими деревьями сохраняют `meta.lastError { text, at }`
  (создание → в основном рабочем дереве репозитория; очищается при следующем успехе); изменения meta рассылаются как
  `{ t: "worktree.meta", path, meta }`.

## Проверка перед «готово» (флаг `checks`)

Команда проверки проекта (тесты, линтер, типы) хранится по проекту в `db.prefs.checksByWorkspace` (`PUT /api/settings`
`checks.byWorkspace: { <id проекта>: команда | null }`; `GET` отдаёт ещё `suggested` — что предлагают файлы репозитория:
`npm test && npm run lint`, `mvn -q test`, `gradlew test`, `go test ./...` …). `checks.maxRounds` (1..5, по умолчанию 2) и
`checks.timeoutMin` (1..180, по умолчанию 15) — в конфиге.

- Когда исполнитель задачи вызывает `worker_done(status: "done")`, а у его рабочего дерева есть проверка (у исполнителя в папке
  проектов — у рабочих деревьев задачи из `task.worktrees`), harness сам запускает команду в рабочем дереве (системная оболочка,
  `CI=1`) — `server/checks.js`. Пока идёт: `task.checks = { workerSessionId, round, state: "running" }`, `agentState: "checking"`.
- Прошла — `checks.state: "passed"`, дальше как обычно: ревью harness (если включено), иначе отчёт координатору и уведомление.
- Не прошла — вывод (хвост до 4000 символов) уходит исполнителю: «Проверка проекта не прошла (раунд N из M) … Исправь причину —
  не отключай и не пропускай проверки — и снова вызови worker_done». После последнего раунда — `agentState: "failed"`, уведомление
  `failed`, координатору — отчёт с тем, что упало.
- Каждый раунд пишется в журнал задачи (`type: "checks"`, `data: { round, ok, results }`) и заметкой в чат исполнителя.
- Исполнитель знает о проверке заранее: в его преамбуле строка «Проверка проекта: `<команда>` — запусти её сам перед worker_done».
- После перезапуска проверка в состоянии `running` запускается снова (тот же раунд).

## Оживление оборвавшегося хода (флаг `revive`)

Ход, который оборвался (ошибка хода `errorKind: "turn"`, обрыв связи), или агент, который молчит (`session.revive.stallWakeMin`,
по умолчанию 15 мин без событий **и** без выполняющегося инструмента — долгая сборка не трогается; процесс останавливается
харнессом, это не «Остановлено пользователем»), продолжается сам: в ту же сессию (`--resume`) уходит сообщение «Предыдущий ход
оборвался (<причина>). Продолжи с того места, где остановился…». Попытки — `session.revive.attempts` (по умолчанию 3) с паузами
30 с, 2 мин, 5 мин; в чате — заметка «продолжу сам через … (попытка N из M)». Не продолжаются: остановленные человеком, ждущие
ответа/разрешения/входа, не запустившиеся ни разу, без исполняемого файла или модели. Пока продолжение запланировано, координатор
и «Входящие» о падении не слышат. Попытки кончились — эскалация во «Входящие» с `actions: ["retry", "open"]`; «Повторить» —
`POST /api/sessions/:id/revive`. Удачный ход обнуляет счётчик (`session.revive`).

## Цикл ревью, который ведёт harness (`orchestration.reviewMode: "harness"`)

Не зависит от того, что говорит команда задачи (`/full-task`). Конфигурация:
```jsonc
"orchestration": {
  "reviewMode": "builtin",               // "builtin": the agent's own command reviews (as in the CLI); "harness": below
  "review": { "grade": "review", "approvalMode": "plan", "maxRounds": 2, "agent": null,
              "promptTemplate": "<default reviewer prompt with {key} {title} {description} {branch} {base} {cwd} {round} {previous}>" }
}
```
1. Исполнитель задачи (не ревьюер, не временный) вызывает `worker_done(status: 'done')` → вместо завершения у задачи
   `agentState = 'reviewing'`, и harness запускает (раунд 1) или переиспользует (раунд > 1) сессию РЕВЬЮЕРА: роль `reviewer`,
   родитель = исполнитель, тот же cwd, `model` = `settings.agents.modelGrades[review.grade]` агента ревьюера (пропускается, когда
   неизвестна/недоступна → значение CLI по умолчанию), `approvalMode = review.approvalMode` (`plan`, только чтение), название `Ревью <KEY>`,
   временная (без задачи на доске). Её промпт = отрисованный `review.promptTemplate` (по умолчанию: проверить `git diff <base>...HEAD`
   плюс незакоммиченные изменения задачи; перечислить замечания с CRITICAL/HIGH/MEDIUM/LOW; закончить `worker_done`, summary которого
   заканчивается на `VERDICT: APPROVED` или `VERDICT: CHANGES_REQUESTED`). Раунд > 1 отправляет в тот же чат ревьюера «Повторное ревью после
   исправлений» + прежние замечания.
2. `worker_done` ревьюера → вердикт = явная строка `VERDICT:`, иначе CHANGES_REQUESTED, если summary содержит CRITICAL
   или HIGH, иначе APPROVED. APPROVED → `agentState = 'approved'`, исполнитель получает информационное сообщение, родительский
   координатор (если есть) получает исходный отчёт исполнителя + «ревью: APPROVED», пользователь — уведомление.
   CHANGES_REQUESTED и раунд < maxRounds → `agentState = 'changes_requested'`, замечания доставляются исполнителю
   («Ревью, раунд n: … Исправь CRITICAL/HIGH и снова вызови worker_done»); раунд == maxRounds → уведомление «ревью не
   сошлось за N раундов» с замечаниями, `agentState = 'changes_requested'`.
3. В этом режиме преамбула исполнителя говорит: «Ревью выполняет harness другой моделью после твоего worker_done; пропусти шаги
   внутреннего ревью твоей команды (не запускай встроенных субагентов-ревьюеров)». Если агент всё равно ревьюит внутри себя,
   ничего не ломается — ревью harness всё равно выполняется.
4. `reviewMode: "builtin"` = прежнее поведение (без ревью harness; внутренние субагенты только визуализируются).
Роль сессии `reviewer`; ревьюеры вложены под своего исполнителя в UI; их транскрипты сохраняются.

## Каталог моделей, переживающий переименования (без правок кода при смене id моделей)

- Базовый id: модели сравниваются без суффикса контекста (`-<n>k|m`): `/models` сообщает `DeepSeek-V4.1-Flash-1017-262k`,
  CLI и конфиги — `DeepSeek-V4.1-Flash-1017`. `merged()` оставляет ОДНУ запись на базовый id (id = id из конфига, если есть,
  иначе обнаруженный; label из конфига; `context` из обнаруженного id); доступность, проверка закреплённой модели
  и пропуск градаций сравнивают по базовому id. В закоммиченном конфиге градаций по умолчанию нет (неизвестный id градации
  роняет GigaCode); градации выбираются в Настройках из обнаруженного каталога.
- Режимы подтверждения: `agents.<id>.approvalModeMap` (по умолчанию для gigacode/qwen `{ "auto": "auto-edit" }`, безголовый GigaCode
  отказывается от простого `auto` без песочницы действий) применяется к argv безголового запуска и ACP; сессия хранит
  выбранный режим и получает `effectiveApprovalMode` (с каким режимом запускался CLI). `agents.<id>.autoSandbox`:
  `null | "workspace" | "workspace-offline"` — если задан, `auto` не отображается, а настройки запуска получают
  `{ tools: { sandbox } }` (ПРОВЕРИТЬ: песочница ограничивает инструменты рабочим пространством, поэтому includeDirs/рабочие деревья вне
  cwd могут блокироваться). Оба параметра есть в `/api/settings`. `GET /api/agents/:id/info` и `--print-config` добавляют
  `identity: { found, source }` (шим, из которого взят identity; само значение — никогда).

- Источники, объединяемые и дедуплицируемые по id: (1) **обнаруженные** — harness запускает CLI агента без головы с
  `agents.<id>.modelsDiscovery.prompt` (по умолчанию для gigacode `"/models"`) в `<dataDir>/chats/helper/discovery` (без записи чата CLI) — сначала с
  лёгкими `quickArgs` (`--safe-mode`: без MCP-серверов), полный запуск только если там id не найдено; строки stderr `Warning:`
  никогда не считаются сообщаемой ошибкой — берётся итоговый
  текст (`result` / текст ассистента) и из него извлекаются id моделей терпимым разбором (markdown-таблица / список / обычные строки;
  токен = буквы/цифры/`.`/`-`, содержит цифру и `-`, 4–80 символов; рядом может быть контекст вроде `262k`/`128k`)
  либо через `modelsDiscovery.pattern` (регулярное выражение с группой захвата), если задан; результат кэшируется в `db.agentMeta[agent].catalog =
  { models: [{id, context?}], at, error? }`; (2) **замеченные** — модели из событий `system/init`; (3) **конфиг**
  `agents.<id>.models` — только метки/описания/порядок (переопределения), не источник истины.
- Каждая объединённая запись: `{ id, label?, context?, description?, available: boolean | null }` — `available = false`, когда
  есть свежее обнаружение и id в нём отсутствует (показывается серым «недоступна», никогда не отбрасывается молча); `null`, когда
  обнаружения ещё не было.
- Триггеры обнаружения: лениво, когда запрашивается `/api/agents/:id/info` или `/api/state` и каталог старше
  `modelsDiscovery.maxAgeHours` (по умолчанию 24) — в фоне, никогда не блокируя запрос; `POST /api/agents/:id/models/refresh`
  (кнопки UI) → `{ models, at, error? }`; автоматически после хода, который завершился ошибкой "is not present in the current backend
  catalogue" (или `modelsDiscovery.missingPattern`). Обнаружение выполняется не более одного за раз на агента; сбои сохраняются в
  `catalog.error` и показываются, никогда не фатальны.
- Устойчивые запуски: при записи settings.json сессии градации, чья модель заведомо недоступна (`available === false`),
  пропускаются (CLI возвращается к значению по умолчанию), и один раз на сессию добавляется системная заметка ⚠; сессия, чья `model`
  заведомо недоступна, получает карточку ошибки вместо заранее обречённого запуска только если обнаружение свежее — иначе ход
  всё же пробуется (каталог может быть устаревшим). Сбой «модель отсутствует» порождает Message с
  `action: 'pick-model'`, чтобы UI мог предложить выбор модели + «Повторить».
- `/api/agents/:id/info` возвращает `catalog` (`{ at, error }`) и объединённые `models`; `/api/state` agents[].models — это
  объединённый список. Произвольные id моделей всегда принимаются (PATCH session.model, настройки).

## Авторизация GigaCode (первый запуск на машине)

GigaCode просит войти через браузер / по ссылке при первом использовании. Поведение безголового `-p` без входа
НЕ подтверждено (он может напечатать URL / код устройства и ждать обратного вызова браузера или завершиться ошибкой). Поэтому runner:
- сканирует не-JSON строки stdout и stderr (до первого JSON-события) на URL в строке, которая также совпадает с
  `/auth|login|oauth|device|verif|sign.?in|авториз|войд|вход/i` (или следующая строка содержит короткий код вроде `ABCD-EFGH`);
- при обнаружении: `session.phase = 'auth'`, системное сообщение `{ kind: 'system', text: '🔑 GigaCode ждёт авторизацию…', link: <url> }`
  (поле `link` у Message), уведомление `{ kind: 'info', text, sessionId, link }`, `db.agentMeta[agent].auth = 'required'`;
  таймаут первого события приостанавливается и заменяется на `agents.<id>.authTimeoutMs` (по умолчанию 600000) — после входа запуск
  продолжается сам; последующий `system/init` выставляет `auth = 'ok'`.
- `GET /api/agents/:id/info` добавляет `auth: 'ok' | 'required' | 'unknown'`.
- Вход из UI: Настройки → «Войти в GigaCode» = `POST /api/sessions { kind: 'terminal', agent: 'gigacode', title:
  'Вход в GigaCode', cwd: <dataDir>/chats/login }` — интерактивный CLI в PTY (ссылки кликабельны через xterm web-links).

## Управление рабочими деревьями и очистка (контекстное меню как в Orca)

- Элементы `GET /api/workspaces/:id/worktrees` дополняются: `{ path, branch, head, main, dirty: number (изменённых файлов),
  ahead: number (коммитов, которых нет в git.defaultBase / targets[0] задачи), taskId: string|null, taskStatus, pr: {state,url}|null,
  sessions: number, running: number, lastActivityAt: number|null, meta: { label?, note?, pinned?: boolean,
  sleeping?: boolean } }` (данные git считаются параллельно с коротким кэшем; meta из `db.worktreeMeta[path]`).
- Масштаб (≈10 репозиториев × 10–20 рабочих деревьев): по умолчанию список дешёвый — один `git worktree list` + meta + число сессий +
  задача/PR из db; `dirty`/`ahead` равны `null`, а `enriched: false`, если нет `?enrich=1` (или свежей записи в кэше).
  `GET /api/worktrees/info?path=` дополняет одно зарегистрированное рабочее дерево. Дополнение: кэш по пути 30 с, не более 4
  вычислений (процессов git) одновременно; при старте ничего не дополняется; обновление PR обходит задачи по одной.
  `lastActivityAt` = самое позднее из: активность сессий рабочего дерева, mtime его рефлога `logs/HEAD` (иначе `HEAD`) и
  — при дополнении или наличии в кэше — время его последнего коммита (`git log -1 --format=%ct`); никогда не mtime индекса. Каждый дочерний процесс git
  запускается с `GIT_OPTIONAL_LOCKS=0`, поэтому чтения (status, diff, log, …) никогда не обновляют/не переписывают индекс. `workspaceId`
  сессии = git-репозиторий, чей список рабочих деревьев содержит её cwd (рабочие деревья обычно лежат вне папки
  репозитория), иначе самая глубокая зарегистрированная папка; при старте один проход (с кэшированными списками рабочих деревьев) переносит существующие
  неархивные сессии, привязанные к папке-workspace, в репозиторий, которому принадлежит их рабочее дерево (число записывается в лог).
  У каждой сессии также есть `worktreePath` (корень рабочего дерева, содержащий её cwd — включая подпапку — по самому длинному префиксу
  среди списков рабочих деревьев зарегистрированных репозиториев, без учёта регистра в Windows; null для папки проектов или обычной
  папки) и `system: true` для всего, что находится в собственных папках harness `<dataDir>/chats` (папки чатов по умолчанию,
  терминал входа, обнаружение моделей), `<dataDir>/terms`, `<dataDir>/runs`: без workspace, без рабочего дерева, никогда не группируется под
  проектом (папка проектов внутри каталога данных, как `<dataDir>/projects` в демо, не является системной). Проход при старте
  пересчитывает все три поля.
  Флаг возможности `worktree-lazy`.
- `PATCH /api/worktrees/meta { path, label?, note?, pinned?, sleeping? }` → meta, рассылается как `{ t: "worktree.meta" }`.
  Ход, начинающийся в «спящем» рабочем дереве, будит его (`sleeping: false`, рассылка).
  `sleeping: true` останавливает терминальные PTY в этом cwd (чат-сессии и так простаивают между ходами; работающий ход НЕ
  убивается — 409, если нет `force`). «Сессии в рабочем дереве» (здесь, DELETE, checkout, счётчики в списке) = сессии, у которых
  `worktreePath` — это рабочее дерево, или (без worktreePath) чей cwd внутри него — агент в подпапке тоже считается.
- `DELETE /api/workspaces/:id/worktrees { path, force?, deleteBranch?: 'no'|'safe'|'force' }`: отказывает для основного рабочего дерева
  (400); отказывает с 409 `{ dirty, ahead, running }`, когда есть незакоммиченные изменения, неотправленные/неслитые коммиты или
  работающий ход и `force` не задан; иначе останавливает все сессии в этом cwd (терминалы закрываются, работающие ходы убиваются),
  помечает их `archived: true` (скрыты из боковой панели, транскрипты сохраняются; `GET /api/state` их по-прежнему возвращает),
  безопасно удаляет рабочее дерево (`git worktree remove --force`; если git завершился ошибкой и всё ещё перечисляет его — заблокировано, … — 400,
  и папка НЕ трогается; иначе то, что осталось → переименование в `.stale-<ts>` → rm, затем `prune --expire now`),
  затем при необходимости `git branch -d` (`safe`) / `-D` (`force`); задача сохраняет свой журнал, `task.branch` остаётся для истории.
  → `{ removed: true, branchDeleted: boolean, archivedSessions: n }`. Сбой выставляет `meta.lastError` (+ `meta.repo`).
- Сироты: папка в корне рабочих деревьев репозитория, которую git больше не перечисляет, но для которой есть запись meta harness (удаление,
  прерванное на полпути: git снял регистрацию, удерживаемый файл сохранил папку), перечисляется в `GET …/worktrees` как
  `{ path, branch: null, head: null, orphan: true, meta, … }` (meta.repo относит её к репозиторию при общем worktreeRoot).
  «Удалить папку» = `DELETE /api/workspaces/:id/worktrees { path, orphan: true }`: архивирует её сессии, переименование + rm
  только самой папки (без команд git над ней), удаляет meta, выполняет prune → `{ removed: true, orphan: true }`; 404 для пути,
  который не является такой сиротой, 409, если папку всё ещё нельзя удалить (выставляется lastError).
- `POST /api/open { cwd, target: 'explorer' | 'ide' }`: запускает файловый менеджер ОС (`explorer.exe` / `open` / `xdg-open`)
  или `config.ide = { command, args: ["{path}"] }` (по умолчанию null → пункт IDE скрыт), без оболочки, путь проверяется:
  это должен быть зарегистрированный workspace или одно из его рабочих деревьев. Команда разрешается так же, как CLI агента (поиск в PATH;
  лаунчер `.cmd` вроде `code.cmd` → его цель); команда, которую не удалось найти или запустить → 400
  «Не удалось запустить «…»: …» (никогда не `ok: true` для неудавшегося запуска).
- Поле сессии `archived: boolean`.

## Запуски переживают перезапуск harness

Ход агента запускается отсоединённым (`detached: true`, `windowsHide: true`), stdout/stderr перенаправляются в файлы
`runs/<sid>/turn-<n>.out.ndjson` / `.err.txt` (не в каналы), а harness читает хвост файла stdout (fs.watch + опрос,
буфер неполной строки, смещение в байтах сохраняется в сессии как `turnOffset`). pid сохраняется. При старте сессия,
оставшаяся `running`, у которой pid ещё жив и файл хода существует, переподключается (чтение хвоста продолжается с сохранённого смещения;
добавляется системная заметка «переподключено после перезапуска»); живость опрашивается (process.kill(pid, 0)), поскольку переподключённый
процесс не наш дочерний — ход завершается по событию `result` или когда pid исчезает (нет result → ошибка из
хвоста файла .err). Если pid исчез, оставшийся файл вычитывается один раз и ход завершается. Остановка harness никогда не
убивает ходы агентов (терминальные PTY всё же закрываются). Stop по-прежнему убивает дерево по pid. Файлы хода удаляются вместе с сессией.

Поле задачи `pr: { index, state, url, updatedAt } | null` обновляется для задач, у которых есть `branch` и workspace, когда
`integrations.pr.refreshSec` > 0 (минимум 30) и подключён клиент UI; рассылаются только изменения.

`GET /api/tasks/:id/external` также возвращает `links: [{ type, from, to }]` (onework `listLinks`; одна запись на связанную задачу —
`decomposition` приоритетнее других типов —, связи, не затрагивающие этот ключ или указывающие на себя, отбрасываются); связи `decomposition`, у которых
`from` — эта задача, — её дочерние. `POST /api/tasks/:id/import-children` импортирует эти дочерние ключи (getIssue для каждого) как задачи
с `parentId` = эта задача и workspace/targets родителя, с дедупликацией по externalId → `{ imported, updated }`.

## Внутренний реестр субагентов агента (совместимость, только чтение)

Некоторые команды задач (например, `/full-task-ui`) запускают собственных внутренних субагентов и пишут реестр в
`{registryDir}`: `<registryDir>/<agentId>/agent.json` (один объект) + `log.jsonl` (события только на добавление).
harness только ЧИТАЕТ его (опрос каждые 2 с, пока сессия работает, иначе по запросу) и показывает их как
строки только для чтения, вложенные под сессию (`GET /api/sessions/:id/subagents`, WS `{ t: 'subagents', sessionId, items }`).
`agent.json`: обязательные `id, name, startedAt, state`; `state` ∈ `queued working restarting compacting waiting blocked
idle done failed interrupted unverifiable`; необязательные `model role parentId worktree lastText lastActivity
activity{tool,since} tokensIn tokensOut settledAt`. Правила чтения: битая запись → пропускается (считается в списке
`problems`, никогда не падает); `working`, у которого `lastActivity` (или `startedAt`, если null) старше
`session.idleWindowSec` (по умолчанию 90), → показывается как `unverifiable` (файл никогда не переписывается); конечные состояния без
`settledAt` помечаются; токены по умолчанию 0. Метки времени — строки ISO-8601 (принимаются и числа epoch). Хвост
`log.jsonl` даёт `lastEvent: { ts, event, state, note, tool }`, а `lastText` берёт запасное значение из его `note`. Поля элемента:
поля agent.json + `flags: string[]` + `lastEvent`. Эти строки отделены от исполнителей harness (которые — настоящие
сессии со своими чатами).

## Доска ↔ трекер: семантика

- Добавленные поля задачи: `externalStatus: string | null` (сырой статус трекера), `statusManual: boolean` (выставляется, когда
  человек двигает карточку; тогда импорт никогда не перезаписывает `status`), `hidden: boolean`, `takenAt: number | null`,
  `snapshot: { title, description, externalStatus, at } | null` (замораживается при взятии в работу).
- Доска = (импортированные, открытые, назначенные на меня) ∪ (взятые в работу через harness, остаются, даже если трекер перестаёт
  их возвращать) ∪ локальные задачи, за вычетом `hidden`. Импортированные задачи, чей статус входит в `integrations.tasks.closedStatuses`,
  не добавляются; известная задача, чей статус в трекере стал закрытым: никогда не бравшаяся в работу (нет takenAt, нет исполнителя, нет
  рабочих деревьев (worktree)) → `hidden: true` + запись в журнале «Закрыта в трекере — скрыта с доски» (один раз); бравшаяся в работу → статус `done` + запись в журнале
  «Закрыта в трекере — перенесена в «Готово»» даже при `statusManual` (закрытие приоритетнее; остальные статусы трекера по-прежнему уважают
  вручную выбранную колонку), никогда не скрывается автоматически. То же правило один раз выполняется при каждом старте для ранее импортированных задач. Значение
  closedStatuses по умолчанию (когда не задано): done, closed, cancelled, canceled, declined, resolved, rejected; колонка «К работе» сопоставляется со статусами
  todo, created, new, open. `DELETE` импортированной задачи = `hidden: true` (повторный импорт оставляет её скрытой);
  локальные задачи удаляются по-настоящему. Поиск по ключу находит и скрытые/закрытые; в UI есть переключатель «показать скрытые».
- Колонка берётся из `statusMap(externalStatus)` при импорте, если нет `statusManual`. Перемещение карточки НИКОГДА не меняет
  трекер; смена статуса в трекере — явное действие: `GET /api/tasks/:id/transitions`, затем
  `POST /api/tasks/:id/tracker-status { transition, comment? }` → `transitionTask()` в `server/integrations/tasks.js`.
- onework (`format: "onework-markdown"`): инструменты отвечают MARKDOWN. Импорт = `tools.find` с
  `{space_code: <space>, assignee: "me", page_size: 100, page_number: n}`, пока `has_next` (≤ 20 страниц, останавливается на `limit`),
  строки `N. **<KEY>** — <summary> [<status> | <priority>] @<assignee>`; закрытые статусы фильтруются на нашей стороне; описания
  в списке нет → `GET /api/tasks/:id/external` получает его лениво. Ошибки инструментов приходят текстом
  (`reported tool error`, `{"error":"…"}`) и становятся ошибками с внутренним сообщением.
### Колонки доски следуют рабочему процессу команды (настраивается)

Внутренние статусы остаются 5 смысловыми значениями (`backlog todo in_progress review done`); доска показывает настроенное
подмножество с метками команды и владеет сопоставлением с трекером. По умолчанию (процесс пользователя: взять → в работе → тестирование и обратно
на доработку):
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
- Статусы, не перечисленные в `columns` (по умолчанию backlog, done), скрыты за «Показать все статусы»; импорт сопоставляет
  статусы трекера через `columns[].trackerStatuses` (это заменяет `integrations.tasks.statusMap`, который остаётся
  запасным вариантом для неизвестных статусов → `todo`); закрытые статусы по-прежнему не импортируются.
- Значок агента у задачи: `task.agentState: 'running' | 'waiting' | 'done' | 'failed' | 'reviewing' | 'approved' |
  'changes_requested' | null` (выводится из сессии исполнителя и цикла ревью harness, рассылается вместе с задачей).
  `worker_done` при `onWorkerDone: "stay"` оставляет колонку (failed тоже больше не возвращает задачу в todo).
- Синхронизация трекера при перемещении (по желанию, `moveSyncsTracker`): после перемещения импортированной задачи в колонку C (пользователем или
  в in_progress через «Взять в работу» — это заменяет `integrations.tasks.onStartTransition`, который остаётся как псевдоним)
  harness загружает доступные для задачи переходы (`getIssueMeta`) и выбирает `columnTransitions[C.status]`, если он доступен,
  иначе первый переход, чей ЦЕЛЕВОЙ статус (статус в скобках в `- \`id\` → name (\`status\`)`) входит в
  `C.trackerStatuses`; вызывает `updateIssueStatus`; при «нет подходящего перехода» или ошибке перемещение на доске остаётся, строка ⚠
  попадает в журнал задачи и отправляется уведомление с причиной (никаких тихих записей в трекер, без отката карточки).
- `/api/settings` отдаёт и принимает `board` (проверяется: статусы ∈ 5 значений, уникальны, ≥ 1 колонка, метки непустые).

- Периодическая синхронизация: `integrations.tasks.refreshSec` (0 = выкл., минимум 10), пока подключён хотя бы один клиент UI;
  рассылаются только изменившиеся задачи (подпись = ключ + статус + название). При сбое доска сохраняет локальный снимок,
  а `GET /api/state` → `integrations.tasksProblem: { error, at } | null` показывается баннером («трекер недоступен,
  показан снимок на HH:MM»). Формат JSON: `limit` передаётся в аргументы инструмента (ограничение на стороне сервера).
- `integrations.tasks.space` — код пространства или массив кодов: синхронизация обходит каждое пространство (`assignee: "me"`, постранично)
  и объединяет по ключу; /api/settings принимает обе формы (ключ остаётся `space`).
- `POST /api/tasks/import { ref }` (флаг `tracker-import`): `ref` = ключ (`PROJ-1234`) или любая ссылка трекера, содержащая
  его (`/([A-Z][A-Z0-9_]+-\d+)/`) → `tools.get` → добавляется как импортированная задача (дедупликация по externalId, статус через
  columns/statusMap, описание из markdown задачи, externalUrl из `urlTemplate`, иначе переданная ссылка), в том числе
  когда она не назначена на меня; возвращает задачу. Только onework-markdown (иначе 501).

## Консольный MCP: серверы, секреты и сбои
Три отдельных слоя MCP — никогда не смешивать:
1. **Консольный MCP** (сам harness читает трекер / создаёт PR): определения серверов берутся из
   `config.mcpServers`, наложенного на `mcpServers` из `config.mcpServersFrom` (по умолчанию `~/.gigacode/settings.json`,
   переопределение через env `CONSOLE_MCP_SETTINGS`; отсутствие файла допустимо). Доступ к трекеру идёт через сервер `onework`
   (инструменты `sbertrack_findIssues`, `sbertrack_listLinks`, `sbertrack_getIssue`, `sbertrack_getIssueMeta`,
   `sbertrack_updateIssueStatus`, `sbertrack_getUser`). Никогда не вызывайте отдельный сервер `sbertrack` для чтения
   задач (он отвечает 403). PR идут через `sourcecontrol`.
2. **Агентский MCP** (что видит GigaCode при запуске): только через `mcpServers` в settings.json сессии
   (`harness` + `agentMcpServers`), плюс всё, что у пользователя в `~/.gigacode/settings.json`.
3. **Сопоставление расширений**: имена инструментов различаются у провайдеров (префиксы), поэтому то, какой инструмент делает find / get / meta /
   transition / links / me, — это данные конфигурации (`integrations.tasks.tools`), а не жёстко заданные значения.

Секреты:
- Записи серверов в `mcpServersFrom` используют формат gemini/qwen: `{ type: "http", url, headers }` или `{ httpUrl }` → http,
  `{ command, args, env }` → stdio.
- Файл секретов: `HARNESS_MCP_SECRETS` || `CONSOLE_MCP_SECRETS` || `config.mcpSecretsFile` || `<dataDir>/mcp-secrets.json`.
  Форматы: JSON `{ "<name>": "<value>" }`, либо текстовые строки `server/Name=value` (комментарии `#`, разделение по первому `=`), либо
  одно «голое» значение (без `=`), которое означает `onework/Authorization`. Имена `scope/header` и `scope_header` равнозначны.
  Секрет `server/Name` идёт НА ЭТОТ сервер: `headers[Name]` для http, `env[Name]` для stdio.
- Строковые значения конфигурации (env, headers, args, url) могут ссылаться на секреты: `${env:NAME}` (окружение процесса, иначе секрет NAME)
  и `$secret:scope/header` / `${secret:scope/header}`. Разрешаются в момент вызова; никогда не логируются и не возвращаются никаким API.
- Каждый секрет также экспортируется в дочерние stdio MCP-процессы и процессы агентов как `MCP_SECRET_<NAME>`
  (`/` → `_`, например `MCP_SECRET_onework_Authorization`).
- Сервер с отсутствующим секретом остаётся в списке с `problem: "missing secret <name>"`; остальные серверы продолжают работать
  (никакого 401, который обнуляет всю карту).
- stdio-серверы: подключение на каждый вызов (запуск → initialize → вызов → закрытие); таймаут на каждый вызов.
- `node server/index.js --print-config` печатает разрешённую конфигурацию: пути (и существуют ли они), режимы подтверждения,
  период обновления, какие секреты присутствуют (только имена, никогда значения). При старте любая строка конфигурации, похожая
  на токен/пароль (длинное значение с высокой энтропией под ключом вроде token/secret/password/authorization), вызывает громкое предупреждение.
- Переменная окружения `HARNESS_CONFIG` выбирает файл конфигурации (по умолчанию `harness.config.json` + `.local`), чтобы рабочие и тестовые
  конфигурации никогда не смешивались.

## Где работает чат: папка проектов, любая папка, дополнительные каталоги

- **Папка проектов** (`workspaces.root`): если null, определяется автоматически как самый глубокий общий родитель ≥ 2 зарегистрированных
  workspace (в Настройках показывается как «Авто»). Это полноценный *workspace-папка* (`{ id, name, path, isGit: false,
  kind: 'root' }`, создаётся/обновляется при старте), стоящий первым в боковой панели как «Все проекты (<dirname>)». Чат там
  видит каждый проект под ней (типичное использование CLI «запуск в папке проектов»). Место по умолчанию для «Новый чат»,
  когда ничего не выбрано.
- **Любая папка**: `GET /api/fs/dirs?path=` → `{ path, parent, entries: [{ name, path }], roots: string[] }` (Windows:
  буквы дисков как корни; POSIX: `/` и `~`; только каталоги; скрытые каталоги пропускаются, если нет `?hidden=1`; защищено токеном,
  как и всё остальное). `POST /api/workspaces { path, kind: 'folder' }` регистрирует её (не-git допустимо), и чат
  запускается там. `db.prefs.recentFolders` (последние 10) возвращается `/api/state` как `recentFolders`.
- **Дополнительные каталоги** (GigaCode `--include-directories` / `--add-dir`, безголовая форма интерактивной `/dir add`):
  поле сессии `includeDirs: string[]` (абсолютные существующие каталоги, без дублей, исключая cwd и его предков).
  Лаунчеры gigacode/qwen/gemini добавляют `--include-directories <dir>` по разу на каталог на КАЖДОМ ходе (каждый ход — новый
  процесс, поэтому изменения применяются со следующего сообщения; лаунчер claude: `--add-dir <dir>`). Редактируется через
  `PATCH /api/sessions/:id { includeDirs }`. Автозаполнение: `includeDirs` исполнителя задачи = репозитории (или существующие рабочие деревья задач)
  остальных подзадач той же родительской задачи + явные `includeDirs` родительской задачи; координатору в
  папке проектов они не нужны. Терминальные сессии с CLI агента получают те же флаги при запуске.
  `POST /api/sessions` принимает `includeDirs`. Флаги возможностей: `folders`, `include-dirs`.
- Текст без единой буквы и с несколькими группами «??» (кириллица потеряна клиентом не в UTF-8, например Windows PowerShell 5.1
  `Invoke-RestMethod`) отвергается с 400 в `POST /api/sessions` (title, prompt), `/api/sessions/:id/messages` и
  `/api/handoff` (input, notes); одиночное «???» проходит.
- Заметки по реализации: `name` корневого workspace — имя папки (UI добавляет «Все проекты»); автоопределение использует
  только workspace-репозитории (не `kind: 'folder'`) и повторяется при добавлении/удалении workspace; `workspaceId`
  сессии — САМАЯ ГЛУБОКАЯ зарегистрированная папка, содержащая её cwd. Скрытые = имена, начинающиеся с `.` или `$`.
  `recentFolders` обновляется через `POST /api/workspaces { kind: 'folder' }` и через `POST /api/sessions` с явным
  cwd. Собственные дополнительные папки родительской задачи: `PATCH /api/tasks/:id { includeDirs }`. Некорректные `includeDirs` из API →
  400; автозаполненные, которых больше нет, отбрасываются молча, так же как устаревшие записи, когда сам harness
  правит список сессии (добавленное worker_start/worker_run дочернее рабочее дерево, удалённое рабочее дерево): это никогда
  не приводит к ошибке. worker_start / worker_run никогда не оставляют сирот: сбой после создания сессии (или рабочего дерева) удаляет её.
  Параметр маршрута с некорректной %-последовательностью → 400.
- `/api/settings` возвращает и принимает `workspaces: { root, repos }` (root: существующая абсолютная папка или null = авто;
  repos: string[]) и возвращает `rootResolved` (используемая папка проектов) + `rootAuto`; сохранение заново регистрирует
  настроенные репозитории, заново запускает определение папки проектов и рассылает `workspaces`.

## Вопросы агента и запросы разрешений

**Вопросы.** (а) `ask` harness (MCP) — уже есть: вопрос + `options`, `waitingFor: 'answer'`, ответ доставляется следующим
сообщением. (б) Собственный структурированный инструмент вопросов CLI: имена tool_use, перечисленные в `agents.<id>.questionTools` (по умолчанию для gigacode
`["ask_user_question", "ask_user", "AskUserQuestion"]`, ПРОВЕРИТЬ настоящее имя), нормализуются в Message
`{ kind: 'question', question: { id, text, options: [{label, description?}], multiSelect } }` + `waitingFor: 'answer'`;
всё, что CLI возвращает на этот вызов в безголовом режиме, скрывается; выбор пользователя доставляется как «Ответ на вопрос «…»: …».
(в) Контекстный блок harness говорит агенту: «вопросы человеку — через mcp__harness__ask (варианты в options), затем заверши ход».

**Разрешения, безголовый транспорт (по умолчанию).** CLI не может ждать подтверждения в режиме `-p`, поэтому отказывает. Нормализатор
обнаруживает отклонённый вызов инструмента (tool_result `is_error`, текст которого соответствует `agents.<id>.denialPattern`, по умолчанию
`/(requires? (user )?(approval|confirmation)|not allowed|denied|permission|подтвержд|запрещ)/i`, ПРОВЕРИТЬ настоящую формулировку) и
выдаёт Message `{ kind: 'permission', permission: { id, tool, input, reason, transport: 'headless',
options: [{id:'allow_once',label:'Разрешить один раз'}, {id:'allow_session',label:'Разрешать в этой сессии'},
{id:'reject',label:'Запретить'}] } }`, у сессии `waitingFor: 'permission'`. `POST /api/sessions/:id/permission
{ permissionId, optionId, note? }`: allow_once → следующий ход с режимом подтверждения на один шаг мягче
(`plan→default→auto-edit→auto`, по порядку `approvalModes`) только на этот ход + сообщение «Разрешаю: выполни <tool> <input
summary>»; allow_session → PATCH session.approvalMode на этот режим + то же сообщение; reject → сообщение «Не выполняй это
(<tool>); найди другой путь или спроси». После этого карточка показывает принятое решение.
**Заменено на целевой машине (подтверждено: `auto` работает как `auto-edit`, который никогда не разрешает `run_shell_command`, поэтому эскалации
некуда идти) — безголовые разрешения теперь строятся на белом списке:** текст отказа `requires permission to use "<tool>"`
называет инструмент; карточка несёт `permission.pattern` (shell → `run_shell_command(<первое слово команды, не cd>)`, например
`cd /d X && git status` → `run_shell_command(git)`; другие инструменты → имя инструмента), `answered`/`resolved`/`resolvedAt`.
allow_once → разрешение на один ход (`session.grantsOnce`, расходуется следующим ходом); allow_project («Разрешать всегда в этом
проекте», предлагается только для сессии с `workspaceId`) → `db.prefs.allowedToolsByWorkspace[workspaceId]`, подмешивается в
каждый ход каждой сессии этого проекта; `/api/settings` возвращает, а PUT заменяет `permissions: {
allowedToolsByWorkspace: { <workspaceId>: string[] } }` (неизвестные id workspace → 400); allow_session → `session.allowedTools`
(PATCH `/api/sessions/:id { allowedTools }` правит его); обе доставляют «Разрешено: повтори <tool> <input summary>» (в очередь, если
ход ещё идёт). Каждый безголовый ход передаёт `agents.<id>.allowedTools` (Настройки «Разрешённые команды») ∪
`session.allowedTools` ∪ разовые разрешения как `agents.<id>.allowedToolsFlag` (по умолчанию для gigacode/qwen `--allowed-tools`,
ПРОВЕРИТЬ), повторяемый для каждой записи (`allowedToolsJoin: "comma"` соединяет их через запятую). Режим подтверждения повышается только для инструмента
редактирования в режиме plan/default. Отказ субагента повторно выдаётся в РОДИТЕЛЬСКОМ чате (`from` = сессия субагента,
`permission.fromSubSessionId`, текст «субагент <type>: <tool>»); разрешение применяется к следующему ходу родителя. Повторяющееся
предупреждение stderr — одно сообщение ⚠ на сессию со `count`; статусы MCP из init сохраняются как `session.mcpStatus`.

**Разрешения, транспорт ACP (`agents.<id>.transport: "acp"`, ПРОВЕРИТЬ для GigaCode `--acp`).** Один долгоживущий процесс на
сессию (`<cli> --acp [--approval-mode m] [--model m] [--include-directories …]`), JSON-RPC 2.0 поверх stdio (ndjson):
`initialize` (clientCapabilities fs.read/write true, terminal false) → `session/new {cwd, mcpServers:[harness + agentMcpServers]}`
(или `session/load {sessionId}`, когда агент поддерживает loadSession и у нас есть externalSessionId) → на каждое сообщение
`session/prompt {sessionId, prompt:[{type:'text',text}]}`; уведомления `session/update` отображаются в те же Message
(agent_message_chunk → дельта текста ассистента, agent_thought_chunk → рассуждение, tool_call/tool_call_update → инструмент (вызов может прийти с rawInput {}, а его настоящий ввод — в более позднем
tool_call_update: карточка, а для вызовов agent — название чата субагента и сообщение задачи, заполняются тогда), plan →
системная заметка о плане); в режиме «Полный доступ» (approvalMode auto/yolo/bypassPermissions) harness сам отвечает на каждый
`session/request_permission` вариантом «разрешить один раз» (никогда «всегда»: это пишет настройки CLI), без карточки; запрос,
несущий собственный вопрос CLI (его toolCallId — вызов инструмента вопроса, или rawInput.questions), — ОДНА
карточка вопроса: запрос остаётся удержанным (агент ждёт), ответ человека отклоняет его, тихо завершает ход (без
«Остановлено») и уходит следующим сообщением; иначе `session/request_permission {toolCall, options[{optionId,name,kind}]}` → Message `permission` с
вариантами агента (`transport: 'acp'`), JSON-RPC запрос удерживается, пока `POST /api/sessions/:id/permission`
не ответит `{outcome:{outcome:'selected', optionId}}` (или `cancelled` по Stop); `fs/read_text_file` / `fs/write_text_file`
обслуживаются внутри cwd/includeDirs; Stop → `session/cancel`; процесс лениво перезапускается, если умирает (load или новая сессия +
системная заметка). То же разрешение identity/лаунчера, что и в безголовом режиме. Тесты покрывает мок ACP-агента (`scripts/mock-acp-agent.js`).
Флаги возможностей: `questions`, `permissions`, `acp`.

Состояние реализации: вопросы (а–в), безголовые разрешения и транспорт ACP реализованы (флаги `questions`,
`permissions`, `acp`; `server/acp.js`, `scripts/mock-acp-agent.js`). Замечания по ACP: процесс запускается со stdio-каналами
(не может пережить harness), stderr идёт в `runs/<sid>/acp.err.txt`, `initialize` должен ответить за
`firstEventTimeoutMs`; повторы `session/update` во время `session/load` отбрасываются (в транскрипте они уже есть); неудавшийся
load или агент без `loadSession` → `session/new` + системная заметка; содержимое diff становится `--- path / +++ path`
с полным старым/новым текстом (без минимальных блоков); Stop помечает открытые карточки ACP как `resolved: 'cancelled'`; ответ ACP — не
новое сообщение (агент продолжает тот же промпт), а запоздалый ответ → 409. `session.pid` остаётся null для ходов ACP, поэтому
`stalled` к ним не применяется. Работающий ход ACP при перезапуске harness получает `interrupted` (восстановление); следующее сообщение
снова запускает процесс через `session/load`. Тёплый процесс: `session.warm` (загружен); простаивающий (нет промпта, нет удерживаемого
разрешения) выгружается через `agents.<id>.acpIdleMin` минут (по умолчанию 30, 0 = никогда; PUT также принимает `null` = никогда,
хранится и возвращается как 0, и `acpIdleTimeoutMin`) и заново загружается через `session/load` на следующем сообщении (заметка — только если load не удался); `transport`
и `acpIdleMin` есть в /api/settings. Обнаружение моделей агента ACP спрашивает тёплый процесс в скрытой дополнительной сессии
(без холодного старта); если его нет, работает в безголовом режиме, как раньше. Исключения MCP для запусков harness: `agents.<id>.mcpExclude`
(никогда не `harness`) записываются в настройки запуска под ключом `agents.<id>.mcpExcludeKey` (по умолчанию `mcp.excluded`, альтернатива
`excludeMCPServers`; ПРОВЕРИТЬ, какой из них учитывает GigaCode); `GET /api/agents/:id/info` → `mcpServers: [{ name, status,
excluded }]` из последнего init для переключателей. Замечания: ответ карточки вопроса — обычное сообщение
(`POST /api/sessions/:id/messages` с «Ответ на вопрос «…»: …»); любая доставка в сессию снимает `waitingFor`
'answer'/'permission'; открытая карточка вопроса сессии получает `question.answered: true, answer, answeredAt` (текст
после префикса «Ответ на вопрос «…»: »), а её уведомления `question` получают `answered: true, read: true`
(повторно отправляются кадрами `notify`). Ответ на разрешение также выставляет на карточке `permission.resolved` + `permission.choice` (id
выбранного пользователем варианта; у отменённых карточек `resolved: 'cancelled'` и нет choice) (+ `resolvedAt`). Архивирование
сессии отменяет только карточки внутри неё; карточка субагента, повторно выданная в родителе, остаётся открытой (разрешённая там,
она применяется к следующему ходу родителя). Второй ответ →
409; `note` добавляется к доставленному сообщению. allow_once выставляет `session.approvalOnce` (расходуется следующим ходом).
У мок-агента есть `#deny <tool>` и `#question <q> | <option> | …`.

## История сессий CLI (сессии, начатые вне harness)

GigaCode записывает чаты (`chatRecording: true`) — ПРОВЕРИТЬ расположение/формат; ожидается стиль Gemini/Qwen
`~/.gigacode/tmp/<projectHash>/chats/*.json` (`{ sessionId, projectHash, startTime, lastUpdated, messages: [{ id,
timestamp, type: 'user'|'gemini'|'assistant'|…, content, toolCalls?, thoughts?, model?, tokens? }] }`, projectHash = sha256
пути корня проекта), либо через `gigacode sessions …` (ПРОВЕРИТЬ подкоманды, например список в JSON).
- Конфигурация `agents.<id>.history: { dirs: ["~/.gigacode/tmp/*/chats"], command: null }` (glob каталогов чатов; или команда CLI,
  возвращающая JSON); терпимый читатель: любой файл JSON/JSONL с id сессии + массивом сообщений; неизвестные формы перечисляются с
  `raw: true` (название из имени файла) вместо ошибки.
- `GET /api/history?cwd=` → `[{ id, agent, cwd, title (первое сообщение пользователя, 80 символов), startedAt, updatedAt, messages,
  model, file, linkedSessionId }]` для сессий, чей путь проекта (из записи или projectHash = sha256(path) от
  cwd и корня его рабочего дерева) совпадает; кэшируется по mtime файла; читается асинхронно и только из папок
  `<hash>/chats` этого проекта плюс папок, чьи записи явно называют этот cwd (индекс явных cwd для каждой папки,
  перестраивается при изменении mtime папки); `GET /api/history/:agent/:id/messages` → Messages (те же
  формы, что у транскриптов; user/assistant/thought/tool, только чтение).
- `POST /api/history/:agent/:id/continue { cwd }` → создаёт (или возвращает уже связанную) чат-сессию harness с
  `externalSessionId = id`, этим cwd и агентом, транскрипт предзаполнен из истории (помечен как импортированный), поэтому следующее
  сообщение запускает `--resume <id>`; выставляется `linkedSessionId`. Флаг возможности `cli-history`.
- Реализация (`server/history.js`): globs в `dirs` допускают `*` в любом сегменте папки; читаются файлы `*.json`/`*.jsonl`;
  собственные `cwd`/`projectRoot` записи приоритетнее хэша; хэш проверяется для cwd и его основного рабочего дерева (в
  Windows с обоими регистрами буквы диска); у JSON-записи без `projectHash` берётся имя её папки `<hash>/chats`. Записи CLI
  `info`/`error` пропускаются; рассуждения `{ subject, description }` становятся по одному сообщению-рассуждению; вызовы инструментов используют
  `displayName`/`args`/`resultDisplay`. Импортированные сообщения несут `imported: true` и ход 0; у чата выставляется `historyId`.
  `history.command` (список через CLI) принимается в конфигурации, но пока не запускается — ожидается настоящий вывод
  `gigacode sessions` (ПРОВЕРИТЬ, открытый вопрос 12 в GIGACODE-FACTS).

## Стратегия разрешений для GigaCode (без yolo): работать без постоянных запросов

В GigaCode нет yolo; безголовый режим отказывает во всём, что не разрешено заранее. Три слоя, чтобы задача выполнялась от начала до конца без присмотра:
1. **«Полный доступ» = auto-edit + белый список по умолчанию; `auto` + песочница рабочего пространства — ПО ЖЕЛАНИЮ**
   (`agents.gigacode.autoSandbox: null` по умолчанию — песочница заметно замедляла запуски на реальной машине;
   Настройки → «Песочница для «Полного доступа»» задаёт `"workspace"`, задокументированный в CLI `settings.tools.sandbox`).
   Когда песочница включена, её область — cwd сессии (+ includeDirs); поэтому задача, запущенная в
   корне проектов, охватывает каждый репозиторий и `<repo>-worktrees`. Самовосстановление: если ход завершается фатальной ошибкой, связанной с
   песочницей (stderr совпадает с `/sandbox/i` до любого события), — или результат инструмента (в том числе субагента) завершается
   с «GigaCode sandbox: …» (замечено: `acl-object-hardlink (Win32 50)`; повтора тогда нет, действует со следующих ходов), — harness выставляет
   `agentMeta.<id>.sandboxBroken = { at, error }`, с этого момента отображает auto → auto-edit для этого агента (approvalModeMap),
   один раз повторяет тот же ход и уведомляет «Песочница GigaCode недоступна: <reason>. «Полный доступ» работает как
   «Авто-правки» + разрешённые команды». Настройки показывают это состояние и действие «Проверить снова» (сбрасывает флаг).
2. **Белый список по умолчанию** (`agents.gigacode.allowedTools` по умолчанию): `run_shell_command(git)`, `(mvn)`, `(mvnw)`, `(gradle)`,
   `(gradlew)`, `(npm)`, `(npx)`, `(node)`, `(java)`, `(python)`, `(py)`, `(pytest)`, `(dir)`, `(ls)`, `(type)`, `(cat)`,
   `(findstr)`, `(rg)`, `(where)`, `(echo)` — передаётся на каждом ходе в auto-edit/default (не в plan), чтобы привычные команды
   никогда не запрашивали подтверждение. Пользователи правят его в Настройках.
3. Оставшиеся отказы → «Разрешить и повторить» (разовые / на сессию разрешения в белом списке) или ACP (настоящее ожидание), если он включён.
Действующий режим + песочница + белый список, использованные ходом, записываются в пользовательское сообщение хода (`runInfo`) и показываются
во всплывающем окне заголовка чата без подсказок «Как запущен агент».
Реализация: значения по умолчанию лаунчера gigacode — `autoSandbox: null`, `approvalModeMap: { auto: "auto-edit" }`
(применяется только без песочницы) и `allowedTools` = список выше (qwen: тот же список, без песочницы); значение в конфигурации агента
переопределяет их (`autoSandbox: null` = без песочницы). Список по умолчанию попадает только в ходы auto-edit/default (auto
под песочницей в нём не нуждается, plan только читает); `allowedTools` чата и разовые разрешения добавляются в любом режиме.
Самовосстановление применяется к ходу, который завершается без событий со строкой stderr, совпадающей с `/sandbox/i`, пока действует песочница:
тот же ход (те же пользовательские сообщения, без нового сообщения) повторяется один раз; `sandboxBroken` показывается в
`GET /api/agents/:id/info` и `/api/settings` (`agents.<id>.sandboxBroken`); `POST /api/agents/:id/sandbox/recheck`
сбрасывает его (следующий ход снова пробует песочницу). `runInfo` = `{ cliMode, sandbox, allowedTools, model, transport,
includeDirs }` в последнем пользовательском сообщении хода.

## Состояния активности сессии (что показывает UI)

Сессия получает `lastEventAt: number | null` (последнее событие stdout текущего хода), `waitingFor: 'answer' | 'auth' | null`
(выставляется, когда сессия вызвала `ask` и ответ ещё не доставлен, либо при фазе auth) и `stalled: boolean` (на стороне сервера:
running И phase !== 'auth' И нет событий в течение `session.stallSec` (по умолчанию 300, в /api/settings), пока pid жив;
пересчитывается каждые 15 с; переключения рассылаются). Производное состояние UI в порядке приоритета:
`waiting_answer` (waitingFor) → `stalled` → `starting` (phase starting/auth) → `running` → `error`/`failed` → `stopped` →
`done` (worker_done done) → `exited` (терминал) → `idle` (ход закончен, готов к следующему сообщению).
Реализация: `waitingFor` может также быть `'permission'` (карточка безголового отказа); `/api/settings` отдаёт и принимает
`session: { stallSec }` (целое ≥ 30); период перепроверки — `session.stallCheckSec` (только в конфигурации, по умолчанию 15); любое событие
сбрасывает `stalled`; `lastEventAt` сам по себе не рассылается (он едет со следующим кадром сессии). Флаг возможности `activity`.
- Для пользователя ход заканчивается на `result`, а не на выходе процесса (GigaCode задерживается на много секунд после `result`: MCP-серверы
  завершаются, запись чата, телеметрия): статус → idle (или done/failed, как раньше), phase null,
  `turnClosing: true`, пока процесс ещё жив; логика после хода (эскалация автоотчёта, цикл ревью) выполняется
  тогда. Процесс остаётся под наблюдением не дольше `agents.<id>.exitGraceMs` (по умолчанию 8000) после `result` — независимо от того, есть ли
  сообщение в очереди, — затем дерево убивается (с защитой, killReason `post_result_linger`); сообщение в очереди запускает
  следующий ход, когда процесс завершился; длительность задержки пишется в `runs/<sid>/stderr.log`. Stop для задержавшегося процесса только
  завершает его (без «Остановлено»); архивирование / DELETE сессии, процесс которой только задерживается, не отклоняются (он завершается).
  `turnClosing` сбрасывается при запуске хода и при каждом старте harness (задержавшийся процесс не отслеживается через
  перезапуск). Ошибка, пришедшая вместе с result (причина остановки ACP `max_tokens`, …), всё равно показывается (сообщение error,
  статус `error`), когда процесс завершается.
- `lastEventKind`: `text_delta` | `assistant_final` | `thought` | `tool_running` | `tool_done` | `result` (кадры сессии
  отправляются при его изменении) — UI пишет «Завершает ход…» вместо «Пишет ответ».
- Кольцо контекста: `session.context = { tokens, at, lastTurn: { input, output, cacheRead } }` из usage последнего шага
  главного агента (перезаписывается на каждом шаге, сохраняется, кадр сессии не чаще раза в секунду; шаги встроенного субагента
  не учитываются). tokens: GigaCode/Qwen/Gemini (стиль OpenAI, cache_read внутри input) = input + output; claude
  (стиль Anthropic) = input + cache_read + cache_creation + output; ACP: `usage` результата промпта, когда есть
  (ПРОВЕРИТЬ). `session.contextLimit`: `context` модели из объединённого каталога («262k» → 262000, «1M»), модель =
  session.model || модель, о которой CLI сообщил при init (`session.cliModel`) || значение агента по умолчанию (суффикс id `-262k`
  тоже учитывается); null, когда неизвестно. Агенты в `/api/state` несут `compressCommand` (по умолчанию для gigacode "/compress") и
  `contextCommand` ("/context", пока не используется) — оба ПРОВЕРИТЬ (GIGACODE-FACTS q.15).

## Ничего не теряется при перезапуске (harness, браузер, ПК)

Долговременное состояние (всё в `<dataDir>`, атомарная запись):
- `db.json` + ротируемый `db.json.bak` (последняя исправная копия, записывается перед каждой заменой); при старте повреждённый/неразбираемый
  `db.json` заменяется на `.bak` с уведомлением «восстановлено из резервной копии»; транскрипты так же
  (`<sid>.json` + `.bak`). Отложенная запись ≤ 250 мс; сброс на диск в конце каждого хода, при остановке и синхронно по SIGINT/SIGTERM.
- Очередь доставки сессии сохраняется (`session.queue: [{ id, from, text, at, recorded? }]`, а не только счётчик); после
  перезапуска отправляются доставки в очереди простаивающих сессий, а у переподключённых работающих сессий они ждут конца хода.
- Ход, процесс которого так и не запустился (ошибка запуска, отсутствующий cwd, неизвестная модель, …), возвращает свои сообщения в начало
  очереди (`recorded: true`: уже в транскрипте, не повторяются) и сообщает «Сообщений в очереди: N — уйдут со
  следующим сообщением или после смены модели.»; автоматического цикла повторов нет: следующая доставка, `PATCH { model }` или
  перезапуск отправляет их; Stop очищает их.
- Длинные промпты: промпт длиннее ~24 000 символов (Windows ограничивает командную строку 32 767) записывается в
  `runs/<sid>/prompts/prompt-<turn>.md`; argv получает строку слэш-команды (если промпт начинается с `/`, она остаётся
  первой) + «Полный текст сообщения: <path>» + инструкцию прочитать его, а эта папка добавляется в
  `--include-directories` CLI на этот ход (CLI читает только внутри каталогов своего рабочего пространства). Промпты ACP это не затрагивает.
- Хранилище: неудавшаяся запись (файл удерживается антивирусом) оставляет свой ключ «грязным» и повторяется через 1 с; `db.json` — компактный
  JSON; одно лишь положение чтения (`turnOffset`) сохраняет db.json не чаще раза в 2 с (при сбое могут перечитаться ≤ 2 с событий);
  в памяти остаются не более 50 транскриптов (LRU; никогда не тот, у которого идёт ход); счётчик ходов — `session.turnCount`.
- Идентичность при переподключении: при запуске harness записывает `pidStartedAt` (Windows: время создания процесса через
  `Get-CimInstance Win32_Process` / запасной `wmic`; Linux: `/proc/<pid>/stat` starttime + время загрузки; macOS: `ps -o lstart=`);
  реализация: отметка при запуске — `Date.now()` в Windows/macOS (равна времени создания в пределах допуска, без
  PowerShell на каждый ход) и значение `/proc` в Linux (те же часы с обеих сторон); запрос к ОС выполняется только при старте и
  перед Stop переподключённого хода (кэш 10 с);
  при старте `running` сессия переподключается, только если pid существует И время его запуска совпадает (±2 с); иначе ход
  завершается по оставшемуся файлу вывода (или помечается прерванным с системной заметкой) — повторно использованный pid никогда не принимается
  и никогда не убивается. Stop для переподключённой сессии перед убийством повторно проверяет идентичность. То, что оркестрация уже обработала в
  ходе (`worker_done` → `session.turnFlags`), сохраняется, поэтому переподключённый ход никогда не отчитывается дважды.
- Блокировка единственного экземпляра: живой pid в `server.json` считается конфликтом, только если `GET <url>/api/health` (новый, без аутентификации,
  возвращает `{ ok, pid, dataDir }`) отвечает от этого pid в течение 1 с; иначе блокировка устарела и перехватывается.
- Ожидания оркестрации: ожидания `worker_run`/`agent` не хранят состояния на сервере (сессия исполнителя сохраняет `parentId`,
  `waiter: true` и свой `report: { status, summary, at }`); `mcp/harness-mcp.js` продолжает длинный опрос `worker_wait` с
  отступом через перезапуски сервера до общего таймаута, поэтому вызов инструмента оркестратора переживает перезапуск harness.
  Каждый `worker_done` сохраняет `session.report` (он заменил `runResult`). Запуски агентов получают `HARNESS_SERVER_JSON`: harness-mcp
  читает из него текущий URL при каждом вызове (перезапущенный harness может слушать в другом месте); нет файла = harness не работает → повтор
  (`HARNESS_RETRY_MS`, по умолчанию 2 мин; повторяются только запросы, которые так и не дошли до сервера, worker_wait — всегда).
- Состояние цикла ревью / переносов (`task.review: { round, reviewerSessionId, verdicts[] }`, `task.ports[]`) сохраняется; ревьюер,
  завершившийся, пока harness был выключен, подхватывается при старте (его отчёт — в транскрипте/поле report).
- Терминалы: история сохраняется (`terms/<sid>.log`); процессы PTY не могут пережить сервер, поэтому при старте каждый терминал,
  который был жив, автоматически запускается заново в том же cwd (системная строка «— перезапуск harness: новая сессия терминала —»
  дописывается в его журнал); терминал, чьей начальной командой был CLI агента с флагом продолжения, запускается с ним
  (`agents.<id>.continueArgs`, по умолчанию для gigacode `["-c"]`). `terminal.autoRespawn` (по умолчанию true). Собственная
  начальная `command` обычной оболочки не запускается повторно (у неё могут быть побочные эффекты). Флаг возможности `health`.
- UI: черновики (поле ввода на сессию, заголовок/тело коммита на cwd, диалог PR на cwd+base, правки в панели задачи) сохраняются в
  localStorage (try/catch, очищаются при отправке/коммите); открытые экраны/вкладки/панели/прокрутка для каждого рабочего дерева сохраняются как и раньше.

## Ничего не выглядит зависшим (запросы git, сетевые таймауты, прогресс)

- Каждый дочерний процесс git получает `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=` и `GIT_SSH_COMMAND` = уже
  существующее значение или `ssh -o BatchMode=yes -o ConnectTimeout=15`. Сетевые операции (push) выполняются с
  `-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=<networkTimeoutSec>` (git сам прерывает зависший HTTP), в собственной
  группе процессов в POSIX, завершаются по 'exit' (переживший `git-remote-http` может держать каналы открытыми) с жёстким сроком
  5 с после убийства; убийство в POSIX = SIGTERM группе, SIGKILL группе через 3 с. Они убиваются (всё дерево) через
  `git.networkTimeoutSec` (по умолчанию 120) → 504 «Нет ответа от удалённого репозитория за N с»; сбой учётных данных/ssh-ключа
  → 401 «Git требует авторизацию — выполните push в терминале этого рабочего дерева» (+ текст git).
- Прогресс без изменений API: запрос с заголовком `x-job-id: <8–64 символа [\w-]>` выполняется как задание; сервер сразу отправляет
  WS `{ t: 'job', id, title, step: null, at }`, на значимых шагах — `{ t: 'job', id, title, step, progress?: { done, total }, at }` и в конце
  `{ t: 'job', id, title, done: true, error?, at }`. Операции с названиями: синхронизация трекера (по
  страницам), взятие в работу (проверка агента → рабочее дерево → сессия), доработка, перенос (рабочее дерево → cherry-pick 0/n…n/n → исполнитель
  конфликта), создание PR (поиск существующего PR → создание), push, checkout, удаление рабочего дерева (сессии i/n → git), обновление моделей,
  импорт дочерних (по каждому дочернему). Шаги фоновой работы после ответа отбрасываются.
  Удерживаемое задание (git через агента) остаётся открытым после ответа: его итоговый кадр — `{ t: 'job', id, title, done: true,
  result: { ok, hash | branch | url }, at }` или `{ …, done: true, error, result? }`, когда ход агента закончился и
  harness проверил результат.
- Цикл событий: опрос SDD асинхронный; транскрипты сериализуются по сообщениям (потоковое обновление повторно сериализует одно сообщение,
  а не весь транскрипт), а копии `.bak` обновляются не чаще раза в 10 с; опрос реестра читает только небольшие файлы.

## Изображения и большие выводы инструментов в чатах

- `GET /api/fs/raw?cwd=&path=` (флаг `fs-raw`) отдаёт потоком изображение для миниатюры: только png/jpg/jpeg/gif/webp/svg (иначе
  400), ≤ 10 МБ (413), путь (относительный или абсолютный) должен разрешаться внутри `cwd` или записи `includeDirs` сессии
  в этом cwd (та же защита с учётом симлинков, что и у файловых маршрутов; снаружи → 400). Токен через `x-harness-token` или `?token=`
  (`<img src>` не отправляет заголовки). Заголовки: `etag` + `last-modified` (`If-None-Match` → 304), `cache-control: private,
  no-cache`, `x-content-type-options: nosniff`; для svg ещё `content-security-policy: sandbox`.
- Транскрипт хранит каждый вывод инструмента целиком; `GET /api/sessions/:id/messages` возвращает `tool.output`, обрезанный до 64 К
  символов, с `tool.outputTruncated: true`; `GET /api/sessions/:id/messages/:mid/output` → `{ output }` (полностью).

## Наведение порядка в сессиях

- `PATCH /api/sessions/:id { archived: boolean, stop?: boolean, title? }`: архивирование работающей сессии (идущий ход или
  живой терминал) → 409, если нет `stop: true` (остановить, затем архивировать); архивные сессии остаются в `/api/state` с
  `archived: true, archivedAt`; разархивирование разрешено; виртуальные сессии субагентов следуют за родителем.
- `sessions.autoArchiveDays` (по умолчанию 7, 0 = выкл.; PUT также принимает `null` = выкл., хранится и возвращается как 0; в /api/settings
  как `sessions: { autoArchiveDays }`): при старте и
  каждый час архивируются простаивающие чаты (не работают, `waitingFor` null, не `interrupted`, нет назначенной задачи в работе, не
  координатор с живыми исполнителями) и завершённые терминалы, чей `lastActivityAt` старше N дней.
- `DELETE /api/sessions/:id` отказывает для работающей сессии (409), если нет `?force=1`; также удаляет виртуальных дочерних и
  файлы запуска.

## Автозаполнение: подсказка репозитория, читаемый журнал задачи, отклонение PR

- `task.suggestedWorkspaceId` (флаг `task-suggest`), пересчитывается при каждом создании/обновлении/импорте, пока `workspaceId`
  пуст (иначе null): один репозиторий-workspace → он; иначе репозиторий, чьё имя или имя папки встречается как токен в
  названии/описании/кэшированных атрибутах трекера (`task.externalFields` из последнего `GET /api/tasks/:id/external`:
  Component/Компонент/Repository/Репозиторий/Сервис/Service), сначала точное совпадение, затем основа `-service` в любом направлении
  (`payments` ↔ `payments-service`); иначе `db.prefs.lastWorkspaceBySpace[<префикс ключа>]` (записывается, когда задача этого
  пространства берётся в работу). Заменено (на реальной машине догадка выбирала посторонний репозиторий): задача также несёт
  `suggestedWorkspace: { id, confidence: 'high' | 'low', reason }` — `high` ТОЛЬКО для имени репозитория (или его основы `-service`)
  как целого токена в поле компонента/сервиса/репозитория трекера или в названии/описании; единственный репозиторий и
  последний репозиторий пространства ключа — `low`. `POST /api/tasks/:id/start { agent?, notes?, workspaceId?, location? }`: явный
  `workspaceId` (из запроса, иначе из задачи) → его рабочее дерево; `location: 'root'` → папка проектов; иначе
  ВЫСОКАЯ подсказка; иначе папка проектов (workspace `kind: 'root'`; без неё — единственный репозиторий) — никогда не
  низкая догадка, и догадка никогда не записывается в задачу. Родительские задачи координируются как раньше.
- Запуск в папке проектов: без рабочего дерева, cwd = корневая папка, роль worker, промпт задачи (сначала слэш) + «Ты в
  папке со всеми проектами (<root>). Определи затронутые репозитории по SDD/описанию задачи (или спроси через ask);
  рабочие деревья создавай по правилам своей команды (<repo>-worktrees\<KEY>, ветка <branchTemplate> от <target>); после
  финального сообщения — worker_done.» (правила «оставайся на своей ветке» нет); `session.atRoot`, `task.location: 'root'`, статус
  in_progress, ветки пока нет. Связывание: при каждом обновлении списка рабочих деревьев и каждые 30 с, пока такая сессия работает, любое
  рабочее дерево зарегистрированного репозитория, чья ветка содержит ключ задачи (без учёта регистра, как целое слово), добавляется в
  `task.worktrees: [{ workspaceId, path, branch }]` (+ `branch` / `workspaceId`, когда они ещё пусты), запись журнала с типом `worktree`
  «Агент создал рабочее дерево: <repo> · <branch>»; затем suggest/commit/PR работают для каждого рабочего дерева как обычно.
- Записи журнала задачи: `{ at, by, type, text, data? }`, `type` ∈ created, imported, status, started, agent_done,
  agent_failed, review, rework, port, pr_created, tracker_transition, comment, worktree, agent_gone («Сессия агента
  удалена» / «…перенесена в архив»: чат исполнителя был удалён или архивирован — `assigneeSessionId` и `agentState`
  становятся null, колонка остаётся); `text` — человеческий русский без id сессий
  или путей («Взята в работу: GigaCode, ветка feature/T-10», «Агент закончил», «PR #562 в develop создан»); id, summary,
  вердикты — в `data`. У старых записей нет `type` (показывается их `text`).
- `POST /api/git/pr/decline { cwd, index }` (флаг `pr-decline`) → `integrations.pr.declineTool` (по умолчанию
  `git_decline_pull_request`) с `integrations.pr.declineArgs` (по умолчанию `{ project, repository, pullRequestIndex }`,
  project/repository из origin), затем обновляется статус PR задачи. Импортированные задачи распознаются по `task.source`.

### Восстановление сессий после перезапуска
- При старте каждая чат-сессия, которая была `running` и НЕ могла быть переподключена (pid исчез / не совпала идентичность), получает
  `interrupted: { at, reason: 'harness_restart' | 'reboot' | 'crash', lastActivity: string|null }` (reason: `reboot`, когда
  время загрузки ОС позже начала хода, `crash`, когда предыдущий harness завершился некорректно
  (остался `server.json`), иначе `harness_restart`; `lastActivity` = последнее резюме инструмента/шага прерванного хода);
  статус становится `idle` с существующей системной заметкой; одно уведомление `{ kind: 'recovery', text: 'Прервано сессий: N' }`.
- `GET /api/recovery` → `{ sessions: [{ id, title, cwd, taskId, role, reason, at, lastActivity }], message }` (только
  `interrupted` и не закрытые); `POST /api/recovery/resume { sessionIds, message? }` → доставляет сообщение каждой
  (обычная очередь; продолжает ту же сессию CLI через --resume), снимает `interrupted`; `POST /api/recovery/dismiss
  { sessionIds }` снимает его без отправки. Конфигурация `recovery: { autoResume: false, message: "Был перезапуск, твой
  предыдущий ход прервался. Продолжи с того места, где остановился — сначала проверь текущее состояние рабочего дерева." }`
  (в /api/settings); `autoResume: true` возобновляет все при старте (координаторов — после их исполнителей). Флаг возможности `recovery`.
- Реализация: ход, чей сохранённый pid не подхвачен, но в чьём файле уже есть `result` (он завершился, пока
  harness был выключен), НЕ считается прерванным. Любая доставка в сессию снимает `interrupted` (её продолжили). Начало
  хода для `reboot` — `pidStartedAt` (иначе `lastActivityAt`); время загрузки = now − `os.uptime()`. `lastActivity` = последний
  вызов инструмента («name input…») транскрипта, иначе начало последнего ответа. Уведомление отправляется один раз за
  запуск, после проверок идентичности.

## Сообщения коммита / PR, написанные агентом

`POST /api/git/generate { cwd, kind: 'commit' | 'pr', base? }` (заголовок `x-job-id` для прогресса; возможность `git-generate`)
→ `{ title, body, model, ms }`. Контекст, отправляемый агенту: задача этого cwd (ключ, название, фрагмент описания ≤ 1500
символов, как в /api/git/suggest), `git diff --stat` + diff (индекс + рабочее дерево, ≤ 15000 символов, обрезается по файлам
с маркером) + имена неотслеживаемых файлов и последние 10 заголовков коммитов репозитория (его стиль); для `pr` также
`git log <base>..HEAD --oneline`. Промпт (на русском) просит только JSON: commit → `{ title ≤ 72 символов, начинается с
"<KEY> ", когда ключ есть, body: 1–4 строки «что и зачем» }`; pr → `{ title ≤ 100 байт UTF-8, body ≤ min(limits.bodyBytes,
300 символов) }`. Разовый безголовый запуск агента по умолчанию в cwd: `agents.<id>.quickArgs` (по умолчанию для gigacode
`["--safe-mode"]` — без MCP/навыков/хуков, быстрый старт; ПРОВЕРИТЬ на целевой машине) + режим подтверждения `plan` + модель = градация агента
`fast`, когда она задана; без преамбулы harness, без сессии, ничего не записывается в список чатов; таймаут
`git.generateTimeoutSec` (по умолчанию 120). Если быстрые аргументы приводят к сбою CLI до любого события, повтор один раз без них
(и запоминается `agentMeta.quickArgsBroken`). Разбирается первый JSON `{…}` ответа; ограничения применяются (обрезка по границе
символа). Сбой → 502 с причиной (UI сохраняет предзаполнение по шаблону). Конфигурация `git.generateMessages:
true` (UI генерирует автоматически; false = только ручная кнопка). `/api/git/suggest` без ключа задачи: `commit.title` = ''
(без запасного варианта из имени ветки) и `commit.body` = '' (без списка файлов).

## Коммит / push / PR через агента (его хуки и навыки выполняются)

Конфигурация `git.via: "agent" | "harness"` (по умолчанию `"agent"`; /api/settings). `POST /api/git/commit|push|pr` принимают
`via` (переопределяет конфигурацию). С `via: "harness"` — как раньше (прямой git / MCP sourcecontrol; собственные хуки git выполняются).
С `via: "agent"`:
- Целевая сессия: сессия исполнителя задачи для этого cwd, если она есть и не работает (иначе ставится в очередь после её
  хода); иначе чат «Коммит · <KEY или ветка>» в этом cwd (роль solo, агент по умолчанию, обычный чат в боковой панели,
  переиспользуется для следующих коммитов того же cwd).
- harness доставляет явную инструкцию (на русском), например для коммита: «Пользователь явно просит закоммитить изменения
  этого рабочего дерева. Сообщение коммита (утверждено пользователем, не меняй):\n<title>\n\n<body>\nВыполни: git add -A
  (кроме путей git.excludeFromCommit), git commit с этим сообщением. Больше ничего не меняй и не правь код. В конце
  ответь строкой RESULT: <хэш коммита> или RESULT: ERROR <причина>.» Push: «… git push -u origin HEAD … RESULT: OK <ветка>
  | ERROR …». PR: «… создай PR через MCP sourcecontrol (head <branch>, base <base>, заголовок/описание утверждены) …
  RESULT: <html_url> | ERROR …».
- Запрос сразу возвращает `{ via: 'agent', sessionId, job }`; задание (x-job-id) остаётся открытым, пока не закончится этот ход,
  затем harness сам проверяет результат (commit: хэш `git log -1` изменился и совпадает с RESULT; push: upstream/ahead
  = 0; pr: URL из RESULT или pr-status) и завершает задание с `{ ok, hash|url|branch, error? }`, плюс
  уведомление при сбое; UI предлагает «Сделать напрямую» (`via: "harness"`).
- `git` входит в белый список по умолчанию, поэтому агента не останавливают разрешения; §0 `/full-task` разрешает запись в git по
  явной просьбе — в инструкции сказано, что это она и есть.
Флаг возможности `git-via-agent`.

## Чаты CLI — обычные чаты (отдельного экрана нет)

Пользователь хочет, чтобы диалоги, начатые в CLI GigaCode, можно было продолжить в UI и никогда не терять — а не отдельный список.
- Усыновление: при старте, каждые 60 с, пока подключён клиент UI, и по требованию (`POST /api/history/adopt`)
  читатель истории (server/history.js) сканирует записи чатов CLI, обновлённые в пределах `history.adoptDays` (по умолчанию 14), и для каждого
  настоящего чата (≥ 1 сообщение пользователя; не `*.runtime.json`; не принадлежащего сессии harness — его sessionId не равен externalSessionId ни одной
  сессии harness; не служебного запуска — cwd вне dataDir harness, первый пользовательский текст не промпт помощника
  (/models, /context, /compress, HARNESS_GENERATE_MESSAGE); название без преамбулы harness) создаёт или обновляет
  чат-сессию harness `{ origin: 'cli', externalSessionId: <id записи>, cwd, title (первая значимая строка ≤ 80),
  lastActivityAt: запись обновлена, status: idle, agent: агент этого CLI }`, сгруппированную по worktreePath/workspace как любая
  сессия. Архивные или удалённые сессии с id сессии CLI — как усыновлённые, так и чаты harness — запоминаются
  (`db.cliIgnored`) и никогда не усыновляются (повторно).
- `createdAt` усыновлённой сессии — это начало чата CLI (`startTime`), а не момент усыновления, поэтому боковая панель сохраняет
  настоящий порядок; у сессий, усыновлённых раньше, оно исправляется на следующем проходе.
- Транскрипт: до первого хода harness `GET /api/sessions/:id/messages` отдаёт сообщения записи (отображённые как
  `/api/history/:agent/:id/messages`), обновляется при изменении mtime записи; первый ход harness импортирует их
  в транскрипт harness (`cliImportedAt`) и продолжает с `--resume <id>`, как любой чат. Более поздняя активность на стороне CLI
  в простаивающей усыновлённой сессии (mtime записи новее последнего сообщения транскрипта harness) дописывает новые сообщения записи
  перед следующим ходом harness.
- Реализация (server/adopt.js): папка записи = её явный cwd, иначе папка, чей sha256 равен её projectHash,
  среди зарегистрированных проектов, их рабочих деревьев, папок корня проектов и cwd сессий (неизвестно → не усыновляется). Также
  пропускается чат, единственное сообщение пользователя в котором — голая слэш-команда (/clear). Транскрипт — это сообщения записи,
  импортированные со стабильными id (импортируются повторно, пока не было ходов harness); после ходов harness собственная запись CLI о них
  (≤ 15 с после конца хода) только сдвигает счётчик, более поздние сообщения записи дописываются (`cliRecordCount`,
  `cliRecordAt`, `cliImportedAt`). Вспомогательные запуски harness (обнаружение моделей, сообщения коммита/PR, пробы) выполняются в
  `<dataDir>/chats/helper/<kind>/<agent>` с собственной настройкой `chatRecording: false`: они не оставляют записи CLI.
- Флаг возможности `cli-adopt`; конфигурация `history.adopt: true`, `history.adoptDays: 14`. Оба в /api/settings как
  `history: { adopt, adoptDays }` (1..365). `/api/history` (все/по папкам) остаётся
  для вкладки «История» (более старые чаты).

## Передача задачи: один ввод, решает оркестратор (основной сценарий)

Привычка пользователя из CLI: в папке проектов `/full-task <ссылка на задачу> [заметки]` или `/full-task <что сделать>`, и агент
сам выбирает репозиторий. `POST /api/handoff { input, notes?, agent?, approvalMode?, model?, workspaceId? }` (шаги задания; возможность
`handoff`) → `{ session, task | null }`:
- где стартует агент: в папке проектов (`workspaces.root`); если её нет — в проекте, заданном `workspaceId`, или в единственном открытом
  проекте; иначе 400 «Откройте проект или укажите папку с проектами» (проектов нет) / «Выберите проект, в котором работать агенту»
  (их несколько). В проекте задача запускается в этом репозитории (не `location: 'root'`); пробный запуск (dryRun) возвращает там `location: 'repo'`;
- `input` содержит ключ или ссылку трекера (`/([A-Z][A-Z0-9_]+-\d+)/` или URL) и интеграция с трекером работает →
  импортировать/обновить эту задачу (как `/api/tasks/import`), затем запустить её в корне проектов (`location: 'root'`, notes) —
  существующий путь запуска (семантика jumped, когда исполнитель уже работает);
- иначе (свободный текст или трекер выключен) → чат в корне проектов (роль worker-подобная solo, название из
  текста), чей первый промпт = `agents.<id>.freePromptTemplate` (со своей командой — `"/full-task {text}{notes}"`,
  по умолчанию `"{text}{notes}"`; те же правила шаблонов, слэш первым) + преамбула корня (выбрать репозитории по SDD/задаче или спросить;
  рабочие деревья создавать по своим правилам).
- Текст рядом с ключом/ссылкой попадает в `notes` («<ссылка> и проверь кеш» → notes «и проверь кеш»). Ключ/ссылка, которую трекер не может
  импортировать (неизвестная, трекер недоступен), возвращается к чату со свободным текстом с `trackerError` в ответе. `approvalMode` /
  `model` применяются к запущенной сессии. Шаги задания «Ищу задачу в трекере», «Запускаю агента».
- `dryRun: true` → `{ prompt, agent, taskKey | null, targets | null, releaseWarning | null, location: 'root' | 'repo' }`: точное первое
  сообщение (слэш-команда первой, без преамбулы harness) из тех же шаблонов, заметок и строк о релизе; без побочных эффектов —
  ключ/ссылка берётся только регулярным выражением (без обращения к трекеру; задача, уже находящаяся на доске, используется ради её полей).
- `GET /api/releases?workspaceId=&limit=10` → `[{ branch, version, repos }]` сначала новейшие, без дублей по ветке среди репозиториев
  (выбор «＋ релиз»; тот же скан и кэш; возможность `release-resolve`).
- Ссылки на релизы (`server/releases.js`, возможность `release-resolve`): `GET /api/releases/resolve?text=&workspaceId=` →
  `{ refs: [{ phrase, version, branch | null, repos, candidates }], onlyRelease }`. Фразы: «релиз 54», «релизную 1.54»,
  «release 1.54.1», «release/1.54.0», «rel154» (→ 1.54; rel1541 → 1.54.1); «только в релиз …» = onlyRelease. Ветки:
  локальные и origin `release/*` / `release-*` этого workspace или каждого зарегистрированного git-репозитория (кэш 5 мин);
  "54" = minor 54 любого major, сначала новейшие; "1.54" = новейшая 1.54.x; "1.54.1" точно. Используется в `/api/handoff` (текст +
  notes; `targets` в теле = чипы UI переопределяют), `/api/tasks/:id/start` и `/rework` (notes): найденный релиз задаёт
  `targets` задачи (onlyRelease → [release], иначе [git.defaultBase, release]), а заметки агента получают «Целевые ветки:
  develop и release/1.54.1 (из «релиз 54»). Изменения нужны в обе: основная работа в develop, перенос в релиз — отдельной
  веткой feature/<KEY>-rel154 → PR в release/1.54.1.» (onlyRelease: «Целевая ветка: … Изменения нужны только в релиз.»);
  ненайденный → текст остаётся, ответ несёт `releaseWarning` «ветка релиза 54 не найдена».
`GET /api/now` НЕ нужен — UI выводит «Сейчас» из сессий + задач.

## Экран первичной настройки (`screen: 'setup'`)

Экран первичной настройки занимает место «Главной», пока `user.setupDone` равно false И (CLI агента не найден ИЛИ не открыт ни один
проект/папка проектов). Он спрашивает: путь к агенту, где лежат проекты и как агент получает задачу.
- Агент получает задачу простым текстом (шаблоны по умолчанию): задача `{key}: {title}

{description}

{taskUrl}{notes}`, свободный текст
  `{text}{notes}`, доработка `Задача {key} готова, но нужны правки: {notes}`.
- Или собственной командой человека `/cmd` (её предлагают из `userCommands` в `GET /api/agents/:id/info`): тогда шаблоны задачи / свободного текста /
  доработки становятся `/cmd {taskUrl}{notes}`, `/cmd {text}{notes}`, `/cmd {taskUrl} Задача готова, но нужны правки: {notes}`
  (`taskPromptTemplate`, `freePromptTemplate`, `reworkPromptTemplate` в `PUT /api/settings`).
- Завершение или пропуск настройки сохраняет `user.setupDone: true` (`PUT /api/settings`), и «Главная» больше не подменяется.

## Флаги возможностей (рассогласование версий клиента и сервера)

`GET /api/state` возвращает `features: string[]` — необязательные группы API, которые реализует этот сервер, например `sdd`, `subagents`,
`virtual-sessions`, `worker-run`, `pr-status`, `branches`, `fs-search`, `agent-info`, `models-refresh`, `tracker-links`,
`worktree-meta`, `open`, `board-columns`, `review-loop`, `skills-install`, `demo`, `health`. UI вызывает необязательную конечную точку, только
если её флаг присутствует (иначе возможность скрыта или показывает «недоступно в этой версии сервера») — без шума 404.
Сервер добавляет флаг в том же коммите, который добавляет маршрут; тест проверяет, что у каждого флага есть маршрут.

## Кроссплатформенность (Windows, Linux, macOS)

- В `harness.config.json` нет значений по умолчанию, привязанных к платформе: `shell: null` и `agents.gigacode.command: null` означают «авто»:
  - shell: win32 → `powershell.exe -NoLogo -NoExit -Command [Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`;
    остальные → `$SHELL` (запасной `/bin/bash`, затем `/bin/sh`) с `-l`; env `LANG`/`LC_ALL` по умолчанию `C.UTF-8`, если не заданы.
  - команда gigacode: win32 → `C:/Program Files/.gigacode/bin/gigacode.cmd`, если существует, иначе `gigacode` из PATH (+PATHEXT);
    остальные → `gigacode` из PATH, иначе `~/.gigacode/bin/gigacode`.
  Явное значение всегда приоритетнее; `--print-config` показывает разрешённый выбор и причину.
- Лаунчер GigaCode в POSIX: если разрешённая команда — исполняемый файл, не `.cmd`, он запускается напрямую
  (без оболочки; shebang-скрипт сам задаёт своё окружение identity, а коды выхода честные) с тем же argv после
  исполняемого файла; разрешение `nodeArgs`/`cliEntry` и разбор identity работают только в Windows, если `node`+`cliEntry` не заданы
  явно. Запасной разбор шимов sh (`ROOT=…`, `export GIGACODE_PACKAGE_IDENTITY=…`, `"$ROOT/runtime/node/bin/node"`)
  используется только когда прямой запуск невозможен. ПРОВЕРИТЬ настоящую раскладку установки в Linux на машине с Linux.
- Управление процессами: Windows `taskkill /PID <pid> /T /F`; POSIX `process.kill(-pid, SIGTERM)`, затем `SIGKILL` через 3 с
  (в POSIX ходы агентов, агенты ACP и сетевые операции git запускаются `detached` = собственная группа процессов). Открыть папку:
  `explorer.exe` / `open` / `xdg-open`.
- Windows: НИ ОДИН дочерний процесс никогда не запускается `detached` (один помощник, `spawnOptions()` в runner.js, используется каждым spawn/execFile):
  DETACHED_PROCESS заставляет Windows игнорировать CREATE_NO_WINDOW (`windowsHide`), и собственные консольные дочерние процессы GigaCode (stdio MCP-серверы,
  инструмент оболочки, node) тогда каждый показывают видимое окно консоли. Недетачнутый дочерний процесс с `windowsHide` получает
  собственную скрытую консоль, наследуемую всеми его потомками; это всё равно отдельная консоль (Ctrl+C в терминале harness
  до неё не доходит), и она переживает harness (Node никогда не убивает дочерние процессы в Windows), так что ходы по-прежнему
  переживают перезапуск harness.
- Никогда не посылать сигнал pid, который мог быть использован повторно (Windows выдаёт pid снова в течение миллисекунд; случайный
  `taskkill /T` или `process.kill` убивал агентов и запуски git других сессий): убийство хода записывает `res.killReason`
  ('stop' | 'first_event_timeout' | 'auth_timeout') ПЕРЕД отправкой сигнала и пропускает дочерний процесс, который уже завершился, поэтому
  ход сообщает эту причину, а не код выхода; таймер первого события перед решением перечитывает файлы вывода;
  дочерние процессы, завершающиеся по EOF stdin (stdio MCP-серверы, агенты ACP), убиваются деревом только если всё ещё работают спустя 2 с
  (`endChild`); отложенный запасной вариант `process.kill(shellPid)` в `kill()` node-pty для Windows отключён (`killPty`,
  патчит приватный `_getConsoleProcessList`; перепроверить при обновлении node-pty) — закрытие псевдоконсоли завершает
  подключённые процессы.
- Пути всегда через `path`; `~` раскрывается; очистка рабочих деревьев/устаревших папок одинакова; тесты выполняются в Windows и Linux (Node ≥ 22).
- UI: сочетания клавиш используют Ctrl в Windows/Linux и ⌘ в macOS (подписи подстраиваются); стеки шрифтов включают запасные для Linux
  (`"Inter","Ubuntu","Cantarell","Noto Sans"` / `"JetBrains Mono","DejaVu Sans Mono","Noto Sans Mono"`).
- Заметки по реализации: `config.shell` = `{ command, args, reason }` (настройка PowerShell в Linux/macOS тоже означает
  авто); терминал получает `LANG`/`LC_ALL=C.UTF-8` только когда НЕ задана ни одна из них. В POSIX шим `.cmd` по-прежнему разрешается
  по-windows-ному (встроенный node + cli-entry + identity), всё остальное исполняемое запускается напрямую. `--print-config` показывает
  `shell.reason` и `agents.<id>.command: { command, reason }`. Сетевые операции git в POSIX выполняются в собственной группе процессов,
  поэтому таймаут убивает и их удалённых помощников.
- Настройки: `PUT /api/settings { agents: { <id>: { command, node, cliEntry } } }` — `command`: путь, массив argv или
  `null` (авто); `node` + `cliEntry`: оба пути или оба null; сохраняется в `harness.config.local.json`. `GET /api/settings`
  возвращает их с `resolved` (тот же `{ ok, command, node, entry, identity: boolean }`, что и
  `GET /api/agents/:id/info`), поэтому «Проверить» работает сразу после сохранения.

## Безопасность

- Слушать на `config.host` (по умолчанию 127.0.0.1).
- Отклонять любой HTTP/WS-запрос, у которого заголовок `Host` не `127.0.0.1:<port>`, `localhost:<port>` или `[::1]:<port>`
  (защита от DNS-rebinding). WS дополнительно требует, чтобы `Origin` отсутствовал или совпадал с хостом.
- Случайный токен в `<dataDir>/token` (создаётся один раз). `index.html` отдаётся со вставленным
  `<meta name="harness-token" content="...">`; каждый вызов `/api` и `/ws` требует его.
- Заголовков CORS нет. Статические файлы только из `web/dist`. Тела запросов ограничены 1 МБ.
- Секреты для MCP-серверов только в файле секретов (вне репозитория); `data/` и `harness.config.local.json` в gitignore.
