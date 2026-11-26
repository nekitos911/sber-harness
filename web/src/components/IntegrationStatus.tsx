import { useEffect, useState } from 'react'
import { Check, CircleAlert, RefreshCw, X } from 'lucide-react'
import { api, tryApi } from '../api'
import { useFeature } from '../store'
import { loadSettings } from '../lib/agents'
import { loadDraft, saveDraft } from '../lib/draft'
import { openPrSettings } from '../lib/pr'
import { Button, IconButton, Select } from './ui'

interface One { server: string | null; found: boolean; ok: boolean; missing: string[]; error?: string }
interface Check { tasks: One; pr: One; servers: string[] }

export function useIntegrationsCheck() {
  const on = useFeature('integrations-check')
  const [r, setR] = useState<Check | null | undefined>(undefined)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!on) return
    let active = true
    setR(undefined)
    api<Check>('GET', '/integrations/check').then((v) => { if (active) setR(v) }, () => { if (active) setR(null) })
    return () => { active = false }
  }, [on, version])
  return { r: on ? r : null, recheck: () => setVersion((v) => v + 1) }
}

const LABEL = { tasks: 'трекера задач', pr: 'пулл-реквестов' }

/**
 * On the board and the PR screen: the harness ITSELF talks to the tracker and the code host through their MCP servers
 * (an agent having them is not enough). Shown only while that server is missing or not answering, with the fix at hand;
 * «Скрыть» for someone who does not use that integration.
 */
export function IntegrationBanner({ kind }: { kind: 'tasks' | 'pr' }) {
  const check = useIntegrationsCheck()
  const key = `hint:integ-${kind}`
  const [hidden, setHidden] = useState(() => !!loadDraft<boolean>(key))
  if (hidden || !check.r || check.r[kind].ok) return null
  return (
    <div className="integ-banner" role="status">
      <div className="integ-banner-head">
        <strong>{kind === 'tasks' ? 'Задачи из трекера не загружаются' : 'Пулл-реквесты недоступны'}</strong>
        <IconButton size="sm" label="Скрыть" icon={<X />} onClick={() => { saveDraft(key, true); setHidden(true) }} />
      </div>
      <p className="muted">
        {kind === 'tasks' ? 'Задачи' : 'PR'} харнесс берёт сам, через MCP-сервер {LABEL[kind]}, а не через агента. Обычно он уже есть
        в ~/.gigacode/settings.json и подхватывается без настройки; если там он называется иначе — выберите его ниже.
      </p>
      <IntegrationStatus kind={kind} check={check} />
      <Button size="sm" onClick={openPrSettings}>Открыть «Задачи и Git»</Button>
    </div>
  )
}

/**
 * Is the tracker's / the code host's MCP server there and answering — in words, with what to do when it is not: the
 * servers come from the agent's own GigaCode settings, so usually there is nothing to add; a differently named one is
 * picked here.
 */
export function IntegrationStatus({ kind, check }: { kind: 'tasks' | 'pr'; check: ReturnType<typeof useIntegrationsCheck> }) {
  const { r, recheck } = check
  if (r === null) return null
  if (r === undefined) return <p className="integ muted">Проверяем подключение {LABEL[kind]}…</p>
  const c = r[kind]
  const others = r.servers.filter((s) => s !== c.server)
  const pick = async (server: string) => {
    if ((await tryApi('PUT', '/settings', { integrations: { [kind]: { server } } })) === undefined) return
    await loadSettings(true)
    window.dispatchEvent(new Event('mcp-changed'))
    recheck()
  }
  return (
    <div className="integ" data-ok={c.ok || undefined}>
      <p className="integ-line">
        {c.ok ? <Check aria-hidden /> : <CircleAlert aria-hidden />}
        <span>
          {c.ok ? <>Подключено: <span className="mono">{c.server}</span> отвечает.</>
            : !c.found ? <>Сервер {LABEL[kind]}{c.server && <> <span className="mono">{c.server}</span></>} не найден.</>
              : c.error ? <><span className="mono">{c.server}</span> не отвечает: {c.error}</>
                : <><span className="mono">{c.server}</span> отвечает, но это не сервер {LABEL[kind]}: у него нет {c.missing.join(', ')}.</>}
        </span>
      </p>
      <div className="integ-actions">
          {others.length > 0 && (
            <Select size="sm" label={`Сервер ${LABEL[kind]}`} placeholder="Выбрать другой сервер…" value="" onChange={(v) => void pick(v)}
              options={others.map((s) => ({ value: s, label: s }))} />
          )}
          <Button size="sm" icon={<RefreshCw />} onClick={recheck}>Проверить</Button>
      </div>
    </div>
  )
}
