import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { IconButton } from '../ui'
import { firstIndex } from '../../lib/sorted'

// CSS Custom Highlight API: matches are painted without touching the DOM React renders (styles: ::highlight(chat-find))
const NONE: string[] = []
const hl = typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null
const clearMarks = (mark: string) => { hl?.delete(mark); hl?.delete(`${mark}-cur`) }

/**
 * Every occurrence of `q` in the rendered transcript, in order. Text inside a folded block (inert) is not on screen:
 * skipped. shortcut: a match split across elements (`**полу**жирный`) is not found; a text index of the messages would be needed.
 */
function findRanges(root: HTMLElement, q: string): Range[] {
  const out: Range[] = []
  const needle = q.toLowerCase()
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // folded (inert), hidden tabs and the find bar itself are not on screen
    acceptNode: (n) => (n.parentElement?.closest('[inert], [aria-hidden="true"], [hidden], .chat-find, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
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
export function FindBar({ root, focusKey, older = NONE, reveal, onClose, label = 'Найти в чате', mark = 'chat-find', className = 'chat-find-anchor' }: {
  root: RefObject<HTMLElement | null>
  focusKey: number // changes on each Ctrl+F: the input takes focus again
  older?: string[] // texts of the messages not rendered yet (oldest first)
  reveal?: (count: number) => void
  onClose: () => void
  label?: string
  mark?: string // highlight name: the chat's and the page's bars paint separately
  className?: string
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
    if (i >= 0) reveal?.(older.length - i)
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
    const scroller = root.current?.closest('.chat-scroll') ?? root.current
    const top = scroller?.getBoundingClientRect().top ?? 0
    // ranges are in document order: a binary search measures ~log n of them (each measure forced a layout: 1.4 s for 3000 matches)
    const i = firstIndex(ranges, (r) => r.getBoundingClientRect().top >= top)
    setCur(i >= 0 ? i : ranges.length - 1)
    setGo((g) => g + 1)
  }, [ranges, root])

  // paint the matches, the current one stronger
  useEffect(() => {
    clearMarks(mark)
    if (!hl || !ranges.length) return
    hl.set(mark, new Highlight(...ranges))
    hl.set(`${mark}-cur`, new Highlight(ranges[Math.min(cur, ranges.length - 1)]))
  }, [ranges, cur, mark])

  // ...and scrolled to the middle (twice: an off-screen block gets its real height once laid out)
  useEffect(() => {
    const el = ranges[cur]?.startContainer.parentElement
    if (!go || !el) return
    el.scrollIntoView({ block: 'center' })
    const raf = requestAnimationFrame(() => el.scrollIntoView({ block: 'center' }))
    return () => cancelAnimationFrame(raf)
  }, [go]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearMarks(mark), [mark])

  const step = (d: number) => { if (ranges.length) { setCur((c) => (c + d + ranges.length) % ranges.length); setGo((g) => g + 1) } }
  const count = !q.trim() ? '' : ranges.length ? `${cur + 1} из ${ranges.length}` : 'нет'

  return (
    <div className={className}>
      <div className="chat-find" role="search" aria-label={label}>
        <input
          ref={input}
          className="chat-find-input"
          placeholder={label}
          aria-label={label}
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
