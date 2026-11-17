import { useState } from 'react'
import { X } from 'lucide-react'

/** Short string list as removable chips; Enter, comma or blur adds what was typed. */
export function ChipsInput({ values, onChange, label }: { values: string[]; onChange: (v: string[]) => void; label: string }) {
  const [v, setV] = useState('')
  const add = () => {
    const next = v.split(',').map((x) => x.trim()).filter((x) => x && !values.includes(x))
    if (next.length) onChange([...values, ...next])
    setV('')
  }
  return (
    <div className="chips">
      {values.map((x) => (
        <span key={x} className="chip">
          {x}
          <button type="button" className="chip-x" aria-label={`Убрать ${x}`} onClick={() => onChange(values.filter((y) => y !== x))}><X /></button>
        </span>
      ))}
      <input
        className="input input-inline"
        placeholder={`+ ${label}`}
        aria-label={`Добавить ${label}`}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
        onBlur={add}
      />
    </div>
  )
}
