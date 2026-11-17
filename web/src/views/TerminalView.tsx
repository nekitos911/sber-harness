import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
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
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10_000,
      theme: themeFromTokens(),
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(el)
    term.current = t
    fit.current = f

    const detach = attachTerm(id, (data, replay) => {
      if (replay) t.reset()
      t.write(data)
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
