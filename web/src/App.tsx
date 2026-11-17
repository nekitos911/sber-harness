import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react'
import { RotateCw, WifiOff } from 'lucide-react'
import { tabKey, useStore, wtKey, type Screen, type Tab } from './store'
import { reconnectNow } from './ws'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { WorkspacePanel } from './components/WorkspacePanel'
import { Dialogs } from './components/Dialogs'
import { Toasts } from './components/Toasts'
import { Loading } from './components/bits'
import { CommandPalette } from './components/CommandPalette'
import { TooltipLayer } from './components/ui'
import { ErrorBoundary } from './components/ErrorBoundary'
import { BoardView } from './views/BoardView'
import { AgentsView } from './views/AgentsView'
import { InboxView } from './views/InboxView'
import { PrsView } from './views/PrsView'
import { SettingsView } from './views/SettingsView'
import { ChatView } from './views/ChatView'
import { DiffView } from './views/DiffView'
import { WorktreeHome } from './views/WorktreeHome'
import { useGitWatch } from './lib/git'
import { useUnreadTitle } from './lib/notify'
import { modKey } from './lib/keys'

// Heavy editors load on first use.
const TerminalView = lazy(() => import('./views/TerminalView'))
const FileView = lazy(() => import('./views/FileView'))

export function App() {
  const sidebar = useStore((s) => s.sidebar)
  const width = useStore((s) => s.sidebarWidth)
  const panel = useStore((s) => s.panel)
  const view = useStore((s) => s.view)
  const wt = useStore((s) => s.wt)
  const [palette, setPalette] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modKey(e) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useUnreadTitle()
  // The worktree on screen keeps its git state fresh (tab badges, panel, sidebar counts).
  useGitWatch(view.kind === 'wt' ? view.cwd : null)

  const here = view.kind === 'wt' ? wtKey(view.cwd) : null
  const hereTabs = here ? wt[here] : undefined
  const showsTab = !!hereTabs?.tabs.some((t) => tabKey(t) === hereTabs.active)

  return (
    <div className="app" data-sidebar={sidebar} style={{ '--sb-w': sidebar ? `${width}px` : '0px' } as CSSProperties}>
      <ErrorBoundary area="верхнюю панель"><TopBar onCommand={() => setPalette(true)} /></ErrorBoundary>
      <ErrorBoundary area="боковую панель"><Sidebar /></ErrorBoundary>
      <main className="main">
        <ConnectionBanner />
        <div className="panels">
          {view.kind === 'screen' && (
            <section className="tabpanel" key={view.screen}>
              <ErrorBoundary area={SCREEN_AREA[view.screen]}><ScreenContent screen={view.screen} /></ErrorBoundary>
            </section>
          )}
          {/* Every worktree's tabs stay mounted (terminals, scroll, drafts); only the active one of the shown worktree is visible. */}
          {Object.entries(wt).flatMap(([k, e]) => e.tabs.map((t) => {
            const key = tabKey(t)
            const shown = k === here && e.active === key
            return (
              <section key={`${k}|${key}`} className="tabpanel" hidden={!shown}>
                <ErrorBoundary area={t.kind === 'session' ? 'эту сессию' : t.kind === 'file' ? 'файл' : 'изменения'}><TabContent tab={t} active={shown} /></ErrorBoundary>
              </section>
            )
          }))}
          {view.kind === 'wt' && !showsTab && (
            <section className="tabpanel" key={`home:${here}`}>
              <ErrorBoundary area="рабочее дерево"><WorktreeHome cwd={view.cwd} /></ErrorBoundary>
            </section>
          )}
        </div>
      </main>
      {view.kind === 'wt' && panel && <ErrorBoundary area="панель файлов и изменений"><WorkspacePanel /></ErrorBoundary>}
      <StatusBar />
      <ErrorBoundary area="диалог"><Dialogs /></ErrorBoundary>
      {palette && <ErrorBoundary area="палитру команд"><CommandPalette onClose={() => setPalette(false)} /></ErrorBoundary>}
      <ErrorBoundary area="уведомления"><Toasts /></ErrorBoundary>
      <AuthExpired />
      <TooltipLayer />
    </div>
  )
}

const SCREEN_AREA: Record<Screen, string> = { board: 'доску задач', agents: 'агентов', prs: 'пулл-реквесты', inbox: 'входящие', settings: 'настройки' }

function ScreenContent({ screen }: { screen: Screen }) {
  switch (screen) {
    case 'board': return <BoardView />
    case 'agents': return <AgentsView />
    case 'prs': return <PrsView />
    case 'inbox': return <InboxView />
    case 'settings': return <SettingsView />
  }
}

function TabContent({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.kind) {
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

function ConnectionBanner() {
  const conn = useStore((s) => s.conn)
  const loaded = useStore((s) => s.loaded)
  const expired = useStore((s) => s.authExpired)
  if (conn !== 'closed' || expired) return null
  return (
    <div className="banner" role="alert">
      <WifiOff aria-hidden />
      {loaded ? 'Связь с сервером потеряна. Переподключаемся…' : 'Сервер harness недоступен. Запустите его (npm start) — подключимся автоматически.'}
      <button type="button" className="btn btn-sm" onClick={reconnectNow}>Повторить</button>
    </div>
  )
}

/** The server restarted with a new token: nothing works until the page reloads, so block and say so. */
function AuthExpired() {
  const expired = useStore((s) => s.authExpired)
  const dirty = useStore((s) => Object.values(s.dirty).some(Boolean))
  if (!expired) return null
  return (
    <div className="auth-scrim" role="alertdialog" aria-modal="true" aria-labelledby="auth-title" aria-describedby="auth-text">
      <div className="auth-card">
        <h2 id="auth-title">Сервер перезапущен — обновите страницу</h2>
        <p id="auth-text">
          Страница держит ключ доступа прошлого запуска сервера. После обновления всё продолжит работать: вкладки и черновики сохранятся.
          {dirty && ' Несохранённые правки в открытых файлах будут потеряны.'}
        </p>
        <button type="button" className="btn btn-primary" autoFocus onClick={() => window.location.reload()}>
          <RotateCw />
          Обновить
        </button>
      </div>
    </div>
  )
}
