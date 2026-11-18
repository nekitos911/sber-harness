// «Комментарий агенту» on lines of a diff or a file: which chats can take it and the message they get.

interface ChatLike { id: string; kind: string; cwd: string; includeDirs?: string[]; archived?: boolean; virtual?: boolean; system?: boolean; lastActivityAt: number }

const fwd = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const normPath = (p: string) => fwd(p).toLowerCase() // as lib/format; kept dependency-free for node --test

/** `path` inside `dir` as the chat sees it (relative when inside its folder), with forward slashes. */
export function pathFor(dir: string, file: string): string {
  const d = normPath(dir)
  const f = normPath(file)
  return f.startsWith(`${d}/`) ? fwd(file).slice(fwd(dir).length + 1) : fwd(file)
}

/** Chats whose folder (or an added folder) contains the file: the one open in this worktree first, then the latest. */
export function commentTargets<S extends ChatLike>(sessions: S[], file: string, openId: string | null): S[] {
  const f = normPath(file)
  const sees = (s: S) => [s.cwd, ...(s.includeDirs ?? [])].some((d) => f.startsWith(`${normPath(d)}/`))
  return sessions
    .filter((s) => s.kind === 'chat' && !s.archived && !s.virtual && !s.system && sees(s))
    .sort((a, b) => Number(b.id === openId) - Number(a.id === openId) || b.lastActivityAt - a.lastActivityAt)
}

/** «Поправь в <path>, строки 71–72:» + the lines (diff signs kept) + what to do. */
export function commentMessage({ path, from, to, snippet, note }: { path: string; from: number | null; to: number | null; snippet: string; note: string }): string {
  const where = from == null ? '' : to != null && to !== from ? `, строки ${from}–${to}` : `, строка ${from}`
  const fence = snippet.includes('```') ? '~~~' : '```'
  return `${note.trim()}\n\n\`${path}\`${where}:\n${fence}\n${snippet.replace(/\n+$/, '')}\n${fence}`
}
