import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, LoaderCircle, RefreshCw } from 'lucide-react'
import { openScreen, useFeature, useStore } from '../../store'
import { api, errorText } from '../../api'
import { ago } from '../../lib/format'
import { GRADES, loadAgentMeta, loadSettings, modelLabel, sameModel, useAgentMeta, useSettings } from '../../lib/agents'
import { pickerModels } from '../../lib/models'
import { useElapsed } from '../../lib/live'
import { ComboList, Popover, type ComboItem, type Placement } from '../ui'

interface Props {
  agentId: string
  /** Selected model id; null = the agent's default. */
  value: string | null
  onChange: (id: string | null) => void
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
 * Orca-style model picker: search, every model of the agent's catalogue (label, context, grade, availability),
 * models seen in past sessions, «Использовать "…"» when nothing matches, and the catalogue refresh. The approval mode
 * has its own chip in the composer.
 */
export function ModelPicker({ agentId, value, onChange, variant = 'inline', label, placement = 'top-end', allowDefault = true, emptyText = 'по умолчанию', disabled, openKey }: Props) {
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
  // The live catalogue (/api/state) is the list; settings only add labels. A short settings list must not hide models.
  const catalog = useMemo(() => pickerModels(agent?.models, conf?.models), [conf?.models, agent?.models])
  const grades = conf?.modelGrades ?? {}
  const fallback = conf?.model ?? grades.default ?? null

  const pick = (id: string | null) => {
    setOpen(false)
    btn.current?.focus({ preventScroll: true })
    if (id !== value) onChange(id)
  }

  const items = useMemo<ComboItem[]>(() => {
    const gradeOf = (id: string) => GRADES.filter((g) => sameModel(grades[g], id))
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
    // Unavailable models stay selectable (the catalogue may be stale) but sit at the end, greyed; unchecked ones say so.
    for (const m of catalog) {
      const g = gradeOf(m.id)
      const off = m.available === false
      const sub = [off ? 'недоступна' : m.available == null && 'не проверено', m.context && `контекст ${m.context}`, g.length && `уровень: ${g.join(', ')}`, m.description].filter(Boolean).join(' · ')
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
          footer={<CatalogRefresh agentId={agentId} />}
        />
      </Popover>
    </>
  )
}

/**
 * The catalogue refresh, with a state you can read: idle «Обновить список · обновлено 5 мин назад»; running «Спрашиваем
 * GigaCode… 12 с»; failed «Не удалось получить список: …» + «Повторить»; a CLI that cannot start points to Settings.
 */
function CatalogRefresh({ agentId }: { agentId: string }) {
  const meta = useAgentMeta(agentId)
  const label = useStore((s) => s.agents.find((a) => a.id === agentId)?.label ?? agentId)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const on = useFeature('models-refresh')
  const running = busy || !!meta?.catalog?.running
  const [since, setSince] = useState(0)
  if (running && !since) setSince(Date.now())
  if (!running && since) setSince(0)
  const elapsed = useElapsed(since, running)
  // The server is still asking the CLI (another refresh, startup discovery): follow it until it answers.
  useEffect(() => {
    if (!meta?.catalog?.running || busy) return
    const t = window.setInterval(() => loadAgentMeta(agentId, true), 2000)
    return () => window.clearInterval(t)
  }, [meta?.catalog?.running, busy, agentId])
  if (!on || !meta || meta.catalog === undefined) return null // this server does not discover models
  if (!meta.resolved.ok) {
    return (
      <div className="picker-refresh" data-state="broken">
        <span>CLI не запускается — см. <button type="button" className="link" onClick={() => openScreen('settings')}>Настройки → {label}</button></span>
      </div>
    )
  }
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
  const error = err ?? meta.catalog?.error ?? null
  const at = meta.catalog?.at
  if (running) {
    return (
      <div className="picker-refresh" data-state="running" role="status">
        <LoaderCircle className="spinner" aria-hidden />
        <span>Спрашиваем {label}…{elapsed > 0 && <span className="num"> {elapsed} с</span>}</span>
      </div>
    )
  }
  if (error) {
    return (
      // a list from before is still there: not an alarm, just «not refreshed» (the reason on hover)
      <div className="picker-refresh" data-state={at ? undefined : 'error'} role={at ? 'status' : 'alert'}>
        {at ? <span className="muted" data-tip={error}>Список не обновился — показан прошлый</span>
          : <span className="picker-refresh-error">Не удалось получить список: {error}</span>}
        <button type="button" className="btn btn-sm" onClick={() => void refresh()}><RefreshCw />Повторить</button>
      </div>
    )
  }
  return (
    <div className="picker-refresh">
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()}>
        <RefreshCw />
        Обновить список
      </button>
      <span className="muted">{!at ? 'ещё не обновлялся' : `обновлено ${ago(at)}`}</span>
    </div>
  )
}
