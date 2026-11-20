import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * Expandable block (replaces <details>): a toggle button for the summary, optional actions beside it
 * (never nested inside the toggle), and a height-animated body that mounts on first open.
 * Uncontrolled by default; pass `open` + `onToggle` to drive it from outside.
 */
export function Disclosure({ summary, actions, children, defaultOpen = false, open: controlled, onToggle, className, chevron = 'start', label }: {
  summary: ReactNode
  actions?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onToggle?: (open: boolean) => void
  className?: string
  chevron?: 'start' | 'end'
  label?: string
}) {
  const [own, setOwn] = useState(defaultOpen)
  const open = controlled ?? own
  const [seen, setSeen] = useState(open)
  if (open && !seen) setSeen(true)
  const toggle = () => { setOwn(!open); onToggle?.(!open) }
  const chev = <ChevronRight className="chev" aria-hidden />
  return (
    <div className={`disclosure ${className ?? ''}`} data-open={open}>
      <div className="disclosure-head">
        <button type="button" className="disclosure-toggle" aria-expanded={open} aria-label={label} onClick={toggle}>
          {chevron === 'start' && chev}
          {summary}
          {chevron === 'end' && chev}
        </button>
        {actions}
      </div>
      <div className="collapse" data-open={open} inert={!open}>
        <div>{seen && children}</div>
      </div>
    </div>
  )
}
