// Read-only viewer of /full-task SDD artifacts: <cwd>/.superpowers/sdd/<plan>/progress.md and verdicts/task-<N>.md.
// Tolerant: a `key: value` block (bold keys, list markers allowed) plus list items under a key; anything not
// understood is still available as `raw`.
import fs from 'node:fs';
import path from 'node:path';

const VERDICTS = ['PASS', 'FAIL', 'ESCALATION_REQUIRED', 'INDEPENDENT_VERIFICATION_REQUIRED'];
const KEYS = ['status', 'files_changed', 'commands', 'open_questions', 'implementer_model', 'reviewer_model', 'second_review_model', 'notes'];

function itemStatus(line) {
  const box = line.match(/^\s*(?:[-*]|\d+\.)\s*\[(.)\]/);
  if (box) return { x: 'done', X: 'done', ' ': 'pending', '~': 'in_progress', '-': 'in_progress', '!': 'failed' }[box[1]] ?? null;
  if (/\b(done|pass(ed)?|complete(d)?|готово|сделано)\b/i.test(line)) return 'done';
  if (/\b(in[ _-]?progress|wip|doing|в работе)\b/i.test(line)) return 'in_progress';
  if (/\b(fail(ed)?|blocked)\b/i.test(line)) return 'failed';
  return null;
}

export function parseProgress(raw) {
  const items = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!/^\s*(?:[-*]|\d+\.)\s+/.test(line)) continue;
    const title = line.replace(/^\s*(?:[-*]|\d+\.)\s*(\[.\]\s*)?/, '').trim();
    if (title) items.push({ title, status: itemStatus(line) });
  }
  return { raw, items };
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

/** All plans under <cwd>/.superpowers/sdd (sorted by name), with progress and verdicts. Async: polled every 3 s. */
export async function readSdd(cwd) {
  const root = path.join(cwd, '.superpowers', 'sdd');
  const dirs = (await list(root)).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  return {
    plans: await Promise.all(dirs.map(async (name) => {
      const dir = path.join(root, name);
      const progressRaw = await read(path.join(dir, 'progress.md'));
      const files = (await list(path.join(dir, 'verdicts'))).map((d) => d.name).filter((f) => /^task-\d+\.md$/i.test(f));
      const verdicts = await Promise.all(files
        .map((file) => ({ n: Number(file.match(/\d+/)[0]), file: path.join(dir, 'verdicts', file) }))
        .sort((a, b) => a.n - b.n)
        .map(async ({ n, file }) => ({ n, file, ...parseVerdict((await read(file)) ?? '') })));
      return { name, dir, progress: progressRaw === null ? null : parseProgress(progressRaw), verdicts };
    })),
  };
}
