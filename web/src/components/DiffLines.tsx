import { useMemo, useState, type ReactNode } from 'react'
import { emphasis, type DiffLine } from '../lib/diff'

function text(l: DiffLine, range: [number, number] | undefined): ReactNode {
  if (!l.text) return ' '
  if (!range) return l.text
  return <>{l.text.slice(0, range[0])}<mark>{l.text.slice(range[0], range[1])}</mark>{l.text.slice(range[1])}</>
}

const SIGN = { add: '+', del: '−', ctx: ' ', hunk: '', note: '' } as const

/** Unified diff body: old/new line numbers, sign, add/remove backgrounds, hunk headers. */
export function DiffLines({ lines, limit = 1500, numbers = true, label }: { lines: DiffLine[]; limit?: number; numbers?: boolean; label: string }) {
  const [all, setAll] = useState(false)
  const marks = useMemo(() => emphasis(lines), [lines])
  const shown = all ? lines : lines.slice(0, limit)
  return (
    <div className="diff-table" data-numbers={numbers} role="table" aria-label={label}>
      {shown.map((l, i) => (
        l.kind === 'hunk' ? (
          <div key={i} className="dr" data-k="hunk" role="row">
            <span className="dc" role="cell">{l.text.replace(/^(@@[^@]*@@)\s*/, '$1  ')}</span>
          </div>
        ) : (
          <div key={i} className="dr" data-k={l.kind} role="row">
            {numbers && <span className="dn" role="cell">{l.old ?? ''}</span>}
            {numbers && <span className="dn" role="cell">{l.new ?? ''}</span>}
            <span className="dl-sign" aria-hidden>{SIGN[l.kind]}</span>
            <span className="dc" role="cell">{text(l, marks.get(i))}</span>
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
