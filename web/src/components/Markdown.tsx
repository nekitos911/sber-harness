import { memo, useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'

function CodeBlock(props: ComponentPropsWithoutRef<'pre'>) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref.current?.textContent ?? '')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch { /* clipboard blocked: nothing to do */ }
  }
  return (
    <div className="md-code">
      <button type="button" className="icon-btn icon-btn-sm md-copy" onClick={copy} aria-label={copied ? 'Скопировано' : 'Копировать код'}>
        {copied ? <Check /> : <Copy />}
      </button>
      <pre ref={ref}>{props.children}</pre>
    </div>
  )
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
}

/** GFM markdown without raw HTML (react-markdown escapes it by default). */
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  )
})
