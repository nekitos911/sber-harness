import { useMemo } from 'react'
import { HistoryList } from '../components/HistoryList'
import { FolderOpen, FolderTree, GitBranch, GitCompareArrows, House, MessageSquarePlus, SquareTerminal } from 'lucide-react'
import { openSession, openTask, showPanel, useFeature, useStore } from '../store'
import { basename, normPath, relTime, statusLabel } from '../lib/format'
import { newChat, newTerminal, workspaceFor } from '../lib/actions'
import { useGit } from '../lib/git'
import { useNow } from '../lib/useNow'
import { StatusIcon } from '../components/bits'
import { openFolder } from '../components/WorktreeMenu'

/** A worktree with no open tabs: what lives here and the quick ways to start. */
export function WorktreeHome({ cwd }: { cwd: string }) {
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  const workspaces = useStore((s) => s.workspaces)
  const worktrees = useStore((s) => s.worktrees)
  const git = useGit(cwd)
  const now = useNow()
  const openOn = useFeature('open')
  const historyOn = useFeature('cli-history')

  const p = normPath(cwd)
  const wsId = workspaceFor(cwd)
  const ws = workspaces.find((w) => w.id === wsId)
  const wt = wsId ? worktrees[wsId]?.find((w) => normPath(w.path) === p) : undefined
  const main = wt?.main ?? (!!ws && normPath(ws.path) === p)
  const branch = git?.status?.branch ?? wt?.branch ?? null
  const changed = git?.status?.files.length ?? 0

  const here = useMemo(() => sessions.filter((s) => normPath(s.cwd) === p).sort((a, b) => b.lastActivityAt - a.lastActivityAt), [sessions, p])
  const linked = useMemo(() => {
    const ids = new Set(here.map((s) => s.id))
    return tasks.filter((t) => (t.assigneeSessionId && ids.has(t.assigneeSessionId)) || (!!branch && t.branch === branch && (!wsId || t.workspaceId === wsId)))
  }, [tasks, here, branch, wsId])

  const where = { cwd, workspaceId: wsId }

  return (
    <div className="wt-home">
      <header className="wt-home-head">
        {main ? <House aria-hidden /> : <GitBranch aria-hidden />}
        <div>
          <h1>{branch ?? basename(cwd)}</h1>
          <p className="muted">
            {ws ? `${ws.name} · ` : ''}{main ? 'основная рабочая копия' : 'рабочее дерево'}
            <span className="mono wt-home-path" data-tip={cwd}>{cwd}</span>
          </p>
        </div>
      </header>

      <div className="wt-home-actions">
        <button type="button" className="btn btn-primary" onClick={() => void newChat(where)}>
          <MessageSquarePlus />
          Новый чат
        </button>
        <button type="button" className="btn" onClick={() => void newTerminal(where)}>
          <SquareTerminal />
          Терминал
        </button>
        <button type="button" className="btn" onClick={() => showPanel('changes')}>
          <GitCompareArrows />
          Изменения{changed > 0 && <span className="count count-run">{changed}</span>}
        </button>
        <button type="button" className="btn" onClick={() => showPanel('files')}>
          <FolderTree />
          Файлы
        </button>
        {openOn && (
          <button type="button" className="btn" onClick={() => openFolder(cwd)}>
            <FolderOpen />
            Открыть папку
          </button>
        )}
      </div>

      {here.length > 0 && (
        <section className="wt-home-section">
          <h2>Сессии в этом дереве</h2>
          <ul>
            {here.map((s) => (
              <li key={s.id}>
                <button type="button" className="wt-home-row" onClick={() => openSession(s.id)}>
                  {s.kind === 'terminal' ? <SquareTerminal className="st" aria-label="терминал" /> : <StatusIcon session={s} />}
                  <span className="ellipsis grow">{s.title || s.id}</span>
                  <span className="mono muted">{s.kind === 'terminal' ? 'shell' : s.model ?? s.agent}</span>
                  <span className="muted num">{relTime(s.lastActivityAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {historyOn && (
        <section className="wt-home-section">
          <h2>История GigaCode</h2>
          <HistoryList cwd={cwd} />
        </section>
      )}

      {linked.length > 0 && (
        <section className="wt-home-section">
          <h2>Задачи</h2>
          <ul>
            {linked.map((t) => (
              <li key={t.id}>
                <button type="button" className="wt-home-row" onClick={() => openTask(t.id)}>
                  <span className="mono muted">{t.externalId ?? t.id}</span>
                  <span className="ellipsis grow">{t.title}</span>
                  <span className="muted">{statusLabel(t.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {here.length === 0 && linked.length === 0 && (
        <p className="muted wt-home-note">Здесь пока нет ни чатов, ни задач. Новый чат начнёт работу агента прямо в этой папке.</p>
      )}
    </div>
  )
}
