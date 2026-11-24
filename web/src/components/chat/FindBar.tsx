import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { IconButton } from '../ui'

// CSS Custom Highlight API: matches are painted without touching the DOM React renders (styles: ::highlight(chat-find))
const hl = typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null
const clearMarks = () => { hl?.delete('chat-find'); hl?.delete('chat-find-cur') }

/**
 * Every occurrence of `q` in the rendered transcript, in order. Text inside a folded block (inert) is not on screen:
 * skipped. shortcut: a match split across elements (`**полу**жирный`) is not found; a text index of the messages would be needed.
 */
function findRanges(root: HTMLElement, q: string): Range[] {
  const out: Range[] = []
  const needle = q.toLowerCase()
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('[inert], [aria-hidden="true"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = (n.nodeValue ?? '').toLowerCase()
    for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + needle.length)) {
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + needle.length)
      out.push(r)
    }
  }
  return out
}

/**
 * Ctrl/⌘+F in a chat: a find bar over the transcript — «N из M», Enter / Shift+Enter (↓ / ↑), Esc closes. Messages behind
 * «Показать ранее» that contain the text are shown first (`reveal`: their count from the end), then searched on screen.
 */
export function FindBar({ root, focusKey, older, reveal, onClose }: {
  root: RefObject<HTMLElement | null>
  focusKey: number // changes on each Ctrl+F: the input takes focus again
  older: string[] // texts of the messages not rendered yet (oldest first)
  reveal: (count: number) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [ranges, setRanges] = useState<Range[]>([])
  const [cur, setCur] = useState(0)
  const [go, setGo] = useState(0) // a move to a match (new query, Enter, arrows): scroll to it; a refresh while streaming does not
  const input = useRef<HTMLInputElement>(null)
  const fresh = useRef(true) // a new query starts at the first match on screen, not at the old index

  useLayoutEffect(() => { input.current?.focus(); input.current?.select() }, [focusKey])

  // older messages with a match come onto the page first
  useEffect(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return
    const i = older.findIndex((t) => t.toLowerCase().includes(needle))
    if (i >= 0) reveal(older.length - i)
  }, [q, older, reveal])

  // what is on screen is searched again when it changes (streaming, a block unfolded, older messages shown)
  useEffect(() => {
    const el = root.current
    const needle = q.trim()
    fresh.current = true
    if (!el || !needle) { setRanges([]); return }
    let timer = 0
    const run = () => { timer = 0; setRanges(findRanges(el, needle)) }
    run()
    const mo = new MutationObserver(() => { if (!timer) timer = window.setTimeout(run, 150) })
    mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['inert'] })
    return () => { mo.disconnect(); window.clearTimeout(timer) }
  }, [q, root])

  // a new query: the first match from the top of the visible area (else the last one, the newest)
  useEffect(() => {
    if (!fresh.current || !ranges.length) { setCur((c) => Math.min(c, Math.max(0, ranges.length - 1))); return }
    fresh.current = false
    const scroller = root.current?.closest('.chat-scroll')
    const top = scroller?.getBoundingClientRect().top ?? 0
    const i = ranges.findIndex((r) => r.getBoundingClientRect().top >= top)
    setCur(i >= 0 ? i : ranges.length - 1)
    setGo((g) => g + 1)
  }, [ranges, root])

  // paint the matches, the current one stronger
  useEffect(() => {
    clearMarks()
    if (!hl || !ranges.length) return
    hl.set('chat-find', new Highlight(...ranges))
    hl.set('chat-find-cur', new Highlight(ranges[Math.min(cur, ranges.length - 1)]))
  }, [ranges, cur])

  // ...and scrolled to the middle (twice: an off-screen block gets its real height once laid out)
  useEffect(() => {
    const el = ranges[cur]?.startContainer.parentElement
    if (!go || !el) return
    el.scrollIntoView({ block: 'center' })
    const raf = requestAnimationFrame(() => el.scrollIntoView({ block: 'center' }))
    return () => cancelAnimationFrame(raf)
  }, [go]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => clearMarks, [])

  const step = (d: number) => { if (ranges.length) { setCur((c) => (c + d + ranges.length) % ranges.length); setGo((g) => g + 1) } }
  const count = !q.trim() ? '' : ranges.length ? `${cur + 1} из ${ranges.length}` : 'нет'

  return (
    <div className="chat-find-anchor">
      <div className="chat-find" role="search" aria-label="Поиск в чате">
        <input
          ref={input}
          className="chat-find-input"
          placeholder="Найти в чате"
          aria-label="Найти в чате"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); step(e.key === 'ArrowUp' ? -1 : 1) }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
          }}
        />
        <span className="chat-find-count muted num" aria-live="polite">{count}</span>
        <IconButton size="sm" label="Предыдущее (Shift+Enter)" icon={<ChevronUp />} disabled={!ranges.length} onClick={() => step(-1)} />
        <IconButton size="sm" label="Следующее (Enter)" icon={<ChevronDown />} disabled={!ranges.length} onClick={() => step(1)} />
        <IconButton size="sm" label="Закрыть (Esc)" icon={<X />} onClick={onClose} />
      </div>
    </div>
  )
}
