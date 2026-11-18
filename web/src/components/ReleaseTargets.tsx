import { useEffect, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { api, qs } from '../api'
import { useFeature } from '../store'
import { useSettings } from '../lib/agents'
import { Menu } from './ui'

interface ReleaseRef { phrase: string; version: string; branch: string | null; repos: string[]; candidates: string[] }
interface Resolved { refs: ReleaseRef[]; onlyRelease: boolean }

// «релиз 54», «release 1.54.1», «rel154», «1.54»: only such text is worth asking about
const LIKELY = /(?:релиз|release|\brel)\s*\d|\b\d+\.\d+(?:\.\d+)?\b/i

/**
 * Releases named in what the person writes («релиз 54», «1.54», «только в релиз 54»), resolved to branches
 * (GET /releases/resolve, feature release-resolve): the targets as chips. `targets` is undefined until the person
 * changes the chips (the server then reads the text itself); after a change it is the chips' branches.
 */
export function useReleaseTargets(text: string, workspaceId?: string | null) {
  const on = useFeature('release-resolve')
  const settings = useSettings()
  const base = settings?.git.defaultBase ?? 'develop'
  const [res, setRes] = useState<Resolved | null>(null)
  const [removed, setRemoved] = useState<string[]>([])
  const [chosen, setChosen] = useState<Record<string, string>>({}) // phrase → another candidate
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (!on || !LIKELY.test(text)) { setRes(null); return }
    let live = true
    const t = window.setTimeout(() => {
      api<Resolved>('GET', `/releases/resolve${qs({ text, workspaceId: workspaceId ?? undefined })}`)
        .then((r) => { if (live) setRes(r?.refs?.length ? r : null) }, () => { if (live) setRes(null) })
    }, 400)
    return () => { live = false; window.clearTimeout(t) }
  }, [on, text, workspaceId])
  const found = res?.refs.filter((r) => r.branch) ?? []
  const branches = [...(res && !res.onlyRelease && found.length ? [base] : []), ...found.map((r) => chosen[r.phrase] ?? r.branch!)]
  const chips = branches.filter((b) => !removed.includes(b))
  return {
    res, base, chips, found,
    unresolved: res?.refs.filter((r) => !r.branch) ?? [],
    targets: touched && chips.length ? chips : undefined,
    remove: (b: string) => { setRemoved([...removed, b]); setTouched(true) },
    choose: (phrase: string, branch: string) => { setChosen({ ...chosen, [phrase]: branch }); setTouched(true) },
    reset: () => { setRemoved([]); setChosen({}); setTouched(false) },
  }
}

export type ReleaseTargets = ReturnType<typeof useReleaseTargets>

/** «→ develop + release/1.54.0»: removable chips, other patch versions on the release chip; amber when not found. */
export function ReleaseChips({ rel }: { rel: ReleaseTargets }) {
  if (!rel.res) return null
  return (
    <div className="rel-chips">
      {rel.chips.length > 0 && (
        <>
          <span className="rel-arrow" aria-hidden>→</span>
          {rel.chips.map((b, i) => {
            const ref = rel.found.find((r) => (r.branch === b || r.candidates.includes(b)) && b !== rel.base)
            return (
              <span key={b} className="rel-chip-wrap">
                {i > 0 && <span className="rel-plus" aria-hidden>+</span>}
                <ReleaseChip branch={b} candidates={ref && ref.candidates.length > 1 ? ref.candidates : []}
                  onPick={(c) => ref && rel.choose(ref.phrase, c)} onRemove={() => rel.remove(b)} />
              </span>
            )
          })}
        </>
      )}
      {rel.unresolved.map((r) => (
        <span key={r.phrase} className="rel-missing">ветка релиза {r.version} не найдена: передам текстом</span>
      ))}
    </div>
  )
}

function ReleaseChip({ branch, candidates, onPick, onRemove }: { branch: string; candidates: string[]; onPick: (b: string) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <span className="chip chip-mono rel-chip">
      {candidates.length ? (
        <>
          <button ref={btn} type="button" className="rel-chip-pick" aria-haspopup="menu" aria-expanded={open} aria-label={`${branch}: другая версия релиза`} onClick={() => setOpen(!open)}>
            {branch}<ChevronDown aria-hidden />
          </button>
          <Menu anchor={btn} open={open} onClose={() => setOpen(false)} label="Версия релиза" placement="bottom-start"
            items={candidates.map((c) => ({ label: `${c === branch ? '✓ ' : ''}${c}`, onSelect: () => onPick(c) }))} />
        </>
      ) : branch}
      <button type="button" className="rel-chip-x" aria-label={`Убрать ${branch}`} onClick={onRemove}><X /></button>
    </span>
  )
}
