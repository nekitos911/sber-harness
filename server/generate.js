// Commit / PR messages written by the agent (POST /api/git/generate): the changes of a folder go to a one-off headless
// run of the default agent (quickArgs, plan mode, the fast grade; no session, no preamble), its first JSON object is the
// message; the limits of the code host are enforced here.
import * as git from './git.js';
import { jobStep } from './jobs.js';
import { launchers } from './launchers.js';
import { runHelper } from './helper.js';
import { truncateBytes } from './orchestration.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const GENERATE_MARKER = 'HARNESS_GENERATE_MESSAGE'; // first prompt line (the mock agent answers it)
const DIFF_MAX = 15000;
const FILE_MAX = 4000;
const ARGV_MAX = 22000; // the prompt is an argv element (Windows caps the command line at 32767)
const chars = (s, n) => (Array.from(s).length > n ? `${Array.from(s).slice(0, n).join('').trimEnd()}` : s);

/** The first `{…}` of a text that parses as a JSON object, else null. */
export function firstJson(text) {
  const s = String(text ?? '');
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    for (let j = s.indexOf('}', i); j >= 0; j = s.indexOf('}', j + 1)) {
      try {
        const v = JSON.parse(s.slice(i, j + 1));
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch {}
    }
  }
  return null;
}

/** The diff (staged + unstaged against HEAD) without service files, each file ≤ FILE_MAX, the whole ≤ max. */
async function diffText(cwd, exclude, max) {
  const r = await git.git(cwd, ['diff', 'HEAD'], { ok: [0, 128] });
  const raw = r.code ? (await git.git(cwd, ['diff', '--cached'], { ok: [0, 128] })).stdout : r.stdout;
  let out = '';
  for (const part of raw.split(/^(?=diff --git )/m).filter(Boolean)) {
    const file = part.match(/^diff --git a\/.+? b\/(.+)$/m)?.[1];
    if (file && git.isService(file, exclude)) continue;
    const piece = part.length > FILE_MAX ? `${part.slice(0, FILE_MAX)}\n… (файл обрезан)\n` : part;
    if (out.length + piece.length > max) return `${out}… (остальной diff обрезан)\n`;
    out += piece;
  }
  return out;
}

/**
 * kind 'commit' | 'pr' → { title, body, model, ms }. suggest = orchestration.gitSuggest (the folder's task, key, base).
 */
export async function generateMessage({ config, store, getUrl, tasks, suggest, cwd, kind, base }) {
  if (!['commit', 'pr'].includes(kind)) fail(400, 'kind: commit или pr');
  const t0 = Date.now();
  jobStep('Собираю изменения');
  const s = await suggest(cwd);
  const task = s.taskId ? tasks.find(s.taskId) : null;
  const exclude = config.git.excludeFromCommit;
  const [stat, st, subjects] = await Promise.all([
    git.git(cwd, ['diff', 'HEAD', '--stat'], { ok: [0, 128] }).then((r) => r.stdout.trim()),
    git.status(cwd, exclude),
    git.git(cwd, ['log', '-10', '--format=%s'], { ok: [0, 128] }).then((r) => r.stdout.trim()),
  ]);
  const untracked = st.files.filter((f) => f.x === '?' && !f.service).map((f) => f.path);
  const target = base || s.base;
  let commits = '';
  if (kind === 'pr') {
    const ref = (await git.refExists(cwd, target)) ? target : `origin/${target}`;
    commits = (await git.onelines(cwd, `${ref}..HEAD`).catch(() => [])).join('\n');
  }
  if (kind === 'commit' && !stat && !untracked.length && !st.files.some((f) => !f.service)) fail(400, 'нет изменений для коммита');

  const bodyBytes = config.integrations?.pr?.limits?.bodyBytes;
  const bodyChars = Math.min(300, bodyBytes || 300);
  const key = s.key;
  const desc = task?.description?.trim();
  const head = [
    GENERATE_MARKER,
    kind === 'commit'
      ? 'Напиши сообщение коммита для изменений ниже.'
      : `Напиши заголовок и описание pull request из ветки ${s.branch || 'HEAD'} в ${target}.`,
    'Ответь ТОЛЬКО одним JSON-объектом без пояснений и без markdown: {"title": "...", "body": "..."}.',
    kind === 'commit'
      ? `- title: одна строка до 72 символов${key ? `, начинается с «${key} » (ключ задачи и пробел)` : ''}; без двоеточия после ключа и без префиксов feat:/fix:.`
      : `- title: одна строка не длиннее 100 байт UTF-8 (кириллица — 2 байта на букву, т. е. ≈ 50 букв)${key ? `, начинается с «${key} »` : ''}.`,
    kind === 'commit' ? '- body: 1–4 строки — что изменено и зачем.' : `- body: не длиннее ${bodyChars} символов — что сделано и зачем.`,
    'Пиши по-русски, в стиле последних коммитов репозитория. Ничего не меняй в файлах и не запускай команды.',
    task && `Задача: ${key} — ${task.title}`,
    desc && `Описание задачи: ${desc.length > 1500 ? `${desc.slice(0, 1500)}…` : desc}`,
    subjects && `Последние коммиты репозитория:\n${subjects}`,
    commits && `Коммиты ветки (git log ${target}..HEAD):\n${commits}`,
    stat && `Изменения (git diff --stat):\n${stat}`,
    untracked.length && `Новые файлы:\n${untracked.slice(0, 50).join('\n')}`,
  ].filter(Boolean).join('\n\n');
  // the diff gets what is left of the argv budget (quotes are escaped on Windows: they count twice)
  const room = Math.min(DIFF_MAX, ARGV_MAX - head.length - (head.match(/["\\]/g)?.length ?? 0) - 100);
  let diff = room > 500 ? await diffText(cwd, exclude, room) : '';
  while (diff && diff.length + (diff.match(/["\\]/g)?.length ?? 0) > room) diff = `${diff.slice(0, Math.floor(diff.length * 0.8))}\n… (diff обрезан)\n`;
  const prompt = diff ? `${head}\n\nDiff:\n${diff}` : head;

  const agent = config.agents[config.defaultAgent] ? config.defaultAgent : Object.keys(config.agents)[0];
  const agentCfg = config.agents[agent] || fail(400, 'нет агента для генерации сообщения');
  const label = agentCfg.label || agent;
  const db = store.db;
  const quick = db.agentMeta?.[agent]?.quickArgsBroken ? [] : agentCfg.quickArgs ?? launchers[agentCfg.launcher]?.defaults.quickArgs ?? [];
  const model = agentCfg.settings?.agents?.modelGrades?.fast || null;
  const timeoutMs = (Number(config.git.generateTimeoutSec) || 120) * 1000;
  jobStep(`${label} пишет сообщение`);
  const once = (extraArgs) => runHelper({ config, store, getUrl, agent, kind: 'generate', prompt, cwd, extraArgs, approvalMode: 'plan', model, timeoutMs });
  let out = await once(quick);
  if (quick.length && !out.res.eventCount && !out.res.timedOut && !out.res.stopped) {
    // the quick args made the CLI fail before any output: remembered, and this run goes without them
    db.agentMeta[agent] = { ...db.agentMeta[agent], quickArgsBroken: { at: Date.now(), args: quick, error: String(out.res.error || out.res.stderrTail || '').trim().slice(0, 300) } };
    store.save();
    out = await once([]);
  }
  const { res } = out;
  const answer = out.resultText || out.text;
  const msg = firstJson(answer);
  if (!msg || typeof msg.title !== 'string' || !msg.title.trim()) {
    const why = res.stopped ? `нет ответа за ${timeoutMs / 1000} с`
      : res.error || (res.timedOut ? 'агент ничего не вывел вовремя' : null)
        || (answer?.trim() ? `ответ не JSON: ${answer.trim().slice(0, 200)}` : String(res.stderrTail || '').trim().split('\n').slice(-3).join(' ') || 'пустой ответ');
    fail(502, `${label} не написал сообщение: ${why}`);
  }
  let title = msg.title.trim().split(/\r?\n/)[0].trim();
  if (key && !title.startsWith(`${key} `)) title = `${key} ${title.replace(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s:–-]*`), '')}`;
  let body = typeof msg.body === 'string' ? msg.body.trim() : '';
  if (kind === 'commit') title = chars(title, 72);
  else {
    title = truncateBytes(title, 100);
    body = truncateBytes(chars(body, bodyChars), bodyBytes);
  }
  return { title, body, model, ms: Date.now() - t0 };
}
