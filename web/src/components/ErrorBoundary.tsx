import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'

interface Props { area?: string; children: ReactNode; full?: boolean }
interface State { error: Error | null; stack: string; key: number }

const RELOADED = 'harness.reloadedForBuild'
/** A lazy chunk of the build this page came from is gone (the UI was rebuilt while open). */
const isStaleBuild = (e: unknown) => /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(String((e as Error)?.message ?? e))

/** Reload once for a new build; false when this tab already did it a moment ago (then the user is asked). */
export function reloadForNewBuild(): boolean {
  try {
    if (sessionStorage.getItem(RELOADED)) return false
    sessionStorage.setItem(RELOADED, '1')
  } catch { return false }
  window.location.reload()
  return true
}
// A page that stayed up is a good build: a later rebuild may reload again.
window.setTimeout(() => { try { sessionStorage.removeItem(RELOADED) } catch { /* storage off */ } }, 15000)

const details = (s: State) => `${s.error?.name}: ${s.error?.message}\n${s.error?.stack ?? ''}\n\nКомпоненты:${s.stack}`

/**
 * A render error stays inside its region: the region shows a compact card (or, at the root, a full-screen one)
 * instead of the whole app going blank. «Повторить» remounts the region.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '', key: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isStaleBuild(error) && reloadForNewBuild()) return
    this.setState({ stack: info.componentStack ?? '' })
    console.error(`[harness] ошибка в области «${this.props.area ?? 'приложение'}»:`, error, info.componentStack)
  }

  private retry = () => this.setState((s) => ({ error: null, stack: '', key: s.key + 1 }))

  private copy = () => { void navigator.clipboard?.writeText(details(this.state)).catch(() => undefined) }

  render() {
    const { error, key } = this.state
    if (!error) return <ErrorKey key={key}>{this.props.children}</ErrorKey>
    if (isStaleBuild(error)) {
      // «Повторить» cannot help: React.lazy keeps the failed import
      return (
        <div className={this.props.full ? 'crash-full' : 'crash-region'} role="alert">
          <div className={this.props.full ? 'crash-card' : 'crash-head'}>
            <RotateCcw aria-hidden />
            <strong>Интерфейс обновлён</strong>
          </div>
          <div className="row">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => window.location.reload()}><RotateCcw />Перезагрузить</button>
          </div>
        </div>
      )
    }
    if (this.props.full) {
      return (
        <div className="crash-full" role="alert">
          <div className="crash-card">
            <TriangleAlert aria-hidden />
            <h2>Что-то сломалось в интерфейсе</h2>
            <p className="mono">{error.message}</p>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}><RotateCcw />Перезагрузить</button>
              <button type="button" className="btn" onClick={this.copy}>Скопировать подробности</button>
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="crash-region" role="alert">
        <div className="crash-head">
          <TriangleAlert aria-hidden />
          <strong>Не удалось показать {this.props.area ?? 'эту область'}</strong>
        </div>
        <p className="mono">{error.message}</p>
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={this.retry}><RotateCcw />Повторить</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={this.copy}>Скопировать подробности</button>
        </div>
      </div>
    )
  }
}

/** Remount children when the boundary is retried. */
function ErrorKey({ children }: { children: ReactNode }) {
  return <>{children}</>
}
