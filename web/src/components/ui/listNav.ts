import { useRef, useState, type KeyboardEvent } from 'react'

/**
 * Keyboard model shared by listbox, menu and combobox lists: arrows/Home/End move over enabled items,
 * Enter picks, and typing a few letters jumps to the next item whose text starts with them (typeahead).
 */
export function useListNav(texts: string[], disabled: (i: number) => boolean, onPick: (i: number) => void, start = 0) {
  const [active, setActive] = useState(start)
  const typed = useRef({ text: '', at: 0 })

  const step = (from: number, dir: 1 | -1) => {
    const n = texts.length
    for (let k = 1; k <= n; k++) {
      const i = (from + dir * k + n) % n
      if (!disabled(i)) return i
    }
    return from
  }

  const onKeyDown = (e: KeyboardEvent, opts: { typeahead?: boolean } = {}) => {
    const n = texts.length
    if (!n) return
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => step(Math.min(a, n - 1), 1)); return
      case 'ArrowUp': e.preventDefault(); setActive((a) => step(Math.min(a, n - 1), -1)); return
      case 'Home': if (opts.typeahead === false) return; e.preventDefault(); setActive(step(-1 + n, 1) % n); return
      case 'End': if (opts.typeahead === false) return; e.preventDefault(); setActive(step(0, -1)); return
      case 'Enter': e.preventDefault(); if (!disabled(active) && active < n) onPick(active); return
    }
    if (opts.typeahead !== false && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now()
      const t = now - typed.current.at < 600 ? typed.current.text + e.key.toLowerCase() : e.key.toLowerCase()
      typed.current = { text: t, at: now }
      for (let k = t.length > 1 ? 0 : 1; k <= n; k++) {
        const i = (active + k) % n
        if (!disabled(i) && texts[i].toLowerCase().startsWith(t)) { setActive(i); break }
      }
    }
  }

  return { active, setActive, onKeyDown }
}
