// What the agent's own «/context» answer says about the context window, as numbers for the ring's popover
// (docs/GIGACODE-FACTS.md). GigaCode prints a fixed vocabulary; unknown sections still land in the list with their
// token count, so an agent that adds or renames a section keeps working.

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)\s*([kKmMмМ]?)(?=\s*tokens?\b|[\s(,.]|$)`;
const TOTAL_RE = new RegExp(String.raw`Context window:\s*${NUMBER}`);
const SECTION_RE = new RegExp(String.raw`^\s{2,}(.+?)[\s.…]*\s${NUMBER}(?:\s*tokens\b)?\s*\((\d+(?:[.,]\d+)?)\s*%\)\s*$`);
// «**Free space**: 200.0k tokens (76.3%)» — the text before the count is its wording, not part of the line
const FREE_RE = new RegExp(String.raw`\*\*[^*\n]*\*\*[^\d\n]*${NUMBER}\s*tokens?\s*\(\s*(\d+(?:[.,]\d+)?)\s*%\)`);

/** "5.2k" | "262,1k" | "1.2M" -> tokens; plain digits count as tokens. */
export function parseTokenCount(value, unit = '') {
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const u = String(unit ?? '').toLowerCase();
  if (u === 'k' || u === 'к') return Math.round(n * 1000);
  if (u === 'm' || u === 'м') return Math.round(n * 1000000);
  return Math.round(n);
}

const round = (n) => Math.max(1, Math.round(n / 100) * 100);

/**
 * «/context» text -> { limit, used, free, items: [{ label, tokens, share }] } or null when there is no window line.
 * `used`/`free` are filled only when the agent reports a spent total; otherwise the caller supplies it.
 */
export function parseContextUsage(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let limit = null;
  let used = null;
  let freeOf = null;
  const items = [];
  for (const line of lines) {
    if (freeOf === null && /free space|available|свободн/i.test(line)) {
      const m = FREE_RE.exec(line);
      if (m) freeOf = m;
    }
    if (limit === null) {
      const total = TOTAL_RE.exec(line);
      if (total) {
        limit = parseTokenCount(total[1], total[2]);
        continue;
      }
    }
    const section = SECTION_RE.exec(line);
    if (!section) continue;
    const tokens = parseTokenCount(section[2], section[3]);
    if (tokens === null) continue;
    items.push({ label: section[1].replace(/[*_`]/g, '').trim(), tokens, share: Number(section[4].replace(',', '.')) });
  }
  // «Free space» is a free amount, so it is read once the window is known whatever order the answer prints them in
  if (freeOf && limit) used = limit - parseTokenCount(freeOf[1], freeOf[2]);
  if (!limit || !items.length) return null;
  return { limit, used, free: used === null ? null : Math.max(0, limit - used), items };
}

/**
 * The breakdown rows for the ring: the agent's own numbers, else the reported total minus them. An agent may account
 * only part of the window; `rest` says how much is unaccounted for, so the popover never claims more than it knows.
 */
export function contextBreakdown(report, total) {
  const sum = report.items.reduce((n, x) => n + x.tokens, 0);
  const used = report.used ?? total ?? sum;
  const rows = report.items.map((x) => ({ label: x.label, tokens: x.tokens }));
  if (report.used !== null) {
    // a spent total the agent did not break down (e.g. conversation not shown): the rest is the conversation
    const rest = used - sum;
    if (rest > 500) rows.push({ label: 'Остальное в окне', tokens: round(rest) });
    return { at: Date.now(), limit: report.limit, used, items: rows, partial: false };
  }
  // the answer accounts the start-up only: the total's remainder is the conversation, which /context cannot see
  const conversation = total && total - sum > 500 ? total - sum : 0;
  return { at: Date.now(), limit: report.limit, used, items: rows, partial: true, unaccounted: conversation };
}
