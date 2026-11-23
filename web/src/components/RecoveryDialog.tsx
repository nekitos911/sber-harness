import { useMemo, useState } from 'react'
import { api, errorText, tryApi } from '../api'
import { closeDialog, setState, toast, useStore } from '../store'
import { ago, basename, plural } from '../lib/format'
import { loadDraft, saveDraft } from '../lib/draft'
import type { RecoveryItem } from '../types'
import { StatusIcon } from './bits'
import { Modal } from './ui/Dialog'
import { Button, Checkbox, MenuButton } from './ui'
import { Ellipsis } from 'lucide-react'

const REASON: Record<RecoveryItem['reason'], string> = { reboot: 'Перезагрузка ПК', harness_restart: 'Перезапуск harness', crash: 'Сбой' }

const preChecked = (s: RecoveryItem) => s.role === 'worker' || s.role === 'coordinator' || s.role === 'reviewer'

export function RecoveryDialog() {
  const recovery = useStore((s) => s.recovery)
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  // The rows as the dialog opened: resumed ones stay (their status turns «работает» live), dismissed ones go.
  const [items, setItems] = useState(() => recovery?.sessions ?? [])
  const [picked, setPicked] = useState<Set<string>>(() => new Set(items.filter(preChecked).map((s) => s.id)))
  const [message, setMessage] = useState(() => loadDraft<string>('recovery:message') ?? recovery?.message ?? '')
  const [resumed, setResumed] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const reasons = useMemo(() => [...new Set(items.map((s) => REASON[s.reason] ?? s.reason))].join(' · '), [items])
  const left = items.filter((s) => !resumed.has(s.id))
  const chosen = left.filter((s) => picked.has(s.id))

  const edit = (v: string) => { setMessage(v); saveDraft('recovery:message', v === recovery?.message ? null : v) }
  const toggle = (id: string, on: boolean) => setPicked((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n })
  const dismiss = async (id: string) => {
    if ((await tryApi('POST', '/recovery/dismiss', { sessionIds: [id] })) === undefined) return
    setItems((list) => list.filter((x) => x.id !== id))
    setState((s) => ({ recovery: s.recovery && s.recovery.sessions.length > 1 ? { ...s.recovery, sessions: s.recovery.sessions.filter((x) => x.id !== id) } : null }))
  }
  const resume = async (rows: RecoveryItem[]) => {
    if (busy || !rows.length) return
    setBusy(true)
    try {
      const { resumed: ids } = await api<{ resumed: string[] }>('POST', '/recovery/resume', { sessionIds: rows.map((s) => s.id), message: message.trim() || undefined })
      setResumed((r) => new Set([...r, ...ids]))
      saveDraft('recovery:message', null)
      toast(`Продолжено ${ids.length} ${plural(ids.length, 'сессия', 'сессии', 'сессий')}`, 'ok')
      setState((s) => {
        const rest = s.recovery?.sessions.filter((x) => !rows.some((c) => c.id === x.id)) ?? []
        return { recovery: rest.length ? { ...s.recovery!, sessions: rest } : null }
      })
      closeDialog() // the rest (if any) stays under «Прерванные» in the inbox
    } catch (e) {
      toast(`Не удалось продолжить: ${errorText(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Восстановление сессий"
      submitLabel={left.length ? `Продолжить выбранные (${chosen.length})` : 'Готово'}
      cancelLabel="Закрыть"
      extraAction={left.length > 0 && <Button size="lg" disabled={busy} onClick={() => void resume(left)}>Продолжить все</Button>}
      focusSubmit
      busy={busy}
      disabled={left.length > 0 && !chosen.length}
      wide
      onClose={closeDialog}
      onSubmit={() => (left.length ? void resume(chosen) : closeDialog())}
    >
      <p className="muted" style={{ marginTop: -6 }}>{reasons ? `${reasons}: ` : ''}эти сессии прервались посреди хода. Можно отправить сообщение ниже всем сессиям в списке или только отмеченным. Через «…» можно убрать сессию из списка.</p>
      <ul className="recovery-list">
        {items.map((it) => {
          const s = sessions.find((x) => x.id === it.id)
          const task = it.taskId ? tasks.find((t) => t.id === it.taskId) : undefined
          const done = resumed.has(it.id)
          return (
            <li key={it.id} className="recovery-row" data-done={done || undefined}>
              <Checkbox checked={done || picked.has(it.id)} disabled={done} onChange={(v) => toggle(it.id, v)}>
                <span className="recovery-title">
                  {s ? <StatusIcon session={s} /> : null}
                  <strong className="ellipsis">{it.title}</strong>
                  {task && <span className="chip chip-mono">{task.externalId ?? task.id}</span>}
                </span>
              </Checkbox>
              <span className="recovery-meta">
                <span className="mono ellipsis" data-tip={it.cwd}>{basename(it.cwd)}</span>
                {it.lastActivity && <span className="ellipsis">прервано на: <span className="mono">{it.lastActivity}</span></span>}
                <span className="num">{ago(it.at)}</span>
              </span>
              {done ? <span className="recovery-state">продолжена</span>
                : <MenuButton label={`Действия: ${it.title}`} icon={<Ellipsis />} align="right" items={[{ label: 'Не продолжать — убрать из списка', onSelect: () => void dismiss(it.id) }]} />}
            </li>
          )
        })}
      </ul>
      {left.length > 0 && (
        <label className="field">
          <span>Сообщение агентам</span>
          <textarea className="textarea" rows={3} value={message} onChange={(e) => edit(e.target.value)} />
        </label>
      )}
    </Modal>
  )
}
