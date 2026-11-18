import { useEffect, useState } from 'react'
import { Check, Circle, CircleAlert } from 'lucide-react'
import { api, errorText, tryApi } from '../api'
import { openDialog, openScreen, toast, useStore } from '../store'
import { loadDraft, saveDraft } from '../lib/draft'
import type { AgentMeta, Settings } from '../types'
import { FolderPicker } from './FolderPicker'
import { Disclosure } from './ui'

type Action = { label: string; run: () => void }
type Step = { key: string; done: boolean; title: string; hint: string; optional?: boolean; action?: Action; alt?: Action }

/**
 * «Начало работы» on the home screen: what this installation still needs before a task can go to an agent — each step
 * with what it means and one button that fixes it. Gone by itself once the required steps are done (or hidden by hand).
 */
export function GettingStarted() {
  const agents = useStore((s) => s.agents)
  const defaultAgent = useStore((s) => s.defaultAgent)
  const root = useStore((s) => s.workspaces.find((w) => w.kind === 'root'))
  const projects = useStore((s) => s.workspaces.filter((w) => !w.kind).length)
  const integrations = useStore((s) => s.integrations)
  const agent = agents.find((a) => a.id === defaultAgent && a.enabled) ?? agents.find((a) => a.enabled)
  const [info, setInfo] = useState<AgentMeta | null>(null)
  const [tick, setTick] = useState(0)
  const [picking, setPicking] = useState(false)
  const [hidden, setHidden] = useState(() => loadDraft<boolean>('home:setup-hidden') ?? false)

  useEffect(() => {
    if (!agent) return
    let live = true
    api<AgentMeta>('GET', `/agents/${agent.id}/info`).then((i) => { if (live) setInfo(i) }, () => { if (live) setInfo(null) })
    return () => { live = false }
  }, [agent?.id, tick])

  if (hidden || !agent || !info) return null
  const setRoot = async (path: string) => {
    setPicking(false)
    try { await api<Settings>('PUT', '/settings', { workspaces: { root: path } }) } catch (e) { toast(`Не удалось сохранить папку: ${errorText(e)}`, 'error') }
  }
  const install = async () => {
    if (await tryApi('POST', `/agents/${agent.id}/skills/install`, { name: 'harness-orchestration' })) setTick(tick + 1)
  }
  const settings = { label: 'Открыть настройки', run: () => openScreen('settings') }
  const skill = info.skills?.['harness-orchestration']
  const steps: Step[] = [
    { key: 'cli', done: info.resolved.ok, title: info.resolved.ok ? `${agent.label} найден` : `Укажите путь к ${agent.label}`, hint: info.resolved.ok ? 'Агент запускается.' : `Не найден запуск агента${info.resolved.error ? `: ${info.resolved.error}` : ''}. Укажите путь в настройках.`, action: settings },
    // a folder with all the projects (the agent picks one), or just a project: not everyone keeps them in one place
    { key: 'root', done: !!root || projects > 0, title: 'Где ваши проекты', hint: root ? root.path : projects ? `Открыто проектов: ${projects}. Папка со всеми проектами — необязательно: тогда агент сам выберет нужный.` : 'Папка, где лежат все проекты (агент сам выберет нужный), или один проект.',
      action: { label: 'Папка со всеми проектами…', run: () => setPicking(true) }, alt: { label: 'Один проект…', run: () => openDialog({ kind: 'workspace' }) } },
    { key: 'skill', done: skill === 'installed', optional: true, title: 'Навык оркестрации', hint: skill === 'installed' ? 'Агент запускает субагентов отдельными чатами.' : 'Без него агент не знает, как запускать субагентов через харнесс.', action: { label: skill === 'different' ? 'Обновить' : 'Установить', run: () => void install() } },
    { key: 'auth', done: info.auth === 'ok', optional: info.auth !== 'required', title: 'Вход в агента', hint: info.auth === 'required' ? 'Агент просит войти: откройте ссылку из чата или войдите в настройках.' : info.auth === 'ok' ? 'Вход выполнен.' : 'Станет ясно при первом запуске; если агент попросит войти — откройте ссылку.', action: info.auth === 'required' ? settings : undefined },
    { key: 'tasks', done: integrations.tasks, optional: true, title: 'Трекер задач', hint: integrations.tasks ? 'Задачи подтягиваются на доску.' : 'Необязательно: без трекера задачу можно описать словами.', action: integrations.tasks ? undefined : settings },
    { key: 'pr', done: integrations.pr, optional: true, title: 'Пулл-реквесты', hint: integrations.pr ? 'PR создаются из панели изменений.' : 'Необязательно: без него коммит и push работают, PR — вручную.', action: integrations.pr ? undefined : settings },
  ]
  const required = steps.filter((s) => !s.optional)
  const extra = steps.filter((s) => s.optional) // folded: a task can go to the agent without them
  if (required.every((s) => s.done)) return null
  const left = required.filter((s) => !s.done).length

  return (
    <section className="setup" aria-label="Начало работы">
      <header className="setup-head">
        <h2>Начало работы</h2>
        <span className="muted">осталось {left} из {required.length}</span>
        <button type="button" className="link-btn" onClick={() => { setHidden(true); saveDraft('home:setup-hidden', true) }}>Скрыть</button>
      </header>
      <ol className="setup-steps">
        {required.map((s) => (
          <li key={s.key} className="setup-step" data-done={s.done || undefined} data-optional={(s.optional && !s.done) || undefined}>
            {s.done ? <Check className="setup-mark" aria-label="готово" /> : s.optional ? <Circle className="setup-mark" aria-label="необязательно" /> : <CircleAlert className="setup-mark" aria-label="нужно сделать" />}
            <div className="setup-text">
              <strong>{s.title}</strong>
              <span className="muted">{s.hint}</span>
            </div>
            {!s.done && s.alt && <button type="button" className="btn btn-sm" onClick={s.alt.run}>{s.alt.label}</button>}
            {!s.done && s.action && <button type="button" className="btn btn-sm" onClick={s.action.run}>{s.action.label}</button>}
          </li>
        ))}
      </ol>
      <Disclosure className="setup-extra" summary={<span>Дополнительно · {extra.filter((s) => s.done).length} из {extra.length}</span>}>
        <ol className="setup-steps">
          {extra.map((s) => (
            <li key={s.key} className="setup-step" data-done={s.done || undefined} data-optional={!s.done || undefined}>
              {s.done ? <Check className="setup-mark" aria-label="готово" /> : <Circle className="setup-mark" aria-label="необязательно" />}
              <div className="setup-text"><strong>{s.title}</strong><span className="muted">{s.hint}</span></div>
              {!s.done && s.action && <button type="button" className="btn btn-sm" onClick={s.action.run}>{s.action.label}</button>}
            </li>
          ))}
        </ol>
      </Disclosure>
      {picking && <FolderPicker title="Папка с проектами" onClose={() => setPicking(false)} onPick={(p) => void setRoot(p)} />}
    </section>
  )
}
