import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Check, ChevronRight, SlidersHorizontal } from 'lucide-react'
import { loadDraft, saveDraft } from '../lib/draft'
import { DEFAULT_PREFS, hidesSomething, isDefault, type ProjectOrder, type SbPrefs, type SortBy } from '../lib/sidebarPrefs'
import type { Workspace } from '../types'
import { Button, Checkbox, Popover, Segmented, Switch } from './ui'

// Per browser (localStorage via draft.ts, try/catch inside), applied at once.
let prefs: SbPrefs = { ...DEFAULT_PREFS, ...loadDraft<Partial<SbPrefs>>('sb:prefs') }
const subs = new Set<() => void>()

export function setSbPrefs(patch: Partial<SbPrefs>) {
  prefs = { ...prefs, ...patch }
  saveDraft('sb:prefs', prefs)
  for (const f of subs) f()
}

export const useSbPrefs = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => prefs)

const SORT: [SortBy, string][] = [['activity', 'Активность агентов'], ['name', 'Имя'], ['new', 'Новые'], ['changes', 'Изменения']]
const ORDER: [ProjectOrder, string][] = [['manual', 'Вручную'], ['alpha', 'По алфавиту'], ['activity', 'По активности']]
const AGES: [number, string][] = [[0, "Не скрывать"], [1 / 24, "1 часа"], [3 / 24, "3 часов"], [6 / 24, "6 часов"], [12 / 24, "12 часов"], [1, "1 дня"], [3, "3 дней"], [7, "7 дней"], [14, "14 дней"], [30, "30 дней"]]
const FILTERS: [keyof SbPrefs, string][] = [
  ['hideSleeping', 'Скрыть спящие рабочие пространства'],
  ['hideMain', 'Скрыть основную ветку'],
  ['hideAgentMade', 'Скрыть созданные агентами'],
  ['hideExternal', 'Скрыть созданные вне harness (CLI)'],
  ['hideDetached', 'Скрыть с отсоединённым HEAD'],
  ['hideEmpty', 'Скрыть без сессий и изменений'],
]

/** «Параметры рабочих пространств»: the sliders button in the «Проекты» header and its popover (like Orca's). */
export function WorkspaceParams({ projects }: { projects: Workspace[] }) {
  const p = useSbPrefs()
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<string | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const hidden = p.hiddenProjects.filter((id) => projects.some((w) => w.id === id)).length
  const toggle = (k: keyof SbPrefs) => (v: boolean) => setSbPrefs({ [k]: v })
  const close = () => { setOpen(false); setSub(null) }
  return (
    <>
      <button ref={btn} type="button" className="icon-btn icon-btn-sm sb-params" aria-label="Параметры рабочих пространств" data-tip="Параметры рабочих пространств"
        aria-expanded={open} data-dot={hidesSomething(p) || undefined} onClick={() => (open ? close() : setOpen(true))}>
        <SlidersHorizontal />
      </button>
      {/* closed: nothing built (the sidebar re-renders on every agent event) */}
      {open && <Popover anchor={btn} open={open} onClose={close} placement="right-start" label="Параметры рабочих пространств" className="sbp">
        {/* a press elsewhere in the panel closes an open submenu (the submenus are portaled, but React events bubble here) */}
        <div onPointerDown={(e) => { if (!(e.target as Element).closest('.sbp-sub, .sbp-row[aria-expanded="true"]')) setSub(null) }}>
          <div className="sbp-title">Параметры рабочих пространств</div>
          <div className="sbp-sec">Показать</div>
          <Sub id="projects" label="Проекты" value={hidden ? `${projects.length - hidden} из ${projects.length}` : 'Все'} sub={sub} setSub={setSub}>
            <Radio checked={!hidden} onSelect={() => setSbPrefs({ hiddenProjects: [] })}>Все проекты</Radio>
            <div className="sbp-list">
              {projects.map((w) => (
                <Checkbox key={w.id} checked={!p.hiddenProjects.includes(w.id)}
                  onChange={(v) => setSbPrefs({ hiddenProjects: v ? p.hiddenProjects.filter((x) => x !== w.id) : [...p.hiddenProjects, w.id] })}>
                  {w.name}
                </Checkbox>
              ))}
            </div>
          </Sub>
          <SwitchRow label="Папки" hint="«Все проекты» и простые папки" checked={p.folders} onChange={toggle('folders')} />
          <SwitchRow label="Чаты из CLI" hint="Сессии, начатые в GigaCode CLI" checked={p.showCli} onChange={toggle('showCli')} />
          <div className="sbp-sec">Группировать по</div>
          <div className="sbp-seg">
            <Segmented size="sm" label="Группировать по" value={p.group} onChange={(group) => setSbPrefs({ group })}
              options={[{ value: 'none', label: 'Нет' }, { value: 'status', label: 'Статус' }, { value: 'pr', label: 'PR' }, { value: 'project', label: 'Проект' }]} />
          </div>
          <Sub id="sort" label="Сортировать по" value={SORT.find(([v]) => v === p.sort)?.[1]} sub={sub} setSub={setSub}>
            {SORT.map(([v, label]) => <Radio key={v} checked={p.sort === v} onSelect={() => setSbPrefs({ sort: v })}>{label}</Radio>)}
          </Sub>
          <Sub id="order" label="Порядок проектов" value={ORDER.find(([v]) => v === p.order)?.[1]} sub={sub} setSub={setSub}>
            {ORDER.map(([v, label]) => <Radio key={v} checked={p.order === v} onSelect={() => setSbPrefs({ order: v })}>{label}</Radio>)}
            {p.order === 'manual' && <p className="sbp-hint">Перетащите проект в боковой панели или нажмите Alt+↑ / Alt+↓ на нём.</p>}
          </Sub>
          <Sub id="cards" label="Отображение карточек" value={p.cards === 'compact' ? 'Компактно' : 'Подробно'} sub={sub} setSub={setSub}>
            <Radio checked={p.cards === 'compact'} onSelect={() => setSbPrefs({ cards: 'compact' })}>Компактно</Radio>
            <Radio checked={p.cards === 'detailed'} onSelect={() => setSbPrefs({ cards: 'detailed' })}>Подробно</Radio>
            <div className="sbp-div" />
            <SwitchRow label="Строка действия" checked={p.showAction} onChange={toggle('showAction')} />
            <SwitchRow label="Модель" checked={p.showModel} onChange={toggle('showModel')} />
            <SwitchRow label="Время" checked={p.showTime} onChange={toggle('showTime')} />
          </Sub>
          <div className="sbp-sec">Фильтры</div>
          <Sub id="age" label="Скрывать чаты старше" value={AGES.find(([v]) => v === p.chatsMaxAgeDays)?.[1] ?? `${p.chatsMaxAgeDays} дн.`} sub={sub} setSub={setSub}>
            {AGES.map(([v, label]) => <Radio key={v} checked={p.chatsMaxAgeDays === v} onSelect={() => setSbPrefs({ chatsMaxAgeDays: v })}>{label}</Radio>)}
            <p className="sbp-hint">По последней активности. Открытый чат и те, что работают или ждут вас, видны всегда.</p>
          </Sub>
          {FILTERS.map(([k, label]) => <SwitchRow key={k} label={label} checked={!!p[k]} onChange={toggle(k)} />)}
          <p className="sbp-hint">Чаты, которые ждут вас, видны всегда — в «Ждут вас».</p>
          <div className="sbp-foot">
            <Button size="sm" variant="ghost" disabled={isDefault(p)} onClick={() => setSbPrefs({ ...DEFAULT_PREFS, projectOrder: p.projectOrder })}>Сбросить</Button>
          </div>
        </div>
      </Popover>}
    </>
  )
}

/** A row «label · value ›» opening its own panel beside the popover. */
function Sub({ id, label, value, sub, setSub, children }: { id: string; label: string; value?: string; sub: string | null; setSub: (v: string | null) => void; children: ReactNode }) {
  const row = useRef<HTMLButtonElement>(null)
  const open = sub === id
  return (
    <>
      <button ref={row} type="button" className="sbp-row" aria-haspopup="dialog" aria-expanded={open} onClick={() => setSub(open ? null : id)}>
        <span className="grow">{label}</span>
        {value && <span className="muted">{value}</span>}
        <ChevronRight aria-hidden />
      </button>
      <Popover anchor={row} open={open} onClose={() => setSub(null)} placement="right-start" label={label} className="sbp sbp-sub">
        <div role="group" aria-label={label}>{children}</div>
      </Popover>
    </>
  )
}

function Radio({ checked, onSelect, children }: { checked: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="sbp-row" onClick={onSelect}>
      <span className="sbp-check" aria-hidden>{checked && <Check />}</span>
      <span className="grow">{children}</span>
    </button>
  )
}

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="sbp-row sbp-switch" data-tip={hint}>
      <span className="grow">{label}</span>
      <Switch label={label} checked={checked} onChange={onChange} />
    </label>
  )
}
