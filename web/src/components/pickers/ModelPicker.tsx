import { useMemo, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useStore } from '../../store'
import { FULL_ACCESS, GRADES, modeShort, modelLabel, normModels, useAgentMeta, useSettings } from '../../lib/agents'
import { ComboList, Popover, Segmented, type ComboItem, type Placement } from '../ui'

interface Props {
  agentId: string
  /** Selected model id; null = the agent's default. */
  value: string | null
  onChange: (id: string | null) => void
  /** Approval mode footer (composer): current mode and setter. */
  mode?: string | null
  onMode?: (m: string) => void
  /** 'inline' = quiet label in the composer bar, 'field' = select-like trigger (settings). */
  variant?: 'inline' | 'field'
  label: string
  placement?: Placement
  /** Offer «По умолчанию агента» (null). */
  allowDefault?: boolean
  /** Text for the empty/default state of the trigger. */
  emptyText?: string
  disabled?: boolean
}

/**
 * Orca-style model picker: search, the agent's catalog (label, context, grade), models seen in past
 * sessions, «Использовать "…"» when nothing matches, and the approval mode as a footer.
 */
export function ModelPicker({ agentId, value, onChange, mode, onMode, variant = 'inline', label, placement = 'top-end', allowDefault = true, emptyText = 'по умолчанию', disabled }: Props) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId))
  const settings = useSettings()
  const meta = useAgentMeta(open ? agentId : null)
  const conf = settings?.agents[agentId]
  const catalog = useMemo(() => normModels(conf?.models ?? agent?.models), [conf?.models, agent?.models])
  const grades = conf?.modelGrades ?? {}
  const modeLabels = conf?.approvalModeLabels ?? agent?.approvalModeLabels ?? {}
  const modes = agent?.approvalModes ?? conf?.approvalModes ?? []
  const fallback = conf?.model ?? grades.default ?? null

  const pick = (id: string | null) => {
    setOpen(false)
    btn.current?.focus({ preventScroll: true })
    if (id !== value) onChange(id)
  }

  const items = useMemo<ComboItem[]>(() => {
    const gradeOf = (id: string) => GRADES.filter((g) => grades[g] === id)
    const row = (title: string, sub: string, selected: boolean, mono = false) => (
      <>
        <span className="option-main">
          <span className="option-label model-name" data-mono={mono || undefined}>{title}</span>
          {sub && <span className="option-hint">{sub}</span>}
        </span>
        {selected && <Check className="option-check" aria-hidden />}
      </>
    )
    const out: ComboItem[] = []
    if (allowDefault) {
      out.push({
        key: '__default', text: 'по умолчанию агента', group: undefined,
        node: row('По умолчанию агента', fallback ? modelLabel(fallback, catalog) : 'модель из настроек CLI', value === null),
        onSelect: () => pick(null),
      })
    }
    for (const m of catalog) {
      const g = gradeOf(m.id)
      const sub = [m.context && `контекст ${m.context}`, g.length && `уровень: ${g.join(', ')}`, m.description].filter(Boolean).join(' · ')
      out.push({ key: m.id, text: `${m.label ?? ''} ${m.id}`, group: 'Модели', node: row(m.label ?? m.id, sub || m.id, value === m.id), onSelect: () => pick(m.id) })
    }
    for (const id of meta?.seen?.models ?? []) {
      if (catalog.some((m) => m.id === id)) continue
      out.push({ key: `seen:${id}`, text: id, group: 'Встречались в сессиях', node: row(id, '', value === id, true), onSelect: () => pick(id) })
    }
    if (value && !out.some((i) => i.key === value || i.key === `seen:${value}`)) {
      out.push({ key: `cur:${value}`, text: value, group: 'Сейчас', node: row(value, 'указана вручную', true, true), onSelect: () => pick(value) })
    }
    return out
  }, [catalog, conf, meta, value, allowDefault, fallback])

  const extra = (q: string, matched: ComboItem[]): ComboItem[] =>
    q && !matched.some((m) => m.text.toLowerCase().split(' ').includes(q.toLowerCase()))
      ? [{ key: `use:${q}`, text: q, node: <span className="option-main"><span className="option-label">Использовать «<span className="mono">{q}</span>»</span></span>, onSelect: () => pick(q) }]
      : []

  const current = value ? modelLabel(value, catalog) : fallback ? modelLabel(fallback, catalog) : emptyText
  const isDefault = !value

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={variant === 'field' ? 'select-trigger model-trigger' : 'model-chip'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current}`}
        data-tip={open || variant === 'field' ? undefined : label}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span className="select-value" data-default={isDefault || undefined}>{current}</span>
        <ChevronDown className="select-chev" aria-hidden />
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} placement={placement} className="picker" role="presentation">
        <ComboList
          items={items}
          extra={extra}
          placeholder="Найти модель…"
          label="Модели"
          empty="Нет моделей в каталоге агента"
          footer={onMode && modes.length > 0 ? (
            <div className="picker-mode">
              <span className="picker-mode-label">Режим</span>
              <Segmented
                size="sm"
                label="Режим подтверждений"
                value={mode ?? ''}
                onChange={(m) => onMode(m)}
                options={modes.map((m) => ({ value: m, label: modeShort(m), hint: modeLabels[m] ?? m, tone: FULL_ACCESS.has(m) ? 'access' : undefined }))}
              />
              {mode && modeLabels[mode] && <span className="picker-mode-hint">{modeLabels[mode]}</span>}
            </div>
          ) : undefined}
        />
      </Popover>
    </>
  )
}
