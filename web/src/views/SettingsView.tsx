import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, errorText } from '../api'
import { toast, useStore } from '../store'
import type { AgentSettings, Settings } from '../types'
import { ChipsInput } from '../components/ChipsInput'
import { Loading } from '../components/bits'

const GRADES = ['default', 'fast', 'review', 'explore'] as const
const GIT_FIELDS: { key: keyof Settings['git']; label: string; hint: string }[] = [
  { key: 'defaultBase', label: 'Базовая ветка', hint: 'например, develop' },
  { key: 'branchTemplate', label: 'Шаблон ветки задачи', hint: 'feature/{key}' },
  { key: 'portBranchTemplate', label: 'Шаблон ветки портирования', hint: '{branch}-{target}' },
  { key: 'commitTitleTemplate', label: 'Заголовок коммита', hint: '{key} {title}' },
  { key: 'prTitleTemplate', label: 'Заголовок PR', hint: '{key} {title}' },
]

export function SettingsView() {
  const conn = useStore((s) => s.conn)
  const labels = useStore((s) => s.agents)
  const [form, setForm] = useState<Settings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (conn !== 'open' || dirty) return
    api<Settings>('GET', '/settings').then(
      (s) => { setForm(s); setLoadError(null) },
      (e) => setLoadError(e instanceof ApiError && e.status === 404 ? 'Этот сервер ещё не умеет редактировать настройки из интерфейса. Обновите harness или правьте harness.config.local.json.' : errorText(e)),
    )
  }, [conn, dirty])

  if (loadError) return <div className="settings-view"><header className="view-head"><h1>Настройки</h1></header><div className="empty"><h2>Настройки недоступны</h2><p>{loadError}</p></div></div>
  if (!form) return <Loading label="Загрузка настроек…" />

  const update = (next: Settings) => { setForm(next); setDirty(true); setSaveError(null) }
  const setAgent = (id: string, patch: Partial<AgentSettings>) =>
    update({ ...form, agents: { ...form.agents, [id]: { ...form.agents[id], ...patch } } })

  const refresh = form.tasks.refreshSec
  const refreshInvalid = !Number.isInteger(refresh) || (refresh !== 0 && refresh < 10)

  const save = async () => {
    setSaving(true)
    try {
      const saved = await api<Settings>('PUT', '/settings', form)
      setForm(saved ?? form)
      setDirty(false)
      setSaveError(null)
      toast('Настройки сохранены', 'ok')
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-view">
      <header className="view-head">
        <h1>Настройки</h1>
        <span className="muted">сохраняются в harness.config.local.json · секреты здесь не показываются</span>
      </header>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); if (!refreshInvalid) void save() }}>
        <section className="settings-section">
          <h2>Агенты</h2>
          <Row label="Агент по умолчанию">
            <select className="select" value={form.defaultAgent} onChange={(e) => update({ ...form, defaultAgent: e.target.value })}>
              {Object.keys(form.agents).map((id) => <option key={id} value={id}>{labels.find((a) => a.id === id)?.label ?? id}</option>)}
            </select>
          </Row>
          {Object.entries(form.agents).map(([id, a]) => (
            <fieldset key={id} className="settings-card">
              <legend>{labels.find((x) => x.id === id)?.label ?? id} <span className="mono muted">{id}</span></legend>
              <div className="settings-grid">
                <Row label="Режим подтверждений">
                  <select className="select" value={a.approvalMode ?? ''} onChange={(e) => setAgent(id, { approvalMode: e.target.value || null })}>
                    {!a.approvalMode && <option value="">—</option>}
                    {a.approvalModes.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </Row>
                <Row label="Модель">
                  <input className="input mono" list={a.models?.length ? `models-${id}` : undefined} placeholder="по умолчанию CLI" value={a.model ?? ''} onChange={(e) => setAgent(id, { model: e.target.value || null })} />
                </Row>
              </div>
              {/* The agent's models as suggestions; any other name can still be typed. */}
              {!!a.models?.length && <datalist id={`models-${id}`}>{a.models.map((m) => <option key={m} value={m} />)}</datalist>}
              <div className="settings-grid settings-grades">
                {GRADES.map((g) => (
                  <Row key={g} label={`Модель: ${g}`}>
                    <input
                      className="input mono"
                      list={a.models?.length ? `models-${id}` : undefined}
                      placeholder={a.models?.length ? 'выберите или введите' : undefined}
                      value={a.modelGrades[g] ?? ''}
                      onChange={(e) => {
                        const grades = { ...a.modelGrades, [g]: e.target.value }
                        if (!e.target.value) delete grades[g]
                        setAgent(id, { modelGrades: grades })
                      }}
                    />
                  </Row>
                ))}
              </div>
              <Row label="Разрешённые уровни" group>
                <ChipsInput values={a.allowedGrades} label="уровень" onChange={(allowedGrades) => setAgent(id, { allowedGrades })} />
              </Row>
              <Row label="Шаблон промпта задачи" hint="пример: /full-task-ui {taskUrl}{notes}">
                <textarea
                  className="textarea mono"
                  rows={3}
                  placeholder="по умолчанию — общий шаблон задач"
                  value={a.taskPromptTemplate ?? ''}
                  onChange={(e) => setAgent(id, { taskPromptTemplate: e.target.value || null })}
                />
              </Row>
            </fieldset>
          ))}
        </section>

        <section className="settings-section">
          <h2>Git</h2>
          <div className="settings-grid">
            {GIT_FIELDS.map((f) => (
              <Row key={f.key} label={f.label}>
                <input className="input mono" placeholder={f.hint} value={form.git[f.key] ?? ''} onChange={(e) => update({ ...form, git: { ...form.git, [f.key]: e.target.value } })} />
              </Row>
            ))}
          </div>
          <p className="field-hint">Переменные: {'{key} {id} {title} {branch} {target}'}</p>
        </section>

        <section className="settings-section">
          <h2>Трекер</h2>
          <Row label="Обновлять каждые, сек" hint="0 — выключено, минимум 10" error={refreshInvalid ? 'Укажите 0 или целое число от 10' : undefined}>
            <input
              className="input num"
              type="number"
              min={0}
              step={1}
              style={{ width: 120 }}
              value={refresh}
              onChange={(e) => update({ ...form, tasks: { ...form.tasks, refreshSec: Number(e.target.value) } })}
            />
          </Row>
        </section>

        <div className="settings-actions">
          {saveError && <p className="field-error" role="alert">{saveError}</p>}
          <button type="submit" className="btn btn-primary" disabled={!dirty || saving || refreshInvalid}>{saving ? 'Сохраняем…' : 'Сохранить'}</button>
          {dirty && <button type="button" className="btn" onClick={() => { setDirty(false); setSaveError(null) }}>Отменить изменения</button>}
        </div>
      </form>
    </div>
  )
}

/** Labelled field; `group` for composite controls (a <label> would forward clicks to the first chip button). */
function Row({ label, hint, error, group, children }: { label: string; hint?: string; error?: string; group?: boolean; children: ReactNode }) {
  const body = (
    <>
      <span>{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint && <span className="field-hint">{hint}</span>}
    </>
  )
  return group ? <div className="field" role="group" aria-label={label}>{body}</div> : <label className="field">{body}</label>
}
