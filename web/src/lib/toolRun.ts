// What a tool call is, in people's words (pure: also run by node --test, so no runtime imports).
import type { Message } from '../types'

const plural = (n: number, [one, few, many]: [string, string, string]) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many

export type ToolKind = 'edit' | 'shell' | 'agent' | 'mcp' | 'read' | 'search' | 'other'

const KIND: [ToolKind, RegExp][] = [
  ['edit', /^(edit|replace|write_file|writefile|write|multiedit|notebookedit|apply_patch|create_file|str_replace\w*)$/i],
  ['shell', /^(run_shell_command|bash|shell|exec_command)$/i],
  ['read', /^(read_file|readfile|read|read_many_files|readmanyfiles|readfolder|view)$/i],
  ['search', /^(glob|grep_search|grep|search|searchtext|findfiles|search_file_content|list_directory|ls|web_search|googlesearch)$/i], // GigaCode display names too
  ['agent', /^(mcp__harness__|harness\.)(agent|worker_run|worker_start)$/], // the harness's own helpers: sub-agents
  ['mcp', /^mcp__|^[\w-]+\.[\w-]+$/], // mcp__server__tool (Claude) or server.tool (GigaCode / harness)
]
export const toolKind = (name: string): ToolKind => KIND.find(([, re]) => re.test(name))?.[0] ?? 'other'

const WORDS: Record<ToolKind, { now: string; past: string; noun: [string, string, string] }> = {
  edit: { now: 'редактирует', past: 'отредактировал', noun: ['файл', 'файла', 'файлов'] },
  shell: { now: 'выполняет', past: 'выполнил', noun: ['команду', 'команды', 'команд'] },
  agent: { now: 'запускает', past: 'запустил', noun: ['субагента', 'субагента', 'субагентов'] },
  mcp: { now: 'использует', past: 'использовал', noun: ['интеграцию', 'интеграции', 'интеграций'] },
  read: { now: 'читает', past: 'прочитал', noun: ['файл', 'файла', 'файлов'] },
  search: { now: 'делает', past: 'сделал', noun: ['поиск', 'поиска', 'поисков'] },
  other: { now: 'использует', past: 'использовал', noun: ['инструмент', 'инструмента', 'инструментов'] },
}

type Obj = Record<string, unknown>
export const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : {})
export const pathOf = (input: unknown) => {
  const o = obj(input)
  const p = o.absolute_path ?? o.file_path ?? o.path ?? o.notebook_path
  return typeof p === 'string' ? p : null
}

/** «Редактирует 1 файл, выполняет 11 команд, использует 3 интеграции и читает 2 файла» (past tense once nothing runs). */
export function toolRunSummary(msgs: Message[], running: boolean): string {
  const count = new Map<ToolKind, Set<string>>()
  for (const m of msgs) {
    if (!m.tool) continue
    const k = toolKind(m.tool.name)
    const id = (k === 'edit' || k === 'read' ? pathOf(m.tool.input) : null) ?? m.id
    count.set(k, (count.get(k) ?? new Set()).add(id))
  }
  const parts = (Object.keys(WORDS) as ToolKind[]).filter((k) => count.has(k)).map((k) => {
    const n = count.get(k)!.size
    return `${running ? WORDS[k].now : WORDS[k].past} ${n} ${plural(n, WORDS[k].noun)}`
  })
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} и ${parts[parts.length - 1]}` : parts[0] ?? ''
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const SERVER_NAMES: Record<string, string> = { onework: 'onework', github: 'GitHub', gitlab: 'GitLab', context7: 'Context7' }
const serverName = (s: string) => SERVER_NAMES[s.toLowerCase()] ?? s.charAt(0).toUpperCase() + s.slice(1)

/** mcp__playwright__browser_click → Playwright / browser_click; harness.worker_start → Harness / worker_start */
export function mcpParts(name: string): [string, string] {
  const m = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^([\w-]+)\.([\w-]+)$/.exec(name)
  return m ? [serverName(m[1]), m[2]] : ['', name]
}

/** Icon and one human line for a step: «Прочитано routes.js», «Изменено x.ts +3 −1», the command, «Поиск *.ts», «Playwright / click». */

// ---------- images a run read or produced ----------

const IMAGE = /(?:[A-Za-z]:)?[^\s"'`<>|*?]*\.(?:png|jpe?g|gif|webp|svg)\b/gi

/** Image paths mentioned by the run's inputs and outputs (screenshots, read images), first 6. */
export function runImages(msgs: Message[]): string[] {
  const found = new Set<string>()
  for (const m of msgs) {
    if (!m.tool) continue
    const texts = [...Object.values(obj(m.tool.input)).filter((v): v is string => typeof v === 'string'), m.tool.output ?? '']
    for (const t of texts) for (const p of t.match(IMAGE) ?? []) found.add(p)
  }
  return [...found].slice(0, 6)
}

/** «Model: … · MCP: harness ✓, java-lsp ✗ (timeout)» or «MCP: …»: the CLI's MCP status line. */
export const isMcpStatus = (text: string) => /(^|·\s*)MCP:\s*\S/.test(text.trim()) && !text.includes('\n')

/** The MCP servers of a status line: name, ok, reason. */
export function mcpServers(text: string): { name: string; ok: boolean; reason: string | null }[] {
  const seg = text.split('·').map((x) => x.trim()).find((x) => x.startsWith('MCP:'))
  if (!seg) return []
  return seg.slice(4).split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const bad = /✗|×|fail/i.test(x)
    const reason = /\((.+)\)\s*$/.exec(x)?.[1] ?? null
    return { name: x.replace(/\s*\(.+\)\s*$/, '').replace(/\s*[✓✔✗×]\s*$/, '').trim(), ok: !bad, reason }
  })
}


// A chat in the projects folder works in several repositories at once and makes its worktrees itself (often only after
// the analysis): which of them it edits and which it only reads, from its tool calls — for the changes panel.
export interface Root { path: string; name: string; branch?: string | null }

// absolute paths in a shell command: `git -C C:\…\repo show …`, `cd /home/…/repo && …`
const SHELL_PATHS = /(?:^|[\s"'=])([A-Za-z]:[\\/][^\s"'`&|;<>]*|\/[^\s"'`&|;<>]+)/g

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() // as lib/format (no imports here)

/** The projects among `roots` (worktrees and repositories; the deepest one wins) that the calls touched: edited and only seen. */
export function touchedRoots(msgs: Message[], roots: Root[]): { edited: Root[]; seen: Root[]; outside: number } {
  const sorted = roots.map((r) => ({ r, n: normPath(r.path) })).sort((a, b) => b.n.length - a.n.length)
  const rootOf = (p: string) => {
    const n = normPath(p)
    return sorted.find((x) => n === x.n || n.startsWith(`${x.n}/`))?.r
  }
  const edited = new Map<string, Root>()
  const seen = new Map<string, Root>()
  let outside = 0 // edits in no known project (a worktree made a moment ago)
  for (const m of msgs) {
    const t = m.tool
    if (m.kind !== 'tool' || !t) continue
    const kind = toolKind(t.name)
    const input = obj(t.input)
    const paths = kind === 'shell'
      ? [...String(input.command ?? '').matchAll(SHELL_PATHS)].map((x) => x[1])
      : [pathOf(t.input), typeof input.dir_path === 'string' ? input.dir_path : null].filter((p): p is string => !!p)
    const into = kind === 'edit' && t.status !== 'error' ? edited : seen // a refused edit changed nothing
    for (const p of paths) {
      const r = rootOf(p)
      if (r) into.set(r.path, r)
      else if (into === edited) outside++
    }
  }
  for (const k of edited.keys()) seen.delete(k)
  return { edited: [...edited.values()], seen: [...seen.values()], outside }
}
