import { Check, X } from 'lucide-react'
import { openTab } from '../../store'
import { planDone, VERDICT_LABEL } from '../../lib/sdd'
import { plural } from '../../lib/format'
import type { SddPlan, SddVerdict } from '../../types'
import { Markdown } from '../Markdown'
import { Disclosure } from '../ui'

/**
 * «Вердикты»: /full-task plans with their progress and a card per verdicted step. `scope` (when the panel shows a
 * chat): only this chat's plans, or every plan of the folder.
 */
export function VerdictsTab({ cwd, plans, scope }: { cwd: string; plans: SddPlan[]; scope?: { all: boolean; set: (all: boolean) => void } }) {
  return (
    <div className="verdicts">
      {scope && (
        <label className="verdicts-scope">
          <input type="checkbox" checked={scope.all} onChange={(e) => scope.set(e.target.checked)} />
          Показать все планы папки
        </label>
      )}
      {plans.length === 0 && <p className="wpanel-note">У этого чата нет планов /full-task.</p>}
      {plans.map((p) => {
        const done = planDone(p)
        const n = p.progress.items.length
        return (
          <section key={p.dir} className="wpanel-section">
            <h3>{p.name} <span className="muted num">{done === null ? `${n} ${plural(n, 'пункт', 'пункта', 'пунктов')}` : `${done}/${n}`}</span></h3>
            {p.requirements && (
              <Disclosure className="verdict" defaultOpen={!p.verdicts.length} summary={<span>Требования: СА ↔ SDD ↔ код</span>}>
                <div className="verdict-body"><Markdown text={p.requirements} /></div>
              </Disclosure>
            )}
            {n > 0 && (done === null ? (
              <ul className="sdd-items">{p.progress.items.map((it, i) => <li key={i}>{it.title}</li>)}</ul>
            ) : (
              <ul className="sdd-progress">
                {p.progress.items.map((it, i) => <li key={i} data-s={it.status ?? undefined}><span className="sdd-dot" aria-hidden />{it.title}<span className="muted">{it.status}</span></li>)}
              </ul>
            ))}
            {p.verdicts.map((v) => <VerdictCard key={v.file} v={v} cwd={cwd} />)}
            {!p.verdicts.length && !p.progress.items.length && p.progress.raw && <Markdown text={p.progress.raw} />}
          </section>
        )
      })}
    </div>
  )
}

export function VerdictChip({ status }: { status: SddVerdict['status'] }) {
  return <span className="verdict-chip" data-v={status ?? 'none'}>{status ? VERDICT_LABEL[status] ?? status : 'без вердикта'}</span>
}

function VerdictCard({ v, cwd }: { v: SddVerdict; cwd: string }) {
  const models = [v.implementerModel && `реализатор: ${v.implementerModel}`, v.reviewerModel && `ревьюер: ${v.reviewerModel}`, v.secondReviewModel && `второе мнение: ${v.secondReviewModel}`].filter(Boolean).join(' · ')
  const questions = Array.isArray(v.openQuestions) ? v.openQuestions : v.openQuestions ? [v.openQuestions] : []
  const parsed = v.status || v.filesChanged?.length || v.commands?.length
  return (
    <Disclosure className="verdict" defaultOpen={v.status === 'FAIL' || v.status === 'ESCALATION_REQUIRED'}
      summary={<><span className="num muted">Шаг {v.n}</span><VerdictChip status={v.status} /></>}>
      <div className="verdict-body">
        {models && <p className="verdict-models mono">{models}</p>}
        {v.findings && <p className="verdict-models">Находки ревью: {v.findings}</p>}
        {!!v.filesChanged?.length && (
          <div className="verdict-files">
            {v.filesChanged.map((f) => <button key={f} type="button" className="link-file mono" onClick={() => openTab({ kind: 'diff', cwd, path: f })} data-tip="Открыть diff">{f}</button>)}
          </div>
        )}
        {!!v.commands?.length && (
          <ul className="verdict-cmds">
            {v.commands.map((c, i) => {
              const ok = /pass|ok|success|✓|0 fail|exit 0/i.test(c.result) && !/fail|error|✗/i.test(c.result)
              return <li key={i} className="mono">{ok ? <Check className="ok" aria-label="успех" /> : <X className="bad" aria-label="ошибка" />}<span>{c.cmd}</span><span className="muted">{c.result}</span></li>
            })}
          </ul>
        )}
        {questions.length > 0 && <div className="verdict-q"><strong>Открытые вопросы</strong>{questions.map((q, i) => <p key={i}>{q}</p>)}</div>}
        {v.notes && <Markdown text={v.notes} />}
        {!parsed && <Markdown text={v.raw} />}
      </div>
    </Disclosure>
  )
}
