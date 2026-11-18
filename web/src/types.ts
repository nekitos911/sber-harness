// Shapes from docs/ARCHITECTURE.md. Keep in sync with the contract.

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done'
export type Priority = 'low' | 'medium' | 'high'

export interface TaskLogEntry { at: number; by: string; text: string; type?: string; data?: Record<string, unknown> }

export interface TaskPort {
  target: string
  branch: string
  cwd: string
  status: 'clean' | 'conflict' | 'done' | 'failed'
  sessionId: string | null
}

export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  order: number
  priority: Priority | null
  deps: string[]
  labels: string[]
  workspaceId: string | null
  /** The server's guess where the task lives; only a high-confidence one is offered by default. */
  suggestedWorkspace?: { id: string; confidence: 'high' | 'low' | number; reason?: string | null } | null
  /** Worktrees created for this task (also by the agent itself), linked by the task key. */
  worktrees?: { workspaceId: string | null; path: string; branch: string | null; dirty?: number | null }[]
  parentId: string | null
  targets: string[] // [0] = primary base (work happens here), rest = cherry-pick ports
  branch: string | null
  ports: TaskPort[]
  assigneeSessionId: string | null
  externalId: string | null
  externalUrl: string | null
  source: string | null
  externalStatus: string | null // raw tracker status
  statusManual: boolean // column set by a human; import no longer overrides it
  hidden: boolean
  takenAt: number | null
  snapshot: { title: string; description: string; externalStatus: string | null; at: number } | null
  log: TaskLogEntry[]
  pr?: TaskPr | null // newer servers: PR of task.branch, refreshed in the background
  agentState?: AgentState | null // what the assigned agent (and the harness review) is doing
  createdAt: number
  updatedAt: number
}

export type AgentState = 'running' | 'waiting' | 'done' | 'failed' | 'reviewing' | 'approved' | 'changes_requested'

export interface BoardColumn { status: TaskStatus; label: string; trackerStatuses: string[] }
export interface BoardSettings {
  columns: BoardColumn[]
  onWorkerDone?: 'stay' | 'review'
  moveSyncsTracker?: boolean
  columnTransitions?: Partial<Record<TaskStatus, string>>
}
export interface ReviewSettings { grade?: string; approvalMode?: string; maxRounds?: number; agent?: string | null; promptTemplate?: string }

/** /full-task ledger: progress.md items and per-step verdict files. */
export interface SddVerdict {
  n: number; file: string
  status: 'PASS' | 'FAIL' | 'ESCALATION_REQUIRED' | 'INDEPENDENT_VERIFICATION_REQUIRED' | null
  filesChanged?: string[]; commands?: { cmd: string; result: string }[]; openQuestions?: string | string[] | null
  implementerModel?: string | null; reviewerModel?: string | null; secondReviewModel?: string | null; notes?: string | null; raw: string
}
export interface SddPlan {
  name: string; dir: string; verdicts: SddVerdict[]
  // done: how many items are done; null = the ledger says nothing about progress (a plain list, no «0/N»)
  progress: { raw: string; items: { title: string; status: string | null }[]; done?: number | null }
}

export interface TaskPr { index: number; state: 'open' | 'merged' | 'declined'; url: string; updatedAt: number }

/** GET /api/git/pr-status: the PR whose head is the branch checked out in a worktree. */
export interface PrInfo {
  index: number
  title: string
  state: 'open' | 'merged' | 'declined'
  url: string
  mergeable: boolean | null
  reviewers: { status: string }[]
  base: string
  updatedAt: number
}

/** kind: 'root' = the projects folder (every project under it), 'folder' = any folder, absent/'repo' = a project. */
export interface Workspace { id: string; name: string; path: string; isGit: boolean; kind?: 'root' | 'folder' | 'repo' }
export interface WorktreeMeta {
  label?: string; note?: string; pinned?: boolean; sleeping?: boolean
  lastError?: { text?: string; op?: string; message?: string; at?: number } | string | null // server: { text: «Не удалось удалить: …», at }
  createdBy?: 'user' | 'agent' | 'external'; createdBySession?: string; parentWorktree?: string; createdAt?: number
}
/** Newer servers enrich the list with git/task/session facts (for the context menu and cleanup). */
export interface Worktree {
  path: string; branch: string | null; head: string; main: boolean
  dirty?: number; ahead?: number; taskId?: string | null; taskStatus?: TaskStatus | null
  pr?: { state: 'open' | 'merged' | 'declined'; url: string } | null
  sessions?: number; running?: number; lastActivityAt?: number | null; meta?: WorktreeMeta
  createdBy?: 'user' | 'agent' | 'external'; detached?: boolean
  orphan?: boolean // a folder left after a removal that failed part-way (git no longer lists it)
}

export type SessionKind = 'chat' | 'terminal'
export type SessionStatus = 'idle' | 'running' | 'stopped' | 'done' | 'failed' | 'exited' | 'error'
export type SessionRole = 'solo' | 'coordinator' | 'worker' | 'reviewer' | 'subagent'

export interface Session {
  id: string
  kind: SessionKind
  title: string
  agent: string
  launcherId: string | null
  cwd: string
  workspaceId: string | null
  branch: string | null
  role: SessionRole
  parentId: string | null
  taskId: string | null
  errorKind?: 'not_started' | 'turn' | string | null // why status is error: never produced output vs this turn failed
  status: SessionStatus
  phase?: 'starting' | 'streaming' | 'auth' | null
  lastEventAt?: number | null // last stdout event of the current turn (newer servers)
  lastEventKind?: 'text_delta' | 'assistant_final' | 'tool_running' | 'tool_done' | 'thought' | 'result' | null // the latest stream event (newer servers)
  turnClosing?: boolean // the answer is complete (result seen); the CLI is only shutting down
  warm?: boolean // ACP sessions only: the process is loaded (false = unloaded after idling)
  origin?: 'cli' | null // adopted from the GigaCode CLI history: an ordinary chat, its first message continues that session
  // the context after the last turn; lastTurn = that turn's own usage (older drafts sent input/output/cached flat)
  context?: { tokens: number; at?: number; lastTurn?: { input?: number; output?: number; cacheRead?: number } | null; input?: number; output?: number; cached?: number } | null
  contextLimit?: number | null // the model's window
  cliModel?: string | null // the model the CLI reported at the turn start (when the chat uses the default)
  mcpStatus?: { name: string; status: string }[] // MCP servers as the CLI reported them at the turn's start
  effectiveApprovalMode?: string | null // what the CLI really runs with (e.g. auto → auto-edit)
  system?: boolean // harness-internal (login terminal, discovery…): shown only under «Служебное»
  persistent?: boolean // a child that is a full participant (e.g. an orchestrator in another worktree): never folded or auto-archived
  worktreePath?: string | null // the worktree root the session runs in (its cwd may be a subfolder)
  allowedTools?: string[] // tool patterns allowed for this chat (e.g. run_shell_command(git))
  waitingFor?: 'answer' | 'auth' | 'permission' | null // called `ask` and no reply yet, or needs a login (newer servers)
  stalled?: boolean // running, process alive, but silent for session.stallSec (newer servers)
  includeDirs?: string[] // extra directories the CLI may use (--include-directories), feature include-dirs
  interrupted?: { at: number; reason: 'harness_restart' | 'reboot' | 'crash'; lastActivity: string | null } | null // a restart cut its turn
  archived?: boolean // its worktree was removed: hidden from the sidebar, transcript kept
  virtual?: boolean // a built-in sub-agent of the parent's stream: read-only chat // newer servers: 'starting' = process up, no event yet (cold start)
  externalSessionId: string | null
  settingsPath: string | null
  model: string | null
  approvalMode: string | null
  autoReport: boolean
  queued: number
  tokensIn: number
  tokensOut: number
  preview: string
  command: string | null
  pid: number | null
  createdAt: number
  lastActivityAt: number
}

export type MessageKind = 'user' | 'assistant' | 'thought' | 'tool' | 'error' | 'system' | 'question' | 'permission'

/** A choice of a permission request: harness ids (allow_once, allow_session, reject) or the ACP agent's options. */
export interface PermissionOption { id: string; label?: string; name?: string; kind?: string }

export interface ToolCall {
  id: string
  name: string
  input: unknown
  output: string | null
  status: 'running' | 'ok' | 'error'
  progress?: string[] // built-in sub-agent activity under this call (agent tool), last lines
  subSessionId?: string | null // the virtual chat of that sub-agent
}

export interface Message {
  id: string
  sessionId: string
  at: number
  kind: MessageKind
  text: string
  from: string | null
  tool: ToolCall | null
  turn: number
  options?: string[] | null // `ask` with choices: each option is a one-click reply
  link?: string | null // e.g. the GigaCode login URL
  action?: 'pick-model' | null // failure the user fixes by choosing another model
  imported?: boolean // copied from a CLI-recorded chat (turn 0): no timing of its own
  question?: { id: string; text: string; options: { label: string; description?: string }[]; multiSelect?: boolean; answer?: string | null; answered?: boolean; resolved?: string | null } | null
  permission?: { id: string; tool: string; input: unknown; reason?: string | null; transport?: 'headless' | 'acp'; options: PermissionOption[]; choice?: string | null; resolved?: string | null; answered?: boolean; pattern?: string | null } | null
}

export type NotificationKind = 'question' | 'permission' | 'recovery' | 'done' | 'failed' | 'escalation' | 'info' | 'error'

export interface Notification {
  id: string
  at: number
  read: boolean
  kind: NotificationKind
  sessionId: string | null
  taskId: string | null
  text: string
  options?: string[] | null
  link?: string | null
  actions?: ('open' | 'rework' | 'accept')[] // escalations: what the person can do right from the inbox
  answered?: boolean // a question answered (in its chat or elsewhere)
  count?: number // the same escalation again: ×N
}

/** A model in an agent's catalog (config may give a plain string; servers normalize it to {id}). */
export interface ModelEntry { id: string; label?: string; context?: string; description?: string; available?: boolean | null }

export interface AgentInfo {
  id: string
  label: string
  launcher: string
  approvalModes: string[]
  approvalMode: string | null
  approvalModeLabels?: Record<string, string>
  enabled: boolean
  models?: (ModelEntry | string)[]
  compressCommand?: string | null // e.g. «/compress»: what «Сжать контекст» sends
  contextCommand?: string | null // e.g. «/context»: the per-category breakdown (later)
}

/** GET /api/agents/:id/info: how the CLI resolves and what the last session reported (system/init). */
export interface AgentMeta {
  id: string
  resolved: { ok: boolean; command?: string; node?: string; entry?: string; identity: boolean; error?: string }
  auth?: 'ok' | 'required' | 'unknown'
  catalog?: { at: number | null; error?: string | null; running?: boolean } | null
  modelRefs?: { file: string; model: string; available: boolean | null }[]
  commands?: Record<string, 'installed' | 'missing' | 'different'>
  skills?: Record<string, 'installed' | 'missing' | 'different'>
  models?: ModelEntry[]
  seen: {
    models: string[]
    slashCommands: string[]
    mcpServers: { name: string; status: string }[]
    agents: string[]
    version: string | null
    at: number
  } | null
}

export interface GitBranch { name: string; remote: boolean; current: boolean; upstream: string | null; lastCommitAt: number; worktree: string | null }
export interface GitBranches { current: string | null; branches: GitBranch[] }

export interface Integrations {
  tasks: boolean
  pr: boolean
  tasksProblem?: { error: string; at: number } | null
}

export interface AppState {
  tasks: Task[]
  workspaces: Workspace[]
  sessions: Session[]
  notifications: Notification[]
  agents: AgentInfo[]
  defaultAgent?: string
  shell: { command: string }
  integrations: Integrations
  features?: string[] // optional API groups this server implements (absent on old servers: none)
  recentFolders?: string[] // last folders chats ran in (feature folders)
}

export type SubAgentState =
  | 'queued' | 'working' | 'restarting' | 'compacting' | 'waiting' | 'blocked'
  | 'idle' | 'done' | 'failed' | 'interrupted' | 'unverifiable'

/** Agent-internal sub-agent from the registry a task command writes (read-only). */
export interface SubAgent {
  id: string
  name: string
  state: SubAgentState
  model?: string | null
  role?: string | null
  parentId?: string | null
  lastText?: string | null
  lastActivity?: number | null
  activity?: { tool: string; since: number } | null
  tokensIn: number
  tokensOut: number
  settledAt?: number | null
}

export type Grade = 'default' | 'fast' | 'review' | 'explore'

export interface AgentSettings {
  approvalMode: string | null
  approvalModes: string[]
  approvalModeLabels?: Record<string, string>
  models?: (ModelEntry | string)[]
  model: string | null
  modelGrades: Partial<Record<Grade, string>>
  allowedGrades: string[]
  taskPromptTemplate: string | null
  taskPromptPresets?: string[]
  reworkPromptTemplate?: string | null // «Доработать»: {taskUrl} {key} {notes} (feature rework)
  reworkPromptPresets?: string[]
  firstEventTimeoutMs?: number
  inheritUserMcp?: boolean
  enabled?: boolean
  transport?: 'headless' | 'acp' // acp: one long-lived process with interactive permissions (feature acp)
  acpIdleMin?: number | null // ACP: unload an idle chat's process after N minutes (null = never)
  mcpExclude?: string[] // MCP servers (from the CLI's own config) not started for harness sessions
  allowedTools?: string[] // tool patterns the CLI may run without asking, e.g. run_shell_command(git)
  autoSandbox?: 'workspace' | 'workspace-offline' | null // «Полный доступ» as real auto under the CLI sandbox (slower)
}

export interface Settings {
  permissions?: { allowedToolsByWorkspace?: Record<string, string[]> } // «Разрешать всегда в этом проекте»
  reworkPromptPresets?: string[] // «Доработать» templates offered for every agent
  workspaces?: { root?: string | null } // projects folder; null = auto (deepest common parent)
  session?: { stallSec?: number } // «нет вывода» after this many seconds of silence (≥ 30)
  recovery?: { autoResume?: boolean; message?: string } // interrupted sessions after a restart
  sessions?: { autoArchiveDays?: number | null } // archive chats idle longer than this (null = never)
  agents: Record<string, AgentSettings>
  defaultAgent: string
  git: {
    defaultBase?: string
    branchTemplate?: string
    portBranchTemplate?: string
    commitTitleTemplate?: string
    prTitleTemplate?: string
    generateMessages?: boolean // the agent writes commit / PR messages (auto on open); false = only on «✨»
    via?: 'agent' | 'harness' // commit / push / PR through the agent (its hooks and skills run) or git from the harness
  }
  tasks: { refreshSec: number }
  orchestration?: { reviewMode?: 'builtin' | 'harness'; subagents?: 'harness' | 'builtin'; workerMayCommit?: boolean; review?: ReviewSettings; subagentRetention?: 'archive' | 'keep'; maxSubagentDepth?: number }
  board?: BoardSettings
  integrations?: {
    tasks?: { enabled?: boolean; space?: string | string[]; urlTemplate?: string; statusMap?: Record<string, string>; closedStatuses?: string[]; onStartTransition?: string | null }
    // enabled «auto» = on when the sourcecontrol MCP server is there; active = whether it is on right now
    pr?: { enabled?: boolean | 'auto'; active?: boolean; me?: string | null; limits?: { titleBytes?: number; bodyBytes?: number } }
  }
}

export interface GitFile {
  path: string; x: string; y: string; status: 'M' | 'A' | 'D' | 'R' | '?' | 'U'
  service?: boolean // .superpowers etc.: never committed
  staged?: boolean // in the index (servers with staging, feature git-stage)
  added?: number; removed?: number // its lines (status with line counts)
}
export interface GitStatus {
  branch: string | null; upstream: string | null; ahead: number; behind: number; files: GitFile[]
  totals?: { added: number; removed: number } // the whole change set's +/−
  webUrl?: string | null // the branch in the code host, when known
}
export interface GitCommit { hash: string; subject: string; author: string; at: number }
export interface GitSuggest {
  taskId: string | null
  key: string | null
  branch: string | null
  base: string
  commit: { title: string; body: string }
  pr: { title: string; body: string; base: string }
}
export interface FsEntry { name: string; path: string; dir: boolean; size: number }
export interface FsFile { path: string; content: string; size: number; binary: boolean }

export type ServerEvent =
  | { t: 'task'; task: Task }
  | { t: 'task.del'; id: string }
  | { t: 'session'; session: Session }
  | { t: 'session.del'; id: string }
  | { t: 'msg'; sessionId: string; msg: Message }
  | { t: 'notify'; n: Notification }
  | { t: 'workspaces'; workspaces: Workspace[] }
  | { t: 'subagents'; sessionId: string; items: SubAgent[] }
  | { t: 'sdd'; cwd: string; sessionId?: string | null; plans: SddPlan[] }
  | { t: 'worktree.meta'; path: string; meta: WorktreeMeta }
  | { t: 'term'; id: string; data: string }
  | { t: 'term.replay'; id: string; data: string }
  | { t: 'job'; id: string; title?: string; step?: string | null; progress?: { done: number; total: number }; done?: boolean; error?: string }

export type ClientEvent =
  | { t: 'term.attach'; id: string }
  | { t: 'term.detach'; id: string }
  | { t: 'term.in'; id: string; data: string }
  | { t: 'term.resize'; id: string; cols: number; rows: number }

/** GET /api/recovery: sessions a restart interrupted mid-turn (feature recovery). */
export interface RecoveryItem { id: string; title: string; cwd: string; taskId: string | null; role: SessionRole; reason: 'harness_restart' | 'reboot' | 'crash'; at: number; lastActivity: string | null }
export interface RecoveryState { sessions: RecoveryItem[]; message: string }

/** GET /api/history?cwd=: a chat the agent CLI recorded itself (feature cli-history). */
export interface HistoryItem { id: string; agent: string; cwd: string; title: string; startedAt: number | null; updatedAt: number | null; messages: number; model: string | null; file: string; linkedSessionId: string | null; raw?: boolean }
