import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { RotateCcw } from 'lucide-react'
import { tryApi } from '../api'
import { useStore } from '../store'
import { attachTerm, send } from '../ws'

function themeFromTokens(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return { background: v('--term-bg'), foreground: v('--term-fg'), cursor: v('--term-cursor'), selectionBackground: v('--term-sel') }
}

export default function TerminalView({ id, active }: { id: string; active: boolean }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === id))
  const scheme = useStore((s) => s.scheme)
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const t = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize: 13,
      fontWeight: 350, // Cascadia is variable; regular reads heavy on dark
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10_000,
      theme: themeFromTokens(),
    })
    const f = new FitAddon()
    t.loadAddon(f)
    // URLs (e.g. the GigaCode login link) open in a new tab.
    t.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')))
    t.open(el)
    term.current = t
    fit.current = f

    // A replay after a reconnect or respawn repeats the server's whole log: when it continues what is on screen,
    // write only the new tail (no flicker, scroll position kept); otherwise (log trimmed, other history) redraw.
    let shown: string | null = '' // what the screen holds since the last replay; null = too long to compare
    let printed = false
    // A respawned process (ConPTY) starts with "erase display", which in xterm.js wipes the old output for good:
    // scroll the screen into the scrollback first, so the previous run stays one scroll away.
    const write = (d: string): void => {
      const i = d.indexOf('\x1b[2J')
      if (i < 0) { if (d) { printed = true; t.write(d) } return }
      const keep = printed || i > 0 // the first erase of a fresh screen has nothing to keep
      t.write(keep ? `${d.slice(0, i)}\x1b[${t.rows};1H${'\n'.repeat(t.rows)}\x1b[2J` : d.slice(0, i + 4))
      printed = true
      write(d.slice(i + 4))
    }
    const detach = attachTerm(id, (data, replay) => {
      if (replay && shown && data.startsWith(shown)) {
        const tail = data.slice(shown.length)
        shown = data
        if (tail) write(tail)
        return
      }
      if (replay) {
        t.reset()
        printed = false
        shown = data
      } else if (shown !== null) {
        shown = shown.length > 4 * 1024 * 1024 ? null : shown + data // past the server's 2 MB ring a match is impossible anyway
      }
      write(data)
    })
    const input = t.onData((data) => send({ t: 'term.in', id, data }))

    let frame = 0
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!el.clientWidth || !el.clientHeight) return // hidden tab
        f.fit()
        send({ t: 'term.resize', id, cols: t.cols, rows: t.rows })
      })
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    return () => {
      ro.disconnect()
      cancelAnimationFrame(frame)
      input.dispose()
      detach()
      t.dispose()
      term.current = null
      fit.current = null
    }
  }, [id])

  useEffect(() => {
    if (term.current) term.current.options.theme = themeFromTokens()
  }, [scheme])

  useEffect(() => {
    if (active) term.current?.focus()
  }, [active])

  const restart = async () => {
    if ((await tryApi<unknown>('POST', `/sessions/${id}/restart`)) === undefined) return
    send({ t: 'term.attach', id }) // fresh replay of the respawned process
  }

  return (
    <div className="term-view">
      {session?.status === 'exited' && (
        <div className="term-bar" role="status">
          Процесс завершён.
          <button type="button" className="btn btn-sm" onClick={() => void restart()}>
            <RotateCcw />
            Перезапустить
          </button>
        </div>
      )}
      <div className="term-host" ref={host} />
    </div>
  )
}
