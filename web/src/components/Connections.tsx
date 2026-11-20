import { useEffect, useState } from 'react'
import { KeyRound, Pencil, Plus } from 'lucide-react'
import { api, errorText } from '../api'
import { loadSettings } from '../lib/agents'
import { useFeature } from '../store'
import { Button, Disclosure, Input, Segmented, Switch, Textarea } from './ui'

interface Connection { name: string; enabled: boolean; transport: 'http' | 'stdio'; local: boolean; editable: boolean }
interface Config { servers: Connection[]; secretsFile: string }

export function Connections({ onSaved }: { onSaved: () => void }) {
  const supported = useFeature('mcp-connections')
  const [config, setConfig] = useState<Config | null>(null)
  const [editing, setEditing] = useState<Connection | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'http' | 'stdio'>('http')
  const [address, setAddress] = useState('')
  const [args, setArgs] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const reload = () => api<Config>('GET', '/mcp/config').then(setConfig)
  useEffect(() => { if (supported) reload().catch((e) => setError(errorText(e))) }, [supported])
  if (!supported) return null

  const change = async (action: () => Promise<void>, success: string) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await action()
      await Promise.all([reload(), loadSettings(true)])
      onSaved()
      window.dispatchEvent(new Event('mcp-changed'))
      setMessage(success)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const save = () => change(async () => {
    const endpoint = editing ? '/mcp/servers/' + encodeURIComponent(editing.name) : '/mcp/servers'
    const definition = transport === 'http' ? { url: address.trim() } : { command: address.trim(), args: args.split('\n').filter(Boolean) }
    await api(editing ? 'PUT' : 'POST', endpoint, { name: name.trim(), transport, ...definition })
    setAdding(false); setEditing(null); setAddress(''); setArgs(''); setName('')
  }, editing ? 'Параметры подключения обновлены.' : 'Сервер добавлен. Его можно выбрать для трекера или пулл-реквестов.')
  const saveSecret = () => change(async () => {
    await api('PUT', '/mcp/secrets/' + encodeURIComponent(secret!), { key: key.trim(), value })
    setValue(''); setSecret(null)
  }, 'Ключ доступа сохранён.')
  return <section className="settings-section">
    <h2>Серверы MCP</h2>
    <p className="set-note">Harness находит подключения GigaCode автоматически. Для отдельного подключения укажите адрес сервиса или команду запуска.</p>
    <div className="connection-list">
      {config?.servers.map((c) => <div key={c.name}>
        <div className="connection-line">
          <span><strong>{c.name}</strong><small>{c.transport === 'http' ? 'HTTP' : 'Локальная команда'} · {c.local ? 'Harness' : 'Из файла настроек'}</small></span>
          {c.editable && <Button size="sm" variant="ghost" disabled={busy} icon={<Pencil />} aria-label={'Изменить ' + c.name} onClick={() => {
            setEditing(c); setAdding(true); setName(c.name); setTransport(c.transport); setAddress(''); setArgs(''); setError(''); setMessage('')
          }}>Изменить</Button>}
          <Button size="sm" variant="ghost" disabled={busy} aria-label={'Ключ доступа для ' + c.name} icon={<KeyRound />} onClick={() => {
            setSecret(secret === c.name ? null : c.name); setKey(c.transport === 'http' ? 'Authorization' : ''); setValue(''); setError(''); setMessage('')
          }}>Ключ</Button>
          <Switch label={'Включить ' + c.name + ' для Harness'} checked={c.enabled} disabled={busy} onChange={(enabled) => void change(async () => {
            await api('PUT', '/mcp/servers/' + encodeURIComponent(c.name), { enabled })
          }, enabled ? 'Сервер включён.' : 'Сервер выключен.')} />
        </div>
        {secret === c.name && <div className="connection-editor">
          <label>{c.transport === 'http' ? 'Имя HTTP-заголовка' : 'Переменная окружения'}<Input value={key} onChange={(e) => setKey(e.target.value)} /></label>
          <label>Значение<Input type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} /></label>
          <small className="muted">Ключ будет записан в {config.secretsFile}</small>
          <Button size="sm" disabled={!value.trim() || !key.trim() || busy} onClick={() => void saveSecret()}>Сохранить ключ</Button>
        </div>}
      </div>)}
    </div>
    <Disclosure open={adding} onToggle={(open) => { setAdding(open); if (!open && editing) { setEditing(null); setName(''); setArgs(''); setAddress('') } }}
      summary={editing ? 'Изменить ' + editing.name : 'Добавить сервер'}>
      <div className="connection-editor">
        <label>Имя сервера<Input disabled={!!editing} value={name} placeholder="my-tracker" onChange={(e) => setName(e.target.value)} /></label>
        {!editing && <Segmented label="Тип подключения" value={transport} onChange={(v) => { setTransport(v); setAddress('') }}
          options={[{ value: 'http', label: 'HTTP' }, { value: 'stdio', label: 'Локальная команда' }]} />}
        <label>{transport === 'http' ? 'Адрес MCP' : 'Исполняемый файл'}<Input value={address} placeholder={transport === 'http' ? 'https://example.org/mcp' : 'node'} onChange={(e) => setAddress(e.target.value)} /></label>
        {transport === 'stdio' && <label>Аргументы, по одному в строке<Textarea value={args} rows={3} onChange={(e) => setArgs(e.target.value)} /></label>}
        {editing && <small className="muted">Новые параметры заменят прежние. Для этого сервера продолжит действовать сохранённый ключ.</small>}
        <Button size="sm" icon={editing ? <Pencil /> : <Plus />} disabled={busy || !name.trim() || !address.trim()} onClick={() => void save()}>{editing ? 'Сохранить подключение' : 'Добавить подключение'}</Button>
      </div>
    </Disclosure>
    {error && <p role="alert" className="field-error">{error}</p>}
    {message && <p role="status" className="set-note">{message}</p>}
  </section>
}
