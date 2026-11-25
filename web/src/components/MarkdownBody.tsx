import { useRef, useState, type ComponentPropsWithoutRef, type ReactElement } from 'react'
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

// Parsed trees by text (ReactMarkdown is a pure function): a chat shown again, its older messages, the same report on
// another screen are not parsed again — parsing was most of the cost of opening a long chat.
const parsed = new Map<string, ReactElement>()
const plugins = [remarkGfm]

export default function MarkdownBody({ text }: { text: string }) {
  let tree = parsed.get(text)
  if (!tree) {
    tree = ReactMarkdown({ remarkPlugins: plugins, components, children: text }) as ReactElement
    parsed.set(text, tree)
    if (parsed.size > 1000) parsed.delete(parsed.keys().next().value!) // oldest out
  }
  return tree
}
