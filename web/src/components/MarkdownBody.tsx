import { useRef, useState, type ComponentPropsWithoutRef } from 'react'
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

export default function MarkdownBody({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
}
