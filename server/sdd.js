// Read-only viewer of /full-task SDD artifacts: <cwd>/.superpowers/sdd/<plan>/progress.md, verdicts/task-<N>.md and
// requirements.md (the «СА ↔ SDD ↔ код» table the agent writes before its first edit).
// Tolerant: a `key: value` block (bold keys, list markers allowed) plus list items under a key; anything not
// understood is still available as `raw`.
import fs from 'node:fs';
import path from 'node:path';

const VERDICTS = ['PASS', 'FAIL', 'ESCALATION_REQUIRED', 'INDEPENDENT_VERIFICATION_REQUIRED'];
const KEYS = ['status', 'files_changed', 'commands', 'open_questions', 'implementer_model', 'reviewer_model', 'second_review_model', 'notes'];

/** Only explicit markers count: a checkbox, ✅/❌/⏳, or `status: DONE|PASS|FAIL|…`; a word in the text is no status. */
function itemStatus(line) {
  const box = line.match(/^\s*(?:[-*]|\d+\.)\s*\[(.)\]/);
  if (box) return { x: 'done', X: 'done', ' ': 'pending', '~': 'in_progress', '-': 'in_progress', '!': 'failed' }[box[1]] ?? null;
  if (/✅|✔/.test(line)) return 'done';
  if (/❌|✖/.test(line)) return 'failed';
  if (/⏳|🔄/.test(line)) return 'in_progress';
  const st = line.replace(/[*`]/g, '').match(/\bstatus\s*[:=]\s*([A-Za-z_]+)/i)?.[1].toUpperCase();
  return { DONE: 'done', PASS: 'done', PASSED: 'done', FAIL: 'failed', FAILED: 'failed', IN_PROGRESS: 'in_progress', PENDING: 'pending', TODO: 'pending' }[st] ?? null;
}

/** → { raw, items: [{ title, status }], total, done }; done is null when no item carries an explicit marker. */
export function parseProgress(raw) {
  const items = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!/^\s*(?:[-*]|\d+\.)\s+/.test(line)) continue;
    const title = line.replace(/^\s*(?:[-*]|\d+\.)\s*(\[.\]\s*)?/, '').trim();
    if (title) items.push({ title, status: itemStatus(line) });
  }
  const marked = items.some((i) => i.status !== null);
  return { raw, items, total: items.length, done: marked ? items.filter((i) => i.status === 'done').length : null };
}

/** verdicts/task-N.md -> { status, filesChanged, commands: [{ cmd, result }], openQuestions, *Model, notes, raw } */
export function parseVerdict(raw) {
  const fields = {};
  let list = null;
  for (const line of raw.split(/\r?\n/)) {
    const clean = line.replace(/\*\*/g, '').replace(/`/g, '');
    const kv = clean.match(/^\s*(?:[-*]\s+)?([A-Za-z_ ]+?)\s*:\s*(.*)$/);
    const key = kv && kv[1].trim().toLowerCase().replace(/\s+/g, '_');
    if (kv && KEYS.includes(key)) {
      const value = kv[2].trim();
      list = value ? null : key;
      fields[key] = value ? value : [];
      continue;
    }
    const item = clean.match(/^\s*[-*]\s+(.*)$/);
    if (item && list) fields[list].push(item[1].trim());
    else if (clean.trim() && !/^#/.test(clean.trim())) list = null;
  }
  const asList = (v) => (Array.isArray(v) ? v : v ? v.split(/\s*[,;]\s*/).filter(Boolean) : []);
  const text = (v) => (Array.isArray(v) ? v.join('\n') : v) || null;
  const status = String(text(fields.status) || '').toUpperCase().match(new RegExp(VERDICTS.join('|')))?.[0] ?? null;
  return {
    status,
    filesChanged: asList(fields.files_changed),
    commands: asList(fields.commands).map((c) => {
      const m = c.match(/^(.*?)\s*(?:→|->)\s*(.*)$/);
      return m ? { cmd: m[1].trim(), result: m[2].trim() } : { cmd: c, result: null };
    }),
    openQuestions: (() => {
      const q = text(fields.open_questions);
      return q && !/^(none|нет|-)$/i.test(q) ? q : null;
    })(),
    implementerModel: text(fields.implementer_model),
    reviewerModel: text(fields.reviewer_model),
    secondReviewModel: text(fields.second_review_model),
    notes: text(fields.notes),
    raw,
  };
}

const read = (file) => fs.promises.readFile(file, 'utf8').catch(() => null);
const list = (dir) => fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
const mtime = (file) => fs.promises.stat(file).then((s) => s.mtimeMs, () => 0);

/**
 * Plans under <cwd>/.superpowers/sdd (sorted by name), with progress, verdicts and modifiedAt (newest progress/verdict
 * file). Async: polled every 3 s. With `forSession` { key, since } only the session's own: the plan name contains its
 * task key, or its files changed after the session started (an old ledger of another run is not shown).
 */
export async function readSdd(cwd, forSession = null) {
  const root = path.join(cwd, '.superpowers', 'sdd');
  const dirs = (await list(root)).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const plans = await Promise.all(dirs.map(async (name) => {
    const dir = path.join(root, name);
    const progressFile = path.join(dir, 'progress.md');
    const progressRaw = await read(progressFile);
    const requirementsFile = path.join(dir, 'requirements.md');
    const requirements = await read(requirementsFile);
    const files = (await list(path.join(dir, 'verdicts'))).map((d) => d.name).filter((f) => /^task-\d+\.md$/i.test(f));
    const verdicts = await Promise.all(files
      .map((file) => ({ n: Number(file.match(/\d+/)[0]), file: path.join(dir, 'verdicts', file) }))
      .sort((a, b) => a.n - b.n)
      .map(async ({ n, file }) => ({ n, file, ...parseVerdict((await read(file)) ?? '') })));
    const modifiedAt = Math.max(await mtime(progressFile), await mtime(requirementsFile), ...(await Promise.all(verdicts.map((v) => mtime(v.file))))) || null;
    return { name, dir, modifiedAt, progress: progressRaw === null ? null : parseProgress(progressRaw), requirements, verdicts };
  }));
  if (!forSession) return { plans };
  const key = forSession.key?.toLowerCase();
  return { plans: plans.filter((p) => (key && p.name.toLowerCase().includes(key)) || (p.modifiedAt || 0) > (forSession.since || 0)) };
}
