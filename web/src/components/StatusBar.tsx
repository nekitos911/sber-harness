import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { plural } from '../lib/format'

interface McpServer { name: string; enabled: boolean; ok: boolean; error?: string; problem?: string }

export function StatusBar() {
  const conn = useStore((s) => s.conn)
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  const [mcp, setMcp] = useState<McpServer[] | null>(null)

  useEffect(() => {
    if (conn !== 'open') return
    api<McpServer[]>('GET', '/mcp/servers').then(setMcp, () => setMcp(null))
  }, [conn])

  const running = sessions.filter((s) => s.status === 'running').length
  const inWork = tasks.filter((t) => t.status === 'in_progress').length
  const enabled = mcp?.filter((m) => m.enabled) ?? []
  const broken = enabled.filter((m) => !m.ok || m.problem)

  return (
    <footer className="statusbar">
      <span>Сессий: {sessions.length}</span>
      {running > 0 && <span style={{ color: 'var(--lamp-run)' }}>Работают: {running}</span>}
      <span>Задач в работе: {inWork}</span>
      {mcp && (
        <span
          className="end"
          style={broken.length ? { color: 'var(--lamp-fail)' } : undefined}
          data-tip={enabled.map((m) => `${m.name}: ${m.problem ?? (m.ok ? 'ok' : m.error ?? 'ошибка')}`).join('\n') || 'MCP-серверы не настроены'}
        >
          MCP: {enabled.length} {plural(enabled.length, 'сервер', 'сервера', 'серверов')}
          {broken.length > 0 && `, с ошибкой: ${broken.length}`}
        </span>
      )}
      <span className={mcp ? 'conn' : 'conn end'} data-state={conn}>
        {conn === 'open' ? 'Подключено' : conn === 'connecting' ? 'Подключение…' : 'Нет связи'}
      </span>
    </footer>
  )
}

