import { useEffect, useRef, useState, type RefObject } from 'react'
import { ChevronDown, Plus, X } from 'lucide-react'
import { api, qs } from '../api'
import { useFeature } from '../store'
import { useSettings } from '../lib/agents'
import { Menu, Popover } from './ui'
import { loadDraft, saveDraft } from '../lib/draft'
import { plural } from '../lib/format'

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

/**
 * «Куда: [develop] [release/1.54.1] ＋ релиз»: target branches as chips. «＋ релиз» lists recent release branches
 * (GET /releases) and resolves a version («54», «1.54»). Any chip but the base goes with ×; the base only while
 * another target remains. With `detectText` the releases it names join live («только в релиз 54» drops the base),
 * and leave again when the text stops naming them; a chip the person removed is not brought back.
 */
export function TargetsLine({ targets, onChange, workspaceId, detectText }: {
  targets: string[]; onChange: (t: string[]) => void; workspaceId?: string | null; detectText?: string
}) {
  const settings = useSettings()
  const base = settings?.git.defaultBase ?? 'develop'
  const list = targets.length ? targets : [base]
  const rel = useReleaseTargets(detectText ?? '', workspaceId)
  const named = rel.found.map((r) => r.branch!)
  const only = !!rel.res?.onlyRelease && named.length > 0
  const auto = useRef<string[]>([]) // what the text added
  const droppedBase = useRef(false) // the text («только в релиз») took the base away
  const dismissed = useRef(new Set<string>())
  useEffect(() => {
    if (detectText === undefined) return
    let next = list.filter((b) => !auto.current.includes(b))
    if (droppedBase.current && !next.includes(base)) next = [base, ...next]
    const add = named.filter((b) => !next.includes(b) && !dismissed.current.has(b))
    next = [...next, ...add]
    droppedBase.current = only && next.includes(base) && next.length > 1
    if (droppedBase.current) next = next.filter((b) => b !== base)
    auto.current = add
    if (next.join('|') !== list.join('|')) onChange(next)
  }, [named.join('|'), only]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (next: string[]) => onChange(next.length ? next : [base])
  const remove = (b: string) => { dismissed.current.add(b); auto.current = auto.current.filter((x) => x !== b); if (b === base) droppedBase.current = false; set(list.filter((x) => x !== b)) }
  const [adding, setAdding] = useState(false)
  const addRef = useRef<HTMLButtonElement>(null)
  const hasRelease = list.some((b) => b !== base)
  // the note about how releases are done is shown once
  const [hint] = useState(() => !loadDraft<boolean>('hint:targets'))
  useEffect(() => { if (hint && hasRelease) saveDraft('hint:targets', true) }, [hint, hasRelease])
  return (
    <div className="targets-line">
      <span className="targets-label">Влить в:</span>
      {list.map((b) => (
        <span key={b} className="chip chip-mono rel-chip">
          {b}
          {(b !== base || list.length > 1) && <button type="button" className="rel-chip-x" aria-label={`Убрать ${b}`} onClick={() => remove(b)}><X /></button>}
        </span>
      ))}
      <button ref={addRef} type="button" className="btn btn-ghost btn-xs targets-add" aria-expanded={adding} aria-haspopup="dialog" onClick={() => setAdding(!adding)}><Plus aria-hidden />релиз</button>
      {adding && (
        <AddRelease anchor={addRef} workspaceId={workspaceId} have={list} onClose={() => setAdding(false)}
          onAdd={(b) => { dismissed.current.delete(b); set([...list, b].filter((x, i, a) => a.indexOf(x) === i)); setAdding(false) }} />
      )}
      {rel.unresolved.map((r) => <span key={r.phrase} className="rel-missing">ветка релиза {r.version} не найдена: передам текстом</span>)}
      {hasRelease && hint && <span className="targets-hint">Основная работа идёт в {base}, в релиз она переносится отдельной веткой и PR.</span>}
    </div>
  )
}

/** «＋ релиз»: recent release branches, newest first, or a version to resolve. */
function AddRelease({ anchor, workspaceId, have, onClose, onAdd }: {
  anchor: RefObject<HTMLElement | null>; workspaceId?: string | null; have: string[]; onClose: () => void; onAdd: (b: string) => void
}) {
  const [list, setList] = useState<{ branch: string; repos: string[] }[] | null>(null)
  const [v, setV] = useState('')
  const [miss, setMiss] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api<{ branch: string; repos: string[] }[]>('GET', `/releases${qs({ workspaceId: workspaceId ?? undefined })}`)
      .then((r) => setList(Array.isArray(r) ? r : []), () => setList([]))
  }, [workspaceId])
  const resolve = async () => {
    const t = v.trim()
    if (!t || busy) return
    setBusy(true)
    const r = await api<{ refs: { branch: string | null }[] }>('GET', `/releases/resolve${qs({ text: /^\d+(\.\d+)*$/.test(t) ? `релиз ${t}` : t, workspaceId: workspaceId ?? undefined })}`).catch(() => null)
    setBusy(false)
    const b = r?.refs?.find((x) => x.branch)?.branch
    if (b) onAdd(b)
    else setMiss(t)
  }
  const shown = list?.filter((r) => !have.includes(r.branch)) ?? []
  return (
    <Popover anchor={anchor} open onClose={onClose} placement="bottom-start" label="Добавить релиз" className="add-release">
      {list === null ? <p className="muted add-release-note">Загрузка…</p> : shown.length === 0 ? <p className="muted add-release-note">Других релизных веток нет.</p> : (
        <div className="add-release-list" data-tip-quiet>
          {shown.map((r) => (
            <button key={r.branch} type="button" className="add-release-row" onClick={() => onAdd(r.branch)}>
              <span className="mono ellipsis">{r.branch}</span>
              <span className="muted">{r.repos.length} {plural(r.repos.length, 'репозиторий', 'репозитория', 'репозиториев')}</span>
            </button>
          ))}
        </div>
      )}
      <label className="field">
        <span>или версия</span>
        <input className="input" placeholder="54 или 1.54, Enter" value={v} disabled={busy} onChange={(e) => { setV(e.target.value); setMiss(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void resolve() } }} />
      </label>
      {miss && <p className="rel-missing">Ветка релиза {miss} не найдена.</p>}
    </Popover>
  )
}
