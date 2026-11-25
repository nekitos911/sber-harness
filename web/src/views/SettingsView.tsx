import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChipsInput } from '../components/ChipsInput'
import { DEFAULT_REWORK } from '../components/board/Rework'
import { FolderPicker } from '../components/FolderPicker'
import { ArrowDown, ArrowUp, Bot, Cable, Check, CircleCheck, Pencil, CircleX, LogIn, PanelsTopLeft, Plus, RefreshCw, Search, SquareKanban, TriangleAlert, X } from 'lucide-react'
import { api, ApiError, errorText, qs, tryApi } from '../api'
import { openScreen, setState, toast, useFeature, useStore } from '../store'
import { adoptSession } from '../lib/actions'
import { desktopNotifyOn, setDesktopNotify } from '../lib/notify'
import { ago, COLUMNS, plural } from '../lib/format'
import { FULL_ACCESS, GRADE_ROLES, GRADES, mainAgent, loadAgentMeta, loadSettings, modeShort, normMeta, sameModel, useAgentMeta } from '../lib/agents'
import { pickerModels } from '../lib/models'
import { useNow } from '../lib/useNow'
import { isMac, modKey, shortcut } from '../lib/keys'
import type { AgentSettings, BoardColumn, BoardSettings, GitBranches, Grade, Session, Settings, TaskStatus } from '../types'
import { Skeleton } from '../components/bits'
import { ModelPicker } from '../components/pickers/ModelPicker'
import { Connections } from '../components/Connections'
import { IntegrationStatus, useIntegrationsCheck } from '../components/IntegrationStatus'
import { Button, Chip, Disclosure, IconButton, Input, Segmented, Select, SuggestInput, Switch, Textarea } from '../components/ui'

const MAIN = 'gigacode'
// `name` is the store id (StatusBar and lib/pr open «Подключения» by it); `label` is what the nav says
const CATEGORIES = [
  { name: 'Рабочее место', label: 'Основные', Icon: PanelsTopLeft }, { name: 'Агенты', label: 'Агенты', Icon: Bot },
  { name: 'Подключения', label: 'Подключения', Icon: Cable }, { name: 'Доска и Git', label: 'Доска и Git', Icon: SquareKanban },
] as const
const VARS = ['{taskUrl}', '{notes}', '{key}', '{title}', '{description}', '{targets}', '{branch}', '{repo}']
const TIMEOUTS = [60, 120, 180, 300]
const SYNC = [{ v: 0, l: 'выключено' }, { v: 60, l: 'каждую минуту' }, { v: 300, l: 'каждые 5 мин' }, { v: 900, l: 'каждые 15 мин' }, { v: 1800, l: 'каждые 30 мин' }]
const CUSTOM = '__custom'

const GIT_TEMPLATES: { key: Exclude<keyof Settings['git'], 'generateMessages' | 'via'>; label: string; presets: string[]; hint: string }[] = [
  { key: 'branchTemplate', label: 'Ветка задачи', presets: ['feature/{key}', 'bugfix/{key}', 'hotfix/{key}'], hint: 'Создаётся при «Взять в работу».' },
  { key: 'portBranchTemplate', label: 'Ветка портирования', presets: ['{branch}-{targetSlug}', '{branch}-{target}'], hint: 'Для cherry-pick в дополнительные целевые ветки.' },
  { key: 'commitTitleTemplate', label: 'Заголовок коммита', presets: ['{key} {title}', '{key}: {title}'], hint: 'Подставляется в поле коммита, его можно поправить.' },
  { key: 'prTitleTemplate', label: 'Заголовок PR', presets: ['{key} {title}', '{key}: {title}'], hint: 'Подставляется в диалог PR.' },
]

/** Sample task for template previews. */
const SAMPLE = { key: 'PROJ-1234', title: 'Пример задачи', target: 'release/1.54.0', branch: 'feature/PROJ-1234' }
const slug = (t: string) => { const m = /(\d+)\.(\d+)/.exec(t); return m ? `rel${m[1]}${m[2]}` : t.replace(/[^\w.-]+/g, '-') }
const render = (tpl: string) => tpl
  .replaceAll('{key}', SAMPLE.key).replaceAll('{title}', SAMPLE.title).replaceAll('{branch}', SAMPLE.branch)
  .replaceAll('{targetSlug}', slug(SAMPLE.target)).replaceAll('{target}', SAMPLE.target).replaceAll('{id}', 'T-12')

function changedFields(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(b)) {
    if (JSON.stringify(a[key]) === JSON.stringify(value)) continue
    // Settings maps (grades, columns, project commands) are submitted as a unit.
    patch[key] = value
  }
  return patch
}

function settingsPatch(before: Settings, after: Settings) {
  const patch = changedFields({ ...before }, { ...after })
  if (patch.agents) {
    patch.agents = Object.fromEntries(Object.entries(after.agents)
      .filter(([id, agent]) => JSON.stringify(agent) !== JSON.stringify(before.agents[id]))
      .map(([id, agent]) => [id, changedFields({ ...before.agents[id] }, { ...agent })]))
  }
  return patch
}

/** Which field a server validation error is about (shown next to that field). */
const FIELD_HINTS: [RegExp, string][] = [
  [/approvalMode/i, 'mode'], [/taskPromptTemplate|template/i, 'command'], [/refreshSec/i, 'sync'],
  [/urlTemplate/i, 'url'], [/space/i, 'space'], [/defaultBase/i, 'base'], [/branchTemplate|portBranch|TitleTemplate/i, 'git'],
]

export function SettingsView() {
  const labels = useStore((s) => s.agents)
  const category = useStore((s) => s.settingsCategory)
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => { scroll.current?.scrollTo(0, 0) }, [category])
  const conn = useStore((s) => s.conn)
  const [orig, setOrig] = useState<Settings | null>(null)
  const [form, setForm] = useState<Settings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<{ field: string | null; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const changes = useMemo(() => !!orig && !!form && JSON.stringify(orig) !== JSON.stringify(form), [orig, form])
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!modKey(e) || e.code !== 'KeyF' || e.shiftKey || e.altKey) return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const found = useSettingsFilter(scroll, q)
  const nav = useSectionNav(scroll, `${category}|${q}|${!!form}`)

  useEffect(() => {
    if (conn !== 'open' || changes) return
    api<Settings>('GET', '/settings').then(
      (s) => { setOrig(s); setForm(structuredClone(s)); setLoadError(null); setState({ settings: s }) },
      (e) => setLoadError(e instanceof ApiError && e.status === 404 ? 'Этот сервер ещё не умеет редактировать настройки из интерфейса. Обновите harness или правьте harness.config.local.json.' : errorText(e)),
    )
  }, [conn])

  if (loadError) return <Shell><div className="empty"><h2>Настройки недоступны</h2><p>{loadError}</p></div></Shell>
  if (!form || !orig) return <Shell><div className="settings"><div className="settings-body"><Skeleton rows={10} label="Загрузка настроек…" /></div></div></Shell>

  const update = (next: Settings) => { setForm(next); setSaveError(null) }
  const save = async () => {
    setSaving(true)
    try {
      const saved = (await api<Settings>('PUT', '/settings', settingsPatch(orig, form))) ?? form
      setOrig(saved)
      setForm(structuredClone(saved))
      setState({ settings: saved, defaultAgent: saved.defaultAgent })
      setSaveError(null)
      toast('Настройки сохранены', 'ok')
    } catch (e) {
      const text = errorText(e)
      setSaveError({ field: FIELD_HINTS.find(([re]) => re.test(text))?.[1] ?? null, text })
    } finally {
      setSaving(false)
    }
  }
  const fieldError = (f: string) => (saveError?.field === f ? saveError.text : undefined)

  const main = mainAgent(form)
  const others = Object.keys(form.agents).filter((id) => id !== main && id !== 'claude')

  return (
    <Shell>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); if (changes) void save() }}>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Разделы настроек">
            <div className="settings-search">
              <Search aria-hidden />
              <input ref={searchRef} className="input" type="search" placeholder="Поиск настроек" aria-label="Поиск настроек" value={query}
                aria-keyshortcuts={isMac ? 'Meta+F' : 'Control+F'}
                onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery('') } }} />
              {!query && <kbd>{shortcut('F')}</kbd>}
            </div>
            {q ? (found ? nav.titles.map((t, i) => <SectionLink key={t + i} title={t} current={i === nav.current} onClick={() => nav.go(i)} />)
              : <p className="settings-nav-empty">Ничего не найдено</p>)
              : CATEGORIES.map(({ name, label, Icon }) => (
                <Fragment key={name}>
                  <button type="button" aria-current={category === name ? 'page' : undefined}
                    onClick={() => setState({ settingsCategory: name })}><Icon aria-hidden />{label}</button>
                  {category === name && nav.titles.length > 1 && nav.titles.map((t, i) => <SectionLink key={t + i} title={t} current={i === nav.current} onClick={() => nav.go(i)} />)}
                </Fragment>
              ))}
          </nav>
          <div ref={scroll} className="settings-body" id="settings-scroll">
            <Searching.Provider value={!!q}>
            {q && !found && <div className="empty settings-empty"><h2>Ничего не нашлось</h2><p>Нет настроек со словами «{query.trim()}». Попробуйте другое слово или очистите поиск клавишей Esc.</p></div>}
            {(q || category === 'Рабочее место') && <>
              <BasicSettings form={form} update={update} fieldError={fieldError} main={main} />
              <ChatsSection form={form} update={update} />
              <InterfaceSection />
            </>}
            {(q || category === 'Агенты') && <>
              {main && <AgentSection id={main} form={form} update={update} fieldError={fieldError} primary />}
              {others.length > 0 && <section className="settings-section">
                <h2>Другие агенты</h2>
                {others.map((id) => <Disclosure key={id} className="agent-options" open={q ? true : undefined} summary={labels.find((a) => a.id === id)?.label ?? id}>
                  <AgentSection id={id} form={form} update={update} fieldError={fieldError} />
                </Disclosure>)}
              </section>}
              <OrchestrationSection form={form} update={update} />
              {form.checks && <ChecksCard form={form} update={update} />}
            </>}
            {(q || category === 'Подключения') && <ConnectionsSection form={form} update={update} fieldError={fieldError} />}
            {(q || category === 'Доска и Git') && <>
              <BoardSection form={form} update={update} />
              <GitSection form={form} update={update} fieldError={fieldError} />
            </>}
            </Searching.Provider>
          </div>
        </div>
        {(changes || saveError) && (
          <div className="save-bar" role="region" aria-label="Несохранённые изменения">
            <span className="save-bar-count">
              {changes ? <>Есть несохранённые изменения</> : 'Не сохранено'}
            </span>
            {saveError && <span className="field-error" role="alert">{saveError.text}</span>}
            <span className="grow" />
            <Button onClick={() => { setForm(structuredClone(orig)); setSaveError(null) }} disabled={saving}>Отменить</Button>
            <Button type="submit" variant="primary" disabled={saving || !changes}>{saving ? 'Сохраняем…' : 'Сохранить'}</Button>
          </div>
        )}
      </form>
    </Shell>
  )
}

const Searching = createContext(false) // «Поиск настроек» is on: folded parts open, so their rows can match

function SectionLink({ title, current, onClick }: { title: string; current: boolean; onClick: () => void }) {
  return <button type="button" className="settings-nav-sub" aria-current={current ? 'location' : undefined} onClick={onClick}>{title}</button>
}

/** The visible sections (their h2) for the nav, the one at the top of the scroll, and a jump to one. */
function useSectionNav(body: RefObject<HTMLDivElement | null>, key: string) {
  const [titles, setTitles] = useState<string[]>([])
  const [current, setCurrent] = useState(0)
  const heads = () => [...(body.current?.querySelectorAll<HTMLElement>('.settings-section > h2') ?? [])]
    .filter((h) => !h.closest('.agent-options, [data-unmatched]'))
  // every render: sections come and go with the settings (a handful of nodes; an unchanged list does not re-render)
  useLayoutEffect(() => {
    const next = heads().map((h) => h.textContent ?? '')
    setTitles((t) => (t.join('\n') === next.join('\n') ? t : next))
  })
  useEffect(() => {
    const el = body.current
    if (!el) return
    const on = () => {
      const hs = heads()
      const top = el.getBoundingClientRect().top + 48
      let i = 0
      hs.forEach((h, j) => { if (h.parentElement!.getBoundingClientRect().top <= top) i = j })
      if (hs.length && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) i = hs.length - 1 // a short last section never reaches the top
      setCurrent(i)
    }
    on()
    el.addEventListener('scroll', on, { passive: true })
    return () => el.removeEventListener('scroll', on)
  }, [body, key]) // eslint-disable-line react-hooks/exhaustive-deps
  const go = (i: number) => heads()[i]?.parentElement?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  return { titles, current, go }
}

/**
 * «Поиск настроек»: rows whose label or hint has the words stay, the rest (and sections, cards, «Расширенные» left
 * empty) are hidden by a data attribute; a section whose title matches keeps all its rows. Whether anything matched.
 */
function useSettingsFilter(body: RefObject<HTMLDivElement | null>, q: string): boolean {
  const [found, setFound] = useState(true)
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    el.querySelectorAll('[data-unmatched]').forEach((n) => n.removeAttribute('data-unmatched'))
    if (!q) { setFound(true); return }
    const has = (n: Element | null | undefined) => !!n?.textContent?.toLowerCase().includes(q)
    const hide = (n: Element) => n.setAttribute('data-unmatched', '')
    let any = false
    for (const sec of el.querySelectorAll('.settings-section')) {
      if (sec.parentElement?.closest('.settings-section')) continue // another agent's section: rows of the outer one
      const head = has(sec.querySelector(':scope > h2'))
      const rows = [...sec.querySelectorAll('.set-row')]
      for (const r of rows) if (!head && !has(r.querySelector('.set-label'))) hide(r)
      const hit = rows.length ? head || rows.some((r) => !r.hasAttribute('data-unmatched')) : has(sec)
      if (hit) any = true; else hide(sec)
    }
    for (const r of el.querySelectorAll('.set-row')) {
      if (r.closest('.settings-section')) continue // rows between sections (MCP timeouts)
      if (has(r.querySelector('.set-label'))) any = true; else hide(r)
    }
    // boxes left with nothing in them
    for (const box of el.querySelectorAll('.set-rows, .set-card, .settings-adv, .agent-options')) {
      const rows = box.querySelectorAll('.set-row')
      if (rows.length && [...rows].every((r) => r.closest('[data-unmatched]'))) hide(box)
    }
    setFound(any)
  })
  return found
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="settings-view">
      <header className="view-head">
        <h1>Настройки</h1>
        <span className="grow" />
        <button type="button" className="link-btn" onClick={() => openScreen('setup')}>Мастер первого запуска</button>
      </header>
      {children}
    </div>
  )
}

function BasicSettings({ form, update, fieldError, main }: SectionProps & { main: string }) {
  const labels = useStore((s) => s.agents)
  const a = form.agents[main]
  const set = (patch: Partial<AgentSettings>) => update({ ...form, agents: { ...form.agents, [main]: { ...a, ...patch } } })
  const modeLabels = a?.approvalModeLabels ?? {}
  if (!a) return null
  return (
    <section className="settings-section settings-basic" id="set-basic">
      <h2>Агент</h2>
      {/* one card: the default-agent choice heads it, because it decides whose status, model and mode follow */}
      <div className="set-card">
        <div className="set-rows">
          <Row label="Агент по умолчанию" hint="С ним начинаются новые чаты и «Взять в работу». Ниже его настройки.">
            <Select label="Агент по умолчанию" value={form.defaultAgent === 'claude' ? '' : form.defaultAgent} placeholder="Выберите агента" onChange={(v) => update({ ...form, defaultAgent: v })}
              options={Object.keys(form.agents).filter((k) => k !== 'claude' && (form.agents[k].enabled !== false || k === form.defaultAgent))
                .map((k) => ({ value: k, label: labels.find((x) => x.id === k)?.label ?? k, hint: k }))} />
          </Row>
        </div>
        <AgentStatus id={main} />
        <div className="set-rows">
          <Row label="Модель">
            <ModelPicker variant="field" agentId={main} label="Модель по умолчанию" value={a.model} onChange={(m) => set({ model: m })} placement="bottom-start" emptyText="как в CLI" />
            <CatalogStatus id={main} />
          </Row>
          {a.approvalModes.length > 0 && (
            <Row label="Режим" hint={modeLabels[a.approvalMode ?? '']} error={fieldError('mode')} wide>
              <Segmented label="Режим подтверждений" value={a.approvalMode ?? ''} onChange={(m) => set({ approvalMode: m })}
                options={a.approvalModes.map((m) => ({ value: m, label: modeShort(m), tone: FULL_ACCESS.has(m) ? 'access' : undefined }))} />
            </Row>
          )}
        </div>
      </div>
    </section>
  )
}

function ConnectionsSection(props: SectionProps) {
  const check = useIntegrationsCheck()
  return <>
    <Connections onSaved={check.recheck} />
    {/* these two rows used to float between sections without a heading */}
    {props.form.mcp !== undefined && <section className="settings-section" id="set-mcp-wait">
      <h2>Ожидание MCP-серверов</h2>
      <McpTimeoutsRows form={props.form} update={props.update} />
    </section>}
    <TrackerSection {...props} check={check} />
    <PrSection {...props} check={check} />
  </>
}

/** ACP start: the agent waits for every MCP server it is given before it answers session/new; these are the limits. */
function McpTimeoutsRows({ form, update }: Omit<SectionProps, 'fieldError'>) {
  if (form.mcp === undefined) return null
  const mcp = form.mcp
  const set = (patch: Partial<NonNullable<Settings['mcp']>>) => update({ ...form, mcp: { ...mcp, ...patch } })
  const pick = (cur: number | undefined, preset: number[]) =>
    [...new Set([...preset, cur ?? 0])].filter((x) => x > 0).sort((a, b) => a - b)
      .map((x) => ({ value: String(x), label: x >= 60000 ? `${x / 60000} мин` : `${x / 1000} с` }))
  return (
    <div className="set-rows">
      <Row label="Процесс на чат: подъём MCP-сервера" hint="Сколько ждать один MCP-сервер при запуске процесса чата. Не дождавшись, агент работает без него и пишет предупреждение в чат; сессия не падает. Действует на новые сообщения.">
        <Select label="Подъём MCP-сервера на чат" value={String(mcp.acpStartTimeoutMs ?? 30000)} onChange={(v) => set({ acpStartTimeoutMs: Number(v) })}
          options={pick(mcp.acpStartTimeoutMs, [15000, 30000, 60000, 120000])} />
      </Row>
      <Row label="Сервер harness: ожидание инструмента" hint="Сколько CLI ждёт ответа инструмента harness (worker_run ждёт целый прогон субагента). Менять стоит, только если в чате появляется «MCP tool timeout».">
        <Select label="Ожидание инструмента harness" value={String(mcp.harnessTimeoutMs ?? 3600000)} onChange={(v) => set({ harnessTimeoutMs: Number(v) })}
          options={pick(mcp.harnessTimeoutMs, [600000, 1800000, 3600000])} />
      </Row>
    </div>
  )
}

function Row({ label, hint, error, children, wide }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="set-row" data-wide={wide || undefined}>
      <div className="set-label">
        <span>{label}</span>
        {hint && <span className="set-hint">{hint}</span>}
      </div>
      <div className="set-control">
        {children}
        {error && <span className="field-error" role="alert">{error}</span>}
      </div>
    </div>
  )
}

interface SectionProps { form: Settings; update: (s: Settings) => void; fieldError: (f: string) => string | undefined }

// ---------- agent (GigaCode first) ----------

function AgentSection({ id, form, update, fieldError, primary }: SectionProps & { id: string; primary?: boolean }) {
  const labels = useStore((s) => s.agents)
  const a = form.agents[id]
  const set = (patch: Partial<AgentSettings>) => update({ ...form, agents: { ...form.agents, [id]: { ...a, ...patch } } })
  const label = labels.find((x) => x.id === id)?.label ?? (id === MAIN ? 'GigaCode' : id)
  const modeLabels = a.approvalModeLabels ?? {}
  // the live catalogue of /api/state (what the CLI really knows) + the labels of the settings
  const live = useStore((s) => s.agents.find((x) => x.id === id)?.models)
  const catalog = useMemo(() => pickerModels(live, a.models), [live, a.models])
  const [gradesOpen, setGradesOpen] = useState(false)
  const acpOn = useFeature('acp')
  const reworkOn = useFeature('rework')
  const idOf = (m: string | undefined) => m ? catalog.find((x) => sameModel(x.id, m))?.id ?? m : undefined
  const gone = (m: string | undefined) => !!m && catalog.find((x) => sameModel(x.id, m))?.available === false

  return (
    <section className="settings-section" id={primary ? 'set-gigacode' : `set-${id}`}>
      {primary && <h2>{label}</h2>}
      {!primary && <div className="set-rows">
        <Row label="Модель по умолчанию" hint="Если пусто, модель выбирает сам CLI.">
          <ModelPicker variant="field" agentId={id} label="Модель по умолчанию" value={a.model} onChange={(m) => set({ model: m })} placement="bottom-start" emptyText="как в CLI" />
        </Row>
        {a.approvalModes.length > 0 && (
          <Row label="Режим подтверждений" hint={modeLabels[a.approvalMode ?? ''] ?? 'Что агенту можно делать без вопроса.'} error={fieldError('mode')} wide>
            <Segmented label="Режим подтверждений" value={a.approvalMode ?? ''} onChange={(m) => set({ approvalMode: m })}
              options={a.approvalModes.map((m) => ({ value: m, label: modeShort(m), hint: modeLabels[m] ?? m, tone: FULL_ACCESS.has(m) ? 'access' : undefined }))} />
          </Row>
        )}
      </div>}

      {primary && (
        <div className="set-rows">
          <Row label="Уровни моделей" hint="Какая модель стоит за каждым уровнем у внутренних агентов harness.">
            <AutoValue value={GRADES.filter((g) => a.modelGrades[g]).map((g) => `${g}: ${catalog.find((m) => sameModel(m.id, a.modelGrades[g]))?.label ?? a.modelGrades[g]}`).join(' · ') || 'как в CLI'}
              open={gradesOpen} onToggle={() => setGradesOpen(!gradesOpen)} />
          </Row>
        </div>
      )}
      {primary && gradesOpen && (
        <>
          <h3>Уровни моделей</h3>
          <p className="set-note">Субагенты просят модель по уровню; здесь задано, какая модель стоит за каждым. Без указанной модели harness берёт уровень по типу субагента: ревьюер review, разведка fast, остальные strong.</p>
          <div className="set-rows">
            {GRADES.map((g) => (
              <Row key={g} label={g} hint={GRADE_ROLES[g]} error={gone(a.modelGrades[g]) ? 'Модели нет в каталоге сервера: субагенты этого уровня запустятся с моделью по умолчанию' : undefined}>
                <ModelPicker variant="field" agentId={id} label={`Модель уровня ${g}`} value={a.modelGrades[g] ?? null} placement="bottom-start" emptyText="не задана"
                  onChange={(m) => { const grades = { ...a.modelGrades }; if (m) grades[g] = idOf(m)!; else delete grades[g]; set({ modelGrades: grades }) }} />
              </Row>
            ))}
            <Row label="Разрешённые уровни" hint="Какие уровни агенту можно запрашивать.">
              <div className="chips">
                {GRADES.map((g) => {
                  const on = a.allowedGrades.includes(g)
                  return <Chip key={g} pressed={on} onClick={() => set({ allowedGrades: on ? a.allowedGrades.filter((x) => x !== g) : [...a.allowedGrades, g] })}>{on && <Check aria-hidden />}{g}</Chip>
                })}
              </div>
            </Row>
          </div>
          {catalog.length > 0 && (
            <Disclosure className="settings-catalog" summary={<h3>Каталог моделей <span className="muted num">{catalog.length}</span></h3>}>
              <p className="set-note">Список приходит от CLI; здесь только подписи, которые видны в выборе модели.</p>
              <div className="catalog-list">
                {catalog.map((m, i) => (
                  <div key={m.id} className="catalog-row" data-off={m.available === false || undefined}>
                    <span className="mono ellipsis" data-tip={m.id}>{m.id}</span>
                    {m.context && <span className="muted">{m.context}</span>}
                    {m.available === false && <span className="field-warn">недоступна</span>}
                    <Input aria-label={`Подпись ${m.id}`} value={m.label ?? ''} placeholder={m.id}
                      onChange={(e) => set({ models: catalog.map((x, j) => (j === i ? { ...x, label: e.target.value || undefined } : x)) })} />
                  </div>
                ))}
              </div>
            </Disclosure>
          )}
        </>
      )}

      <div className="set-rows">
        <CommandRow id={id} a={a} set={set} error={fieldError('command')} />
        {primary && reworkOn && <ReworkRow a={a} set={set} />}
        {primary && acpOn && (
            <Row label="Запуск" hint={a.transport === 'acp' ? 'Один процесс на чат: быстрее, ждёт ваших разрешений. Экспериментально.' : 'Новый запуск на каждое сообщение, как gigacode -p.'}>
              <Segmented label="Как запускать агента" value={a.transport ?? 'headless'} onChange={(v) => set({ transport: v })}
                options={[{ value: 'headless', label: 'На каждое сообщение' }, { value: 'acp', label: 'Процесс на чат' }]} />
            </Row>
        )}
        {primary && acpOn && a.transport === 'acp' && (
          <Row label="Простой выгружает процесс через" hint="Неактивный чат освобождает память; следующее сообщение снова запустит процесс.">
            <Select label="Простой выгружает процесс через" value={!a.acpIdleMin ? 'never' : String(a.acpIdleMin)}
              onChange={(v) => set({ acpIdleMin: v === 'never' ? 0 : Number(v) })}
              options={[{ value: '15', label: '15 мин' }, { value: '30', label: '30 мин' }, { value: '60', label: '60 мин' }, { value: 'never', label: 'никогда' }]} />
          </Row>
        )}
        {primary && <McpServersRow id={id} a={a} set={set} />}
        {primary && a.allowedTools !== undefined && <AllowedToolsRow a={a} set={set} />}
        {primary && a.autoSandbox !== undefined && (
          <Row label="Песочница для «Полного доступа»"
            hint="Выключено (быстрее): «Полный доступ» работает как авто-правки без разрешающего списка, команды не спрашиваются. Включено: настоящий auto в песочнице рабочей папки GigaCode, запуск бывает медленнее.">
            <Switch label="Песочница для «Полного доступа»" checked={!!a.autoSandbox} onChange={(v) => set({ autoSandbox: v ? 'workspace' : null })} />
          </Row>
        )}
        {primary && form.permissions?.allowedToolsByWorkspace !== undefined && <ProjectToolsRow form={form} update={update} />}
      </div>
      <Advanced id={`agent-${id}`}>
      <div className="set-rows">
        {a.enabled !== undefined && (
          <Row label="Включён" hint="Выключенный агент не предлагается для новых чатов и задач.">
            <Switch label={`${label} включён`} checked={a.enabled !== false} onChange={(v) => set({ enabled: v })} />
          </Row>
        )}
        {a.firstEventTimeoutMs !== undefined && (
          <Row label="Таймаут запуска" hint="Сколько ждать первого ответа CLI (холодный старт с MCP занимает 30–60 с).">
            <Select label="Таймаут запуска" value={String(Math.round(a.firstEventTimeoutMs / 1000))} onChange={(v) => set({ firstEventTimeoutMs: Number(v) * 1000 })}
              options={[...new Set([...TIMEOUTS, Math.round(a.firstEventTimeoutMs / 1000)])].sort((x, y) => x - y).map((s) => ({ value: String(s), label: `${s} с` }))} />
          </Row>
        )}
        {a.inheritUserMcp !== undefined && (
          <Row label="Наследовать MCP пользователя" hint="Подключать к каждому запуску MCP-серверы из ~/.gigacode/settings.json, а не только серверы harness.">
            <Switch label="Наследовать MCP пользователя" checked={!!a.inheritUserMcp} onChange={(v) => set({ inheritUserMcp: v })} />
          </Row>
        )}
        {a.maxStarting !== undefined && (
          <Row label="Одновременных запусков" hint="Сколько процессов агента могут одновременно стартовать (загружать MCP). Работающих агентов это не ограничивает: следующий стартует, как только предыдущий ответил.">
            <Select label="Одновременных запусков" value={String(a.maxStarting)} onChange={(v) => set({ maxStarting: Number(v) })}
              options={[...new Set([1, 2, 3, 4, 6, 8, 12, 0, a.maxStarting])].map((n) => ({ value: String(n), label: n === 0 ? 'без предела' : String(n) }))} />
          </Row>
        )}
        {a.userHooks !== undefined && (
          <Row label="Хуки GigaCode" hint="Хуки из ~/.gigacode/settings.json в запусках харнесса. Выключите, если какой-то хук зависает и мешает ходам.">
            <Switch label="Хуки GigaCode" checked={a.userHooks !== false} onChange={(v) => set({ userHooks: v })} />
          </Row>
        )}
      </div>
      </Advanced>
    </section>
  )
}

/** Is the CLI there and signed in: one line; paths, commands and model names in agent files fold under «Подробнее». */
function AgentStatus({ id }: { id: string }) {
  const meta = useAgentMeta(id)
  const now = useNow()
  const [checking, setChecking] = useState(false)
  const [editPath, setEditPath] = useState(false)
  const agentLabel = useStore((s) => s.agents.find((agent) => agent.id === id)?.label ?? id)
  const login = async () => {
    const s = await tryApi<Session>('POST', '/sessions', { kind: 'terminal', agent: id, title: 'Вход в ' + agentLabel })
    if (s) adoptSession(s)
  }
  const recheck = async () => {
    setChecking(true)
    try {
      const m = await api<NonNullable<typeof meta>>('GET', `/agents/${encodeURIComponent(id)}/info`)
      setState((s) => ({ agentMeta: { ...s.agentMeta, [id]: normMeta(m) } }))
    } catch { /* keep the last answer */ }
    setChecking(false)
  }
  if (meta === undefined) return <div className="status-card"><Skeleton rows={2} label="Проверяем CLI…" /></div>
  if (meta === null) return <p className="set-note">Состояние CLI недоступно в этой версии сервера.</p>
  const r = meta.resolved
  const seen = meta.seen
  const signedIn = meta.auth === 'ok' || (meta.auth === undefined && r.identity)
  const needsLogin = meta.auth === 'required' || (meta.auth === undefined && !r.identity)
  const badRefs = meta.modelRefs?.filter((m) => m.available === false).length ?? 0
  const Ok = ({ ok }: { ok: boolean }) => (ok ? <CircleCheck className="ok" aria-label="да" /> : <CircleX className="bad" aria-label="нет" />)
  return (
    <div className="status-card" data-bad={!r.ok || undefined}>
      <div className="status-head status-auth">
        <Ok ok={r.ok} />
        <strong>{r.ok ? 'CLI найден' : 'CLI не найден'}</strong>
        {seen?.version && <span className="mono muted">v{seen.version}</span>}
        {r.ok && (signedIn ? <span className="muted">· вход выполнен</span>
          : needsLogin ? <><TriangleAlert className="warn" aria-hidden />нужен вход</>
            : <span className="muted">· вход проверится при первом запуске</span>)}
        {r.ok && !signedIn && <Button size="sm" variant={needsLogin ? undefined : 'ghost'} icon={<LogIn />} onClick={() => void login()}>Войти в {agentLabel}</Button>}
        <span className="grow" />
        {/* not found: the path field below has the one «Проверить» */}
        {r.ok && <Button size="sm" variant="ghost" icon={<RefreshCw className={checking ? 'spinner' : undefined} />} onClick={() => void recheck()} disabled={checking}>Проверить</Button>}
      </div>
      {!r.ok && <CliPathFix id={id} error={r.error ?? ''} onChecked={() => void recheck()} />}
      {/* not found: the path fix is the whole story — no details repeating the same error */}
      {r.ok && (
        <Disclosure summary={<span>Подробнее{badRefs > 0 && <span className="field-warn"> · {badRefs} {plural(badRefs, 'модель', 'модели', 'моделей')} в файлах агентов недоступны</span>}</span>}>
          <dl className="status-grid">
            {r.command && <><dt>Путь к CLI</dt><dd>{editPath ? <CliPathFix id={id} error="" initial={r.command} onChecked={() => { setEditPath(false); void recheck() }} /> : <AutoValue value={r.command} mono open={false} onToggle={() => setEditPath(true)} />}</dd></>}
            {r.node && <><dt>Node</dt><dd className="mono">{r.node}</dd></>}
            {r.entry && <><dt>Точка входа</dt><dd className="mono">{r.entry}</dd></>}
            {seen && <><dt>Команды</dt><dd>{seen.slashCommands.length ? `${seen.slashCommands.length} slash-команд` : <span className="muted">не сообщались</span>}</dd></>}
            {!!meta.modelRefs?.length && (
              <>
                <dt>Модели в агентах и командах</dt>
                <dd className="model-refs">
                  {meta.modelRefs.map((m) => (
                    <span key={`${m.file}:${m.model}`} className="model-ref" data-bad={m.available === false || undefined}>
                      {m.available === false ? <TriangleAlert className="warn" aria-hidden /> : <Ok ok />}
                      <span className="mono">{m.model}</span>
                      <span className="muted mono ellipsis" data-tip={m.file}>{m.file}</span>
                      {m.available === false && <span className="field-warn">недоступна: переименуйте модель в файле агента</span>}
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>
          {seen && <p className="set-note">По данным последней сессии, {ago(seen.at, now)}.</p>}
        </Disclosure>
      )}
    </div>
  )
}

/**
 * Where the model list comes from, under the model picker. A failed /models with a list to offer anyway (the config's
 * or the last one) is a calm note — the server tries again within the hour; red only when there is nothing to pick.
 */
function CatalogStatus({ id }: { id: string }) {
  const meta = useAgentMeta(id)
  const now = useNow()
  const refreshOn = useFeature('models-refresh')
  const [refreshing, setRefreshing] = useState(false)
  if (!meta?.resolved.ok) return null
  const c = meta.catalog
  const hasList = (meta.models?.length ?? 0) > 0
  const refresh = async () => {
    setRefreshing(true)
    const res = await tryApi<{ error?: string; timedOut?: boolean; models?: unknown[] }>('POST', `/agents/${encodeURIComponent(id)}/models/refresh`)
    setRefreshing(false)
    if (res?.error) toast(res.models?.length ? `Список моделей пока прежний: ${res.error}` : `Список моделей не обновлён: ${res.error}`, res.models?.length ? 'info' : 'error')
    loadAgentMeta(id, true)
    void loadSettings(true)
  }
  const from = c?.at ? `список от ${ago(c.at, now)}` : 'список из настроек'
  const text = refreshing || c?.running ? <span className="muted">список моделей обновляется…</span>
    : c?.error && hasList ? <span className="muted" data-tip={c.error}>{from}; {c.timedOut ? c.error : 'CLI не отдал список'}, повторим позже</span>
      : c?.error ? <span className="field-error">Список моделей не получен: {c.error}</span>
        : c?.at ? <span className="muted">список моделей обновлён {ago(c.at, now)}</span> : null
  if (!text && !refreshOn) return null
  return (
    <span className="status-auth set-hint">
      {text}
      {refreshOn && <Button size="sm" variant="ghost" icon={<RefreshCw className={refreshing ? 'spinner' : undefined} />} disabled={refreshing} onClick={() => void refresh()}>Обновить список</Button>}
    </span>
  )
}

/** Task command: a preset or a custom template with clickable variables; warns when the slash command is unknown. */
function CommandRow({ id, a, set, error }: { id: string; a: AgentSettings; set: (p: Partial<AgentSettings>) => void; error?: string }) {
  const meta = useAgentMeta(id)
  // /full-task-harness is superseded by automatic harness sub-agents; offered only when it is already chosen.
  const presets = (a.taskPromptPresets ?? []).filter((p) => !p.startsWith('/full-task-harness') || p === a.taskPromptTemplate)
  const value = a.taskPromptTemplate ?? ''
  const [custom, setCustom] = useState(!!value && !presets.includes(value))
  const area = useRef<HTMLTextAreaElement>(null)
  const known = meta?.seen?.slashCommands ?? []
  const cmd = /^\/([\w-]+)/.exec(value)?.[1]
  const unknown = cmd && known.length > 0 && !known.some((k) => k.replace(/^\//, '') === cmd)

  const insert = (v: string) => {
    const el = area.current
    const at = el ? el.selectionStart : value.length
    set({ taskPromptTemplate: value.slice(0, at) + v + value.slice(at) })
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + v.length, at + v.length) })
  }

  return (
    <Row label="Команда для задачи" hint="Первое сообщение агенту при «Взять в работу». Slash-команда работает только первым словом." error={error} wide>
      {presets.length > 0 && (
        <Select label="Команда для задачи" mono value={custom ? CUSTOM : value || CUSTOM}
          onChange={(v) => { if (v === CUSTOM) setCustom(true); else { setCustom(false); set({ taskPromptTemplate: v }) } }}
          options={[...presets.map((p) => ({ value: p, label: p.split('\n')[0], text: p, hint: PRESET_HINT[p.split(/\s/)[0]] })), { value: CUSTOM, label: 'Свой шаблон…', text: 'Свой шаблон' }]} />
      )}
      {(custom || !presets.length) && (
        <>
          <Textarea ref={area} mono rows={3} aria-label="Шаблон команды" placeholder="/full-task {taskUrl}{notes}" value={value} onChange={(e) => set({ taskPromptTemplate: e.target.value || null })} />
          <Disclosure summary="Вставить переменную"><div className="chips">
            {VARS.map((v) => <Chip key={v} mono onClick={() => insert(v)} tip="Вставить в шаблон">{v}</Chip>)}
          </div></Disclosure>
        </>
      )}
      {unknown && <span className="field-warn"><TriangleAlert aria-hidden />Команда /{cmd} не встречалась в сессиях GigaCode. Проверьте, что она установлена.</span>}
      {known.length > 0 && <span className="set-hint">Известные команды: <span className="mono">{known.slice(0, 12).join(' ')}{known.length > 12 ? ' …' : ''}</span></span>}
    </Row>
  )
}

/** «Разрешённые команды по проектам»: what «Разрешать всегда в этом проекте» saved, per project; × takes one back. */
function ProjectToolsRow({ form, update }: { form: Settings; update: (s: Settings) => void }) {
  const workspaces = useStore((s) => s.workspaces)
  const by = form.permissions?.allowedToolsByWorkspace ?? {}
  const entries = Object.entries(by).filter(([, list]) => list.length)
  const set = (id: string, list: string[]) =>
    update({ ...form, permissions: { ...form.permissions, allowedToolsByWorkspace: { ...by, [id]: list } } })
  return (
    <Row label="Разрешённые команды по проектам" hint="Добавляются кнопкой «Разрешать всегда в этом проекте» в карточке разрешения; действуют во всех чатах проекта." wide>
      {entries.length ? (
        <dl className="project-tools">
          {entries.map(([id, list]) => (
            <div key={id} className="project-tools-row">
              <dt>{workspaces.find((w) => w.id === id)?.name ?? id}</dt>
              <dd className="chips">{list.map((t) => <Chip key={t} mono onRemove={() => set(id, list.filter((x) => x !== t))} removeLabel={`Убрать ${t}`}>{t}</Chip>)}</dd>
            </div>
          ))}
        </dl>
      ) : <span className="set-hint">Пока нет: появятся из карточек разрешений.</span>}
    </Row>
  )
}

const QUICK_TOOLS = ['git', 'mvn', 'mvnw', 'gradle', 'gradlew', 'npm', 'npx', 'node', 'java', 'python', 'pytest'].map((c) => `run_shell_command(${c})`)

/** «Разрешённые команды»: tool patterns the CLI may run without asking (--allowed-tools), with quick-add for common ones. */
function AllowedToolsRow({ a, set }: { a: AgentSettings; set: (p: Partial<AgentSettings>) => void }) {
  const list = a.allowedTools ?? []
  const all = list.includes('*') // what «Полный доступ» passes when the sandbox is off
  const missing = QUICK_TOOLS.filter((t) => !list.includes(t))
  return (
    <Row label="Разрешённые команды" hint="Что CLI выполняет без вопроса в любом чате (шаблон вида run_shell_command(git)). Остальное агент попросит разрешить. «Полный доступ» этот список не спрашивает." wide>
      {all
        ? <span className="set-line">Список не используется: в наборе есть <code>*</code>, то есть разрешено всё без вопроса.</span>
        : <ChipsInput label="шаблон" values={list} onChange={(v) => set({ allowedTools: v })} />}
      {!all && missing.length > 0 && (
        <div className="chips quick-tools" aria-label="Быстро добавить">
          {missing.map((t) => <Chip key={t} mono onClick={() => set({ allowedTools: [...list, t] })} tip="Добавить">+ {t}</Chip>)}
        </div>
      )}
    </Row>
  )
}

/**
 * The MCP servers the CLI starts for every session (from its last init), each with a switch: excluded ones are not
 * started for harness sessions (agents.<id>.mcpExclude), which speeds up every start.
 */
function McpServersRow({ id, a, set }: { id: string; a: AgentSettings; set: (p: Partial<AgentSettings>) => void }) {
  const meta = useAgentMeta(id)
  const servers = meta?.mcpServers ?? meta?.seen?.mcpServers ?? []
  if (!servers.length) return null
  const editable = a.mcpExclude !== undefined // a server that does not return the field would drop it on save
  const off = new Set(a.mcpExclude ?? [])
  const disabled = new Set(meta?.mcpDisabled ?? []) // switched off for every agent in the config file
  return (
    <Row label="MCP-серверы для агентов" hint="Отключите ненужные или сломанные (например java-lsp), чтобы ускорить запуск." wide>
      <ul className="mcp-list">
        {servers.map((m) => {
          const ok = /connect|ok|ready|running/i.test(m.status)
          const on = !off.has(m.name) && !disabled.has(m.name)
          return (
            <li key={m.name} data-off={!on || undefined}>
              <span className="mcp-dot" data-ok={ok || undefined} aria-label={ok ? 'запускается' : `ошибка: ${m.status}`} />
              <span className="mono ellipsis">{m.name}</span>
              <span className="muted ellipsis">{on ? m.status : 'не запускается'}</span>
              {!editable ? null : disabled.has(m.name)
                ? <span className="set-hint">выключен в harness.config.local.json</span>
                : <Switch label={`MCP ${m.name}`} checked={on}
                    onChange={(v) => set({ mcpExclude: v ? [...off].filter((x) => x !== m.name) : [...off, m.name] })} />}
            </li>
          )
        })}
      </ul>
      {!editable && <span className="set-hint">Отключать серверы из интерфейса можно в более новой версии сервера.</span>}
    </Row>
  )
}

const FULL_TASK_REWORK = '/full-task {taskUrl} Задача готова, но нужны правки: {notes}' // GigaCode's /full-task with the notes

/** «Доработать»: the message the agent gets with the person's notes; presets (the default first) or a custom template. */
function ReworkRow({ a, set }: { a: AgentSettings; set: (p: Partial<AgentSettings>) => void }) {
  const all = useStore((s) => s.settings?.reworkPromptPresets)
  // unset = the server's default; then the presets it sends (per agent, else for all)
  const presets = [...new Set([DEFAULT_REWORK, FULL_TASK_REWORK, ...(a.reworkPromptPresets ?? all ?? [])])]
  const value = a.reworkPromptTemplate || DEFAULT_REWORK
  const [custom, setCustom] = useState(!presets.includes(value))
  return (
    <Row label="Команда доработки" hint="Сообщение агенту по кнопке «Доработать». {notes}: что поправить, {taskUrl}: ссылка на задачу." wide>
      <Select label="Команда доработки" mono value={custom ? CUSTOM : value}
        onChange={(v) => { if (v === CUSTOM) setCustom(true); else { setCustom(false); set({ reworkPromptTemplate: v === DEFAULT_REWORK ? null : v }) } }}
        options={[...presets.map((p) => ({ value: p, label: p.split('\n')[0], text: p, hint: p === DEFAULT_REWORK ? 'по умолчанию' : undefined })), { value: CUSTOM, label: 'Свой…', text: 'Свой шаблон' }]} />
      {custom && <Textarea mono rows={2} aria-label="Шаблон доработки" placeholder={DEFAULT_REWORK} value={a.reworkPromptTemplate ?? ''} onChange={(e) => set({ reworkPromptTemplate: e.target.value || null })} />}
    </Row>
  )
}

// ---------- tracker ----------

function TrackerSection({ form, update, fieldError, check }: SectionProps & { check: ReturnType<typeof useIntegrationsCheck> }) {
  const t = form.integrations?.tasks
  const set = (patch: NonNullable<NonNullable<Settings['integrations']>['tasks']>) =>
    update({ ...form, integrations: { ...form.integrations, tasks: { ...t, ...patch } } })
  const refresh = form.tasks.refreshSec
  const spaces = Array.isArray(t?.space) ? t.space : t?.space ? [t.space] : []
  const sample = (t?.urlTemplate ?? '').replaceAll('{key}', `${spaces[0] || 'PROJ'}-1234`)
  return (
    <section className="settings-section" id="set-tracker">
      <h2>Трекер задач</h2>
      <IntegrationStatus kind="tasks" check={check} />
      <div className="set-rows">
        {t && <>
            <Row label="Импорт задач"><Switch label="Импорт задач из трекера" checked={!!t.enabled} onChange={(v) => set({ enabled: v })} /></Row>
            <Row label="Пространства" hint="Enter или запятая: добавить." error={fieldError('space')}>
              <ChipsInput label="пространство" values={spaces}
                onChange={(v) => { const up = [...new Set(v.map((x) => x.trim().toUpperCase()).filter(Boolean))]; set({ space: up.length === 1 ? up[0] : up }) }} />
            </Row>
        </>}
        <Row label="Синхронизация" hint="Как часто перечитывать задачи из трекера." error={fieldError('sync')}>
          <Select label="Интервал синхронизации" value={String(refresh)} onChange={(v) => update({ ...form, tasks: { ...form.tasks, refreshSec: Number(v) } })}
            options={[...SYNC, ...(SYNC.some((s) => s.v === refresh) ? [] : [{ v: refresh, l: `каждые ${refresh} с` }])].map((s) => ({ value: String(s.v), label: s.l }))} />
        </Row>
      </div>
      <Advanced id="tracker">
      <div className="set-rows">
        {t && (
          <Row label="Ссылка на задачу" hint={sample ? <>Пример: <span className="mono">{sample}</span></> : 'Шаблон с {key}; из него берётся {taskUrl}.'} error={fieldError('url')} wide>
            <Input mono value={t.urlTemplate ?? ''} placeholder="https://tracker/swtr/units/all/unit/{key}" onChange={(e) => set({ urlTemplate: e.target.value })} />
          </Row>
        )}
        {t && <StartTransitionRow value={t.onStartTransition ?? ''} statuses={Object.keys(t.statusMap ?? {})} onChange={(v) => set({ onStartTransition: v || null })} />}
      </div>
      {/* With board columns the mapping lives in «Доска» (columns own their tracker statuses). */}
      {!form.board && t?.statusMap && Object.keys(t.statusMap).length > 0 && (
        <>
          <h3>Статусы трекера → колонки доски</h3>
          <div className="map-table" role="table" aria-label="Соответствие статусов">
            {Object.entries(t.statusMap).map(([ext, col]) => (
              <div key={ext} className="map-row" role="row">
                <span className="mono" role="cell">{ext}</span>
                <span className="map-arrow" aria-hidden>→</span>
                <span role="cell">
                  <Select size="sm" label={`Колонка для статуса ${ext}`} value={col} onChange={(v) => set({ statusMap: { ...t.statusMap, [ext]: v } })}
                    options={COLUMNS.map((c) => ({ value: c.id, label: c.label }))} />
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      </Advanced>
    </section>
  )
}

// ---------- git ----------

function GitSection({ form, update, fieldError }: SectionProps) {
  const workspaces = useStore((s) => s.workspaces)
  const [branches, setBranches] = useState<string[]>([])
  const ws = workspaces.find((w) => w.isGit)
  const branchesOn = useFeature('branches')
  const viaOn = useFeature('git-via-agent')
  useEffect(() => {
    if (!ws || !branchesOn) return
    api<GitBranches>('GET', `/git/branches${qs({ cwd: ws.path })}`).then((r) => setBranches((Array.isArray(r?.branches) ? r.branches : []).filter((b) => !b.remote).map((b) => b.name)), () => setBranches([]))
  }, [ws, branchesOn])
  const g = form.git
  const [editBase, setEditBase] = useState(false)
  const set = (patch: Partial<Settings['git']>) => update({ ...form, git: { ...g, ...patch } })
  const bases = [...new Set(['develop', 'main', 'master', ...branches, ...(g.defaultBase ? [g.defaultBase] : [])])]
  return (
    <section className="settings-section" id="set-git">
      <h2>Git</h2>
      <div className="set-rows">
        <Row label="Базовая ветка" hint="От неё создаются ветки задач." error={fieldError('base')}>
          {editBase || !g.defaultBase
            ? <Select label="Базовая ветка" mono value={g.defaultBase ?? ''} onChange={(v) => set({ defaultBase: v })} options={bases.map((b) => ({ value: b, label: b }))} />
            : <AutoValue value={g.defaultBase} mono open={false} onToggle={() => setEditBase(true)} />}
        </Row>
        <TemplateRow f={GIT_TEMPLATES[0]} value={g[GIT_TEMPLATES[0].key] ?? ''} onChange={(v) => set({ [GIT_TEMPLATES[0].key]: v })} error={fieldError('git')} />
        {viaOn && (
          <Row label="Коммит, push и PR" hint="Через агента работают хуки и навыки GigaCode (например, проверки перед коммитом), но это медленнее. Напрямую: git и sourcecontrol из harness. Тексты коммитов и PR агент пишет только по кнопке у поля «Сообщение» и в окне «Создать PR».">
            <Segmented label="Коммит, push и PR" value={g.via ?? 'agent'} onChange={(v) => set({ via: v })}
              options={[{ value: 'agent', label: 'Через агента' }, { value: 'harness', label: 'Напрямую' }]} />
          </Row>
        )}
      </div>
      <Advanced id="git">
        <div className="set-rows">
          {GIT_TEMPLATES.slice(1).map((f) => <TemplateRow key={f.key} f={f} value={g[f.key] ?? ''} onChange={(v) => set({ [f.key]: v })} error={fieldError('git')} />)}
        </div>
      </Advanced>
      <p className="set-note">Превью на примере задачи <span className="mono">{SAMPLE.key}</span> «{SAMPLE.title}», цель <span className="mono">{SAMPLE.target}</span>.</p>
    </section>
  )
}

function TemplateRow({ f, value, onChange, error }: { f: (typeof GIT_TEMPLATES)[number]; value: string; onChange: (v: string) => void; error?: string }) {
  const [custom, setCustom] = useState(!!value && !f.presets.includes(value))
  return (
    <Row label={f.label} hint={<>{f.hint} <span className="set-preview">→ <span className="mono">{value ? render(value) : 'не задано'}</span></span></>} error={error}>
      <Select label={f.label} mono value={custom ? CUSTOM : value || CUSTOM}
        onChange={(v) => { if (v === CUSTOM) setCustom(true); else { setCustom(false); onChange(v) } }}
        options={[...f.presets.map((p) => ({ value: p, label: p, hint: render(p) })), { value: CUSTOM, label: 'Свой…', text: 'Свой' }]} />
      {custom && <Input mono aria-label={`${f.label}: свой шаблон`} value={value} placeholder={f.presets[0]} onChange={(e) => onChange(e.target.value)} />}
    </Row>
  )
}

// ---------- PR ----------

function PrSection({ form, update, check }: Omit<SectionProps, 'fieldError'> & { check: ReturnType<typeof useIntegrationsCheck> }) {
  const pr = form.integrations?.pr
  if (!pr) return null
  const lim = pr.limits ?? {}
  return (
    <section className="settings-section" id="set-pr">
      <h2>Пулл-реквесты</h2>
      <IntegrationStatus kind="pr" check={check} />
      <div className="set-rows">
        <Row label="Создание пулл-реквестов" hint="В режиме «Авто» Harness использует настроенный сервер хостинга кода.">
          <Segmented label="PR-интеграция" value={String(pr.enabled ?? 'auto') as 'auto' | 'true' | 'false'}
            onChange={(v) => update({ ...form, integrations: { ...form.integrations, pr: { ...pr, enabled: v === 'auto' ? 'auto' : v === 'true' } } })}
            options={[
              { value: 'auto', label: 'Авто' },
              { value: 'true', label: 'Вкл' },
              { value: 'false', label: 'Выкл' },
            ]} />
        </Row>
        <Row label="Ваш логин" hint="Для «Мои PR». Если пусто, логин берётся из sourcecontrol (git_get_user), а если он не ответил, имя пользователя ОС.">
          <input className="input mono" aria-label="Ваш логин в sourcecontrol" placeholder="авто" value={pr.me ?? ''}
            onChange={(e) => update({ ...form, integrations: { ...form.integrations, pr: { ...pr, me: e.target.value || null } } })} />
        </Row>
        <Row label="Ограничения" hint="Лимиты сервера sourcecontrol в байтах UTF-8: буква кириллицы занимает 2 байта.">
          <span className="set-readonly">заголовок до <span className="num">{lim.titleBytes ?? 100}</span> байт, описание до <span className="num">{lim.bodyBytes ?? 512}</span> байт</span>
        </Row>
      </div>
    </section>
  )
}

// ---------- orchestration ----------

function OrchestrationSection({ form, update }: Omit<SectionProps, 'fieldError'>) {
  const o = form.orchestration ?? {}
  const mode = o.reviewMode ?? 'builtin'
  const agentId = mainAgent(form)
  return (
    <section className="settings-section" id="set-orchestration">
      <h2>Субагенты</h2>
      <div className="set-rows">
        <Row label="Показывать субагентов отдельными чатами"
          hint="Субагента запускает агент: для ревью, исследования кода, части задачи. В отдельном чате видно, что он делает; ему можно ответить или остановить его. Нужен навык ниже.">
          <Switch label="Показывать субагентов отдельными чатами" checked={(o.subagents ?? 'harness') === 'harness'}
            onChange={(v) => update({ ...form, orchestration: { ...o, subagents: v ? 'harness' : 'builtin' } })} />
          {(o.subagents ?? 'harness') === 'harness' && (
            <InstallFile id={agentId} kind="skills" name="harness-orchestration" target="~/.gigacode/skills/harness-orchestration/SKILL.md" title="Навык для субагентов" action="Установить навык" />
          )}
        </Row>
        {o.subagentMcpExclude !== undefined && <SubagentMcpRow off={o.subagentMcpExclude} onChange={(list) => update({ ...form, orchestration: { ...o, subagentMcpExclude: list } })} />}
        {o.subagentRetention !== undefined && (
          <Row label="Оставлять закончивших субагентов в боковой панели" hint="Иначе закончивший субагент уходит в архив; его чат открывается по ссылке в чате агента.">
            <Switch label="Оставлять закончивших субагентов" checked={o.subagentRetention === 'keep'}
              onChange={(v) => update({ ...form, orchestration: { ...o, subagentRetention: v ? 'keep' : 'archive' } })} />
          </Row>
        )}
        <Row label="Ревью готовой задачи" wide hint={mode === 'builtin'
          ? 'Агент проверяет свою работу сам (или его команда для задач, если она это умеет).'
          : 'Когда агент сдал задачу, её проверяет отдельный агент-ревьюер другой моделью, в своём чате; замечания уходят обратно агенту.'}>
          <Segmented label="Ревью готовой задачи" value={mode} onChange={(v) => update({ ...form, orchestration: { ...o, reviewMode: v } })}
            options={[{ value: 'builtin', label: 'Агент сам' }, { value: 'harness', label: 'Отдельный ревьюер' }]} />
        </Row>
      </div>
      <Advanced id="orchestration">
        {o.maxSubagentDepth !== undefined && (
          <div className="set-rows">
            <Row label="Глубина субагентов" hint="Может ли субагент запускать своих субагентов. При 1 субагентов запускает только сам агент.">
              <Select label="Глубина субагентов" value={String(o.maxSubagentDepth)} onChange={(v) => update({ ...form, orchestration: { ...o, maxSubagentDepth: Number(v) } })}
                options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} />
            </Row>
          </div>
        )}
        {mode === 'harness' && <div className="set-rows"><ReviewRows form={form} update={update} /></div>}
      </Advanced>
    </section>
  )
}

/** Tracker transition on «Взять в работу»: none, a known status, or a custom one. */
function StartTransitionRow({ value, statuses, onChange }: { value: string; statuses: string[]; onChange: (v: string) => void }) {
  const known = [...new Set(statuses)]
  const [custom, setCustom] = useState(!!value && !known.includes(value))
  return (
    <Row label="Переводить при взятии в работу" hint="Статус задачи в трекере, когда агент её берёт. По умолчанию не переводить.">
      <Select label="Переход при взятии в работу" mono value={custom ? CUSTOM : value}
        onChange={(v) => { if (v === CUSTOM) setCustom(true); else { setCustom(false); onChange(v) } }}
        options={[{ value: '', label: 'Не переводить', text: 'Не переводить' }, ...known.map((k) => ({ value: k, label: k })), { value: CUSTOM, label: 'Свой…', text: 'Свой' }]} />
      {custom && <Input mono aria-label="Свой статус" value={value} placeholder="development" onChange={(e) => onChange(e.target.value.trim())} />}
    </Row>
  )
}

const REVIEW_VARS = ['{key}', '{title}', '{description}', '{branch}', '{base}', '{cwd}', '{round}', '{previous}']

/** Harness-run review: which model grade reviews, in which mode, how many rounds, with what prompt. */
function ReviewRows({ form, update }: Omit<SectionProps, 'fieldError'>) {
  const o = form.orchestration ?? {}
  const r = o.review ?? {}
  const set = (patch: Partial<NonNullable<typeof r>>) => update({ ...form, orchestration: { ...o, review: { ...r, ...patch } } })
  const agentId = r.agent ?? mainAgent(form)
  const agent = form.agents[agentId]
  const live = useStore((s) => s.agents.find((x) => x.id === agentId)?.models)
  const catalog = useMemo(() => pickerModels(live, agent?.models), [live, agent?.models])
  const grade = (r.grade ?? 'review') as Grade
  const resolved = agent?.modelGrades[grade]
  const entry = resolved ? catalog.find((m) => sameModel(m.id, resolved)) : undefined
  const area = useRef<HTMLTextAreaElement>(null)
  const tpl = r.promptTemplate ?? ''
  const insert = (v: string) => {
    const at = area.current?.selectionStart ?? tpl.length
    set({ promptTemplate: tpl.slice(0, at) + v + tpl.slice(at) })
  }
  return (
    <>
      <p className="set-note set-row-note">Работает независимо от содержимого /full-task: после worker_done harness запускает ревьюера другой моделью и возвращает замечания исполнителю.</p>
      <Row label="Модель ревьюера" hint={resolved ? <>уровень {grade}: <span className="mono">{entry?.label ?? resolved}</span>{entry?.available === false && <span className="field-warn"> · модели нет в каталоге, ревью пойдёт с моделью по умолчанию</span>}</> : 'Уровень не настроен: модель по умолчанию CLI.'}>
        <Select label="Уровень модели ревьюера" mono value={grade} onChange={(v) => set({ grade: v })} options={GRADES.map((g) => ({ value: g, label: g, hint: agent?.modelGrades[g] ?? 'не задан' }))} />
      </Row>
      <Row label="Режим ревьюера" hint="По умолчанию «План»: ревьюер только читает.">
        <Select label="Режим ревьюера" value={r.approvalMode ?? 'plan'} onChange={(v) => set({ approvalMode: v })}
          options={(agent?.approvalModes ?? ['plan']).map((m) => ({ value: m, label: modeShort(m), hint: agent?.approvalModeLabels?.[m] }))} />
      </Row>
      <Row label="Раундов ревью, не больше" hint="После последнего раунда придёт уведомление с замечаниями.">
        <Select label="Максимум раундов" value={String(r.maxRounds ?? 2)} onChange={(v) => set({ maxRounds: Number(v) })} options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))} />
      </Row>
      <Row label="Промпт ревьюера" wide hint="Пусто: встроенный (ревью diff с базовой веткой, находки CRITICAL/HIGH/MEDIUM/LOW, VERDICT в конце).">
        <Textarea ref={area} mono rows={5} aria-label="Промпт ревьюера" value={tpl} onChange={(e) => set({ promptTemplate: e.target.value || undefined })} />
        <div className="chips">{REVIEW_VARS.map((v) => <Chip key={v} mono onClick={() => insert(v)} tip="Вставить в промпт">{v}</Chip>)}</div>
      </Row>
    </>
  )
}

const SEMANTIC: { value: TaskStatus; label: string }[] = [
  { value: 'backlog', label: 'бэклог' }, { value: 'todo', label: 'к работе' }, { value: 'in_progress', label: 'в работе' },
  { value: 'review', label: 'на проверке' }, { value: 'done', label: 'готово' },
]

/** Board columns of the team workflow and how they talk to the tracker. */
function BoardSection({ form, update }: Omit<SectionProps, 'fieldError'>) {
  const tasks = useStore((s) => s.tasks)
  const b = form.board
  if (!b) return null
  const set = (patch: Partial<BoardSettings>) => update({ ...form, board: { ...b, ...patch } })
  const cols = b.columns
  const setCol = (i: number, patch: Partial<BoardColumn>) => set({ columns: cols.map((c, j) => (j === i ? { ...c, ...patch } : c)) })
  const move = (i: number, d: -1 | 1) => { const next = [...cols]; [next[i], next[i + d]] = [next[i + d], next[i]]; set({ columns: next }) }
  const known = [...new Set([...tasks.map((t) => t.externalStatus).filter((x): x is string => !!x), ...cols.flatMap((c) => c.trackerStatuses), ...Object.keys(form.integrations?.tasks?.statusMap ?? {})])].sort()
  const reviewCol = cols.find((c) => c.status === 'review')
  const free = SEMANTIC.filter((s) => !cols.some((c) => c.status === s.value))
  return (
    <section className="settings-section" id="set-board">
      <h2>Доска</h2>
      <p className="set-note">Колонки и их порядок; у каждой свой внутренний статус и статусы трекера, которые в неё попадают при импорте.</p>
      <div className="board-cols">
        {cols.map((c, i) => (
          <div key={`${c.status}-${i}`} className="board-col-row">
            <div className="board-col-order">
              <IconButton size="sm" label="Выше" icon={<ArrowUp />} disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton size="sm" label="Ниже" icon={<ArrowDown />} disabled={i === cols.length - 1} onClick={() => move(i, 1)} />
            </div>
            <Input aria-label="Название колонки" value={c.label} invalid={!c.label.trim()} onChange={(e) => setCol(i, { label: e.target.value })} />
            <Select label="Статус колонки" value={c.status} onChange={(v) => setCol(i, { status: v as TaskStatus })}
              options={SEMANTIC.filter((s) => s.value === c.status || !cols.some((x) => x.status === s.value)).map((s) => ({ value: s.value, label: s.label }))} />
            <IconButton size="sm" label="Убрать колонку" icon={<X />} disabled={cols.length <= 1} onClick={() => set({ columns: cols.filter((_, j) => j !== i) })} />
            <div className="chips board-col-statuses" aria-label="Статусы трекера">
              {known.map((k) => (
                <Chip key={k} mono pressed={c.trackerStatuses.includes(k)}
                  onClick={() => setCol(i, { trackerStatuses: c.trackerStatuses.includes(k) ? c.trackerStatuses.filter((x) => x !== k) : [...c.trackerStatuses, k] })}>{k}</Chip>
              ))}
            </div>
            {b.moveSyncsTracker && (
              <div className="board-col-transition">
                <SuggestInput mono label={`Переход для «${c.label}»`} placeholder="переход: подбирается автоматически" value={b.columnTransitions?.[c.status] ?? ''}
                  suggestions={c.trackerStatuses} onChange={(v) => set({ columnTransitions: { ...b.columnTransitions, [c.status]: v || undefined } })} />
              </div>
            )}
          </div>
        ))}
      </div>
      {free.length > 0 && (
        <Button size="sm" icon={<Plus />} onClick={() => set({ columns: [...cols, { status: free[0].value, label: free[0].label[0].toUpperCase() + free[0].label.slice(1), trackerStatuses: [] }] })}>Добавить колонку</Button>
      )}
      <Advanced id="board">
      <div className="set-rows">
        <Row label="Когда агент закончил" hint="Карточка получает отметку агента в любом случае.">
          <Segmented label="Когда агент закончил" value={b.onWorkerDone ?? 'stay'} onChange={(v) => set({ onWorkerDone: v })}
            options={[{ value: 'stay' as const, label: 'Оставить в колонке' }, ...(reviewCol ? [{ value: 'review' as const, label: `Перенести в «${reviewCol.label}»` }] : [])]} />
        </Row>
        <Row label="Двигать задачу в трекере" hint="При переносе карточки (и при «Взять в работу»): переход подбирается автоматически из доступных в трекере.">
          <Switch label="Двигать задачу в трекере при переносе карточки" checked={!!b.moveSyncsTracker} onChange={(v) => set({ moveSyncsTracker: v })} />
        </Row>
      </div>
      </Advanced>
    </section>
  )
}

/** Explicit path, or «Авто: <the detected projects folder>»; changed with the folder picker. */
function ProjectsFolder({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const auto = useStore((s) => s.workspaces.find((w) => w.kind === 'root')?.path ?? null)
  const [picking, setPicking] = useState(false)
  return (
    <div className="auto-value">
      {value
        ? <span className="auto-text mono">{value}</span>
        : <span className="auto-text"><span className="muted">Авто: </span><span className="mono">{auto ?? 'не определена (нужно ≥ 2 проектов)'}</span></span>}
      <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setPicking(true)}>Изменить</Button>
      {value && <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Авто</Button>}
      {picking && <FolderPicker title="Папка с проектами" initial={value ?? auto} onClose={() => setPicking(false)} onPick={(p) => { setPicking(false); onChange(p) }} />}
    </div>
  )
}

/** «Чаты»: where projects live, how long chats stay, what happens after an interruption. */
function ChatsSection({ form, update }: Omit<SectionProps, 'fieldError'>) {
  const foldersOn = useFeature('folders')
  return (
    <section className="settings-section" id="set-chats">
      <h2>Чаты</h2>
      <div className="set-rows">
        {foldersOn && form.workspaces !== undefined && (
          <Row label="Папка с проектами" hint="Стартовая папка агента: её чаты видны над списком проектов. Подойдёт и обычная папка без Git.">
            <ProjectsFolder value={form.workspaces?.root ?? null} onChange={(root) => update({ ...form, workspaces: { ...form.workspaces, root } })} />
          </Row>
        )}
        {form.sessions !== undefined && (
          <Row label="Автоархив неактивных чатов через" hint="Чаты без активности дольше этого уходят в архив. История сохраняется, вернуть чат можно на экране «Агенты».">
            <Select label="Автоархив неактивных чатов" value={!form.sessions.autoArchiveDays ? 'off' : String(form.sessions.autoArchiveDays)}
              onChange={(v) => update({ ...form, sessions: { ...form.sessions, autoArchiveDays: v === 'off' ? 0 : Number(v) } })}
              options={[{ value: 'off', label: 'выкл' }, { value: '1', label: '1 день' }, { value: '3', label: '3 дня' }, { value: '7', label: '7 дней' }, { value: '30', label: '30 дней' }]} />
          </Row>
        )}
        {form.sessions !== undefined && (
          <Row label="Удалять архив через" hint="Чаты в архиве дольше этого удаляются вместе с историей и логами. Закреплённые и привязанные к незакрытой задаче остаются.">
            <Select label="Удалять архив через" value={!(form.sessions.purgeArchivedDays ?? 30) ? 'off' : String(form.sessions.purgeArchivedDays ?? 30)}
              onChange={(v) => update({ ...form, sessions: { ...form.sessions, purgeArchivedDays: v === 'off' ? 0 : Number(v) } })}
              options={[{ value: 'off', label: 'никогда' }, { value: '7', label: '7 дней' }, { value: '30', label: '30 дней' }, { value: '90', label: '90 дней' }]} />
          </Row>
        )}
        {form.recovery !== undefined && (
          <Row label="Продолжать прерванные сессии сами" hint="После перезапуска harness или компьютера прерванные ходы продолжаются без вас: координаторы после своих исполнителей. Выключено: откроется окно «Восстановление сессий».">
            <Switch label="Продолжать прерванные сессии автоматически" checked={!!form.recovery.autoResume} onChange={(v) => update({ ...form, recovery: { ...form.recovery, autoResume: v } })} />
          </Row>
        )}
      </div>
      {/* rarely changed: what happens to an interrupted or silent agent */}
      <Advanced id="general">
      <div className="set-rows">
        {form.recovery !== undefined && (
          <Row label="Сообщение для продолжения" hint="Что получает агент, когда его прерванный ход продолжают." wide>
            <Textarea rows={2} aria-label="Сообщение для продолжения" value={form.recovery.message ?? ''} onChange={(e) => update({ ...form, recovery: { ...form.recovery, message: e.target.value } })} />
          </Row>
        )}
        {form.session?.revive && (
          <>
            <Row label="Если агент оборвался" hint="Ошибка или обрыв связи посреди работы: harness продолжает ту же сессию с того же места после пауз 30 с, 2 мин и 5 мин. Не помогло: придёт уведомление с кнопкой «Повторить».">
              <Select label="Если агент оборвался" value={String(form.session.revive.attempts)} onChange={(v) => update({ ...form, session: { ...form.session, revive: { ...form.session!.revive!, attempts: Number(v) } } })}
                options={[{ value: '0', label: 'не продолжать, сразу уведомить' }, { value: '1', label: 'продолжить 1 раз' }, { value: '3', label: 'продолжить до 3 раз' }, { value: '5', label: 'продолжить до 5 раз' }]} />
            </Row>
            <Row label="Будить молчащего агента через" hint="Агент ничего не пишет и не выполняет команду. Долгая сборка или тесты считаются нормальной тишиной. Процесс останавливается, сессия продолжается с того же места.">
              <Select label="Будить молчащего агента через" value={String(form.session.revive.stallWakeMin)} onChange={(v) => update({ ...form, session: { ...form.session, revive: { ...form.session!.revive!, stallWakeMin: Number(v) } } })}
                options={[{ value: '0', label: 'не будить' }, ...[10, 15, 30, 60].map((m) => ({ value: String(m), label: `${m} мин` }))]} />
            </Row>
          </>
        )}
        {form.session?.stallSec !== undefined && (
            <Row label="«Нет вывода» через" hint="Работающий агент без единого события дольше этого считается зависшим: в боковой панели он попадёт в «Ждут вас», в чате появится предложение остановить.">
              <Select label="«Нет вывода» через" value={String(form.session.stallSec)} onChange={(v) => update({ ...form, session: { ...form.session, stallSec: Number(v) } })}
                options={[...new Set([30, 60, 120, 300, 600, 900, form.session.stallSec])].sort((x, y) => x - y).map((s) => ({ value: String(s), label: s < 60 ? `${s} с` : `${s / 60} мин` }))} />
            </Row>
        )}
      </div>
      </Advanced>
    </section>
  )
}

/** «Интерфейс»: kept in this browser, saved at once (no «Сохранить»). */
function InterfaceSection() {
  const scheme = useStore((s) => s.scheme)
  const [on, setOn] = useState(desktopNotifyOn)
  const supported = 'Notification' in window
  const denied = supported && Notification.permission === 'denied'
  return (
    <section className="settings-section" id="set-ui">
      <h2>Интерфейс</h2>
      <div className="set-rows">
        <Row label="Тема" hint="Хранится в этом браузере.">
          <Segmented label="Тема" value={scheme} onChange={(v) => setState({ theme: v })} options={[{ value: 'dark', label: 'Тёмная' }, { value: 'light', label: 'Светлая' }]} />
        </Row>
        <Row label="Уведомления на рабочем столе" hint={denied ? 'Браузер запретил уведомления для этой страницы: разрешите их в настройках сайта.' : 'Вопросы агентов, готовые задачи и ошибки, пока вкладка в фоне. Хранится в этом браузере.'}>
          <Switch label="Уведомления на рабочем столе" checked={on} disabled={!supported || denied}
            onChange={(v) => void setDesktopNotify(v).then((res) => { setOn(res); if (v && !res) toast('Браузер не разрешил уведомления', 'error') })} />
        </Row>
      </div>
    </section>
  )
}

const PRESET_HINT: Record<string, string> = {
  '/full-task': 'команда сама запускает субагентов внутри CLI',
  '/full-task-ui': 'то же для задач с интерфейсом',
  '/full-task-harness': 'субагенты отдельными интерактивными чатами (как в Orca)',
}

/** A file shipped with the harness (skill or command): written into ~/.gigacode only on an explicit, confirmed click. */
export function InstallFile({ id, kind, name, target, title, action }: { id: string; kind: 'skills' | 'commands'; name: string; target: string; title: string; action: string }) {
  const meta = useAgentMeta(id)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const installOn = useFeature('skills-install')
  const state = meta?.[kind]?.[name]
  if (!installOn) return <span className="set-hint">Установка из интерфейса недоступна в этой версии сервера.</span>
  if (!meta || !state) return null
  const install = async () => {
    setBusy(true)
    const r = await tryApi('POST', `/agents/${encodeURIComponent(id)}/${kind}/install`, { name, force: state === 'different' || undefined })
    setBusy(false)
    setConfirm(false)
    if (r !== undefined) { toast(`Установлено: ${title}`, 'ok'); loadAgentMeta(id, true) }
  }
  return (
    <div className="install-cmd">
      {state === 'installed' ? <span className="ok-text"><CircleCheck className="ok" aria-hidden />{title}: установлен в GigaCode</span>
        : state === 'different' ? <span className="field-warn"><TriangleAlert aria-hidden />{title}: в GigaCode другая версия</span>
          : <span className="field-warn"><TriangleAlert aria-hidden />{title}: не установлен в GigaCode</span>}
      {state !== 'installed' && !confirm && <Button size="sm" onClick={() => setConfirm(true)}>{state === 'different' ? 'Обновить' : action}</Button>}
      {confirm && (
        <div className="install-confirm" role="alertdialog" aria-label="Подтверждение установки">
          <span>Записать файл <span className="mono">{target}</span>?{state === 'different' && ' Текущий файл будет перезаписан.'}</span>
          <Button size="sm" variant={state === 'different' ? 'danger' : 'primary'} className={state === 'different' ? 'btn-primary' : undefined} disabled={busy} onClick={() => void install()}>
            {busy ? 'Записываем…' : state === 'different' ? 'Перезаписать' : 'Установить'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Отмена</Button>
        </div>
      )}
    </div>
  )
}

/** «CLI не найден»: the path in plain words, a field to fix it and a check; the raw message under «Подробности». */
export function CliPathFix({ id, error, onChecked, initial }: { id: string; error: string; onChecked: () => void; initial?: string }) {
  const quoted = /"([^"]+)"/.exec(error)?.[1] ?? initial ?? ''
  const exe = quoted ? quoted.split(/[\\/]/).pop() : id
  const [path, setPath] = useState(quoted)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const check = async () => {
    setBusy(true)
    setErr(null)
    try {
      const saved = await api<Settings>('PUT', '/settings', { agents: { [id]: { command: path.trim() } } })
      if (saved) setState({ settings: saved })
      onChecked()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cli-fix">
      {error && <p className="status-error">{/not found|не найден/i.test(error) ? <>Не найден {exe}. Укажите, где он лежит, и нажмите «Проверить»:</> : 'Агент не запускается: проверьте путь и нажмите «Проверить».'}</p>}
      <div className="cli-fix-row">
        <Input mono aria-label="Путь к агенту" value={path} placeholder="Полный путь к исполняемому файлу" onChange={(e) => setPath(e.target.value)} />
        <Button disabled={busy || !path.trim()} onClick={() => void check()}>{busy ? 'Проверяем…' : 'Проверить'}</Button>
      </div>
      {err && <p className="field-error">{err}</p>}
      {error && <Disclosure className="cli-raw" summary={<span className="muted">Подробности</span>}><pre className="mono">{error}</pre></Disclosure>}
    </div>
  )
}

/**
 * «Проверка перед «готово»»: the project's own command (tests, lint) that the harness runs in the agent's worktree once it
 * reports — a failure goes back to the agent with the output. One per project; «Проверить сейчас» runs it on the project.
 */
function ChecksCard({ form, update }: { form: Settings; update: (s: Settings) => void }) {
  const workspaces = useStore((s) => s.workspaces).filter((w) => !w.kind)
  const c = form.checks!
  const setCmd = (id: string, v: string) => update({ ...form, checks: { ...c, byWorkspace: { ...c.byWorkspace, [id]: v } } })
  const [runs, setRuns] = useState<Record<string, { busy?: boolean; ok?: boolean; code?: number | null; output?: string; ms?: number }>>({})
  const tryNow = async (id: string) => {
    setRuns((r) => ({ ...r, [id]: { busy: true } }))
    const res = await tryApi<{ ok: boolean; code: number | null; output: string; ms: number }>('POST', '/checks/run', { workspaceId: id, command: c.byWorkspace[id] })
    setRuns((r) => ({ ...r, [id]: res ?? {} }))
  }
  return (
    <section className="settings-section project-checks">
      <h2>Проверки проектов</h2>
      <p className="set-note">Укажите команду тестов или линтера для нужных проектов. Если проверка не пройдёт, агент получит вывод для исправления.</p>
      {workspaces.length === 0 && <p className="muted">Добавьте проект, и здесь появится поле для его проверки.</p>}
      <div className="set-rows">
        {workspaces.map((w) => {
          const cmd = c.byWorkspace[w.id] ?? ''
          const sug = c.suggested?.[w.id]
          const run = runs[w.id]
          return (
            <Row key={w.id} label={w.name} hint={!cmd && sug ? <button type="button" className="link-btn" onClick={() => setCmd(w.id, sug)}>Подставить: <span className="mono">{sug}</span></button> : undefined}>
              <div className="check-row">
                <Input mono aria-label={`Проверка ${w.name}`} value={cmd} placeholder={sug ?? 'Команда проверки'} onChange={(e) => setCmd(w.id, e.target.value)} />
                <Button size="sm" disabled={!cmd.trim() || run?.busy} onClick={() => void tryNow(w.id)}>{run?.busy ? 'Идёт…' : 'Проверить'}</Button>
              </div>
              {run && !run.busy && run.ok !== undefined && (
                <Disclosure className="check-result" summary={<span className={run.ok ? 'ok-text' : 'field-error'}>{run.ok ? 'Прошла' : run.code == null ? 'Не прошла' : `Не прошла (код ${run.code})`} · {Math.round((run.ms ?? 0) / 1000)} с</span>}>
                  <pre className="mono">{run.output?.trim() || '(нет вывода)'}</pre>
                </Disclosure>
              )}
            </Row>
          )
        })}
        {workspaces.length > 0 && (
          <Row label="Попыток исправить" hint="После последней попытки придёт уведомление.">
            <Select label="Попыток исправить" value={String(c.maxRounds)} onChange={(v) => update({ ...form, checks: { ...c, maxRounds: Number(v) } })}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))} />
          </Row>
        )}
      </div>
    </section>
  )
}

/** Per-section «Расширенные»: closed by default, remembered in this browser. */
function Advanced({ id, children }: { id: string; children: ReactNode }) {
  const key = `harness.settings.adv.${id}`
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) === '1' } catch { return false } })
  const searching = useContext(Searching)
  return (
    <Disclosure className="settings-adv" open={open || searching} onToggle={(v) => { setOpen(v); try { localStorage.setItem(key, v ? '1' : '0') } catch { /* not remembered */ } }}
      summary={<span>Расширенные</span>}>
      {children}
    </Disclosure>
  )
}

/** A value the harness found by itself: «Авто: …» with «Изменить». */
function AutoValue({ value, mono, open, onToggle }: { value: string; mono?: boolean; open: boolean; onToggle: () => void }) {
  return (
    <div className="auto-value">
      <span className="auto-text"><span className="muted">Авто: </span><span className={mono ? 'mono' : undefined}>{value}</span></span>
      <Button size="sm" variant="ghost" icon={<Pencil />} onClick={onToggle} aria-expanded={open}>{open ? 'Скрыть' : 'Изменить'}</Button>
    </div>
  )
}

/** Which of the CLI's MCP servers a sub-agent or worker starts with: each one costs start time, harness always comes. */
function SubagentMcpRow({ off, onChange }: { off: string[]; onChange: (list: string[]) => void }) {
  const can = useFeature('mcp-connections')
  const [names, setNames] = useState<string[] | null>(null)
  useEffect(() => {
    if (!can) return
    void tryApi<{ servers: { name: string; enabled: boolean }[] }>('GET', '/mcp/config')
      .then((r) => setNames((r?.servers ?? []).filter((x) => x.enabled && x.name !== 'harness').map((x) => x.name)))
  }, [can])
  // a server switched off earlier but no longer configured stays listed: it can still be switched back on
  const all = [...new Set([...(names ?? []), ...off])].sort()
  if (!can || !all.length) return null
  return (
    <Row label="MCP-серверы субагентов" wide hint="Субагенты стартуют только с отмеченными серверами (harness подключается всегда). Каждый лишний сервер добавляет секунды к старту.">
      <div className="set-chips">
        {/* the server's name next to its switch: an aria-label alone left a row of unnamed toggles */}
        {all.map((n) => (
          <label key={n} className="set-switch">
            <Switch label={`MCP-сервер ${n} для субагентов`} checked={!off.includes(n)} onChange={(v) => onChange(v ? off.filter((x) => x !== n) : [...off, n])} />
            <span className="mono">{n}</span>
          </label>
        ))}
      </div>
    </Row>
  )
}
