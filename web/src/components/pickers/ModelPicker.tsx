import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, RefreshCw } from 'lucide-react'
import { useFeature, useStore } from '../../store'
import { api, errorText } from '../../api'
import { relTime } from '../../lib/format'
import { FULL_ACCESS, GRADES, loadAgentMeta, loadSettings, modeShort, modelLabel, normModels, useAgentMeta, useSettings } from '../../lib/agents'
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
  /** Opens when a 'harness:pick-model' event carries this key (the chat's session id). */
  openKey?: string
  disabled?: boolean
}

/**
 * Orca-style model picker: search, the agent's catalog (label, context, grade), models seen in past
 * sessions, «Использовать "…"» when nothing matches, and the approval mode as a footer.
 */
export function ModelPicker({ agentId, value, onChange, mode, onMode, variant = 'inline', label, placement = 'top-end', allowDefault = true, emptyText = 'по умолчанию', disabled, openKey }: Props) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!openKey) return
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail === openKey) setOpen(true) }
    window.addEventListener('harness:pick-model', on)
    return () => window.removeEventListener('harness:pick-model', on)
  }, [openKey])
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
    // Unavailable models stay selectable (the catalogue may be stale) but sink to the end, greyed.
    for (const m of [...catalog].sort((x, y) => Number(x.available === false) - Number(y.available === false))) {
      const g = gradeOf(m.id)
      const off = m.available === false
      const sub = [off && 'недоступна', m.context && `контекст ${m.context}`, g.length && `уровень: ${g.join(', ')}`, m.description].filter(Boolean).join(' · ')
      out.push({ key: m.id, text: `${m.label ?? ''} ${m.id}`, group: 'Модели', node: <span className="model-row" data-off={off || undefined}>{row(m.label ?? m.id, sub || m.id, value === m.id)}</span>, onSelect: () => pick(m.id) })
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
          footer={<>
            <CatalogRefresh agentId={agentId} />
            {onMode && modes.length > 0 && (
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
            )}
          </>}
        />
      </Popover>
    </>
  )
}

/** «Обновить список · обновлено 3 ч назад»: re-discover the CLI's models; errors stay inline. */
function CatalogRefresh({ agentId }: { agentId: string }) {
  const meta = useAgentMeta(agentId)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const on = useFeature('models-refresh')
  if (!on || !meta || meta.catalog === undefined) return null // this server does not discover models
  const refresh = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ error?: string | null }>('POST', `/agents/${encodeURIComponent(agentId)}/models/refresh`)
      if (r?.error) setErr(r.error)
      loadAgentMeta(agentId, true)
      void loadSettings(true)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const at = meta.catalog?.at
  return (
    <div className="picker-refresh">
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void refresh()}>
        <RefreshCw className={busy ? 'spinner' : undefined} />
        Обновить список
      </button>
      <span className="muted">{busy ? 'спрашиваем CLI…' : at ? `обновлено ${relTime(at)} назад` : 'ещё не обновлялся'}</span>
      {(err || meta.catalog?.error) && <span className="field-error">{err ?? meta.catalog?.error}</span>}
    </div>
  )
}
