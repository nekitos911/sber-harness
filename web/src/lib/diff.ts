// Minimal unified-diff parser for `git diff` output (multi-file, hunks, renames, binary).

export type LineKind = 'ctx' | 'add' | 'del' | 'hunk' | 'note'
export interface DiffLine { kind: LineKind; text: string; old: number | null; new: number | null }
export interface DiffFile {
  path: string
  oldPath: string | null
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary'
  lines: DiffLine[]
  added: number
  removed: number
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0 // lines still expected in the current hunk; a hunk line "--- x" is a deletion, not a header
  let newLeft = 0

  const start = (path: string, oldPath: string | null) => {
    file = { path, oldPath, status: 'modified', lines: [], added: 0, removed: 0 }
    files.push(file)
  }

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const inHunk = (oldLeft > 0 || newLeft > 0) && !line.startsWith('diff --git ')

    if (line[0] === '\\' && file) { // "\ No newline at end of file" (comes after the hunk counts run out)
      (file as DiffFile).lines.push({ kind: 'note', text: line, old: null, new: null })
      continue
    }
    if (inHunk && file) {
      const f: DiffFile = file
      const sign = line[0]
      if (sign === '+') { f.lines.push({ kind: 'add', text: line.slice(1), old: null, new: newNo++ }); f.added++; newLeft-- }
      else if (sign === '-') { f.lines.push({ kind: 'del', text: line.slice(1), old: oldNo++, new: null }); f.removed++; oldLeft-- }
      else { f.lines.push({ kind: 'ctx', text: line.slice(1), old: oldNo++, new: newNo++ }); oldLeft--; newLeft-- }
      continue
    }

    if (line.startsWith('diff --git ')) {
      oldLeft = newLeft = 0
      const m = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(line)
      start(m?.[2] ?? line.slice(11), m?.[1] ?? null)
      continue
    }
    if (line.startsWith('--- ') && (!file || (file as DiffFile).lines.length > 0)) {
      start(line.slice(4).replace(/^a\//, ''), null)
      continue
    }
    if (!file) continue
    const f: DiffFile = file
    const m = HUNK.exec(line)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[3])
      oldLeft = m[2] === undefined ? 1 : Number(m[2])
      newLeft = m[4] === undefined ? 1 : Number(m[4])
      f.lines.push({ kind: 'hunk', text: line, old: null, new: null })
    } else if (line.startsWith('new file mode')) f.status = 'added'
    else if (line.startsWith('deleted file mode')) f.status = 'deleted'
    else if (line.startsWith('rename from ')) { f.status = 'renamed'; f.oldPath = line.slice(12) }
    else if (line.startsWith('rename to ')) f.path = line.slice(10)
    else if (line.startsWith('Binary files')) f.status = 'binary'
    else if (line.startsWith('+++ ') && !line.endsWith('/dev/null')) f.path = line.slice(4).replace(/^b\//, '')
  }
  return files
}

/**
 * Word-level emphasis: a block of N removed lines followed by N added lines is read as N edited lines,
 * and the changed middle of each pair (between the common prefix and suffix) is highlighted.
 */
export function emphasis(lines: DiffLine[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>()
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind !== 'del') { i++; continue }
    let j = i
    while (j < lines.length && lines[j].kind === 'del') j++
    let k = j
    while (k < lines.length && lines[k].kind === 'add') k++
    const n = j - i
    if (n > 0 && n === k - j && n <= 40) {
      for (let p = 0; p < n; p++) {
        const a = lines[i + p].text
        const b = lines[j + p].text
        let pre = 0
        while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
        let suf = 0
        while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
        // A pair that changed almost entirely is a rewrite, not an edit: no emphasis.
        if (pre + suf < Math.min(a.length, b.length) * 0.3) continue
        if (a.length - suf > pre) out.set(i + p, [pre, a.length - suf])
        if (b.length - suf > pre) out.set(j + p, [pre, b.length - suf])
      }
    }
    i = k > j ? k : j
  }
  return out
}
