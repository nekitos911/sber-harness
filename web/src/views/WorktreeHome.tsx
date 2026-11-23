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
import { Disclosure } from '../components/ui'

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
  const changed = git?.status?.files.filter((f) => !f.service).length ?? 0

  const here = useMemo(() => sessions.filter((s) => normPath(s.cwd) === p).sort((a, b) => b.createdAt - a.createdAt), [sessions, p])
  const linked = useMemo(() => {
    const ids = new Set(here.map((s) => s.id))
    const keyIn = (t: (typeof tasks)[number]) => !!branch && !!t.externalId && new RegExp(`(^|[^A-Za-z0-9])${t.externalId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i').test(branch)
    return tasks.filter((t) => (t.assigneeSessionId && ids.has(t.assigneeSessionId)) || (!!branch && t.branch === branch && (!wsId || t.workspaceId === wsId)) || (t.worktrees ?? []).some((w) => normPath(w.path) === p) || keyIn(t))
  }, [tasks, here, branch, wsId, p])

  // chats that work in this worktree from elsewhere (a task started in the projects folder makes its worktree itself)
  const elsewhere = useMemo(() => {
    const ids = new Set(here.map((s) => s.id))
    const mine = tasks.filter((t) => (t.worktrees ?? []).some((w) => normPath(w.path) === p))
    const maker = sessions.find((s) => s.id === wt?.meta?.createdBySession)
    const by = new Set([...mine.map((t) => t.assigneeSessionId), maker?.id, maker?.parentId].filter((x): x is string => !!x))
    return sessions.filter((s) => !ids.has(s.id) && !s.archived && s.kind === 'chat' && !s.virtual
      && (by.has(s.id) || mine.some((t) => t.id === s.taskId) || (s.includeDirs ?? []).some((d) => normPath(d) === p)))
      .sort((x, y) => y.createdAt - x.createdAt)
  }, [sessions, tasks, here, p, wt])

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

      {elsewhere.length > 0 && (
        <section className="wt-home-section">
          <h2>Работу здесь ведёт</h2>
          <ul>
            {elsewhere.map((s) => (
              <li key={s.id}>
                <button type="button" className="wt-home-row" onClick={() => openSession(s.id)} data-tip={`Чат в ${s.cwd}: он создал это дерево и правит в нём`}>
                  <StatusIcon session={s} />
                  <span className="ellipsis grow">{s.title || s.id}</span>
                  <span className="muted">чат в {basename(s.cwd)}</span>
                  <span className="muted num">{relTime(s.lastActivityAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

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

      {historyOn && (
        <section className="wt-home-section">
          <Disclosure summary={<h2>История GigaCode в этой папке</h2>} defaultOpen={here.length === 0 && linked.length === 0 && elsewhere.length === 0}>
            <HistoryList cwd={cwd} />
          </Disclosure>
        </section>
      )}

      {here.length === 0 && linked.length === 0 && elsewhere.length === 0 && (
        <p className="muted wt-home-note">Здесь пока нет ни чатов, ни задач. Новый чат начнёт работу агента прямо в этой папке.</p>
      )}
    </div>
  )
}
