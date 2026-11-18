import { useMemo, useState } from 'react'
import { Send } from 'lucide-react'
import { tryApi } from '../api'
import { toast, useStore, wtKey } from '../store'
import { commentMessage, commentTargets, pathFor, within } from '../lib/agentComment'
import { newChat } from '../lib/actions'
import { Button, Select } from './ui'

const NEW = 'new'

/**
 * «Комментарий агенту» under selected lines (a diff or a file): what to change, and which chat gets it — the chat open in
 * this worktree, else the latest one that sees the file, or a new one. A busy agent gets it as its next message.
 */
export function AgentComment({ cwd, path, from, to, snippet, onDone }: {
  cwd: string; path: string; from: number | null; to: number | null; snippet: string; onDone: () => void
}) {
  const sessions = useStore((s) => s.sessions)
  const active = useStore((s) => s.wt[wtKey(cwd)]?.active ?? null)
  const file = `${cwd.replace(/[\\/]+$/, '')}/${path}`
  const openId = active?.startsWith('s:') ? active.slice(2) : null
  const targets = useMemo(() => commentTargets(sessions, file, openId, cwd), [sessions, file, openId, cwd])
  // preselected only when it is this worktree's chat (or the open one); otherwise the person picks — no silent detour
  const own = targets[0] && (targets[0].id === openId || within(targets[0].cwd, cwd))
  const [target, setTarget] = useState<string>(() => (own ? targets[0].id : targets.length ? '' : NEW))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (!note.trim() || busy || !target) return
    setBusy(true)
    const chat = targets.find((s) => s.id === target)
    const text = commentMessage({ path: chat ? pathFor(chat.cwd, file) : path, from, to, snippet, note })
    if (chat) {
      const ok = await tryApi('POST', `/sessions/${chat.id}/messages`, { text })
      if (ok !== undefined) toast(`Отправлено в «${chat.title}»${chat.status === 'running' ? ' — в очередь' : ''}`)
    } else {
      await newChat({ cwd }, text)
    }
    setBusy(false)
    onDone()
  }

  return (
    <form className="agent-comment" onSubmit={(e) => { e.preventDefault(); void send() }}>
      <textarea
        className="input" rows={2} autoFocus aria-label="Что поправить агенту" value={note}
        placeholder={`Что поправить в ${from == null ? 'этом месте' : to != null && to !== from ? `строках ${from}–${to}` : `строке ${from}`}`}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send() }
        }}
      />
      <div className="agent-comment-bar">
        <span className="muted">в</span>
        <Select size="sm" label="Какому чату отправить" value={target} onChange={setTarget} placeholder="Выберите чат"
          options={[...targets.map((s) => ({ value: s.id, label: s.title || s.id, hint: s.status === 'running' ? 'работает — в очередь' : undefined })), { value: NEW, label: 'Новый чат' }]} />
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={onDone}>Отмена</Button>
        <Button size="sm" variant="primary" type="submit" icon={<Send />} busy={busy} disabled={!note.trim() || !target}>Отправить</Button>
      </div>
    </form>
  )
}
