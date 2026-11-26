import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Cable, KeyRound, Pencil, Plus, Terminal } from 'lucide-react'
import { api, errorText } from '../api'
import { loadSettings, useAgentMeta } from '../lib/agents'
import { useFeature } from '../store'
import { Modal } from './ui/Dialog'
import { Button, IconButton, Input, Segmented, Switch, Textarea } from './ui'

type Transport = 'http' | 'stdio'
type Source = 'none' | 'value' | 'env'
interface Credential { key: string; variable?: string; bearer?: boolean }
interface Connection { name: string; enabled: boolean; transport: Transport; local: boolean; editable: boolean; credentials?: Credential[] }
type Editor = { kind: 'add' } | { kind: 'address' | 'auth'; server: Connection }

/**
 * «MCP-серверы»: one table — a row per server, a column per place it runs: the harness itself (tracker import, PR),
 * agents' chats, sub-agents' chats. Every switch applies at once. `agents` / `subagents` are absent on an older server.
 */
export function McpServers({ agentId, onSaved, agents, subagents }: {
  agentId: string | null
  onSaved: () => void
  agents?: { off: string[]; set: (list: string[]) => Promise<void> }
  subagents?: { off: string[]; set: (list: string[]) => Promise<void> }
}) {
  const supported = useFeature('mcp-connections')
  const meta = useAgentMeta(agentId)
  const [servers, setServers] = useState<Connection[]>([])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const reload = async () => setServers((await api<{ servers: Connection[] }>('GET', '/mcp/config')).servers)
  useEffect(() => { if (supported) void reload().catch((e) => setError(errorText(e))) }, [supported])

  const refresh = async () => {
    window.dispatchEvent(new Event('mcp-changed'))
    onSaved()
    try { await Promise.all([reload(), loadSettings(true)]); setError('') }
    catch (e) { setError(errorText(e)) }
  }
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    try { await fn(); setError('') } catch (e) { setError(errorText(e)) } finally { setBusy('') }
  }
  const toggleHarness = (server: Connection, enabled: boolean) => run(`h:${server.name}`, async () => {
    await api('PUT', '/mcp/servers/' + encodeURIComponent(server.name), { enabled })
    await refresh()
  })
  const flip = (list: string[], name: string, on: boolean) => (on ? list.filter((x) => x !== name) : [...new Set([...list, name])])

  // every server any side knows: the harness's own list, what the CLI reported at its last start, switched-off leftovers
  const seen = meta?.mcpServers ?? meta?.seen?.mcpServers ?? []
  const status = new Map(seen.map((m) => [m.name, m.status]))
  const disabled = new Set(meta?.mcpDisabled ?? [])
  const byName = new Map(servers.map((s) => [s.name, s]))
  const names = [...new Set([...servers.map((s) => s.name), ...seen.map((m) => m.name), ...(agents?.off ?? []), ...(subagents?.off ?? [])])]
    .filter((n) => n && n !== 'harness').sort((a, b) => a.localeCompare(b))
  if (!supported && !names.length) return null

  return <section className="settings-section" id="set-mcp">
    <header className="connection-head">
      <h2>MCP-серверы</h2>
      {supported && <Button icon={<Plus />} onClick={() => setEditor({ kind: 'add' })}>Добавить сервер</Button>}
    </header>
    <p className="set-note">
      Где сервер запускается: <b>Харнес</b> — сам харнес (импорт задач, PR, проверки); <b>Агенты</b> — в чатах агентов;
      <b> Субагенты</b> — в чатах субагентов. Каждый лишний сервер добавляет секунды к старту агента. Свой сервер harness
      агенты получают всегда. Переключатели применяются сразу.
    </p>
    <div className="mcp-table" role="table" aria-label="MCP-серверы">
      <div className="mcp-tr mcp-th" role="row">
        <span role="columnheader">Сервер</span>
        <span role="columnheader">Харнес</span>
        <span role="columnheader">Агенты</span>
        {subagents && <span role="columnheader">Субагенты</span>}
        <span role="columnheader"><span className="sr-only">Действия</span></span>
      </div>
      {names.map((n) => {
        const s = byName.get(n)
        const st = status.get(n)
        const agentOn = !disabled.has(n) && !(agents?.off ?? []).includes(n)
        const ok = st ? /connect|ok|ready|running/i.test(st) : null
        return <div key={n} className="mcp-tr" role="row" data-off={(!agentOn && !(s?.enabled)) || undefined}>
          <span className="mcp-name" role="cell">
            {s?.transport === 'http' ? <Cable aria-hidden /> : <Terminal aria-hidden />}
            <span>
              <strong className="mono">{n}</strong>
              <small>
                {s ? `${s.transport === 'http' ? 'HTTP' : 'команда'} · ${s.local ? 'добавлен здесь' : 'из GigaCode'}` : 'из GigaCode'}
                {agentOn && ok !== null && <> · <span className="mcp-state" data-ok={ok || undefined} data-tip={`При последнем запуске агента: ${st}`}>{ok ? 'работал у агента' : 'не запустился у агента'}</span></>}
              </small>
            </span>
          </span>
          <span role="cell">
            {s ? <Switch label={`${n}: харнес`} checked={s.enabled} disabled={!!busy} onChange={(v) => void toggleHarness(s, v)} />
              : <span className="muted" data-tip="Сервер только в настройках GigaCode: харнес к нему сам не подключается">—</span>}
          </span>
          <span role="cell">
            {disabled.has(n) ? <span className="set-hint" data-tip="mcpDisabled в harness.config.local.json">выключен в конфиге</span>
              : agents ? <Switch label={`${n}: агенты`} checked={agentOn} disabled={!!busy} onChange={(v) => void run(`a:${n}`, () => agents.set(flip(agents.off, n, v)))} />
                : <span className="muted">—</span>}
          </span>
          {subagents && <span role="cell">
            <Switch label={`${n}: субагенты`} checked={!subagents.off.includes(n)} disabled={!!busy} onChange={(v) => void run(`s:${n}`, () => subagents.set(flip(subagents.off, n, v)))} />
          </span>}
          <span className="mcp-actions" role="cell">
            {s?.editable && <IconButton size="sm" label={'Изменить подключение ' + n} icon={<Pencil />} onClick={() => setEditor({ kind: 'address', server: s })} />}
            {s && <IconButton size="sm" label={'Ключ доступа для ' + n} icon={<KeyRound />} onClick={() => setEditor({ kind: 'auth', server: s })} />}
          </span>
        </div>
      })}
      {!names.length && <p className="set-note">Серверов пока нет. Они появятся после первого запуска агента или добавьте свой.</p>}
    </div>
    {error && <p role="alert" className="field-error">{error}</p>}
    {editor && createPortal(<ConnectionEditor editor={editor} onClose={() => setEditor(null)} onSaved={refresh} />, document.body)}
  </section>
}

function ConnectionEditor({ editor, onClose, onSaved }: { editor: Editor; onClose: () => void; onSaved: () => Promise<void> }) {
  const server = editor.kind === 'add' ? null : editor.server
  const [name, setName] = useState(server?.name ?? '')
  const [transport, setTransport] = useState<Transport>(server?.transport ?? 'http')
  const [address, setAddress] = useState('')
  const [args, setArgs] = useState('')
  const [created, setCreated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const credentials = server?.credentials ?? []
  const first = credentials[0]
  const [key, setKey] = useState(first?.key ?? (transport === 'http' ? 'Authorization' : 'API_KEY'))
  const [variable, setVariable] = useState(first?.variable ?? '')
  const [value, setValue] = useState('')
  const [bearer, setBearer] = useState(first?.bearer ?? false)
  const [source, setSource] = useState<Source>(first ? (first.variable ? 'env' : 'value') : 'none')
  const authOnly = editor.kind === 'auth' || created
  const auth = editor.kind !== 'address'
  const existing = credentials.some((entry) => entry.key === key)
  const selectKey = (entry: Credential) => {
    setKey(entry.key); setVariable(entry.variable ?? ''); setBearer(!!entry.bearer); setValue('')
    setSource(entry.variable ? 'env' : 'value')
  }
  const invalid = (!authOnly && (!name.trim() || !address.trim())) ||
    (auth && source !== 'none' && (!key.trim() || !(source === 'env' ? variable : value).trim()))
  const save = async () => {
    setBusy(true); setError('')
    try {
      if (!authOnly) {
        const def = transport === 'http' ? { url: address.trim() } : { command: address.trim(), args: args.split('\n').filter(Boolean) }
        await api(server ? 'PUT' : 'POST', '/mcp/servers' + (server ? '/' + encodeURIComponent(name) : ''), { name: name.trim(), transport, ...def })
        if (!server) setCreated(true)
      }
      if (auth && (source !== 'none' || existing)) {
        await api('PUT', '/mcp/secrets/' + encodeURIComponent(name.trim()), { key: key.trim(), source,
          ...(source === 'env' ? { variable: variable.trim(), bearer } : source === 'value' ? { value } : {}) })
      }
      await onSaved()
      onClose()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <Modal title={authOnly ? 'Доступ · ' + name : server ? 'Подключение · ' + name : 'Новый MCP-сервер'}
    submitLabel={authOnly || server ? 'Сохранить' : 'Добавить сервер'} disabled={invalid} busy={busy}
    onClose={() => { if (created) void onSaved(); onClose() }} onSubmit={() => void save()}>
    {!authOnly && <>
      {!server && <label className="field">Название<Input data-initial-focus value={name} placeholder="my-server" onChange={(e) => setName(e.target.value)} /></label>}
      {!server && <Segmented label="Транспорт" value={transport} onChange={(v) => {
        setTransport(v); setAddress(''); setKey(v === 'http' ? 'Authorization' : 'API_KEY'); setBearer(false)
      }} options={[{ value: 'http', label: 'HTTP' }, { value: 'stdio', label: 'Процесс (stdio)' }]} />}
      <label className="field">{transport === 'http' ? 'Адрес сервера' : 'Команда запуска'}
        <Input mono value={address} placeholder={transport === 'http' ? 'http://localhost:8080/mcp' : 'node'} onChange={(e) => setAddress(e.target.value)} />
      </label>
      {transport === 'stdio' && <label className="field">Аргументы, по одному в строке<Textarea mono rows={2} value={args} onChange={(e) => setArgs(e.target.value)} /></label>}
      {editor.kind === 'address' && <p className="muted">Введите новые параметры подключения. Ключи доступа сохранятся.</p>}
    </>}
    {auth && <div className="connection-auth">
      {credentials.length > 0 && <div className="credential-keys">{credentials.map((c) => <Button size="sm" key={c.key} aria-pressed={c.key === key} onClick={() => selectKey(c)}>{c.key}</Button>)}
        <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => { setKey(''); setValue(''); setVariable(''); setSource('value'); setBearer(false) }}>Ещё ключ</Button></div>}
      <Segmented label="Источник ключа" value={source} onChange={setSource} options={[{ value: 'none', label: existing ? 'Не передавать' : 'Без ключа' }, { value: 'value', label: 'Значение' }, { value: 'env', label: 'Из окружения' }]} />
      {source !== 'none' && <>
        <label className="field">{transport === 'http' ? 'Имя HTTP-заголовка' : 'Переменная процесса'}<Input mono value={key} onChange={(e) => setKey(e.target.value)} /></label>
        {source === 'value'
          ? <label className="field">{existing ? 'Новое значение' : 'Значение'}<Input type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} /></label>
          : <><label className="field">Переменная окружения Harness<Input mono placeholder="MY_API_KEY" value={variable} onChange={(e) => setVariable(e.target.value)} /></label>
            {transport === 'http' && <label><input type="checkbox" checked={bearer} onChange={(e) => setBearer(e.target.checked)} /> Добавлять Bearer перед значением</label>}</>}
      </>}
    </div>}
    {error && <p role="alert" className="field-error">{created ? 'Сервер добавлен. Проверьте параметры доступа. ' : ''}{error}</p>}
  </Modal>
}
