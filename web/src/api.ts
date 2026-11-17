import { toast } from './store'

const token = document.querySelector<HTMLMetaElement>('meta[name="harness-token"]')?.content ?? ''

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined
        ? { 'x-harness-token': token }
        : { 'x-harness-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Сервер недоступен', 0)
  }
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  if (!res.ok) {
    const err = data && typeof data === 'object' && 'error' in data ? String(data.error) : `HTTP ${res.status}`
    throw new ApiError(err, res.status)
  }
  return data as T
}

/** Like api(), but reports the error as a toast and resolves to undefined. */
export async function tryApi<T>(method: Method, path: string, body?: unknown): Promise<T | undefined> {
  try {
    return await api<T>(method, path, body)
  } catch (e) {
    toast(errorText(e), 'error')
    return undefined
  }
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function qs(params: Record<string, string | number | null | undefined>) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) p.set(k, String(v))
  return `?${p}`
}

export const wsUrl = () =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`
