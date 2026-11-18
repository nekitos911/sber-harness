import { useEffect, useRef, useState } from 'react'
import { basicSetup } from 'codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { java } from '@codemirror/lang-java'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { FileWarning, MessageSquarePlus, Save } from 'lucide-react'
import { api, errorText, qs, tryApi } from '../api'
import { dirtyKey, setDirty, tabKey, toast } from '../store'
import type { FsFile } from '../types'
import { Loading } from '../components/bits'
import { AgentComment } from '../components/AgentComment'
import { shortcut } from '../lib/keys'

function language(path: string): Extension {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return javascript()
    case 'jsx': return javascript({ jsx: true })
    case 'ts': case 'mts': case 'cts': return javascript({ typescript: true })
    case 'tsx': return javascript({ typescript: true, jsx: true })
    case 'py': return python()
    case 'java': case 'kt': return java()
    case 'json': case 'jsonc': return json()
    case 'md': case 'markdown': return markdown()
    case 'css': case 'scss': case 'less': return css()
    case 'html': case 'htm': case 'vue': case 'svelte': return html()
    case 'sql': return sql()
    case 'yml': case 'yaml': return yaml()
    default: return []
  }
}

// Colours come from CSS tokens, so the editor follows the app theme without reconfiguring.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-fn)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-prop)' },
  { tag: [t.meta, t.annotation, t.tagName], color: 'var(--syn-meta)' },
  { tag: t.heading, fontWeight: '600', color: 'var(--ink)' },
  { tag: t.link, color: 'var(--signal)', textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--lamp-fail)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--canvas)', color: 'var(--ink)', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', fontWeight: '350', lineHeight: '1.55', fontVariantLigatures: 'none' },
  '.cm-content': { caretColor: 'var(--ink)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '.cm-gutters': { backgroundColor: 'var(--canvas)', color: 'var(--ink-4)', border: 'none', borderRight: '1px solid var(--rule-soft)' },
  '.cm-activeLine': { backgroundColor: 'var(--deck)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--deck)', color: 'var(--ink-2)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--term-sel) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--signal-soft)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--deck-3)', outline: '1px solid var(--rule-strong)' },
  '.cm-panels': { backgroundColor: 'var(--deck)', color: 'var(--ink)', borderColor: 'var(--rule)' },
  '.cm-tooltip': { backgroundColor: 'var(--deck-2)', border: '1px solid var(--rule)', color: 'var(--ink)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--deck-3)', color: 'var(--ink)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--deck-2)', border: 'none', color: 'var(--ink-3)' },
  '.cm-searchMatch': { backgroundColor: 'var(--run-soft)', outline: '1px solid var(--lamp-run)' },
})

type Load = { state: 'loading' } | { state: 'error'; error: string } | { state: 'binary'; size: number } | { state: 'ready'; content: string }

export default function FileView({ cwd, path }: { cwd: string; path: string }) {
  const key = dirtyKey(cwd, tabKey({ kind: 'file', cwd, path }))
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [dirty, setLocalDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ask, setAsk] = useState<{ from: number; to: number; snippet: string } | null>(null) // «Агенту»: the selected lines
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const saveRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    let live = true
    api<FsFile>('GET', `/fs/file${qs({ cwd, path })}`).then(
      (f) => { if (live) setLoad(f.binary ? { state: 'binary', size: f.size } : { state: 'ready', content: f.content }) },
      (e) => { if (live) setLoad({ state: 'error', error: errorText(e) }) },
    )
    return () => { live = false }
  }, [cwd, path])

  const mark = (v: boolean) => { setLocalDirty(v); setDirty(key, v) }

  saveRef.current = async () => {
    const v = view.current
    if (!v || saving) return
    setSaving(true)
    const res = await tryApi('PUT', '/fs/file', { cwd, path, content: v.state.doc.toString() })
    setSaving(false)
    if (res !== undefined) { mark(false); toast(`Сохранено: ${path}`, 'ok') }
  }

  useEffect(() => {
    if (load.state !== 'ready' || !host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: load.content,
        extensions: [
          basicSetup,
          language(path),
          syntaxHighlighting(highlight),
          theme,
          Prec.highest(keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { saveRef.current(); return true } }])),
          EditorView.updateListener.of((u) => { if (u.docChanged) mark(true) }),
        ],
      }),
    })
    view.current = v
    return () => { v.destroy(); view.current = null }
  }, [load, path])

  if (load.state === 'loading') return <Loading label="Открываем файл…" />
  if (load.state === 'error') return <div className="empty"><h2>Не удалось открыть файл</h2><p className="mono">{load.error}</p></div>
  if (load.state === 'binary') {
    return (
      <div className="empty">
        <FileWarning className="empty-icon" aria-hidden />
        <h2>Двоичный файл</h2>
        <p>{path} ({Math.round(load.size / 1024)} КБ) нельзя показать как текст.</p>
      </div>
    )
  }

  return (
    <div className="file-view">
      <div className="file-bar">
        <span className="mono ellipsis" data-tip={`${cwd} / ${path}`}>{path}</span>
        {dirty && <span className="muted">· изменён</span>}
        <span className="grow" />
        <button type="button" className="btn btn-sm" aria-pressed={!!ask} onClick={() => {
          const v = view.current
          if (!v || ask) { setAsk(null); return }
          const { from, to } = v.state.selection.main // no selection: the line with the cursor
          const a = v.state.doc.lineAt(from)
          const b = v.state.doc.lineAt(to)
          setAsk({ from: a.number, to: b.number, snippet: v.state.sliceDoc(a.from, b.to) })
        }}>
          <MessageSquarePlus />
          Агенту
        </button>
        <kbd>{shortcut('S')}</kbd>
        <button type="button" className="btn btn-sm" disabled={!dirty || saving} onClick={() => saveRef.current()}>
          <Save />
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
      {ask && <AgentComment cwd={cwd} path={path} from={ask.from} to={ask.to} snippet={ask.snippet} onDone={() => setAsk(null)} />}
      <div className="file-editor" ref={host} />
    </div>
  )
}
