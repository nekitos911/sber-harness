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
  log: TaskLogEntry[]
  createdAt: number
  updatedAt: number
}

export interface Workspace { id: string; name: string; path: string; isGit: boolean }
export interface Worktree { path: string; branch: string | null; head: string; main: boolean }

export type SessionKind = 'chat' | 'terminal'
export type SessionStatus = 'idle' | 'running' | 'done' | 'failed' | 'exited' | 'error'
export type SessionRole = 'solo' | 'coordinator' | 'worker'

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
  externalSessionId: string | null
  settingsPath: string | null
  model: string | null
  approvalMode: string | null
  autoReport: boolean
  queued: number
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
}

export interface AgentInfo {
  id: string
  label: string
  launcher: string
  approvalModes: string[]
  approvalMode: string | null
  enabled: boolean
}

export interface AppState {
  tasks: Task[]
  workspaces: Workspace[]
  sessions: Session[]
  notifications: Notification[]
  agents: AgentInfo[]
  shell: { command: string }
  integrations: { tasks: boolean; pr: boolean }
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
  | { t: 'term'; id: string; data: string }
  | { t: 'term.replay'; id: string; data: string }

export type ClientEvent =
  | { t: 'term.attach'; id: string }
  | { t: 'term.detach'; id: string }
  | { t: 'term.in'; id: string; data: string }
  | { t: 'term.resize'; id: string; cols: number; rows: number }
