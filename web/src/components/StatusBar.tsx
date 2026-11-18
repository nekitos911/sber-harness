import { useEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store'
import { Popover } from './ui'

interface McpServer { name: string; enabled: boolean; ok: boolean; error?: string; problem?: string }

/** What the usual services are for, in words; the id stays next to it. */
const PURPOSE: Record<string, string> = { onework: 'Трекер задач', sourcecontrol: 'Пулл-реквесты' }

export function StatusBar() {
  const conn = useStore((s) => s.conn)
  const [mcp, setMcp] = useState<McpServer[] | null>(null)
  const [open, setOpen] = useState(false)
  const mcpBtn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (conn !== 'open') return
    api<McpServer[]>('GET', '/mcp/servers').then(setMcp, () => setMcp(null))
  }, [conn])

  const enabled = mcp?.filter((m) => m.enabled) ?? []
  const broken = enabled.filter((m) => !m.ok || m.problem)

  return (
    <footer className="statusbar">
      {/* who works is in the sidebar («В работе», «Ждут вас»): the bar keeps only what is nowhere else */}
      {mcp && (
        <>
          <button ref={mcpBtn} type="button" className="end sb-mcp" aria-expanded={open} data-bad={broken.length > 0 || undefined} onClick={() => setOpen(!open)}>
            Сервисы: {enabled.length}
            {broken.length > 0 && `, с ошибкой: ${broken.length}`}
          </button>
          <Popover anchor={mcpBtn} open={open} onClose={() => setOpen(false)} placement="top-end" label="Сервисы для задач и PR" className="sb-mcp-pop">
            <p className="sb-mcp-head">Сервисы, через которые приходят задачи и создаются PR (подключены по MCP). Сервисы самого агента — в «Настройках».</p>
            {enabled.length === 0 && <p className="muted">Не настроены.</p>}
            {enabled.map((m) => (
              <div key={m.name} className="sb-mcp-row" data-bad={!m.ok || !!m.problem || undefined}>
                {m.ok && !m.problem ? <Check aria-hidden /> : <X aria-hidden />}
                <span>{PURPOSE[m.name] ?? m.name}</span>{PURPOSE[m.name] && <span className="mono muted">{m.name}</span>}
                {(m.problem || (!m.ok && m.error)) && <span className="sb-mcp-err">{m.problem ?? m.error}</span>}
              </div>
            ))}
            {broken.length > 0 && (
              <p className="muted">
                Нет секрета — допишите его в файл секретов (CONSOLE_MCP_SECRETS). Сервер не нужен — выключите в harness.config.local.json:
                <code> mcpServers.&lt;имя&gt;.enabled: false</code>.
              </p>
            )}
          </Popover>
        </>
      )}
      <span className={mcp ? 'conn' : 'conn end'} data-state={conn}>
        {conn === 'open' ? 'Подключено' : conn === 'connecting' ? 'Подключение…' : 'Нет связи'}
      </span>
    </footer>
  )
}
