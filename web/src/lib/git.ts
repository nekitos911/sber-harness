import { useEffect } from 'react'
import { api, errorText, qs } from '../api'
import { getState, setState, useStore, wtKey, type GitInfo } from '../store'
import type { GitStatus } from '../types'
import { parseDiff, type DiffFile } from './diff'
import { normPath } from './format'

const inflight = new Set<string>()
const again = new Set<string>()

async function load(cwd: string): Promise<GitInfo> {
  try {
    const raw = await api<GitStatus>('GET', `/git/status${qs({ cwd })}`)
    const status: GitStatus = { branch: raw?.branch ?? null, upstream: raw?.upstream ?? null, ahead: raw?.ahead ?? 0, behind: raw?.behind ?? 0, files: Array.isArray(raw?.files) ? raw.files : [] }
    let files: DiffFile[] | null = []
    if (status.files.length) {
      // One whole-tree diff gives every file's +N −M and the inline diffs (untracked files come as added).
      try { files = parseDiff(String((await api<{ diff: string }>('GET', `/git/diff${qs({ cwd })}`))?.diff ?? '')) } catch { files = null }
    }
    return { status, error: null, files }
  } catch (e) {
    return { status: null, error: errorText(e), files: null }
  }
}

/** Re-read git status + diff of a worktree; a request while one is running queues exactly one more. */
export function refreshGit(cwd: string) {
  const k = wtKey(cwd)
  // The projects folder and plain folders are not repositories: say so without asking git.
  if (getState().workspaces.some((w) => (w.kind === 'root' || w.kind === 'folder') && wtKey(w.path) === k)) {
    if (!getState().git[k]) setState((s) => ({ git: { ...s.git, [k]: { status: null, error: 'не git-репозиторий', files: null } } }))
    return
  }
  if (inflight.has(k)) { again.add(k); return }
  inflight.add(k)
  void load(cwd)
    .then((info) => setState((s) => ({ git: { ...s.git, [k]: info } })))
    .finally(() => {
      inflight.delete(k)
      if (again.delete(k)) refreshGit(cwd)
    })
}

export const useGit = (cwd: string | null) => useStore((s) => (cwd ? s.git[wtKey(cwd)] : undefined))

/** Keep a worktree's git state fresh: on first look and whenever a session there changes status (a turn ends). */
export function useGitWatch(cwd: string | null) {
  const sig = useStore((s) => (cwd ? s.sessions.filter((x) => normPath(x.cwd) === normPath(cwd)).map((x) => x.id + x.status).join() : ''))
  useEffect(() => { if (cwd) refreshGit(cwd) }, [cwd, sig])
}

export const diffOf = (files: DiffFile[] | null | undefined, path: string) => {
  const p = path.replace(/\\/g, '/')
  return files?.find((f) => f.path === p || f.oldPath === p)
}

export function splitPath(path: string) {
  const p = path.replace(/\\/g, '/')
  const cut = p.lastIndexOf('/')
  return { dir: cut > 0 ? p.slice(0, cut) : '', name: p.slice(cut + 1) }
}

/** Letters as editors show them: untracked is U (green), a merge conflict is C (red). */
export const gsLetter = (s: string) => (s === '?' ? 'U' : s === 'U' ? 'C' : s)
