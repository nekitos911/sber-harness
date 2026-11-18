import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChipsInput } from '../components/ChipsInput'
import { DEFAULT_REWORK } from '../components/board/Rework'
import { FolderPicker } from '../components/FolderPicker'
import { ArrowDown, ArrowUp, Check, CircleCheck, Pencil, CircleX, LogIn, Plus, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { api, ApiError, errorText, qs, tryApi } from '../api'
import { setState, toast, useFeature, useStore } from '../store'
import { adoptSession } from '../lib/actions'
import { desktopNotifyOn, setDesktopNotify } from '../lib/notify'
import { ago, COLUMNS } from '../lib/format'
import { FULL_ACCESS, GRADES, loadAgentMeta, loadSettings, modeShort, normMeta, normModels, useAgentMeta } from '../lib/agents'
import { useNow } from '../lib/useNow'
import type { AgentSettings, BoardColumn, BoardSettings, GitBranches, Grade, Session, Settings, TaskStatus } from '../types'
import { Skeleton } from '../components/bits'
import { ModelPicker } from '../components/pickers/ModelPicker'
import { Button, Chip, Disclosure, IconButton, Input, Segmented, Select, SuggestInput, Switch, Textarea } from '../components/ui'

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
        <div className="settings-layout">
        <SectionNav sections={[
          ['set-general', 'Общие'], ['set-gigacode', 'GigaCode'], ['set-orchestration', 'Оркестрация'],
          ...(form.board ? [['set-board', 'Доска'] as [string, string]] : []), ['set-tracker', 'Трекер'], ['set-git', 'Git'],
          ...(form.integrations?.pr ? [['set-pr', 'Pull requests'] as [string, string]] : []),
        ]} />
        <div className="settings-body" id="settings-scroll">
          <GeneralSection form={form} update={update} />
          <AgentSection id={main} form={form} update={update} fieldError={fieldError} primary />
          <OrchestrationSection form={form} update={update} />
          <BoardSection form={form} update={update} />
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
  const catalog = normModels(a.models)
  const [gradesOpen, setGradesOpen] = useState(false)
  const acpOn = useFeature('acp')
  const reworkOn = useFeature('rework')
  const unavailable = (m: string | undefined) => !!m && catalog.find((x) => x.id === m)?.available === false

  return (
    <section className="settings-section" id={primary ? 'set-gigacode' : `set-${id}`}>
      <h2>{label}{!primary && <span className="mono muted"> {id}</span>}</h2>
      {primary && <AgentStatus id={id} />}
      <div className="set-rows">
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
        <div className="set-rows">
          <Row label="Уровни моделей" hint="Какая модель стоит за каждым уровнем у внутренних агентов GigaCode.">
            <AutoValue value={GRADES.filter((g) => a.modelGrades[g]).map((g) => `${g}: ${catalog.find((m) => m.id === a.modelGrades[g])?.label ?? a.modelGrades[g]}`).join(' · ') || 'как в CLI'}
              open={gradesOpen} onToggle={() => setGradesOpen(!gradesOpen)} />
          </Row>
        </div>
      )}
      {primary && gradesOpen && (
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
          <Row label={<>Как запускать агента <span className="badge-verify">ACP — экспериментально</span></>}
            hint={<>
              <span className="set-line">Каждое сообщение — новый запуск: как <code>gigacode -p</code> в консоли. Проверено, но каждый ответ начинается с запуска MCP (10–60 с), а запрещённые команды отклоняются сразу — их можно разрешить и повторить.</span>
              <span className="set-line">Процесс на весь чат: как интерактивный <code>gigacode</code>. MCP запускаются один раз, ответы быстрее, агент ждёт ваше разрешение. Ещё не проверено с GigaCode — попробуйте на тестовом чате; если что-то не так, верните первый вариант.</span>
            </>} wide>
            <Segmented label="Как запускать агента" value={a.transport ?? 'headless'} onChange={(v) => set({ transport: v })}
              options={[{ value: 'headless', label: 'Новый запуск на сообщение' }, { value: 'acp', label: 'Процесс на весь чат (ACP)' }]} />
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
            hint="Выключено (быстрее): «Полный доступ» работает как авто-правки + разрешённые команды. Включено: настоящий auto в песочнице рабочей папки GigaCode — без вопросов, но запуск может быть медленнее.">
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
      </div>
      </Advanced>
    </section>
  )
}

/** CLI resolution and what the last session reported. */
function AgentStatus({ id }: { id: string }) {
  const meta = useAgentMeta(id)
  const now = useNow()
  const [checking, setChecking] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [editPath, setEditPath] = useState(false)
  const refreshOn = useFeature('models-refresh')
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
      setState((s) => ({ agentMeta: { ...s.agentMeta, [id]: normMeta(m) } }))
    } catch { /* keep the last answer */ }
    setChecking(false)
  }
  if (meta === undefined) return <div className="status-card"><Skeleton rows={3} label="Проверяем CLI…" /></div>
  if (meta === null) return <p className="set-note">Состояние CLI недоступно в этой версии сервера.</p>
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
        {/* not found: the path field below has the one «Проверить» */}
        {r.ok && <Button size="sm" variant="ghost" icon={<RefreshCw className={checking ? 'spinner' : undefined} />} onClick={() => void recheck()} disabled={checking}>Проверить</Button>}
      </div>
      {!r.ok && <CliPathFix id={id} error={r.error ?? ''} onChecked={() => void recheck()} />}
      <dl className="status-grid">
        {r.ok && r.command && <><dt>Команда</dt><dd>{editPath ? <CliPathFix id={id} error="" initial={r.command} onChecked={() => { setEditPath(false); void recheck() }} /> : <AutoValue value={r.command} mono open={false} onToggle={() => setEditPath(true)} />}</dd></>}
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
            : meta.catalog?.at ? <span>обновлён {ago(meta.catalog.at, now)}</span> : <span className="muted">ещё не запрашивался</span>}
          {refreshOn && <Button size="sm" variant="ghost" icon={<RefreshCw className={refreshing ? 'spinner' : undefined} />} disabled={refreshing || !r.ok} onClick={() => void refreshModels()}>Обновить список</Button>}
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
      <p className="set-note">{seen ? `По данным последней сессии, ${ago(seen.at, now)}.` : 'Сессий этого агента ещё не было: MCP и команды появятся после первого запуска.'}</p>
    </div>
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
  const missing = QUICK_TOOLS.filter((t) => !list.includes(t))
  return (
    <Row label="Разрешённые команды" hint="Что CLI выполняет без вопроса в любом чате (шаблон вида run_shell_command(git)). Остальное агент попросит разрешить." wide>
      <ChipsInput label="шаблон" values={list} onChange={(v) => set({ allowedTools: v })} />
      {missing.length > 0 && (
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
  const servers = meta?.seen?.mcpServers ?? []
  if (!servers.length) return null
  const editable = a.mcpExclude !== undefined // a server that does not return the field would drop it on save
  const off = new Set(a.mcpExclude ?? [])
  return (
    <Row label="MCP-серверы для агентов" hint="Отключите ненужные или сломанные (например java-lsp), чтобы ускорить запуск." wide>
      <ul className="mcp-list">
        {servers.map((m) => {
          const ok = /connect|ok|ready|running/i.test(m.status)
          const excluded = off.has(m.name)
          return (
            <li key={m.name} data-off={excluded || undefined}>
              <span className="mcp-dot" data-ok={ok || undefined} aria-label={ok ? 'запускается' : `ошибка: ${m.status}`} />
              <span className="mono ellipsis">{m.name}</span>
              <span className="muted ellipsis">{excluded ? 'не запускается' : m.status}</span>
              {editable && <Switch label={`MCP ${m.name}`} checked={!excluded}
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
    <Row label="Команда доработки" hint="Сообщение агенту по кнопке «Доработать»: {notes} — что поправить, {taskUrl} — ссылка на задачу." wide>
      <Select label="Команда доработки" mono value={custom ? CUSTOM : value}
        onChange={(v) => { if (v === CUSTOM) setCustom(true); else { setCustom(false); set({ reworkPromptTemplate: v === DEFAULT_REWORK ? null : v }) } }}
        options={[...presets.map((p) => ({ value: p, label: p.split('\n')[0], text: p, hint: p === DEFAULT_REWORK ? 'по умолчанию' : undefined })), { value: CUSTOM, label: 'Свой…', text: 'Свой шаблон' }]} />
      {custom && <Textarea mono rows={2} aria-label="Шаблон доработки" placeholder={DEFAULT_REWORK} value={a.reworkPromptTemplate ?? ''} onChange={(e) => set({ reworkPromptTemplate: e.target.value || null })} />}
    </Row>
  )
}

// ---------- tracker ----------

function TrackerSection({ form, update, fieldError }: SectionProps) {
  const t = form.integrations?.tasks
  const set = (patch: NonNullable<NonNullable<Settings['integrations']>['tasks']>) =>
    update({ ...form, integrations: { ...form.integrations, tasks: { ...t, ...patch } } })
  const refresh = form.tasks.refreshSec
  const spaces = Array.isArray(t?.space) ? t.space : t?.space ? [t.space] : []
  const sample = (t?.urlTemplate ?? '').replaceAll('{key}', `${spaces[0] || 'PROJ'}-1234`)
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
          <Row label="Пространства" hint="Коды пространств в трекере: задачи на вас импортируются из каждого. Enter или запятая — добавить." error={fieldError('space')}>
            <ChipsInput label="пространство" values={spaces}
              onChange={(v) => { const up = [...new Set(v.map((x) => x.trim().toUpperCase()).filter(Boolean))]; set({ space: up.length === 1 ? up[0] : up }) }} />
          </Row>
        )}
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
        <Row label="PR-интеграция" hint={pr.active === undefined ? 'Кнопка «Создать PR» в панели изменений и экран «Пулл-реквесты».'
          : pr.active ? 'Включена: «Создать PR» и экран «Пулл-реквесты» работают.' : 'Сейчас выключена: MCP-сервер sourcecontrol не найден или интеграция выключена.'}>
          <Segmented label="PR-интеграция" value={String(pr.enabled ?? 'auto') as 'auto' | 'true' | 'false'}
            onChange={(v) => update({ ...form, integrations: { ...form.integrations, pr: { ...pr, enabled: v === 'auto' ? 'auto' : v === 'true' } } })}
            options={[
              { value: 'auto', label: pr.enabled === 'auto' || pr.enabled === undefined ? (pr.active ? 'Авто (найден sourcecontrol)' : 'Авто (sourcecontrol не найден)') : 'Авто', hint: 'Включается сама, когда есть MCP-сервер sourcecontrol' },
              { value: 'true', label: 'Вкл' },
              { value: 'false', label: 'Выкл' },
            ]} />
        </Row>
        <Row label="Ваш логин" hint="Для «Мои PR». Пусто — берётся из sourcecontrol (git_get_user), а если он не ответил — имя пользователя ОС.">
          <input className="input mono" aria-label="Ваш логин в sourcecontrol" placeholder="авто" value={pr.me ?? ''}
            onChange={(e) => update({ ...form, integrations: { ...form.integrations, pr: { ...pr, me: e.target.value || null } } })} />
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
  const mode = o.reviewMode ?? 'builtin'
  const agentId = form.agents[MAIN] ? MAIN : form.defaultAgent
  return (
    <section className="settings-section" id="set-orchestration">
      <h2>Оркестрация</h2>
      <div className="set-rows">
        <Row label="Субагенты отдельными чатами (через harness)" wide
          hint="Агент сам запускает субагентов через harness: каждый откроется отдельным чатом. Если модель всё же использует встроенного субагента, он покажется чатом только для чтения.">
          <Switch label="Субагенты отдельными чатами" checked={(o.subagents ?? 'harness') === 'harness'}
            onChange={(v) => update({ ...form, orchestration: { ...o, subagents: v ? 'harness' : 'builtin' } })} />
          {(o.subagents ?? 'harness') === 'harness' && (
            <InstallFile id={agentId} kind="skills" name="harness-orchestration" target="~/.gigacode/skills/harness-orchestration/SKILL.md" title="навык harness-orchestration" action="Установить навык в GigaCode" />
          )}
        </Row>
        {o.subagentRetention !== undefined && (
          <Row label="Хранить завершённых субагентов в боковой панели" hint="Временные субагенты (в том же рабочем дереве) убираются после завершения; дочерние оркестраторы в других деревьях остаются. Чат убранного открывается из карточки в чате оркестратора.">
            <Switch label="Хранить завершённых субагентов" checked={o.subagentRetention === 'keep'}
              onChange={(v) => update({ ...form, orchestration: { ...o, subagentRetention: v ? 'keep' : 'archive' } })} />
          </Row>
        )}
        {o.maxSubagentDepth !== undefined && (
          <Row label="Глубина субагентов" hint="Может ли субагент запускать своих субагентов. 1 — только оркестратор.">
            <Select label="Глубина субагентов" value={String(o.maxSubagentDepth)} onChange={(v) => update({ ...form, orchestration: { ...o, maxSubagentDepth: Number(v) } })}
              options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} />
          </Row>
        )}
        <Row label="Ревью" wide hint={mode === 'builtin'
          ? 'Для /full-task оставьте «Внутри агента»: команда сама делает кросс-модельное ревью, харнесс показывает его в карточках субагентов и во вкладке «Вердикты».'
          : '«Через харнесс»: для задач без такой команды. Ревью идёт отдельным чатом-ревьюером другой моделью.'}>
          <Segmented label="Режим ревью" value={mode} onChange={(v) => update({ ...form, orchestration: { ...o, reviewMode: v } })}
            options={[{ value: 'builtin', label: 'Внутри агента (как в CLI)' }, { value: 'harness', label: 'Через харнесс (отдельные чаты)' }]} />
        </Row>
      </div>
      <Advanced id="orchestration">
        {form.session?.stallSec !== undefined && (
          <div className="set-rows">
            <Row label="«Нет вывода» через" hint="Работающий агент без единого события дольше этого считается зависшим: красный значок и предложение остановить.">
              <Select label="«Нет вывода» через" value={String(form.session.stallSec)} onChange={(v) => update({ ...form, session: { ...form.session, stallSec: Number(v) } })}
                options={[...new Set([30, 60, 120, 300, 600, 900, form.session.stallSec])].sort((x, y) => x - y).map((s) => ({ value: String(s), label: s < 60 ? `${s} с` : `${s / 60} мин` }))} />
            </Row>
          </div>
        )}
        {mode === 'harness' && <div className="set-rows"><ReviewRows form={form} update={update} /></div>}
        <p className="set-note">Ручная команда /full-task-harness больше не нужна: субагенты идут через harness автоматически. Её можно установить для старых сценариев.</p>
        <InstallFile id={agentId} kind="commands" name="full-task-harness" target="~/.gigacode/commands/full-task-harness.md" title="команда /full-task-harness" action="Установить в ~/.gigacode/commands" />
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
  const agentId = r.agent ?? (form.agents[MAIN] ? MAIN : form.defaultAgent)
  const agent = form.agents[agentId]
  const catalog = normModels(agent?.models)
  const grade = (r.grade ?? 'review') as Grade
  const resolved = agent?.modelGrades[grade]
  const area = useRef<HTMLTextAreaElement>(null)
  const tpl = r.promptTemplate ?? ''
  const insert = (v: string) => {
    const at = area.current?.selectionStart ?? tpl.length
    set({ promptTemplate: tpl.slice(0, at) + v + tpl.slice(at) })
  }
  return (
    <>
      <p className="set-note set-row-note">Работает независимо от содержимого /full-task: после worker_done harness запускает ревьюера другой моделью и возвращает замечания исполнителю.</p>
      <Row label="Модель ревьюера" hint={resolved ? <>уровень {grade}: <span className="mono">{catalog.find((m) => m.id === resolved)?.label ?? resolved}</span></> : 'Уровень не настроен: модель по умолчанию CLI.'}>
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

/** Local to this browser: desktop notifications for questions, results and errors while the tab is in the background. */
/** Общие: default agent, notifications, theme. */
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

function GeneralSection({ form, update }: Omit<SectionProps, 'fieldError'>) {
  const labels = useStore((s) => s.agents)
  const foldersOn = useFeature('folders')
  const scheme = useStore((s) => s.scheme)
  const [on, setOn] = useState(desktopNotifyOn)
  const supported = 'Notification' in window
  const denied = supported && Notification.permission === 'denied'
  return (
    <section className="settings-section" id="set-general">
      <h2>Общие</h2>
      <div className="set-rows">
        <Row label="Агент по умолчанию" hint="Для «Новый чат» и «Взять в работу».">
          <Select label="Агент по умолчанию" value={form.defaultAgent} onChange={(v) => update({ ...form, defaultAgent: v })}
            options={Object.keys(form.agents).filter((k) => form.agents[k].enabled !== false || k === form.defaultAgent)
              .map((k) => ({ value: k, label: labels.find((x) => x.id === k)?.label ?? k, hint: k }))} />
        </Row>
        {foldersOn && form.workspaces !== undefined && ( // only when the server's settings carry it (else a save would drop it)
          <Row label="Папка с проектами" hint="«Все проекты» в боковой панели и место нового чата, когда ничего не выбрано.">
            <ProjectsFolder value={form.workspaces?.root ?? null} onChange={(root) => update({ ...form, workspaces: { ...form.workspaces, root } })} />
          </Row>
        )}
        {form.sessions !== undefined && (
          <Row label="Автоархив неактивных чатов через" hint="Чаты без активности дольше этого уходят в архив (история сохраняется, вернуть — на экране «Агенты»).">
            <Select label="Автоархив неактивных чатов" value={!form.sessions.autoArchiveDays ? 'off' : String(form.sessions.autoArchiveDays)}
              onChange={(v) => update({ ...form, sessions: { ...form.sessions, autoArchiveDays: v === 'off' ? 0 : Number(v) } })}
              options={[{ value: 'off', label: 'выкл' }, { value: '1', label: '1 день' }, { value: '3', label: '3 дня' }, { value: '7', label: '7 дней' }, { value: '30', label: '30 дней' }]} />
          </Row>
        )}
        {form.recovery !== undefined && (
          <>
            <Row label="Продолжать прерванные сессии автоматически" hint="После перезапуска harness или ПК прерванные ходы продолжаются сами (координаторы — после своих исполнителей). Иначе — окно «Восстановление сессий».">
              <Switch label="Продолжать прерванные сессии автоматически" checked={!!form.recovery.autoResume} onChange={(v) => update({ ...form, recovery: { ...form.recovery, autoResume: v } })} />
            </Row>
            <Row label="Сообщение для продолжения" hint="Что получает агент, когда его прерванный ход продолжают." wide>
              <Textarea rows={2} aria-label="Сообщение для продолжения" value={form.recovery.message ?? ''} onChange={(e) => update({ ...form, recovery: { ...form.recovery, message: e.target.value } })} />
            </Row>
          </>
        )}
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
function InstallFile({ id, kind, name, target, title, action }: { id: string; kind: 'skills' | 'commands'; name: string; target: string; title: string; action: string }) {
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

/** Sticky section index with scroll-spy (the section under the top of the scroll area is current). */
function SectionNav({ sections }: { sections: [string, string][] }) {
  const [current, setCurrent] = useState(sections[0]?.[0])
  useEffect(() => {
    const root = document.getElementById('settings-scroll')
    if (!root) return
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      if (top) setCurrent(top.target.id)
    }, { root, rootMargin: '0px 0px -70% 0px' })
    for (const [id] of sections) { const el = document.getElementById(id); if (el) io.observe(el) }
    return () => io.disconnect()
  }, [sections.map(([id]) => id).join()])
  return (
    <nav className="settings-nav" aria-label="Разделы настроек">
      {sections.map(([id, label]) => (
        <a key={id} href={`#${id}`} aria-current={current === id ? 'true' : undefined}
          onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setCurrent(id) }}>{label}</a>
      ))}
    </nav>
  )
}

/** «CLI не найден»: the path in plain words, a field to fix it and a check; the raw message under «Подробности». */
function CliPathFix({ id, error, onChecked, initial }: { id: string; error: string; onChecked: () => void; initial?: string }) {
  const quoted = /"([^"]+)"/.exec(error)?.[1] ?? initial ?? ''
  const exe = quoted ? quoted.split(/[\\/]/).pop() : 'gigacode.cmd'
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
      {error && <p className="status-error">{/not found|не найден/i.test(error) ? <>Не найден {exe}{quoted && <>: <span className="mono">{quoted}</span></>}</> : 'CLI не запускается.'}</p>}
      <div className="cli-fix-row">
        <Input mono aria-label="Путь к gigacode.cmd" value={path} placeholder="C:/Program Files/.gigacode/bin/gigacode.cmd" onChange={(e) => setPath(e.target.value)} />
        <Button disabled={busy || !path.trim()} onClick={() => void check()}>{busy ? 'Проверяем…' : 'Проверить'}</Button>
      </div>
      {err && <p className="field-error">{err}</p>}
      {error && <Disclosure className="cli-raw" summary={<span className="muted">Подробности</span>}><pre className="mono">{error}</pre></Disclosure>}
    </div>
  )
}

/** Per-section «Расширенные»: closed by default, remembered in this browser. */
function Advanced({ id, children }: { id: string; children: ReactNode }) {
  const key = `harness.settings.adv.${id}`
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) === '1' } catch { return false } })
  return (
    <Disclosure className="settings-adv" open={open} onToggle={(v) => { setOpen(v); try { localStorage.setItem(key, v ? '1' : '0') } catch { /* not remembered */ } }}
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
