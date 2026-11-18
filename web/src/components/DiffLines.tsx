import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { emphasis, type DiffLine } from '../lib/diff'
import { AgentComment } from './AgentComment'

function text(l: DiffLine, range: [number, number] | undefined): ReactNode {
  if (!l.text) return ' '
  if (!range) return l.text
  return <>{l.text.slice(0, range[0])}<mark>{l.text.slice(range[0], range[1])}</mark>{l.text.slice(range[1])}</>
}

const SIGN = { add: '+', del: '−', ctx: ' ', hunk: '', note: '' } as const
const ASCII = { add: '+', del: '-', ctx: ' ', hunk: '', note: '' } as const // what the agent reads

/**
 * Unified diff body: old/new line numbers, sign, add/remove backgrounds, hunk headers. With `comment` (a file of a
 * worktree) a line's «+» selects it, Shift+click a range, and a «Комментарий агенту» form opens under the selection.
 */
export function DiffLines({ lines, limit = 1500, numbers = true, label, comment }: {
  lines: DiffLine[]; limit?: number; numbers?: boolean; label: string; comment?: { cwd: string; path: string }
}) {
  const [all, setAll] = useState(false)
  const [sel, setSel] = useState<[number, number] | null>(null)
  const marks = useMemo(() => emphasis(lines), [lines])
  const shown = all ? lines : lines.slice(0, limit)
  const [lo, hi] = sel ? [Math.min(...sel), Math.max(...sel)] : [-1, -1]
  const pick = (i: number) => (e: MouseEvent) => setSel(e.shiftKey && sel ? [sel[0], i] : [i, i])
  const picked = sel ? lines.slice(lo, hi + 1).filter((l) => l.kind !== 'hunk' && l.kind !== 'note') : []
  const num = (l: DiffLine | undefined) => (l ? l.new ?? l.old : null)

  return (
    <div className="diff-table" data-numbers={numbers} data-comment={!!comment || undefined} role="table" aria-label={label}>
      {shown.map((l, i) => (
        l.kind === 'hunk' ? (
          <div key={i} className="dr" data-k="hunk" role="row">
            <span className="dc" role="cell">{l.text.replace(/^(@@[^@]*@@)\s*/, '$1  ')}</span>
          </div>
        ) : (
          <div key={i} role="presentation">
            <div className="dr" data-k={l.kind} data-sel={(i >= lo && i <= hi) || undefined} role="row">
              {numbers && <span className="dn" role="cell">{l.old ?? ''}</span>}
              {numbers && <span className="dn" role="cell">{l.new ?? ''}</span>}
              <span className="dl-sign" aria-hidden>{SIGN[l.kind]}</span>
              <span className="dc" role="cell">{text(l, marks.get(i))}</span>
              {comment && (
                <button type="button" className="dr-comment" aria-label={`Комментарий агенту к строке ${num(l) ?? ''}`} onClick={pick(i)}>
                  <Plus aria-hidden />
                </button>
              )}
            </div>
            {comment && i === hi && (
              <AgentComment
                cwd={comment.cwd} path={comment.path} from={num(picked[0])} to={num(picked.at(-1))}
                snippet={picked.map((x) => `${ASCII[x.kind]}${x.text}`).join('\n')} onDone={() => setSel(null)}
              />
            )}
          </div>
        )
      ))}
      {!all && lines.length > limit && (
        <button type="button" className="btn btn-ghost btn-sm diff-more" onClick={() => setAll(true)}>
          Показать остальные {lines.length - limit} строк
        </button>
      )}
    </div>
  )
}
