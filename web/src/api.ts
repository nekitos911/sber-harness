import { getState, setState, toast } from './store'

const token = document.querySelector<HTMLMetaElement>('meta[name="harness-token"]')?.content ?? ''

export class ApiError extends Error {
  status: number
  data: unknown // the parsed error body (e.g. a 409 with { dirty, ahead, running })
  constructor(message: string, status: number, data: unknown = null) {
    super(message)
    this.status = status
    this.data = data
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface ApiOpts { jobId?: string } // x-job-id: the server reports progress of this request over WS

export async function api<T>(method: Method, path: string, body?: unknown, opts?: ApiOpts): Promise<T> {
  // No socket = the server is down or unreachable: say so at once instead of a slow network failure.
  if (method !== 'GET' && getState().conn === 'closed') throw new ApiError('Нет связи с сервером', 0)
  const headers: Record<string, string> = { 'x-harness-token': token }
  const raw = body instanceof Blob // a pasted image goes as bytes (with its own type), not JSON
  if (body !== undefined) headers['content-type'] = raw ? body.type : 'application/json'
  if (opts?.jobId) headers['x-job-id'] = opts.jobId
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Сервер недоступен', 0)
  }
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  if (res.status === 401) {
    // The page holds the token of a previous server run; only a reload picks up the new one.
    setState({ authExpired: true })
    throw new ApiError('Сервер перезапущен — обновите страницу', 401)
  }
  if (!res.ok) {
    const err = data && typeof data === 'object' && 'error' in data ? String(data.error) : `HTTP ${res.status}`
    throw new ApiError(err, res.status, data)
  }
  return data as T
}

/** Like api(), but reports the error as a toast and resolves to undefined. */
export async function tryApi<T>(method: Method, path: string, body?: unknown, opts?: ApiOpts): Promise<T | undefined> {
  try {
    return await api<T>(method, path, body, opts)
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) toast(errorText(e), 'error')
    return undefined
  }
}

/** A binary GET (images) as an object URL; the caller revokes it. */
export async function apiBlobUrl(path: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, { headers: { 'x-harness-token': token } })
  } catch {
    throw new ApiError('Сервер недоступен', 0)
  }
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status)
  return URL.createObjectURL(await res.blob())
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function qs(params: Record<string, string | number | null | undefined>) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) p.set(k, String(v))
  return `?${p}`
}

export const wsUrl = () =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`
