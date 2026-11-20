import { useEffect, useState } from 'react'
import { Check, Circle, CircleAlert, FolderOpen } from 'lucide-react'
import { api, errorText } from '../api'
import { getState, openDialog, openScreen, setState, toast, useStore } from '../store'
import { loadAgentMeta, useAgentMeta, useSettings } from '../lib/agents'
import type { Settings } from '../types'
import { FolderPicker } from '../components/FolderPicker'
import { Button, Disclosure, Input, Segmented, Select, Switch } from '../components/ui'
import { CliPathFix } from './SettingsView'

const SKILL = 'harness-orchestration'

/** The templates for «how the agent gets a task»: the person's own command (`/full-task …`), or the task as plain text. */
export function taskTemplates(command: string | null) {
  return command
    ? { taskPromptTemplate: `/${command} {taskUrl}{notes}`, freePromptTemplate: `/${command} {text}{notes}`, reworkPromptTemplate: `/${command} {taskUrl} Задача готова, но нужны правки: {notes}` }
    : { taskPromptTemplate: null, freePromptTemplate: null, reworkPromptTemplate: null } // the defaults: the task as its text
}

/** The command the agent's task template starts with (`/full-task {taskUrl}` → full-task), if any. */
const commandOf = (tpl: string | null | undefined) => tpl?.match(/^\/([\w.-]+)/)?.[1] ?? null

/** The agent the setup is about: the default one if enabled, else the first enabled. */
function useSetupAgent() {
  const agents = useStore((s) => s.agents)
  const defaultAgent = useStore((s) => s.defaultAgent)
  return agents.find((a) => a.id === defaultAgent && a.enabled) ?? agents.find((a) => a.enabled)
}

/** true while the first-run setup should stand in for «Главная»: not done or skipped, and the agent or the projects are missing. */
export function useSetupNeeded(): boolean | null {
  const settings = useSettings()
  const agent = useSetupAgent()
  const meta = useAgentMeta(agent?.id)
  const projects = useStore((s) => s.workspaces.some((w) => w.kind === 'root' || !w.kind))
  const missing = !!settings && !!agent && meta !== undefined && (!meta?.resolved.ok || !projects)
  const [started, setStarted] = useState(false)
  useEffect(() => { if (missing) setStarted(true) }, [missing])
  if (settings?.user?.setupDone) return false
  if (!settings || !agent || meta === undefined) return null
  return started || missing
}

/**
 * The first-run setup: only what a task cannot go to an agent without — the agent, where the projects are, how the
 * agent gets a task. Nothing here assumes one person's machine: no projects folder, no own command and no skills are
 * all fine. Shown on «Главная» until done or skipped; «Настройки» bring it back.
 */
export function SetupView() {
  const settings = useSettings()
  const agents = useStore((s) => s.agents)
  const workspaces = useStore((s) => s.workspaces)
  const first = useSetupAgent()
  const [agentId, setAgentId] = useState<string | null>(null)
  const id = agentId ?? first?.id ?? ''
  const agent = agents.find((a) => a.id === id)
  const meta = useAgentMeta(id || null)
  const root = workspaces.find((w) => w.kind === 'root')
  const projects = workspaces.filter((w) => !w.kind)
  const own = meta?.userCommands ?? []
  // what is set now counts only if the agent really has that command; a fresh install starts with the plain text
  const current = commandOf(settings?.agents[id]?.taskPromptTemplate) ?? commandOf(settings?.agents[id]?.freePromptTemplate)
  const known = current && (own.includes(current) || meta?.seen?.slashCommands.includes(current)) ? current : null
  const [how, setHow] = useState<'text' | 'command' | null>(null)
  const [command, setCommand] = useState<string | null>(null)
  const mode = how ?? (known ? 'command' : 'text')
  const cmd = (command ?? known ?? own[0] ?? '').replace(/^\//, '').trim()
  const skill = meta?.skills?.[SKILL]
  const [installSkill, setInstallSkill] = useState(false)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const agentOk = !!meta?.resolved.ok
  const placesOk = !!root || projects.length > 0
  const commandOk = mode === 'text' || /^[\w.-]+$/.test(cmd)
  const ready = agentOk && placesOk && commandOk

  const setRoot = async (path: string) => {
    setPicking(false)
    try {
      const saved = await api<Settings>('PUT', '/settings', { workspaces: { root: path } })
      if (saved) setState({ settings: saved })
    } catch (e) { toast(`Не удалось сохранить папку: ${errorText(e)}`, 'error') }
  }
  const finish = async (skip: boolean) => {
    setBusy(true)
    try {
      // the templates change only when the command does: someone's own wording of them stays; a command the agent does
      // not have (a default from another machine) is replaced by the plain text
      const chosen = mode === 'command' ? cmd : null
      const changed = !skip && chosen !== current
      if (!skip && installSkill && skill !== 'installed') await api('POST', `/agents/${encodeURIComponent(id)}/skills/install`, { name: SKILL, force: skill === 'different' || undefined })
      const saved = await api<Settings>('PUT', '/settings', { user: { setupDone: true }, ...(!skip && id ? { defaultAgent: id } : {}), ...(changed ? { agents: { [id]: taskTemplates(chosen) } } : {}) })
      setState({ settings: saved, ...(!skip ? { defaultAgent: id } : {}) })
      if (!skip) loadAgentMeta(id, true)
      const view = getState().view
      if (view.kind === 'screen' && view.screen === 'setup') openScreen('home')
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="setup firstrun" aria-label="Первый запуск">
      <header className="setup-head">
        <h2>Ваше рабочее место</h2>
        <span className="muted">Выберите агента и откройте проект, чтобы начать первый чат.</span>
      </header>
      <ol className="setup-steps firstrun-steps">
        <li className="firstrun-step" data-done={agentOk || undefined}>
          {agentOk ? <Check className="setup-mark" aria-label="готово" /> : <CircleAlert className="setup-mark" aria-label="нужно сделать" />}
          <div className="firstrun-body">
            <strong>Агент</strong>
            {agents.filter((a) => a.enabled).length > 1 && (
              <Select size="sm" label="Агент" value={id} onChange={(v) => { setAgentId(v); setHow(null); setCommand(null); setInstallSkill(false) }} options={agents.filter((a) => a.enabled).map((a) => ({ value: a.id, label: a.label }))} />
            )}
            {meta === undefined ? <span className="muted">Проверяем…</span>
              : agentOk ? <span className="muted">{agent?.label} найден{meta?.resolved.command ? <>: <span className="mono">{meta.resolved.command}</span></> : null}</span>
                : <CliPathFix id={id} error={meta?.resolved.error || 'Укажите путь к агенту'} onChecked={() => loadAgentMeta(id, true)} />}
            {meta?.auth === 'required' && <span className="field-warn">Агент просит войти: войдите в него в терминале или по ссылке из первого чата.</span>}
          </div>
        </li>

        <li className="firstrun-step" data-done={placesOk || undefined}>
          {placesOk ? <Check className="setup-mark" aria-label="готово" /> : <CircleAlert className="setup-mark" aria-label="нужно сделать" />}
          <div className="firstrun-body">
            <strong>Где ваши проекты</strong>
            <span className="muted">
              {root ? <>Папка со всеми проектами: <span className="mono">{root.path}</span> — агент сам выберет нужный проект.</>
                : projects.length ? <>Открыто: {projects.map((w) => w.name).join(', ')}. Если все проекты лежат в одной папке, укажите её — тогда агент выберет проект сам.</>
                  : 'Откройте репозиторий или выберите общую папку для нескольких проектов.'}
            </span>
            <div className="firstrun-actions">
              <Button size="sm" icon={<FolderOpen />} onClick={() => openDialog({ kind: 'workspace', stay: true })}>Открыть проект…</Button>
              <Button size="sm" onClick={() => setPicking(true)}>{root ? 'Другая папка с проектами…' : 'Папка со всеми проектами…'}</Button>
            </div>
          </div>
        </li>

      </ol>
      <Disclosure summary="Команда для задач и помощники" className="firstrun-options">
        <ul className="setup-steps">
        <li className="firstrun-step" data-done={commandOk || undefined} data-optional>
          {commandOk ? <Check className="setup-mark" aria-label="готово" /> : <Circle className="setup-mark" aria-label="не заполнено" />}
          <div className="firstrun-body">
            <strong>Есть ли у вас своя команда для задач? <span className="muted">· необязательно</span></strong>
            <span className="muted">Некоторые заводят в агенте команду, которая ведёт задачу по шагам: разобраться, сделать, проверить, открыть PR (например, <span className="mono">/full-task</span>). Если такой нет — ничего страшного, агент получит задачу как есть.</span>
            <Segmented size="sm" label="Своя команда для задач" value={mode} onChange={(v) => setHow(v)}
              options={[{ value: 'text', label: 'Нет' }, { value: 'command', label: 'Есть' }]} />
            {mode === 'command' && (
              <div className="firstrun-actions">
                <Input mono aria-label="Команда" value={cmd ? `/${cmd}` : ''} placeholder="/full-task" onChange={(e) => setCommand(e.target.value)} />
                {own.length > 0 && <span className="muted">нашлись у агента:</span>}
                {own.slice(0, 6).map((c) => <button key={c} type="button" className="chip chip-mono" aria-pressed={c === cmd} onClick={() => setCommand(c)}>/{c}</button>)}
              </div>
            )}
            <span className="muted">Так агент получит задачу PROJ-123:</span>
            <pre className="firstrun-example mono">{mode === 'command' && commandOk
              ? `/${cmd} https://tracker/…/PROJ-123`
              : 'PROJ-123: Добавить фильтр по дате\n\nОписание задачи из трекера…\n\nСсылка: https://tracker/…/PROJ-123'}</pre>
          </div>
        </li>

        {skill && skill !== 'installed' && (
          <li className="firstrun-step" data-optional>
            <Switch checked={installSkill} onChange={setInstallSkill} label="Показывать помощников агента" />
            <div className="firstrun-body">
              <strong>Показывать помощников агента <span className="muted">· необязательно</span></strong>
              <span className="muted">Иногда агент зовёт на помощь другого агента — например, проверить код свежим взглядом. Если включить, каждый такой помощник появится здесь отдельным чатом: видно, что он делает, ему можно ответить или остановить. Если нет — помощники работают внутри агента незаметно.</span>
              <span className="muted">Для этого в папку агента запишется файл с инструкцией (навык).</span>
            </div>
          </li>
        )}
        </ul>
      </Disclosure>
      <footer className="firstrun-foot">
        <button type="button" className="link-btn" disabled={busy} onClick={() => void finish(true)}>Пропустить</button>
        <span className="grow" />
        <Button variant="primary" disabled={!ready || busy} busy={busy} onClick={() => void finish(false)}>Начать работу</Button>
      </footer>
      {picking && <FolderPicker title="Папка со всеми проектами" onClose={() => setPicking(false)} onPick={(p) => void setRoot(p)} />}
    </section>
  )
}
