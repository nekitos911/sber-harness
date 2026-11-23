import { useEffect, useRef, useState } from 'react'
import { Check, RefreshCw, X } from 'lucide-react'
import { api, errorText } from '../api'
import { openScreen, setState, useFeature, useStore } from '../store'
import { mainAgent, useAgentMeta, useSettings } from '../lib/agents'
import { InstallFile } from '../views/SettingsView'
import { Button, Popover } from './ui'

interface McpServer { name: string; enabled: boolean; ok: boolean; error?: string; problem?: string; roles?: ('tasks' | 'pr')[]; tools?: { name: string }[] }

/** What the usual services are for, in words; the id stays next to it. */
const PURPOSE = { tasks: 'Трекер задач', pr: 'Пулл-реквесты' }

function SkillStatus() {
  const settings = useSettings()
  const enabled = useFeature('skills-install')
  const id = settings && enabled && settings.orchestration?.subagents !== 'builtin' ? mainAgent(settings) : ''
  const state = useAgentMeta(id)?.skills?.['harness-orchestration']
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (!state) return null
  const label = state === 'installed' ? 'Навык установлен' : state === 'different' ? 'Обновить навык' : 'Установить навык'
  return <>
    <button type="button" ref={anchor} className="sb-skill" data-ready={state === 'installed'} aria-expanded={open}
      data-tip="Навык оркестрации" onClick={() => setOpen(!open)}>{label}</button>
    <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-start" label="Навык оркестрации" className="sb-mcp-pop">
      <strong>Навык оркестрации · {id}</strong>
      <InstallFile key={id} id={id} kind="skills" name="harness-orchestration" target="harness-orchestration/SKILL.md" title="Навык оркестрации" action="Установить" />
    </Popover>
  </>
}

export function StatusBar() {
  const conn = useStore((s) => s.conn)
  const [mcp, setMcp] = useState<McpServer[] | null>(null)
  const [open, setOpen] = useState(false)
  const mcpBtn = useRef<HTMLButtonElement>(null)

  const canReconnect = useFeature('mcp-connections')
  const [pending, setPending] = useState<string[]>([])
  useEffect(() => {
    if (conn !== 'open') return
    let version = 0
    const refresh = () => {
      const ticket = ++version
      api<McpServer[]>('GET', '/mcp/servers').then((rows) => { if (ticket === version) setMcp(rows) }, () => { if (ticket === version) setMcp(null) })
    }
    refresh()
    window.addEventListener('mcp-changed', refresh)
    return () => { ++version; window.removeEventListener('mcp-changed', refresh) }
  }, [conn])

  const reconnect = async (name: string) => {
    setPending((names) => [...names, name])
    try {
      const row = await api<McpServer>('POST', '/mcp/servers/' + encodeURIComponent(name) + '/reconnect')
      setMcp((rows) => rows?.map((old) => old.name === name ? row : old) ?? null)
    } catch (e) {
      setMcp((rows) => rows?.map((old) => old.name === name ? { ...old, ok: false, problem: undefined, error: errorText(e) } : old) ?? null)
    } finally { setPending((names) => names.filter((n) => n !== name)) }
  }
  const enabled = mcp?.filter((m) => m.enabled) ?? []
  const broken = enabled.filter((m) => !m.ok || m.problem)

  return (
    <footer className="statusbar">
      <SkillStatus />
      {/* who works is in the sidebar («В работе», «Ждут вас»): the bar keeps only what is nowhere else */}
      {mcp && (
        <>
          <button ref={mcpBtn} type="button" className="end sb-mcp" aria-expanded={open} data-bad={broken.length > 0 || undefined} onClick={() => setOpen(!open)}>
            Сервисы: {enabled.length}
            {broken.length > 0 && `, с ошибкой: ${broken.length}`}
          </button>
          <Popover anchor={mcpBtn} open={open} onClose={() => setOpen(false)} placement="top-end" label="Сервисы для задач и PR" className="sb-mcp-pop">
            <strong className="sb-mcp-head">Состояние сервисов</strong>
            {enabled.length === 0 && <p className="muted">Нет включённых MCP-сервисов.</p>}
            {enabled.map((m) => {
              const purpose = m.roles?.map((role) => PURPOSE[role]).join(' · ')
              const error = m.problem || m.error
              const ok = m.ok && !error
              return <div key={m.name} className="sb-mcp-row" data-bad={!ok || undefined}>
                {ok ? <Check aria-hidden /> : <X aria-hidden />}
                <div className="sb-mcp-name"><strong>{purpose || m.name}</strong>
                  <small>{purpose && m.name + ' · '}{ok ? 'Подключено' : 'Ошибка подключения'}</small>
                </div>
                {canReconnect && <Button size="sm" variant="ghost" aria-label={'Переподключить ' + m.name} busy={pending.includes(m.name)}
                  icon={<RefreshCw />} onClick={() => void reconnect(m.name)}>Переподключить</Button>}
                {error && <div className="sb-mcp-err" role="status">
                  {/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_UNTRUSTED/i.test(error) && <p>Не удалось проверить цепочку сертификатов. Проверьте доверенный CA на этом компьютере.</p>}
                  {error}
                </div>}
              </div>
            })}
            <button type="button" className="link-btn" onClick={() => {
              setOpen(false); setState({ settingsCategory: 'Подключения' }); openScreen('settings')
            }}>Настроить подключения</button>
          </Popover>
        </>
      )}
      <span className={mcp ? 'conn' : 'conn end'} data-state={conn}>
        {conn === 'open' ? 'Подключено' : conn === 'connecting' ? 'Подключение…' : 'Нет связи'}
      </span>
    </footer>
  )
}
