// Shapes from docs/ARCHITECTURE.md. Keep in sync with the contract.

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done'
export type Priority = 'low' | 'medium' | 'high'

export interface TaskLogEntry { at: number; by: string; text: string }

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

export interface Workspace { id: string; name: string; path: string; isGit: boolean }
export interface WorktreeMeta { label?: string; note?: string; pinned?: boolean; sleeping?: boolean }
/** Newer servers enrich the list with git/task/session facts (for the context menu and cleanup). */
export interface Worktree {
  path: string; branch: string | null; head: string; main: boolean
  dirty?: number; ahead?: number; taskId?: string | null; taskStatus?: TaskStatus | null
  pr?: { state: 'open' | 'merged' | 'declined'; url: string } | null
  sessions?: number; running?: number; lastActivityAt?: number | null; meta?: WorktreeMeta
}

export type SessionKind = 'chat' | 'terminal'
export type SessionStatus = 'idle' | 'running' | 'stopped' | 'done' | 'failed' | 'exited' | 'error'
export type SessionRole = 'solo' | 'coordinator' | 'worker' | 'reviewer'

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
  status: SessionStatus
  phase?: 'starting' | 'streaming' | 'auth' | null
  archived?: boolean // its worktree was removed: hidden from the sidebar, transcript kept // newer servers: 'starting' = process up, no event yet (cold start)
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

export type MessageKind = 'user' | 'assistant' | 'thought' | 'tool' | 'error' | 'system'

export interface ToolCall {
  id: string
  name: string
  input: unknown
  output: string | null
  status: 'running' | 'ok' | 'error'
  progress?: string[] // built-in sub-agent activity under this call (agent tool), last lines
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
}

export type NotificationKind = 'question' | 'done' | 'failed' | 'escalation' | 'info' | 'error'

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
}

/** GET /api/agents/:id/info: how the CLI resolves and what the last session reported (system/init). */
export interface AgentMeta {
  id: string
  resolved: { ok: boolean; command?: string; node?: string; entry?: string; identity: boolean; error?: string }
  auth?: 'ok' | 'required' | 'unknown'
  catalog?: { at: number | null; error?: string | null } | null
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
  firstEventTimeoutMs?: number
  inheritUserMcp?: boolean
  enabled?: boolean
}

export interface Settings {
  agents: Record<string, AgentSettings>
  defaultAgent: string
  git: {
    defaultBase?: string
    branchTemplate?: string
    portBranchTemplate?: string
    commitTitleTemplate?: string
    prTitleTemplate?: string
  }
  tasks: { refreshSec: number }
  orchestration?: { reviewMode?: 'builtin' | 'harness'; workerMayCommit?: boolean; review?: ReviewSettings }
  board?: BoardSettings
  integrations?: {
    tasks?: { enabled?: boolean; space?: string; urlTemplate?: string; statusMap?: Record<string, string>; closedStatuses?: string[]; onStartTransition?: string | null }
    pr?: { enabled?: boolean; limits?: { titleBytes?: number; bodyBytes?: number } }
  }
}

export interface GitFile { path: string; x: string; y: string; status: 'M' | 'A' | 'D' | 'R' | '?' | 'U' }
export interface GitStatus { branch: string | null; upstream: string | null; ahead: number; behind: number; files: GitFile[] }
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
  | { t: 'term'; id: string; data: string }
  | { t: 'term.replay'; id: string; data: string }

export type ClientEvent =
  | { t: 'term.attach'; id: string }
  | { t: 'term.detach'; id: string }
  | { t: 'term.in'; id: string; data: string }
  | { t: 'term.resize'; id: string; cols: number; rows: number }
