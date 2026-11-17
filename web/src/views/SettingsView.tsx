import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CircleCheck, CircleX, LogIn, RefreshCw, TriangleAlert } from 'lucide-react'
import { api, ApiError, errorText, qs, tryApi } from '../api'
import { setState, toast, useStore } from '../store'
import { adoptSession } from '../lib/actions'
import { COLUMNS, relTime } from '../lib/format'
import { FULL_ACCESS, GRADES, loadAgentMeta, loadSettings, modeShort, normModels, useAgentMeta } from '../lib/agents'
import { useNow } from '../lib/useNow'
import type { AgentSettings, GitBranches, Session, Settings } from '../types'
import { Skeleton } from '../components/bits'
import { ModelPicker } from '../components/pickers/ModelPicker'
import { Button, Chip, Disclosure, Input, Segmented, Select, Switch, Textarea } from '../components/ui'

const MAIN = 'gigacode'
const VARS = ['{taskUrl}', '{notes}', '{key}', '{title}', '{description}', '{targets}', '{branch}', '{repo}']
const TIMEOUTS = [60, 120, 180, 300]
const SYNC = [{ v: 0, l: 'выключено' }, { v: 60, l: 'каждую минуту' }, { v: 300, l: 'каждые 5 мин' }, { v: 900, l: 'каждые 15 мин' }, { v: 1800, l: 'каждые 30 мин' }]
const CUSTOM = '__custom'

const GIT_TEMPLATES: { key: keyof Settings['git']; label: string; presets: string[]; hint: string }[] = [
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

/** Number of leaf values that differ (the save bar shows it). */
function countChanges(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  let n = 0
  for (const k of keys) n += countChanges((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  return n
}

/** Which field a server validation error is about (shown next to that field). */
const FIELD_HINTS: [RegExp, string][] = [
  [/approvalMode/i, 'mode'], [/taskPromptTemplate|template/i, 'command'], [/refreshSec/i, 'sync'],
  [/urlTemplate/i, 'url'], [/space/i, 'space'], [/defaultBase/i, 'base'], [/branchTemplate|portBranch|TitleTemplate/i, 'git'],
]

export function SettingsView() {
  const conn = useStore((s) => s.conn)
  const [orig, setOrig] = useState<Settings | null>(null)
  const [form, setForm] = useState<Settings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<{ field: string | null; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const changes = useMemo(() => (orig && form ? countChanges(orig, form) : 0), [orig, form])

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
      const saved = (await api<Settings>('PUT', '/settings', form)) ?? form
      setOrig(saved)
      setForm(structuredClone(saved))
      setState({ settings: saved })
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

  const main = form.agents[MAIN] ? MAIN : form.defaultAgent
  const others = Object.keys(form.agents).filter((id) => id !== main)

  return (
    <Shell>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); if (changes) void save() }}>
        <div className="settings-body">
          <AgentSection id={main} form={form} update={update} fieldError={fieldError} primary />
          <OrchestrationSection form={form} update={update} />
          <TrackerSection form={form} update={update} fieldError={fieldError} />
          <GitSection form={form} update={update} fieldError={fieldError} />
          <PrSection form={form} update={update} />
          {others.length > 0 && (
            <section className="settings-section">
              <Disclosure className="settings-others" summary={<h2>Другие агенты (для разработки)</h2>}>
                <div className="settings-others-body">
                  {others.map((id) => <AgentSection key={id} id={id} form={form} update={update} fieldError={fieldError} />)}
                </div>
              </Disclosure>
            </section>
          )}
        </div>
        {(changes > 0 || saveError) && (
          <div className="save-bar" role="region" aria-label="Несохранённые изменения">
            <span className="save-bar-count">
              {changes > 0 ? <>Несохранённых изменений: <span className="num">{changes}</span></> : 'Не сохранено'}
            </span>
            {saveError && !saveError.field && <span className="field-error" role="alert">{saveError.text}</span>}
            <span className="grow" />
            <Button onClick={() => { setForm(structuredClone(orig)); setSaveError(null) }} disabled={saving}>Отменить</Button>
            <Button type="submit" variant="primary" disabled={saving || !changes}>{saving ? 'Сохраняем…' : 'Сохранить'}</Button>
          </div>
        )}
      </form>
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="settings-view">
      <header className="view-head">
        <h1>Настройки</h1>
        <span className="muted">сохраняются в harness.config.local.json; секреты здесь не показываются</span>
      </header>
      {children}
    </div>
  )
}

/** A settings row: label and one-line explanation on the left, the control on the right, error under it. */
function Row({ label, hint, error, children, wide }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; wide?: boolean }) {
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
  const enabledAgents = Object.keys(form.agents).filter((k) => form.agents[k].enabled !== false)
  const catalog = normModels(a.models)
  const unavailable = (m: string | undefined) => !!m && catalog.find((x) => x.id === m)?.available === false

  return (
    <section className="settings-section" id={`set-${id}`}>
      <h2>{label}{!primary && <span className="mono muted"> {id}</span>}</h2>
      {primary && <AgentStatus id={id} />}
      <div className="set-rows">
        {a.enabled !== undefined && (
          <Row label="Включён" hint="Выключенный агент не предлагается для новых чатов и задач.">
            <Switch label={`${label} включён`} checked={a.enabled !== false} onChange={(v) => set({ enabled: v })} />
          </Row>
        )}
        {primary && enabledAgents.length > 1 && (
          <Row label="Агент по умолчанию" hint="Для «Новый чат» и «Взять в работу».">
            <Select label="Агент по умолчанию" value={form.defaultAgent} onChange={(v) => update({ ...form, defaultAgent: v })}
              options={Object.keys(form.agents).map((k) => ({ value: k, label: labels.find((x) => x.id === k)?.label ?? k, hint: k }))} />
          </Row>
        )}
        <Row label="Модель по умолчанию" hint="Если пусто, модель выбирает сам CLI.">
          <ModelPicker variant="field" agentId={id} label="Модель по умолчанию" value={a.model} onChange={(m) => set({ model: m })} placement="bottom-start" emptyText="как в CLI" />
        </Row>
        {a.approvalModes.length > 0 && (
          <Row label="Режим подтверждений" hint={modeLabels[a.approvalMode ?? ''] ?? 'Что агенту можно делать без вопроса.'} error={fieldError('mode')} wide>
            <Segmented label="Режим подтверждений" value={a.approvalMode ?? ''} onChange={(m) => set({ approvalMode: m })}
              options={a.approvalModes.map((m) => ({ value: m, label: modeShort(m), hint: modeLabels[m] ?? m, tone: FULL_ACCESS.has(m) ? 'access' : undefined }))} />
          </Row>
        )}
      </div>

      {primary && (
        <>
          <h3>Уровни моделей</h3>
          <p className="set-note">Внутренние агенты GigaCode просят модель по уровню; здесь задано, какая модель стоит за каждым.</p>
          <div className="set-rows">
            {GRADES.map((g) => (
              <Row key={g} label={g} error={unavailable(a.modelGrades[g]) ? 'Модель недоступна: выберите другую' : undefined}>
                <ModelPicker variant="field" agentId={id} label={`Модель уровня ${g}`} value={a.modelGrades[g] ?? null} placement="bottom-start" emptyText="не задана"
                  onChange={(m) => { const grades = { ...a.modelGrades }; if (m) grades[g] = m; else delete grades[g]; set({ modelGrades: grades }) }} />
              </Row>
            ))}
            <Row label="Разрешённые уровни" hint="Какие уровни агенту можно запрашивать.">
              <div className="chips">
                {GRADES.map((g) => (
                  <Chip key={g} mono pressed={a.allowedGrades.includes(g)} onClick={() => set({ allowedGrades: a.allowedGrades.includes(g) ? a.allowedGrades.filter((x) => x !== g) : [...a.allowedGrades, g] })}>{g}</Chip>
                ))}
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

      <h3>Запуск</h3>
      <div className="set-rows">
        <CommandRow id={id} a={a} set={set} error={fieldError('command')} />
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
      </div>
    </section>
  )
}

/** CLI resolution and what the last session reported. */
function AgentStatus({ id }: { id: string }) {
  const meta = useAgentMeta(id)
  const now = useNow()
  const [checking, setChecking] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const login = async () => {
    const s = await tryApi<Session>('POST', '/sessions', { kind: 'terminal', agent: id, title: 'Вход в GigaCode' })
    if (s) adoptSession(s)
  }
  const refreshModels = async () => {
    setRefreshing(true)
    const res = await tryApi<{ error?: string }>('POST', `/agents/${encodeURIComponent(id)}/models/refresh`)
    setRefreshing(false)
    if (res?.error) toast(`Список моделей не обновлён: ${res.error}`, 'error')
    loadAgentMeta(id, true)
    void loadSettings(true)
  }
  const recheck = async () => {
    setChecking(true)
    try {
      const m = await api<NonNullable<typeof meta>>('GET', `/agents/${encodeURIComponent(id)}/info`)
      setState((s) => ({ agentMeta: { ...s.agentMeta, [id]: m } }))
    } catch { /* keep the last answer */ }
    setChecking(false)
  }
  if (meta === undefined) return <div className="status-card"><Skeleton rows={3} label="Проверяем CLI…" /></div>
  if (meta === null) return <p className="set-note">Сервер не сообщает состояние CLI (нужна новая версия harness).</p>
  const r = meta.resolved
  const seen = meta.seen
  const Ok = ({ ok }: { ok: boolean }) => (ok ? <CircleCheck className="ok" aria-label="да" /> : <CircleX className="bad" aria-label="нет" />)
  return (
    <div className="status-card" data-bad={!r.ok || undefined}>
      <div className="status-head">
        <Ok ok={r.ok} />
        <strong>{r.ok ? 'CLI найден' : 'CLI не найден'}</strong>
        {seen?.version && <span className="mono muted">v{seen.version}</span>}
        <span className="grow" />
        <Button size="sm" variant="ghost" icon={<RefreshCw className={checking ? 'spinner' : undefined} />} onClick={() => void recheck()} disabled={checking}>Проверить</Button>
      </div>
      {!r.ok && (
        <p className="status-error">{r.error ?? 'Команда не разрешилась.'} Проверьте <span className="mono">agents.{id}.command</span> в harness.config.local.json.</p>
      )}
      <dl className="status-grid">
        {r.command && <><dt>Команда</dt><dd className="mono">{r.command}</dd></>}
        {r.node && <><dt>Node</dt><dd className="mono">{r.node}</dd></>}
        {r.entry && <><dt>Точка входа</dt><dd className="mono">{r.entry}</dd></>}
        <dt>Вход</dt>
        <dd className="status-auth">
          {meta.auth === 'ok' || (meta.auth === undefined && r.identity) ? <><Ok ok />выполнен</>
            : meta.auth === 'required' || (meta.auth === undefined && !r.identity) ? <><TriangleAlert className="warn" aria-hidden />требуется вход</>
              : <span className="muted">неизвестно (станет ясно при первом запуске)</span>}
          {meta.auth !== 'ok' && r.ok && <Button size="sm" icon={<LogIn />} onClick={() => void login()}>Войти в GigaCode</Button>}
        </dd>
        <dt>Каталог моделей</dt>
        <dd className="status-auth">
          {meta.catalog?.error ? <span className="field-error">{meta.catalog.error}</span>
            : meta.catalog?.at ? <span>обновлён {relTime(meta.catalog.at, now)} назад</span> : <span className="muted">ещё не запрашивался</span>}
          <Button size="sm" variant="ghost" icon={<RefreshCw className={refreshing ? 'spinner' : undefined} />} disabled={refreshing || !r.ok} onClick={() => void refreshModels()}>Обновить список</Button>
        </dd>
        {seen && (
          <>
            <dt>MCP-серверы</dt>
            <dd className="status-mcp">
              {seen.mcpServers.length ? seen.mcpServers.map((s) => {
                const ok = /connect|ok|ready|running/i.test(s.status)
                return <span key={s.name} className="mcp-item" data-bad={!ok || undefined} data-tip={s.status}>{ok ? <CircleCheck /> : <CircleX />}{s.name}</span>
              }) : <span className="muted">нет</span>}
            </dd>
            <dt>Команды</dt><dd>{seen.slashCommands.length ? `${seen.slashCommands.length} slash-команд` : <span className="muted">не сообщались</span>}</dd>
          </>
        )}
      </dl>
      <p className="set-note">{seen ? `По данным последней сессии, ${relTime(seen.at, now)} назад.` : 'Сессий этого агента ещё не было: MCP и команды появятся после первого запуска.'}</p>
    </div>
  )
}

/** Task command: a preset or a custom template with clickable variables; warns when the slash command is unknown. */
function CommandRow({ id, a, set, error }: { id: string; a: AgentSettings; set: (p: Partial<AgentSettings>) => void; error?: string }) {
  const meta = useAgentMeta(id)
  const presets = a.taskPromptPresets ?? []
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
          options={[...presets.map((p) => ({ value: p, label: p.split('\n')[0], text: p })), { value: CUSTOM, label: 'Свой шаблон…', text: 'Свой шаблон' }]} />
      )}
      {(custom || !presets.length) && (
        <>
          <Textarea ref={area} mono rows={3} aria-label="Шаблон команды" placeholder="/full-task {taskUrl}{notes}" value={value} onChange={(e) => set({ taskPromptTemplate: e.target.value || null })} />
          <div className="chips" aria-label="Переменные">
            {VARS.map((v) => <Chip key={v} mono onClick={() => insert(v)} tip="Вставить в шаблон">{v}</Chip>)}
          </div>
        </>
      )}
      {unknown && <span className="field-warn"><TriangleAlert aria-hidden />Команда /{cmd} не встречалась в сессиях GigaCode. Проверьте, что она установлена.</span>}
      {known.length > 0 && <span className="set-hint">Известные команды: <span className="mono">{known.slice(0, 12).join(' ')}{known.length > 12 ? ' …' : ''}</span></span>}
    </Row>
  )
}

// ---------- tracker ----------

function TrackerSection({ form, update, fieldError }: SectionProps) {
  const t = form.integrations?.tasks
  const set = (patch: NonNullable<NonNullable<Settings['integrations']>['tasks']>) =>
    update({ ...form, integrations: { ...form.integrations, tasks: { ...t, ...patch } } })
  const refresh = form.tasks.refreshSec
  const space = t?.space ?? ''
  const sample = (t?.urlTemplate ?? '').replaceAll('{key}', `${space || 'PROJ'}-1234`)
  return (
    <section className="settings-section" id="set-tracker">
      <h2>Трекер (onework)</h2>
      <div className="set-rows">
        {t && (
          <Row label="Импорт задач" hint="Задачи пространства появляются на доске; статус в трекере меняется только явно.">
            <Switch label="Импорт задач из трекера" checked={!!t.enabled} onChange={(v) => set({ enabled: v })} />
          </Row>
        )}
        {t && (
          <Row label="Пространство" hint="Код пространства в трекере." error={fieldError('space')}>
            <Input mono className="input-short" value={space} placeholder="PROJ" onChange={(e) => set({ space: e.target.value.trim().toUpperCase() })} />
          </Row>
        )}
        {t && (
          <Row label="Ссылка на задачу" hint={sample ? <>Пример: <span className="mono">{sample}</span></> : 'Шаблон с {key}; из него берётся {taskUrl}.'} error={fieldError('url')} wide>
            <Input mono value={t.urlTemplate ?? ''} placeholder="https://tracker/swtr/units/all/unit/{key}" onChange={(e) => set({ urlTemplate: e.target.value })} />
          </Row>
        )}
        {t && <StartTransitionRow value={t.onStartTransition ?? ''} statuses={Object.keys(t.statusMap ?? {})} onChange={(v) => set({ onStartTransition: v || null })} />}
        <Row label="Синхронизация" hint="Как часто перечитывать задачи из трекера." error={fieldError('sync')}>
          <Select label="Интервал синхронизации" value={String(refresh)} onChange={(v) => update({ ...form, tasks: { ...form.tasks, refreshSec: Number(v) } })}
            options={[...SYNC, ...(SYNC.some((s) => s.v === refresh) ? [] : [{ v: refresh, l: `каждые ${refresh} с` }])].map((s) => ({ value: String(s.v), label: s.l }))} />
        </Row>
      </div>
      {t?.statusMap && Object.keys(t.statusMap).length > 0 && (
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
    </section>
  )
}

// ---------- git ----------

function GitSection({ form, update, fieldError }: SectionProps) {
  const workspaces = useStore((s) => s.workspaces)
  const [branches, setBranches] = useState<string[]>([])
  const ws = workspaces.find((w) => w.isGit)
  useEffect(() => {
    if (!ws) return
    api<GitBranches>('GET', `/git/branches${qs({ cwd: ws.path })}`).then((r) => setBranches(r.branches.filter((b) => !b.remote).map((b) => b.name)), () => setBranches([]))
  }, [ws])
  const g = form.git
  const set = (patch: Partial<Settings['git']>) => update({ ...form, git: { ...g, ...patch } })
  const bases = [...new Set(['develop', 'main', 'master', ...branches, ...(g.defaultBase ? [g.defaultBase] : [])])]
  return (
    <section className="settings-section" id="set-git">
      <h2>Git</h2>
      <div className="set-rows">
        <Row label="Базовая ветка" hint={ws ? `Ветки ${ws.name} и стандартные имена.` : 'От неё создаются ветки задач.'} error={fieldError('base')}>
          <Select label="Базовая ветка" mono value={g.defaultBase ?? ''} onChange={(v) => set({ defaultBase: v })} options={bases.map((b) => ({ value: b, label: b }))} />
        </Row>
        {GIT_TEMPLATES.map((f) => <TemplateRow key={f.key} f={f} value={g[f.key] ?? ''} onChange={(v) => set({ [f.key]: v })} error={fieldError('git')} />)}
      </div>
      <p className="set-note">Превью на примере задачи <span className="mono">{SAMPLE.key}</span> «{SAMPLE.title}», цель <span className="mono">{SAMPLE.target}</span>.</p>
    </section>
  )
}

function TemplateRow({ f, value, onChange, error }: { f: (typeof GIT_TEMPLATES)[number]; value: string; onChange: (v: string) => void; error?: string }) {
  const [custom, setCustom] = useState(!!value && !f.presets.includes(value))
  return (
    <Row label={f.label} hint={<>{f.hint} <span className="set-preview">→ <span className="mono">{value ? render(value) : '—'}</span></span></>} error={error}>
      <Select label={f.label} mono value={custom ? CUSTOM : value || CUSTOM}
        onChange={(v) => { if (v === CUSTOM) setCustom(true); else { setCustom(false); onChange(v) } }}
        options={[...f.presets.map((p) => ({ value: p, label: p, hint: render(p) })), { value: CUSTOM, label: 'Свой…', text: 'Свой' }]} />
      {custom && <Input mono aria-label={`${f.label}: свой шаблон`} value={value} placeholder={f.presets[0]} onChange={(e) => onChange(e.target.value)} />}
    </Row>
  )
}

// ---------- PR ----------

function PrSection({ form, update }: Omit<SectionProps, 'fieldError'>) {
  const pr = form.integrations?.pr
  if (!pr) return null
  const lim = pr.limits ?? {}
  return (
    <section className="settings-section" id="set-pr">
      <h2>Pull requests</h2>
      <div className="set-rows">
        <Row label="Создание PR" hint="Кнопка «Создать PR» в панели изменений.">
          <Switch label="Создание PR" checked={!!pr.enabled} onChange={(v) => update({ ...form, integrations: { ...form.integrations, pr: { ...pr, enabled: v } } })} />
        </Row>
        <Row label="Ограничения" hint="Лимиты сервера sourcecontrol, в байтах UTF-8 (кириллица — 2 байта на букву).">
          <span className="set-readonly">заголовок до <span className="num">{lim.titleBytes ?? 100}</span> байт, описание до <span className="num">{lim.bodyBytes ?? 512}</span> байт</span>
        </Row>
      </div>
    </section>
  )
}

// ---------- orchestration ----------

function OrchestrationSection({ form, update }: Omit<SectionProps, 'fieldError'>) {
  const o = form.orchestration ?? {}
  const mode = o.reviewMode ?? 'internal'
  return (
    <section className="settings-section" id="set-orchestration">
      <h2>Оркестрация</h2>
      <div className="set-rows">
        <Row label="Ревью" wide hint={mode === 'internal'
          ? 'Как в CLI: /full-task сам запускает субагента-ревьюера; его шаги и вывод видны в карточке субагента в чате.'
          : 'Через харнесс: ревью идёт отдельными чатами-исполнителями, их видно в боковой панели и в панели агентов.'}>
          <Segmented label="Режим ревью" value={mode} onChange={(v) => update({ ...form, orchestration: { ...o, reviewMode: v } })}
            options={[{ value: 'internal', label: 'Внутри агента (как в CLI)' }, { value: 'harness', label: 'Через харнесс (отдельные чаты)' }]} />
        </Row>
      </div>
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
