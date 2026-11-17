/** The token being typed at the caret: «@que» anywhere, or «/com» as the first word. */
export function tokenAt(text: string, caret: number): { kind: '@' | '/'; query: string; start: number } | null {
  const before = text.slice(0, caret)
  const at = /(^|\s)@([^\s@]*)$/.exec(before)
  if (at) return { kind: '@', query: at[2], start: caret - at[2].length - 1 }
  const sl = /^\/([^\s]*)$/.exec(before)
  if (sl) return { kind: '/', query: sl[1], start: 0 }
  return null
}
