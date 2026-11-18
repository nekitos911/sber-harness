// Files attached in the composer travel to the agent as a list of paths at the end of the message; the chat shows them
// as thumbnails / chips again instead of the raw paths.

const HEAD = 'Вложения:'

/** «текст\n\nВложения:\n1. C:\…\a.png\n2. …» — the agent reads one path per line (no quoting needed). */
export function withAttachments(text: string, paths: string[]): string {
  if (!paths.length) return text
  return [text, `${HEAD}\n${paths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`].filter(Boolean).join('\n\n')
}

/** The reverse: the message's own text and the attached paths (none when the message has no such block at its end). */
export function splitAttachments(text: string): { text: string; paths: string[] } {
  const m = /(?:^|\n\n)Вложения:\n((?:\d+\. [^\n]+(?:\n|$))+)$/.exec(text)
  if (!m) return { text, paths: [] }
  return { text: text.slice(0, m.index).trimEnd(), paths: m[1].trim().split('\n').map((l) => l.replace(/^\d+\. /, '')) }
}

export const isImagePath = (p: string) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)
