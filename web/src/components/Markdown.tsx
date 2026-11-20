import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react'

const MarkdownBody = lazy(() => import('./MarkdownBody'))

/**
 * A text that keeps changing (an answer being written) is shown at most every `ms`; the last version always shows.
 * The whole markdown is parsed again for every version: ~12 a second for a long streamed report was a real cost.
 */
function useSettled(value: string, ms: number): string {
  const [shown, setShown] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    if (value === shown) return
    const t = window.setTimeout(() => { last.current = Date.now(); setShown(value) }, Math.max(0, ms - (Date.now() - last.current)))
    return () => window.clearTimeout(t)
  }, [value, shown, ms])
  return shown
}

export const Markdown = memo(function Markdown({ text: live }: { text: string }) {
  const text = useSettled(live, 300)
  return (
    <div className="md">
      <Suspense fallback={text}><MarkdownBody text={text} /></Suspense>
    </div>
  )
})
