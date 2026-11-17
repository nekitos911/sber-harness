import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { useListNav } from './listNav'

export interface ComboItem {
  key: string
  /** Text matched by the search and used for typeahead. */
  text: string
  group?: string
  disabled?: boolean
  node: ReactNode
  onSelect: () => void
}

interface Props {
  items: ComboItem[]
  placeholder: string
  label: string
  /** Items appended after filtering (e.g. «Использовать "<query>"», «Создать ветку <query>»). */
  extra?: (query: string, matched: ComboItem[]) => ComboItem[]
  empty?: ReactNode
  footer?: ReactNode
  /** Rendered above the list (inline errors). */
  notice?: ReactNode
}

/** Search field + listbox: typing filters, arrows move, Enter picks (focus stays in the field). */
export function ComboList({ items, placeholder, label, extra, empty = 'Ничего не найдено', footer, notice }: Props) {
  const [q, setQ] = useState('')
  const id = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    const matched = n ? items.filter((i) => i.text.toLowerCase().includes(n)) : items
    return [...matched, ...(extra?.(q.trim(), matched) ?? [])]
  }, [items, q, extra])
  const firstEnabled = Math.max(0, shown.findIndex((i) => !i.disabled))
  const nav = useListNav(shown.map((i) => i.text), (i) => !!shown[i]?.disabled, (i) => shown[i]?.onSelect(), firstEnabled)

  useEffect(() => { nav.setActive(firstEnabled) }, [q]) // the best match leads after every keystroke
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${nav.active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [nav.active])

  let lastGroup: string | undefined
  return (
    <div className="combo">
      <div className="combo-search">
        <Search aria-hidden />
        <input
          className="combo-input"
          role="combobox"
          aria-expanded
          aria-controls={id}
          aria-activedescendant={shown.length ? `${id}-${nav.active}` : undefined}
          aria-label={label}
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => nav.onKeyDown(e, { typeahead: false })}
        />
      </div>
      {notice}
      <div className="combo-list" role="listbox" id={id} aria-label={label} ref={listRef}>
        {shown.map((it, i) => {
          const head = it.group && it.group !== lastGroup ? it.group : null
          lastGroup = it.group
          return (
            <div key={it.key} role="presentation">
              {head && <div className="combo-group" role="presentation">{head}</div>}
              <div
                id={`${id}-${i}`}
                data-i={i}
                role="option"
                aria-selected={i === nav.active}
                aria-disabled={it.disabled || undefined}
                className="option"
                data-active={i === nav.active || undefined}
                onPointerMove={() => { if (!it.disabled && nav.active !== i) nav.setActive(i) }}
                onClick={() => { if (!it.disabled) it.onSelect() }}
              >
                {it.node}
              </div>
            </div>
          )
        })}
        {!shown.length && <div className="option-empty">{empty}</div>}
      </div>
      {footer && <div className="combo-footer">{footer}</div>}
    </div>
  )
}
