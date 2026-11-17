import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react'
import { Bot, Inbox, SquareKanban, WifiOff } from 'lucide-react'
import { openTab, tabKey, useStore, type Tab } from './store'
import { reconnectNow } from './ws'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { WorkspacePanel } from './components/WorkspacePanel'
import { Dialogs } from './components/Dialogs'
import { Toasts } from './components/Toasts'
import { Loading } from './components/bits'
import { CommandPalette } from './components/CommandPalette'
import { BoardView } from './views/BoardView'
import { AgentsView } from './views/AgentsView'
import { InboxView } from './views/InboxView'
import { ChatView } from './views/ChatView'
import { DiffView } from './views/DiffView'

// Heavy editors load on first use.
const TerminalView = lazy(() => import('./views/TerminalView'))
const FileView = lazy(() => import('./views/FileView'))

export function App() {
  const sidebar = useStore((s) => s.sidebar)
  const width = useStore((s) => s.sidebarWidth)
  const panel = useStore((s) => s.panel)
  const tabs = useStore((s) => s.tabs)
  const active = useStore((s) => s.active)
  const [palette, setPalette] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app" data-sidebar={sidebar} style={{ '--sb-w': sidebar ? `${width}px` : '0px' } as CSSProperties}>
      <TopBar onCommand={() => setPalette(true)} />
      <Sidebar />
      <main className="main">
        <ConnectionBanner />
        <div className="panels">
          {tabs.map((t) => {
            const key = tabKey(t)
            return (
              <section key={key} className="tabpanel" role="tabpanel" hidden={key !== active} aria-label={key}>
                <TabContent tab={t} active={key === active} />
              </section>
            )
          })}
          {tabs.length === 0 && <Launcher />}
        </div>
      </main>
      {panel && <WorkspacePanel />}
      <StatusBar />
      <Dialogs />
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      <Toasts />
    </div>
  )
}

function TabContent({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.kind) {
    case 'board': return <BoardView />
    case 'agents': return <AgentsView />
    case 'inbox': return <InboxView />
    case 'session': return <SessionTab id={tab.id} active={active} />
    case 'file': return <Suspense fallback={<Loading />}><FileView cwd={tab.cwd} path={tab.path} /></Suspense>
    case 'diff': return <DiffView cwd={tab.cwd} path={tab.path} />
  }
}

function SessionTab({ id, active }: { id: string; active: boolean }) {
  const kind = useStore((s) => s.sessions.find((x) => x.id === id)?.kind)
  if (!kind) return <Loading />
  if (kind === 'terminal') return <Suspense fallback={<Loading />}><TerminalView id={id} active={active} /></Suspense>
  return <ChatView id={id} active={active} />
}

function Launcher() {
  return (
    <div className="empty">
      <h2>Все вкладки закрыты</h2>
      <div className="row">
        <button type="button" className="btn" onClick={() => openTab({ kind: 'board' })}><SquareKanban />Задачи</button>
        <button type="button" className="btn" onClick={() => openTab({ kind: 'agents' })}><Bot />Агенты</button>
        <button type="button" className="btn" onClick={() => openTab({ kind: 'inbox' })}><Inbox />Входящие</button>
      </div>
    </div>
  )
}

function ConnectionBanner() {
  const conn = useStore((s) => s.conn)
  const loaded = useStore((s) => s.loaded)
  if (conn !== 'closed') return null
  return (
    <div className="banner" role="alert">
      <WifiOff aria-hidden />
      {loaded ? 'Связь с сервером потеряна. Переподключаемся…' : 'Сервер harness недоступен. Запустите его (npm start) — подключимся автоматически.'}
      <button type="button" className="btn btn-sm" onClick={reconnectNow}>Повторить</button>
    </div>
  )
}
