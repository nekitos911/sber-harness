import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * Expandable block (replaces <details>): a toggle button for the summary, optional actions beside it
 * (never nested inside the toggle), and a height-animated body that mounts on first open.
 */
export function Disclosure({ summary, actions, children, defaultOpen = false, className, chevron = 'start', label }: {
  summary: ReactNode
  actions?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
  chevron?: 'start' | 'end'
  label?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [seen, setSeen] = useState(defaultOpen)
  const toggle = () => { setOpen(!open); setSeen(true) }
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
      <div className="collapse" data-open={open}>
        <div>{seen && children}</div>
      </div>
    </div>
  )
}
