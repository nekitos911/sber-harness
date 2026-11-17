import { useEffect, useMemo, useState } from 'react'
import { History, Play } from 'lucide-react'
import { api, errorText, tryApi } from '../api'
import { closeTab, getState, tabKey, wtKey, type Tab } from '../store'
import { adoptSession } from '../lib/actions'
import { loadHistory } from '../lib/history'
import type { Message, Session } from '../types'
import { Skeleton } from '../components/bits'
import { Button } from '../components/ui'
import { MessageItem } from '../components/chat/MessageItem'
import { buildItems, ToolRun, TurnFiles } from '../components/chat/Turn'

type HistoryTab = Extract<Tab, { kind: 'history' }>

/** A chat the CLI recorded outside the harness: read-only, rendered like a live one; «Продолжить в harness» resumes it. */
export function HistoryView({ tab }: { tab: HistoryTab }) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api<Message[]>('GET', `/history/${encodeURIComponent(tab.agent)}/${encodeURIComponent(tab.id)}/messages`)
      .then((m) => { if (live) setMessages(Array.isArray(m) ? m : []) }, (e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [tab.agent, tab.id])
  const items = useMemo(() => buildItems(messages ?? [], null, null), [messages])

  const resume = async () => {
    setBusy(true)
    const s = await tryApi<Session>('POST', `/history/${encodeURIComponent(tab.agent)}/${encodeURIComponent(tab.id)}/continue`, { cwd: tab.cwd })
    setBusy(false)
    if (!s) return
    loadHistory(tab.cwd, true)
    adoptSession(s) // the linked live chat opens next to this tab
    if (getState().wt[wtKey(tab.cwd)]?.tabs.some((t) => tabKey(t) === tabKey(tab))) closeTab(tab.cwd, tabKey(tab))
  }

  return (
    <div className="chat history-view">
      <header className="chat-head">
        <History aria-hidden className="st" />
        <span className="chat-title ellipsis">История: {tab.title || tab.id}</span>
      </header>
      <div className="history-banner" role="note">
        <span>Сессия из CLI — только чтение.</span>
        <span className="grow" />
        <Button variant="primary" size="sm" icon={<Play />} busy={busy} onClick={() => void resume()}>Продолжить в harness</Button>
      </div>
      <div className="chat-scroll">
        <div className="chat-col">
          {!messages && !error && <Skeleton rows={6} label="Загрузка сессии…" />}
          {error && <p className="field-error">Не удалось прочитать сессию: {error}</p>}
          {items.map((it) => {
            switch (it.kind) {
              case 'msg': return <MessageItem key={it.key} m={it.m} until={it.until} />
              case 'tools': return <ToolRun key={it.key} msgs={it.msgs} cwd={tab.cwd} live={false} />
              case 'files': return <TurnFiles key={it.key} msgs={it.msgs} cwd={tab.cwd} />
              default: return null
            }
          })}
        </div>
      </div>
    </div>
  )
}
