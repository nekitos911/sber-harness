import { useEffect, useState } from 'react'
import { Check, CircleAlert, RefreshCw } from 'lucide-react'
import { api, tryApi } from '../api'
import { useFeature } from '../store'
import { loadSettings } from '../lib/agents'
import { Button, Select } from './ui'

interface One { server: string | null; found: boolean; ok: boolean; missing: string[]; error?: string }
interface Check { tasks: One; pr: One; servers: string[] }

// one request for every block on the page; «Проверить» asks again
let shared: Promise<Check | null> | null = null

/** GET /integrations/check: undefined while asking, null when this server cannot tell. */
export function useIntegrationsCheck() {
  const on = useFeature('integrations-check')
  const [r, setR] = useState<Check | null | undefined>(undefined)
  const run = (fresh: boolean) => {
    if (fresh || !shared) shared = api<Check>('GET', '/integrations/check').catch(() => null)
    setR(undefined)
    void shared.then(setR)
  }
  useEffect(() => { if (on) run(false) }, [on]) // eslint-disable-line react-hooks/exhaustive-deps
  return { r: on ? r : null, recheck: () => run(true) }
}

const LABEL = { tasks: 'трекера задач', pr: 'пулл-реквестов' }

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
      {!c.found && (
        <p className="muted">
          Программа берёт MCP-серверы из настроек GigaCode (<span className="mono">~/.gigacode/settings.json</span>, раздел{' '}
          <span className="mono">mcpServers</span>): если сервер {LABEL[kind]} подключён самому агенту, он найдётся сам. Если нет — добавьте его туда и нажмите «Проверить».
        </p>
      )}
      {!c.ok && (
        <div className="integ-actions">
          {others.length > 0 && (
            <Select size="sm" label={`Сервер ${LABEL[kind]}`} placeholder="Это другой сервер…" value="" onChange={(v) => void pick(v)}
              options={others.map((s) => ({ value: s, label: s }))} />
          )}
          <Button size="sm" icon={<RefreshCw />} onClick={recheck}>Проверить</Button>
        </div>
      )}
    </div>
  )
}
