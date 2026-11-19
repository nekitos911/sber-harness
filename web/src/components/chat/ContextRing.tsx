import { useRef, useState } from 'react'
import { tryApi } from '../../api'
import { toast, useStore } from '../../store'
import { tokens } from '../../lib/format'
import type { Session } from '../../types'
import { Button, Popover } from '../ui'

const R = 7
const C = 2 * Math.PI * R

/**
 * How full the model's context window is: a small ring left of «Отправить» (neutral < 60 %, amber to 85 %, red above),
 * with the numbers in a popover and «Сжать контекст» past half. Hidden while the server does not report both numbers.
 */
export function ContextRing({ session, running }: { session: Session; running: boolean }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === session.agent))
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const used = session.context?.tokens
  const limit = session.contextLimit
  if (!used) return null
  // a model whose window is unknown (not in its name, not in the catalogue): the tokens still show, without a share
  const share = limit ? Math.min(1, used / limit) : 0
  const pct = Math.round(share * 100)
  const level = share > 0.85 ? 'high' : share >= 0.6 ? 'mid' : 'low'
  const ctx = session.context!
  const turn = { input: ctx.lastTurn?.input ?? ctx.input, output: ctx.lastTurn?.output ?? ctx.output, cached: ctx.lastTurn?.cacheRead ?? ctx.cached }
  // the chat's model, else what the CLI reported it runs (the agent default)
  const modelId = session.model || session.cliModel
  const model = agent?.models?.map((m) => (typeof m === 'string' ? { id: m, label: m } : m)).find((m) => m.id === modelId)
  const compress = agent?.compressCommand
  const sendCompress = async () => {
    if (!compress) return
    setBusy(true)
    const ok = (await tryApi('POST', `/sessions/${encodeURIComponent(session.id)}/messages`, { text: compress })) !== undefined
    setBusy(false)
    if (ok) { toast(`Отправлено ${compress}: агент сожмёт контекст`, 'ok'); setOpen(false) }
  }
  return (
    <>
      <button ref={btn} type="button" className="ctx-ring" data-level={level} aria-label={limit ? `Контекст: ${pct}%` : `Контекст: ${tokens(used)}`} aria-expanded={open}
        data-tip={open ? undefined : limit ? `Контекст: ${pct}% (${tokens(used)} из ${tokens(limit)})` : `Контекст: ${tokens(used)} (размер окна модели неизвестен)`} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden>
          <circle cx="9" cy="9" r={R} className="ctx-track" />
          <circle cx="9" cy="9" r={R} className="ctx-fill" strokeDasharray={C} strokeDashoffset={C * (1 - share)} transform="rotate(-90 9 9)" />
        </svg>
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} placement="top-end" label="Контекст" className="ctx-pop">
        <div className="ctx-head"><strong>Контекст</strong><span className="num">{limit ? `${tokens(used)} / ${tokens(limit)}` : tokens(used)}</span></div>
        {limit && <div className="ctx-bar" data-level={level} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Заполнение контекста">
          <span style={{ width: `${pct}%` }} />
        </div>}
        <dl className="ctx-rows">
          {(turn.input !== undefined || turn.output !== undefined) && (
            <><dt>Последний ход</dt><dd className="num">
              {[turn.input !== undefined && `вход ${tokens(turn.input)}`, turn.output !== undefined && `выход ${tokens(turn.output)}`, turn.cached && `из кэша ${tokens(turn.cached)}`].filter(Boolean).join(' · ')}
            </dd></>
          )}
          {session.tokensIn + session.tokensOut > 0 && <><dt>Всего в сессии</dt><dd className="num">вход {tokens(session.tokensIn)}, выход {tokens(session.tokensOut)}</dd></>}
          <dt>Модель</dt><dd>{model?.label ?? modelId ?? 'по умолчанию CLI'} · {limit ? `окно ${tokens(limit)}` : 'размер окна неизвестен'}</dd>
        </dl>
        {share > 0.5 && compress && (
          <Button size="sm" busy={busy} disabled={running || busy} onClick={() => void sendCompress()} tip={running ? 'Дождитесь конца хода' : `Отправить агенту ${compress}`}>Сжать контекст</Button>
        )}
        <p className="ctx-foot">Разбивка по категориям — команда {agent?.contextCommand ?? '/context'} (появится позже)</p>
      </Popover>
    </>
  )
}
