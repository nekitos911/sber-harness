import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Cable, KeyRound, Pencil, Plus, Terminal } from 'lucide-react'
import { api, errorText } from '../api'
import { loadSettings } from '../lib/agents'
import { useFeature } from '../store'
import { Modal } from './ui/Dialog'
import { Button, IconButton, Input, Segmented, Switch, Textarea } from './ui'

type Transport = 'http' | 'stdio'
type Source = 'none' | 'value' | 'env'
interface Credential { key: string; variable?: string; bearer?: boolean }
interface Connection { name: string; enabled: boolean; transport: Transport; local: boolean; editable: boolean; credentials?: Credential[] }
type Editor = { kind: 'add' } | { kind: 'address' | 'auth'; server: Connection }

export function Connections({ onSaved }: { onSaved: () => void }) {
  const supported = useFeature('mcp-connections')
  const [servers, setServers] = useState<Connection[]>([])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reload = async () => setServers((await api<{ servers: Connection[] }>('GET', '/mcp/config')).servers)
  useEffect(() => { if (supported) void reload().catch((e) => setError(errorText(e))) }, [supported])
  if (!supported) return null

  const refresh = async () => {
    window.dispatchEvent(new Event('mcp-changed'))
    onSaved()
    try { await Promise.all([reload(), loadSettings(true)]); setError('') }
    catch (e) { setError(errorText(e)) }
  }
  const toggle = async (server: Connection, enabled: boolean) => {
    setBusy(true)
    try {
      await api('PUT', '/mcp/servers/' + encodeURIComponent(server.name), { enabled })
      await refresh()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <section className="settings-section">
    <header className="connection-head">
      <h2>Серверы MCP</h2>
      <Button icon={<Plus />} onClick={() => setEditor({ kind: 'add' })}>Добавить сервер</Button>
    </header>
    <p className="set-note">Подключения из GigaCode появляются здесь автоматически.</p>
    <div className="connection-list">
      {servers.map((s) => <div key={s.name} className="connection-line">
        {s.transport === 'http' ? <Cable aria-hidden /> : <Terminal aria-hidden />}
        <span><strong>{s.name}</strong><small>{s.transport === 'http' ? 'HTTP' : 'Команда · stdio'} · {s.local ? 'Harness' : 'GigaCode'}</small></span>
        {s.editable && <IconButton label={'Изменить подключение ' + s.name} icon={<Pencil />} onClick={() => setEditor({ kind: 'address', server: s })} />}
        <IconButton label={'Настроить доступ для ' + s.name} icon={<KeyRound />} onClick={() => setEditor({ kind: 'auth', server: s })} />
        <Switch label={'Включить ' + s.name + ' для Harness'} checked={s.enabled} disabled={busy} onChange={(enabled) => void toggle(s, enabled)} />
      </div>)}
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
