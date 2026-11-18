// Agent-facing orchestration API (tools for coordinator/worker agents), worker start (shared with the UI's
// assign/start), ports into extra target branches, preambles, escalation, notifications, commit/PR prefill.
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT, expandHome } from './config.js';
import * as git from './git.js';
import { jobStep } from './jobs.js';
import { newId, subagentTitle } from './sessions.js';
import { launchers } from './launchers.js';

const GENERIC_REWORK = '{key} {title}: нужны правки: {notes}'; // agents without a task command (/full-task)

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const HARNESS_CLI = path.join(CODE_ROOT, 'mcp', 'harness-mcp.js');
const REPORT_RE = /^Worker report \((?:done|failed)\): ([\s\S]*)$/;
const TASK_VARS = ['{taskUrl}', '{key}', '{id}', '{description}'];

/** Longest prefix of `text` within `max` UTF-8 bytes, cut on a code point boundary (an ellipsis marks the cut). */
export function truncateBytes(text, max) {
  if (!max || Buffer.byteLength(text) <= max) return text;
  let out = '';
  let used = Buffer.byteLength('…');
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return `${out}…`;
}

/**
 * Single pass with a replacer function: values are inserted literally ($&, $' stay as typed) and never
 * expanded again; unknown {placeholders} are left as they are.
 */
/** Agent profile (~/.gigacode/agents/<name>.md): YAML frontmatter with scalar keys and a `tools` list, then the role prompt. */
export function parseProfile(text) {
  const m = String(text).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text).trim() };
  const meta = {};
  let list = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) {
      meta[list].push(item[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    list = null;
    if (raw === '') {
      meta[key] = [];
      list = key;
    } else if (/^\[.*\]$/.test(raw)) meta[key] = raw.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else meta[key] = raw.trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2].trim() };
}

export const NO_SUBAGENTS = 'Субагенты не запускают своих субагентов: выполни это сам или верни запрос оркестратору';
export const SUBAGENT_CONTEXT = 'Ты работаешь внутри harness. Субагентов запускай инструментом mcp__harness__agent с теми же аргументами, что у встроенного agent (subagent_type, prompt, model) — встроенный agent не используй: harness откроет каждого субагента отдельным чатом и вернёт тебе его результат так же. Вопросы человеку — через mcp__harness__ask (варианты в options), затем заверши ход.';
const CONTEXT_LAUNCHERS = new Set(['gigacode', 'qwen', 'gemini', 'mock']);

export const render = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k] ?? '') : m));

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description });

function checkArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail(400, 'аргументы должны быть JSON-объектом');
  for (const k of schema.required) if (args[k] == null || args[k] === '') fail(400, `нужен параметр ${k}`);
  for (const [k, p] of Object.entries(schema.properties)) {
    const v = args[k];
    if (v == null) continue;
    const ok = p.type === 'array' ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === p.type;
    if (!ok) fail(400, `${k}: нужен ${p.type === 'array' ? 'массив строк' : `тип ${p.type}`}`);
    if (p.enum && !p.enum.includes(v)) fail(400, `${k} — одно из: ${p.enum.join(', ')}`);
  }
}

/** Deepest common parent folder of paths (never a drive/filesystem root), or null. */
export function commonDir(paths) {
  if (!paths.length) return null;
  const split = (p) => path.resolve(p).split(path.sep);
  let common = split(paths[0]);
  for (const p of paths.slice(1)) {
    const parts = split(p);
    let i = 0;
    while (i < common.length && i < parts.length && (process.platform === 'win32' ? common[i].toLowerCase() === parts[i].toLowerCase() : common[i] === parts[i])) i++;
    common = common.slice(0, i);
  }
  return common.length > 1 && common.join('') ? common.join(path.sep) : null; // never a drive/filesystem root
}

export function createOrchestration({ config, store, bus, tasks, sessions }) {
  const db = store.db;
  const gitCfg = () => ({ branchTemplate: 'feature/{key}', portBranchTemplate: '{branch}-{targetSlug}', commitTitleTemplate: '{key} {title}', prTitleTemplate: '{key} {title}', ...config.git });
  const label = (s) => `${s.title} (${s.id})`;
  const fromSession = (s, text) => `[harness] Message from ${label(s)}:\n${text}`;
  const isActive = (s) => !!s && s.kind === 'chat' && (s.status === 'idle' || s.status === 'running');
  const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  const findWs = (id) => db.workspaces.find((w) => w.id === id) || null;
  const starting = new Map(); // taskId -> Promise<Session> (single flight per task)

  // orphan locks: assignees whose session no longer exists
  for (const t of db.tasks) if (t.assigneeSessionId && !sessions.find(t.assigneeSessionId)) t.assigneeSessionId = null;

  function workspaceRef(ref) {
    const lower = String(ref).toLowerCase();
    return db.workspaces.find((w) => w.id === ref) || db.workspaces.find((w) => w.name.toLowerCase() === lower) || fail(404, `рабочая папка «${ref}» не найдена (см. workspace_list)`);
  }

  function activeWorker(task) {
    const s = task.assigneeSessionId && sessions.find(task.assigneeSessionId);
    return isActive(s) ? s : null;
  }

  function notify({ kind, sessionId = null, taskId = null, text, options, link, actions }) {
    const n = { id: newId('n'), at: Date.now(), read: false, kind, sessionId, taskId, text, ...(options?.length ? { options } : {}), ...(link ? { link } : {}), ...(actions?.length ? { actions } : {}) };
    db.notifications.push(n);
    if (db.notifications.length > 500) db.notifications.splice(0, db.notifications.length - 500);
    store.save();
    bus.send({ t: 'notify', n });
    return n;
  }

  const lastSummary = (task) => {
    for (let i = task.log.length - 1; i >= 0; i--) {
      const e = task.log[i];
      if ((e.type === 'agent_done' || e.type === 'agent_failed') && e.data?.summary) return e.data.summary;
      const m = !e.type && e.text.match(REPORT_RE); // entries written before typed logs
      if (m) return m[1];
    }
    return null;
  };

  function savePort(task, rec) {
    tasks.update(task.id, { ports: [...task.ports.filter((p) => p.target !== rec.target), rec] }, 'harness');
  }

  function promptTemplate(agent) {
    const tpl = config.agents[agent]?.taskPromptTemplate ?? config.tasks?.promptTemplate ?? '{key}: {title}\n\n{description}';
    if (!TASK_VARS.some((v) => tpl.includes(v))) {
      fail(400, `ошибка настроек: в шаблоне промпта задачи для «${agent}» нет ни одной из переменных ${TASK_VARS.join(' ')} — агент начал бы без задачи`);
    }
    return tpl;
  }

  function taskPrompt(task, s, { notes = '' } = {}) {
    return render(promptTemplate(s.agent), promptVars(task, s, notes.trim() ? ` ${notes.trim()}` : ''));
  }

  /** «Доработка» prompt: agents.<id>.reworkPromptTemplate ({notes} = the user's text as is). */
  function reworkPrompt(task, s, notes) {
    return render(reworkTemplate(s.agent), promptVars(task, s, notes.trim()));
  }

  /** The agent's effective «Доработка» template: its config, its launcher's default (gigacode: /full-task), generic. */
  function reworkTemplate(agent) {
    const a = config.agents[agent];
    return a?.reworkPromptTemplate || launchers[a?.launcher]?.defaults.reworkPromptTemplate || GENERIC_REWORK;
  }

  /** Presets for the «Доработка» popover: the effective default first. */
  const reworkPresets = (agent) => [...new Set([reworkTemplate(agent), ...(config.agents[agent]?.reworkPromptPresets || []), GENERIC_REWORK])];

  function promptVars(task, s, notes) {
    const agentCfg = config.agents[s.agent] || {};
    const ws = findWs(s.workspaceId);
    return {
      key: tasks.key(task),
      id: task.id,
      title: task.title,
      description: task.description,
      url: task.externalUrl || '',
      taskUrl: task.externalUrl || tasks.key(task), // local tasks have no URL; the key still identifies them
      targets: task.targets.join(', '),
      branch: s.branch || task.branch || '',
      repo: ws?.name || path.basename(s.cwd),
      notes,
      runId: s.id,
      registryDir: sessions.registryDir(s.id),
      settingsPath: s.settingsPath || '',
      approvalMode: s.approvalMode || agentCfg.approvalMode || '',
    };
  }

  /** Worktree + branch for a task: branchTemplate with the task key, started from targets[0]; reused if present. */
  const wtKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  /** db.worktreeMeta[path] (label, createdBy, parentWorktree, lastError, …), broadcast as { t: 'worktree.meta' }. */
  function markWorktree(p, patch) {
    db.worktreeMeta ||= {};
    const key = wtKey(p);
    const meta = { ...db.worktreeMeta[key], ...patch };
    for (const [k, v] of Object.entries(meta)) if (v === undefined) delete meta[k];
    db.worktreeMeta[key] = meta;
    store.save();
    bus.send({ t: 'worktree.meta', path: path.resolve(p), meta });
    return meta;
  }
  const madeBy = (caller) => (caller ? { createdBy: 'agent', createdBySession: caller.id } : { createdBy: 'user' });
  /** worktree placement: current | new-child (a new worktree of the caller's repo) | new-top-level (another repo) */
  const PLACEMENTS = { current: 'current', new: 'new-child', 'new-child': 'new-child', 'new-top-level': 'new-top-level' };

  async function taskWorktree(task, cwd, explicitBranch, name = null) {
    if (!(await git.isRepo(cwd))) fail(400, `нельзя создать рабочее дерево: ${cwd} — не git-репозиторий`);
    let branch;
    if (explicitBranch) branch = git.sanitizeBranch(explicitBranch);
    else if (task.branch && (await git.branchExists(cwd, task.branch))) branch = task.branch;
    else branch = await git.uniqueBranch(cwd, git.sanitizeBranch(render(gitCfg().branchTemplate, { key: tasks.key(task), id: task.id })), task.branch);
    const existed = (await git.worktrees(cwd)).some((w) => w.branch === branch);
    const start = await git.startPoint(cwd, task.targets[0]);
    const wt = await git.addWorktree(cwd, { branch, start, worktreeRoot: config.worktreeRoot, dirName: name || tasks.key(task) });
    return { wt, created: !existed, repo: cwd };
  }

  /** includeDirs of a subtask worker: the other subtasks' repos (their task worktree when it exists) + the parent's own. */
  async function siblingDirs(task) {
    const parent = task.parentId && tasks.find(task.parentId);
    if (!parent) return [];
    const dirs = [];
    for (const t of db.tasks.filter((x) => x.parentId === parent.id && x.id !== task.id)) {
      const ws = findWs(t.workspaceId);
      if (!ws) continue;
      const wt = t.branch && (await git.worktrees(ws.path).catch(() => [])).find((w) => w.branch === t.branch && !w.main);
      dirs.push(wt?.path || ws.path);
    }
    return [...dirs, ...(parent.includeDirs || [])];
  }

  /**
   * Creates a worker chat session for `task` and sends it the first prompt. Used by worker_start, assign, start.
   * task null: an agent's ad-hoc spec (worker_start without task_id) — no board task, a persistent child of the caller.
   */
  async function startWorker(task, o, caller) {
    if (task) {
      const busy = activeWorker(task);
      if (busy) fail(409, `у задачи ${task.id} уже есть активный агент (${busy.id})`);
      if (starting.has(task.id)) fail(409, `задача ${task.id} запускается прямо сейчас`);
      const pending = task.deps.filter((d) => tasks.find(d)?.status !== 'done');
      if (pending.length) fail(409, `у задачи ${task.id} есть незавершённые зависимости: ${pending.join(', ')}`);
    } else if (!o.spec) fail(400, 'нужен task_id или spec');
    if (o.worktree && !PLACEMENTS[o.worktree]) fail(400, 'worktree: "current", "new-child" (или "new") или "new-top-level"');
    const placement = PLACEMENTS[o.worktree || 'current'];
    if (placement === 'new-top-level' && !o.workspace) fail(400, 'для new-top-level нужен workspace — репозиторий из workspace_list');
    const name = o.name ? git.sanitizeBranch(o.name).replace(/\//g, '-') : null;
    const agent = o.agent || (caller?.kind === 'chat' ? caller.agent : null) || config.defaultAgent;
    // fail fast, before any worktree or session exists
    jobStep('Проверка агента');
    sessions.resolveAgent(agent);
    if (!o.spec) promptTemplate(agent);
    const ws = o.workspace ? workspaceRef(o.workspace) : o.workspaceId ? findWs(o.workspaceId) || fail(404, `рабочая папка ${o.workspaceId} не найдена`) : task ? findWs(task.workspaceId) : null;
    // current = where the caller works (its worktree), never the repository's main checkout
    const here = caller && !o.cwd && placement === 'current';
    if (here && ws && ws.id !== caller.workspaceId) {
      fail(400, `${task ? `задача ${tasks.key(task)} — в` : 'указан'} репозиторий «${ws.name}», а вы работаете в другом: запустите с worktree: "new-top-level", workspace: "${ws.name}"`);
    }

    const run = (async () => {
      let cwd = o.cwd ? path.resolve(o.cwd) : ws ? ws.path : caller?.cwd || config.root;
      // a new child worktree comes from the caller's own repository (nested under its worktree in the UI)
      if (here || (placement === 'new-child' && caller && !o.workspace)) cwd = caller.worktreePath || caller.cwd;
      let branch;
      let made = null;
      if (placement !== 'current') {
        jobStep('Создание worktree');
        made = task ? await taskWorktree(task, cwd, o.branch, name) : await specWorktree(cwd, o.branch, name);
        cwd = made.wt.path;
        branch = made.wt.branch;
        if (made.created) {
          markWorktree(cwd, { ...madeBy(caller), ...(name ? { label: name } : {}), ...(placement === 'new-child' && caller ? { parentWorktree: caller.worktreePath || caller.cwd } : {}), lastError: undefined });
        }
      } else {
        branch = await git.currentBranch(cwd);
      }
      const inWorktree = !!made || (await git.worktrees(cwd).catch(() => [])).some((w) => !w.main && samePath(w.path, cwd));
      const includeDirs = task ? await siblingDirs(task) : [];
      const title = task ? `${tasks.key(task)}: ${task.title}` : (o.title || o.spec.split('\n').find((l) => l.trim()) || 'агент').trim().slice(0, 80);
      let s;
      jobStep('Запуск сессии');
      try {
        s = await sessions.create({
          kind: 'chat', agent, cwd, workspaceId: ws?.id, title, role: 'worker',
          parentId: caller?.id ?? null, taskId: task?.id ?? null, model: o.model, branch, inWorktree, includeDirs, autoIncludeDirs: true, atRoot: o.atRoot === true,
          persistent: !!caller && (placement !== 'current' || !task),
        });
        sessions.update(s.id, { placement, ...(name ? { worktreeName: name } : {}), ...(o.workspace ? { placementWorkspace: o.workspace } : {}), ...(o.retryOf ? { retryOf: o.retryOf } : {}) });
      } catch (e) {
        if (made?.created) await git.removeWorktree(made.repo, made.wt.path).catch(() => {});
        throw e;
      }
      const by = caller?.id || 'user';
      const patch = { status: 'in_progress', assigneeSessionId: s.id };
      if (task && !task.workspaceId && ws) patch.workspaceId = ws.id;
      if (task && (placement !== 'current' || (!task.branch && branch && !task.targets.includes(branch)))) patch.branch = branch;
      if (task && !task.takenAt) {
        patch.takenAt = Date.now();
        patch.snapshot = { title: task.title, description: task.description, externalStatus: task.externalStatus ?? null, at: patch.takenAt };
      }
      try {
        sessions.deliver(s.id, { from: by, text: o.spec ?? taskPrompt({ ...task, ...patch }, s, { notes: o.notes }) });
      } catch (e) {
        // never an orphan: no worker session or worktree stays behind a failed start
        sessions.remove(s.id, { force: true });
        if (made?.created) await git.removeWorktree(made.repo, made.wt.path).catch(() => {});
        throw e;
      }
      if (!task) {
        if (caller && made) sessions.patch(caller.id, { includeDirs: [...(caller.includeDirs || []), cwd] }, { strict: false });
        return s;
      }
      tasks.update(task.id, patch, by);
      tasks.addLog(task.id, by, `Взята в работу: ${config.agents[agent]?.label || agent}${branch ? `, ветка ${branch}` : ''}`, 'started', { sessionId: s.id, agent, branch: branch ?? null });
      const prefix = tasks.key(task).match(/^([A-Z][A-Z0-9_]*)-\d+$/)?.[1];
      if (prefix && ws) {
        db.prefs ||= {};
        db.prefs.lastWorkspaceBySpace = { ...db.prefs.lastWorkspaceBySpace, [prefix]: ws.id }; // a hint for the next task of this space
      }
      // the parent CLI can read the child's files from its next turn (a stale entry of the parent is dropped, not a 400)
      if (caller && made) sessions.patch(caller.id, { includeDirs: [...(caller.includeDirs || []), cwd] }, { strict: false });
      return s;
    })();
    if (!task) return run;
    starting.set(task.id, run);
    try {
      return await run;
    } finally {
      starting.delete(task.id);
    }
  }

  /** A new worktree for an ad-hoc spec worker: branch = the explicit one, else the name, else sub/agent-<id>. */
  async function specWorktree(cwd, explicitBranch, name) {
    if (!(await git.isRepo(cwd))) fail(400, `нельзя создать рабочее дерево: ${cwd} — не git-репозиторий`);
    const want = git.sanitizeBranch(explicitBranch || name || `sub/agent-${newId('x').slice(2)}`);
    const branch = explicitBranch ? want : await git.uniqueBranch(cwd, want);
    const existed = (await git.worktrees(cwd)).some((w) => w.branch === branch);
    const wt = await git.addWorktree(cwd, { branch, worktreeRoot: config.worktreeRoot, dirName: name });
    return { wt, created: !existed, repo: cwd };
  }

  /** Cherry-picks the task's commits into another target branch in a new worktree (see ARCHITECTURE.md). */
  async function port(task, target, { agent } = {}, caller = null) {
    if (typeof target !== 'string' || !target.trim()) fail(400, 'нужна целевая ветка (target)');
    if (!task.branch) fail(409, `У задачи ${task.id} ещё нет рабочей ветки — сначала возьмите её в работу.`);
    const primary = task.targets[0];
    if (target === primary) fail(400, `${target} — основная целевая ветка; переносят в остальные`);
    const prev = task.ports.find((p) => p.target === target);
    if (prev?.status === 'clean' || prev?.status === 'done') return prev;
    if (prev?.status === 'conflict' && isActive(sessions.find(prev.sessionId))) fail(409, `Перенос ${task.id} в ${target} уже разбирается (${prev.sessionId}).`);
    const ws = findWs(task.workspaceId);
    const repo = ws?.path || sessions.find(task.assigneeSessionId)?.cwd || config.root;
    const conflictAgent = agent || (caller?.kind === 'chat' ? caller.agent : null) || config.defaultAgent;
    const start = (await git.startPoint(repo, target)) || fail(400, `целевая ветка ${target} не найдена ни локально, ни в origin`);
    const ahead = (await git.revList(repo, `${primary}..${task.branch}`)) ?? (await git.revList(repo, `origin/${primary}..${task.branch}`));
    if (!ahead) fail(400, `не удалось получить коммиты ${task.branch} относительно ${primary}`);
    if (!ahead.length) fail(409, `Пока нечего переносить: в ${task.branch} нет коммитов сверх ${primary}. Сначала закоммитьте работу.`);
    // only what the target lacks (patch-id aware), so a partial earlier port is not picked twice
    const commits = await git.missingCommits(repo, start, task.branch);
    if (!commits) fail(400, `не удалось сравнить ${task.branch} с ${target}`);
    if (!commits.length) fail(409, `Нечего переносить: в ${target} уже есть все изменения ${task.branch}.`);
    sessions.resolveAgent(conflictAgent); // a conflict needs a worker: fail before creating the worktree
    const branch = await git.uniqueBranch(repo, git.sanitizeBranch(render(gitCfg().portBranchTemplate, { branch: task.branch, target, targetSlug: git.targetSlug(target), key: tasks.key(task) })));
    jobStep('Создание worktree');
    const wt = await git.addWorktree(repo, { branch, start, worktreeRoot: config.worktreeRoot });
    markWorktree(wt.path, madeBy(caller));
    jobStep('cherry-pick', { done: 0, total: commits.length });
    const status = await git.cherryPick(wt.path, commits); // one sequence: --continue after a conflict picks the rest
    if (status === 'clean') jobStep('cherry-pick', { done: commits.length, total: commits.length });
    const rec = { target, branch, cwd: wt.path, status, sessionId: null };
    savePort(task, rec);
    const by = caller?.id || 'user';
    tasks.addLog(task.id, by, `Перенос в ${target}: ${status === 'clean' ? 'без конфликтов' : 'конфликт, агент разбирается'} (коммитов: ${commits.length})`, 'port', { target, status, branch, commits: commits.length });
    if (status === 'conflict') {
      jobStep('Конфликт: запуск агента');
      const s = await sessions.create({
        kind: 'chat', agent: conflictAgent, cwd: wt.path, workspaceId: ws?.id, title: `${tasks.key(task)}: port to ${target}`, role: 'worker',
        parentId: caller?.id ?? null, taskId: task.id, branch,
      });
      rec.sessionId = s.id;
      savePort(task, rec);
      sessions.deliver(s.id, { from: by, text: `Разреши конфликты cherry-pick задачи ${tasks.key(task)} «${task.title}» (коммиты из ${task.branch}) в ветке ${branch}, цель — ${target}.` });
    }
    return rec;
  }

  /** Plan of a parent task for its coordinator: the subtasks (one per repository) and how to run them. */
  function planSection(task) {
    const key = tasks.key(task);
    const branch = git.sanitizeBranch(render(gitCfg().branchTemplate, { key, id: task.id }));
    const subs = db.tasks.filter((t) => t.parentId === task.id && !t.hidden);
    const line = (t) => `- ${t.id}${t.externalId ? ` (${t.externalId})` : ''} "${t.title}" - workspace: ${findWs(t.workspaceId)?.name ?? 'none'} - deps: ${t.deps.length ? t.deps.join(', ') : 'none'} - status: ${t.status}${tasks.isReady(t) ? ' (ready)' : ''}`;
    return [
      '',
      `Plan for ${key} "${task.title}" (task id ${task.id}). Subtasks:`,
      ...(subs.length ? subs.map(line) : ['- (none yet)']),
      `Start a worker for every READY subtask with worker_start({ task_id, worktree: "new" }): each subtask runs in its own repository on the same branch name ${branch}.`,
      `If the spec needs more repositories, call workspace_list and create the missing subtasks with task_create({ parent_id: "${task.id}", workspace, title, description }), then start them. End your turn after starting workers.`,
    ].join('\n');
  }

  /** Common parent folder of the given absolute paths (null when there is none, e.g. different drives). */

  /** "Take into work" for a parent task: a coordinator that starts one worker per subtask/repository. */
  async function startCoordinator(task, { agent, notes }) {
    agent = agent || config.defaultAgent;
    sessions.resolveAgent(agent);
    promptTemplate(agent);
    const subs = db.tasks.filter((t) => t.parentId === task.id);
    const wsPaths = [...new Set(subs.map((t) => findWs(t.workspaceId)?.path).filter(Boolean))];
    const root = config.workspaces?.root;
    let cwd = root && fs.existsSync(root) ? root : commonDir(wsPaths.length > 1 ? wsPaths : wsPaths.map((p) => path.dirname(p)));
    if (cwd && !fs.existsSync(cwd)) cwd = null;
    const run = (async () => {
      const s = await sessions.create({ kind: 'chat', agent, cwd: cwd ?? undefined, title: `${tasks.key(task)}: ${task.title}`, role: 'coordinator', taskId: task.id });
      const patch = { status: 'in_progress', assigneeSessionId: s.id };
      if (!task.takenAt) {
        patch.takenAt = Date.now();
        patch.snapshot = { title: task.title, description: task.description, externalStatus: task.externalStatus ?? null, at: patch.takenAt };
      }
      tasks.update(task.id, patch, 'user');
      tasks.addLog(task.id, 'user', `Взята в работу координатором: ${config.agents[agent]?.label || agent}, подзадач: ${subs.length}`, 'started', { sessionId: s.id, agent, subtasks: subs.length });
      sessions.deliver(s.id, { from: 'user', text: taskPrompt(task, s, { notes }) });
      return s;
    })();
    starting.set(task.id, run);
    try {
      return await run;
    } finally {
      starting.delete(task.id);
    }
  }

  // ---- sub-agents as real chats: worker_run / harness `agent` (Level 2) ----

  const runWaiters = new Map(); // sessionId -> [resolve]

  function loadProfile(agentCfg, name) {
    if (!name || !/^[\w.-]+$/.test(name)) return null;
    const file = path.join(expandHome(agentCfg?.agentsDir || '~/.gigacode/agents'), `${name}.md`);
    try {
      return parseProfile(fs.readFileSync(file, 'utf8'));
    } catch {
      return null; // a built-in type without a profile file: the spec alone
    }
  }

  /** Result of an ephemeral run: worker_done, or its turn ended without one (no_report). Wakes worker_wait callers. */
  function settleRun(s, result) {
    if (!s.report) sessions.update(s.id, { report: { ...result, at: Date.now() } });
    for (const resolve of runWaiters.get(s.id) || []) resolve();
    runWaiters.delete(s.id);
    retire(s);
  }

  /**
   * orchestration.subagentRetention "archive": a same-worktree helper is archived once its result is in (still openable
   * by id); a persistent child (own worktree/repo) never. A running turn is archived when its process ends.
   */
  function retire(s) {
    if (s.persistent || config.orchestration?.subagentRetention === 'keep') return;
    if (sessions.isRunning(s.id)) sessions.update(s.id, { archiveOnSettle: true });
    else sessions.archive(s.id, true);
  }

  /** Chain of same-worktree helpers above `s` (a task worker, coordinator or persistent child counts 0). */
  function subagentDepth(s) {
    let d = 0;
    const seen = new Set();
    for (let cur = s; cur && cur.ephemeral && !cur.persistent && !seen.has(cur.id); cur = cur.parentId && sessions.find(cur.parentId)) {
      seen.add(cur.id);
      d++;
    }
    return d;
  }
  const atDepthLimit = (s) => !!s && subagentDepth(s) >= Number(config.orchestration?.maxSubagentDepth ?? 1);

  async function workerRun(a, caller) {
    if (!caller) fail(400, 'worker_run вызывается только из сессии harness (заголовок x-harness-session)');
    if (typeof a.spec !== 'string' || !a.spec.trim()) fail(400, 'нужно задание (spec)');
    const agent = caller.kind === 'chat' && config.agents[caller.agent] ? caller.agent : config.defaultAgent;
    const agentCfg = config.agents[agent] || {};
    const profile = a.profile ? loadProfile(agentCfg, a.profile) : null;
    let model = a.model ?? profile?.meta.model ?? null;
    const grades = agentCfg.settings?.agents?.modelGrades || {};
    if (model && grades[model]) model = grades[model]; // a grade name ("review") -> its model id
    if (model && sessions.unavailableModels(agent).has(model)) model = null; // the CLI default instead of a doomed run
    let mode = a.approvalMode ?? profile?.meta.approvalMode ?? null;
    if (mode && agentCfg.approvalModes?.length && !agentCfg.approvalModes.includes(mode)) mode = null;
    // a child in its own worktree or repository is persistent (a per-service orchestrator); a same-worktree helper is
    // ephemeral: archived once settled and depth-limited
    const persistent = a.worktree === 'new' || !!a.workspace;
    if (!persistent && atDepthLimit(caller)) fail(409, NO_SUBAGENTS);
    const base = a.workspace ? workspaceRef(a.workspace).path : caller.cwd;
    let cwd = base;
    let branch = a.workspace ? await git.currentBranch(base) : caller.branch;
    if (a.worktree === 'new') {
      const name = a.name ? git.sanitizeBranch(a.name).replace(/\//g, '-') : null;
      const wantBranch = name || git.sanitizeBranch(`sub/${a.profile || 'agent'}-${newId('x').slice(2)}`);
      const wt = await git.addWorktree(base, { branch: await git.uniqueBranch(base, wantBranch), worktreeRoot: config.worktreeRoot, dirName: name });
      cwd = wt.path;
      branch = wt.branch;
      markWorktree(cwd, { ...madeBy(caller), ...(name ? { label: name } : {}), parentWorktree: caller.worktreePath || caller.cwd });
    }
    let s = null;
    try {
      s = await sessions.create({
        kind: 'chat', agent, cwd, role: 'worker', parentId: caller.id, model, approvalMode: mode, branch, ephemeral: true, autoReport: false, persistent,
        title: a.title || subagentTitle(a.profile || 'agent', a.description || a.spec),
      });
      if (!persistent && (s.worktreePath ?? s.cwd) !== (caller.worktreePath ?? caller.cwd)) sessions.update(s.id, { persistent: true });
      sessions.deliver(s.id, { from: caller.id, text: [profile?.body, `## Задание\n${a.spec}`].filter(Boolean).join('\n\n') });
    } catch (e) {
      // never an orphan: no sub-agent chat or worktree stays behind a failed start
      if (s) sessions.remove(s.id, { force: true });
      if (a.worktree === 'new') await git.removeWorktree(base, cwd).catch(() => {});
      throw e;
    }
    if (a.worktree === 'new') sessions.patch(caller.id, { includeDirs: [...(caller.includeDirs || []), cwd] }, { strict: false });
    return { sessionId: s.id };
  }

  async function waitRun(sessionId, timeoutMs = 25000) {
    // stateless: the answer comes from the persisted report, so a caller that keeps polling survives a restart
    const s = sessions.get(sessionId);
    if (!s.report) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(Math.max(Number(timeoutMs) || 0, 0), 60000));
        timer.unref?.(); // a long-poll cut by a harness shutdown must not keep the process alive
        runWaiters.set(sessionId, [...(runWaiters.get(sessionId) || []), () => { clearTimeout(timer); resolve(); }]);
      });
    }
    const now = sessions.find(sessionId);
    return now?.report ? { done: true, sessionId, status: now.report.status, summary: now.report.summary } : { done: false, sessionId, status: now?.status ?? null };
  }

  // ---- harness review loop (orchestration.reviewMode "harness") ----

  const reviewCfg = () => ({ grade: 'review', approvalMode: 'plan', maxRounds: 2, agent: null, ...config.orchestration?.review });

  /** Verdict of a reviewer summary: an explicit VERDICT line, else CHANGES_REQUESTED when CRITICAL/HIGH findings are named. */
  function parseVerdict(summary) {
    const m = String(summary).match(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/i);
    if (m) return m[1].toUpperCase();
    return /\b(CRITICAL|HIGH)\b/.test(summary) ? 'CHANGES_REQUESTED' : 'APPROVED';
  }

  function setReview(task, patch) {
    const review = { ...task.review, ...patch };
    tasks.update(task.id, { review, agentState: review.state }, 'harness');
  }

  async function startReview(task, worker, report) {
    const rc = reviewCfg();
    const prev = task.review?.workerSessionId === worker.id ? task.review : null;
    const round = (prev?.round || 0) + 1;
    const agent = rc.agent || worker.agent;
    const agentCfg = config.agents[agent] || fail(400, `агент ревью «${agent}» не настроен`);
    const gradeModel = agentCfg.settings?.agents?.modelGrades?.[rc.grade] || null;
    const model = gradeModel && !sessions.unavailableModels(agent).has(gradeModel) ? gradeModel : null; // else the CLI default
    const mode = rc.approvalMode && (!agentCfg.approvalModes?.length || agentCfg.approvalModes.includes(rc.approvalMode)) ? rc.approvalMode : null;
    const key = tasks.key(task);
    const text = render(rc.promptTemplate || '{key}: review the changes on {branch} against {base} and finish with worker_done; end the summary with VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED.', {
      key, id: task.id, title: task.title, description: task.description, branch: worker.branch || task.branch || '', base: task.targets[0],
      cwd: worker.cwd, round, previous: prev?.findings ? `\nПредыдущие замечания (раунд ${round - 1}):\n${prev.findings}\n` : '',
    });
    setReview(task, { round, workerSessionId: worker.id, reviewerSessionId: prev?.reviewerSessionId ?? null, state: 'reviewing', report, findings: prev?.findings ?? null, startedAt: Date.now() });
    let reviewer = prev?.reviewerSessionId && sessions.find(prev.reviewerSessionId);
    if (reviewer) {
      sessions.deliver(reviewer.id, { from: 'harness', text: `Повторное ревью после исправлений (раунд ${round}).\n\n${text}` });
    } else {
      reviewer = await sessions.create({ kind: 'chat', agent, cwd: worker.cwd, role: 'reviewer', parentId: worker.id, taskId: task.id, model, approvalMode: mode, title: `Ревью ${key}`, branch: worker.branch });
      setReview(tasks.get(task.id), { reviewerSessionId: reviewer.id });
      sessions.deliver(reviewer.id, { from: 'harness', text });
    }
    tasks.addLog(task.id, 'harness', `Ревью, раунд ${round}: начато${model ? ` (${model})` : ''}`, 'review', { round, sessionId: reviewer.id, model: model ?? null });
  }

  function reviewerDone(summary, reviewer) {
    sessions.flag(reviewer.id, 'reported');
    sessions.setStatus(reviewer.id, 'done');
    const task = reviewer.taskId ? tasks.find(reviewer.taskId) : null;
    const rv = task?.review;
    if (!rv || rv.reviewerSessionId !== reviewer.id) {
      const parent = reviewer.parentId && sessions.find(reviewer.parentId);
      if (parent) sessions.deliver(parent.id, { from: reviewer.id, text: fromSession(reviewer, summary) });
      return { ok: true };
    }
    const verdict = parseVerdict(summary);
    const worker = sessions.find(rv.workerSessionId);
    const coordinator = worker?.parentId && sessions.find(worker.parentId);
    const key = tasks.key(task);
    tasks.addLog(task.id, reviewer.id, `Ревью, раунд ${rv.round}: ${verdict === 'APPROVED' ? 'одобрено' : 'есть замечания'}`, 'review', { round: rv.round, verdict });
    if (verdict === 'APPROVED') {
      setReview(task, { state: 'approved', findings: summary });
      if (worker) sessions.note(worker.id, `Ревью (раунд ${rv.round}): APPROVED\n\n${summary}`);
      if (coordinator) sessions.deliver(coordinator.id, { from: worker.id, text: fromSession(worker, `${rv.report}\nревью: APPROVED`) });
      notify({ kind: 'done', sessionId: worker?.id ?? reviewer.id, taskId: task.id, text: `${key}: ревью пройдено (раунд ${rv.round})` });
      return { ok: true, verdict };
    }
    setReview(task, { state: 'changes_requested', findings: summary });
    if (worker && rv.round < (reviewCfg().maxRounds || 2)) {
      sessions.deliver(worker.id, { from: reviewer.id, text: `Ревью, раунд ${rv.round}: есть замечания.\n\n${summary}\n\nИсправь CRITICAL/HIGH и снова вызови worker_done.` });
      return { ok: true, verdict };
    }
    notify({ kind: 'failed', sessionId: worker?.id ?? reviewer.id, taskId: task.id, text: `${key}: ревью не сошлось за ${rv.round} раунд(а)\n\n${summary}` });
    // the coordinator must not wait forever: it gets the report with the open findings
    if (coordinator) sessions.deliver(coordinator.id, { from: worker.id, text: fromSession(worker, `${rv.report}\nревью не сошлось за ${rv.round} раунд(а):\n${summary}`) });
    return { ok: true, verdict };
  }

  /**
   * After a restart (re-attached turns already decided): a review whose reviewer is no longer running and never reached
   * reviewerDone continues from its persisted report or verdict text, else the reviewer is asked to finish.
   */
  function resumeReviews() {
    for (const task of db.tasks) {
      const rv = task.review;
      const reviewer = rv?.state === 'reviewing' && rv.reviewerSessionId && sessions.find(rv.reviewerSessionId);
      if (!reviewer || reviewer.status === 'running' || sessions.isRunning(reviewer.id) || reviewer.queue?.length) continue;
      const since = rv.startedAt || 0;
      const last = sessions.messages(reviewer.id).filter((m) => m.kind === 'assistant' && m.at >= since).at(-1);
      if (reviewer.report && reviewer.report.at >= since) reviewerDone(reviewer.report.summary, reviewer);
      else if (last && /VERDICT:/i.test(last.text)) reviewerDone(last.text, reviewer);
      else sessions.deliver(reviewer.id, { from: 'harness', text: 'harness был перезапущен во время ревью. Продолжи ревью и вызови worker_done; summary должен заканчиваться строкой VERDICT: APPROVED или VERDICT: CHANGES_REQUESTED.' });
    }
  }

  /** task.agentState: what the assignee session (and the harness review) is doing, for the board badge. */
  function syncAgentState(s) {
    if (s.kind !== 'chat') return;
    const task = db.tasks.find((t) => t.assigneeSessionId === s.id);
    if (!task) return;
    const reviewState = task.review?.workerSessionId === s.id ? task.review.state : null;
    const state = s.status === 'running' ? 'running'
      : reviewState || ({ idle: 'waiting', stopped: 'waiting', done: 'done', failed: 'failed', error: 'failed' }[s.status] ?? null);
    if (task.agentState !== state) tasks.update(task.id, { agentState: state }, 'harness');
  }

  // ---- preambles ----

  function preamble(s) {
    const context = s.ephemeral && atDepthLimit(s) ? `${NO_SUBAGENTS}.` : SUBAGENT_CONTEXT;
    const block = config.orchestration?.subagents !== 'builtin' && CONTEXT_LAUNCHERS.has(s.launcherId) ? context : '';
    return [block, rolePreamble(s)].filter(Boolean).join('\n\n');
  }

  function rolePreamble(s) {
    const tools = `Harness tools are in the MCP server "harness" (fallback from a shell: node "${HARNESS_CLI}" call <tool> '<json>').`;
    const registry = `Registry dir: ${sessions.registryDir(s.id)} - if you start built-in helper sub-agents (agent tool), record them there per your orchestration skill (<id>/agent.json + log.jsonl).`;
    const helpers = '- The built-in agent tool is fine for internal helpers (review, exploration); parallel task work the user should see goes through worker_start (each worker gets its own chat).';
    if (s.role === 'coordinator') {
      const parentTask = s.taskId && tasks.find(s.taskId);
      return [
        `[harness] You are the COORDINATOR session ${s.id} ("${s.title}") in a local multi-agent harness. Working directory: ${s.cwd}.`,
        tools,
        registry,
        'Rules:',
        '- Split the work into tasks with task_create; put ordering into deps. Every task spec must be self-contained (goal, files, constraints, how to verify).',
        '- Start workers with worker_start (task_id; worktree "new" gives the worker its own git worktree and branch).',
        helpers,
        '- After starting workers END YOUR TURN. The harness wakes you with a message for every worker report, question or escalation. Do not poll.',
        '- Answer worker questions with send_message(to: <worker session id>, body); ask the user with send_message(to: "user") when needed.',
        '- Several repositories: one task per repository. Call workspace_list, then create one subtask per repo with task_create({ parent_id, workspace, ... }). Subtasks share the parent key, so every repo gets the same branch.',
        '- Several target branches (task.targets): the work happens on targets[0]; once its commits exist call task_port({ task_id, target }) for every other target. One PR per repo per target.',
        ...(parentTask ? [planSection(parentTask)] : []),
      ].join('\n');
    }
    if (s.role === 'reviewer') {
      const t = s.taskId && tasks.find(s.taskId);
      return [
        `[harness] You are a REVIEWER session (${s.id}) in a local multi-agent harness${t ? ` for task ${tasks.key(t)}` : ''}; the worker you review is ${s.parentId}.`,
        `Working directory: ${s.cwd}. Read only: do not change files, do not commit or push.`,
        'Finish with worker_done(summary, status: "done"); the summary ends with "VERDICT: APPROVED" or "VERDICT: CHANGES_REQUESTED".',
        tools,
      ].join('\n');
    }
    if (s.role !== 'worker') return '';
    if (s.ephemeral) {
      const parent = s.parentId && sessions.find(s.parentId);
      return [
        `[harness] Ты — субагент (сессия ${s.id}), запущенный ${parent ? label(parent) : 'harness'}. Рабочая папка: ${s.cwd}.`,
        'Выполни задание ниже. В конце вызови worker_done(summary, status: "done" | "failed") — summary вернётся вызвавшему агенту как результат.',
        tools,
      ].join('\n');
    }
    const task = s.taskId && tasks.find(s.taskId);
    const parent = s.parentId && sessions.find(s.parentId);
    const who = `Session: ${s.id}; parent: ${parent ? label(parent) : 'none (your reports go to the user)'}.`;
    const common = [
      '- Need a decision? Call ask(question, options?), then END YOUR TURN; the answer arrives as your next message.',
      helpers,
      '- Finish with exactly one worker_done(summary, status: "done" | "failed"): what changed, evidence (commands and results), open blockers.',
      tools,
      registry,
    ];
    if (!task) return [`[harness] You are a WORKER session in a local multi-agent harness. ${who}`, `Working directory: ${s.cwd}.`, ...common].join('\n');
    const key = tasks.key(task);
    const commitFormat = `commit message format: "${key} <summary>" (the key, a space, a short summary from the task; no colon, no feat:/fix: prefixes, no Co-authored-by, no mention of AI or GigaCode)`;
    const portRec = task.ports.find((p) => p.sessionId === s.id);
    if (portRec) {
      return [
        `[harness] You are a WORKER session resolving a cherry-pick conflict. ${who}`,
        `Task: ${key} - ${task.title} (task id ${task.id}). Commits from ${task.branch} are being cherry-picked onto ${portRec.branch} (target ${portRec.target}).`,
        `Working directory: ${s.cwd}.`,
        'Steps: run git status; resolve every conflict keeping the intent of the original change; git add the files;',
        'run `git -c core.editor=true cherry-pick --continue` (repeat until the cherry-pick finishes; never abort or skip commits without asking);',
        `run the project checks if any. Stay on this branch; do not push, merge or create pull requests. If you must write a commit message yourself, ${commitFormat}.`,
        ...common,
      ].join('\n');
    }
    const commitRule = config.orchestration?.workerMayCommit
      ? `- Commit your changes on this branch; ${commitFormat}. Do not push, merge or create pull requests.`
      : `- Do NOT commit, push, merge, create pull requests or change the tracker unless the task explicitly says so: leave your changes in the working tree; the user reviews and commits them from the harness UI (the commit message is prefilled from your worker_done summary). If the task does ask you to commit, ${commitFormat}.`;
    return [
      `[harness] You are a WORKER session in a local multi-agent harness. ${who}`,
      `Task: ${key} - ${task.title} (task id ${task.id}).`,
      `Working directory: ${s.cwd}. Branch: ${s.branch || task.branch || '(current)'}. Base branch (primary target): ${task.targets[0]}.`,
      // started in the projects folder: the agent (/full-task) picks the repositories and makes the worktrees itself
      ...(s.atRoot
        ? [`Ты в папке со всеми проектами (${s.cwd}). Определи затронутые репозитории по SDD/описанию задачи (или спроси через ask); рабочие деревья создавай по правилам своей команды (<repo>-worktrees\\${key}, ветка ${git.sanitizeBranch(render(gitCfg().branchTemplate, { key, id: task.id }))} от ${task.targets[0]}); после финального сообщения — worker_done.`]
        : []),
      // for task commands that make their own worktree (/full-task): this one is it
      ...(s.inWorktree
        ? [`Ты уже в рабочем дереве задачи \`${s.cwd}\` (ветка \`${s.branch || task.branch}\`) — это и есть worktree задачи; не создавай другой.${config.orchestration?.workerMayCommit ? '' : ' Коммиты/пуш/PR/трекер — только пользователь из UI.'} После финального сообщения твоей команды вызови worker_done с тем же текстом.`]
        : []),
      'Rules:',
      '- Do only this task and only inside the working directory.',
      ...(s.atRoot ? [] : ['- Stay on your branch: do not switch or create branches.']),
      commitRule,
      ...(config.orchestration?.reviewMode === 'harness'
        ? ['- Ревью выполняет harness другой моделью после твоего worker_done; пропусти шаги внутреннего ревью твоей команды (не запускай встроенных субагентов-ревьюеров).']
        : []),
      ...common,
    ].join('\n');
  }

  // ---- post-turn: escalation and error notifications ----

  function turnEnded(s, { reported, communicated, stopped, queueEmpty, userFollowUp }) {
    if (s.ephemeral && !reported && queueEmpty) {
      const last = sessions.messages(s.id).filter((m) => m.kind === 'assistant').at(-1);
      settleRun(s, { status: stopped ? 'stopped' : 'no_report', summary: last?.text ?? '' });
      return;
    }
    if (stopped) return;
    if (s.role === 'reviewer' && !reported && s.status !== 'error') {
      const last = sessions.messages(s.id).filter((m) => m.kind === 'assistant').at(-1);
      if (last?.text) reviewerDone(last.text, s);
      return;
    }
    if (s.status === 'error' && s.role !== 'worker') {
      notify({ kind: 'error', sessionId: s.id, taskId: s.taskId, text: `${s.title}: агент не смог выполнить ход (подробности в чате)` });
    }
    if (s.role !== 'worker' || !s.autoReport || reported || communicated || !queueEmpty) return;
    const parent = s.parentId && sessions.find(s.parentId);
    if (parent) {
      // the agent-oriented hint goes only to a coordinator agent
      const lastError = sessions.messages(s.id).filter((m) => m.kind === 'error').at(-1)?.text.split('\n')[0];
      const text = `Агент ${label(s)} закончил ход, не вызвав worker_done (статус: ${s.status}${lastError ? `; причина: ${lastError}` : ''}).\nПоследний вывод: ${s.preview || '(нет)'}\nЧто можно: send_message(to: "${s.id}") — уточнить и продолжить; worker_inspect — посмотреть состояние; worker_stop + worker_retry — перезапустить; или сообщить пользователю (send_message to "user").`;
      sessions.deliver(parent.id, { from: s.id, text: fromSession(s, text) });
      return;
    }
    if (userFollowUp) return; // the user's own follow-up: they are in the chat already
    escalateToUser(s);
  }

  /** The user's Inbox: at most one open escalation per session (a repeat updates its count and time). */
  function escalateToUser(s) {
    const task = s.taskId && tasks.find(s.taskId);
    const who = task ? tasks.key(task) : `«${s.title}»`;
    const text = s.status === 'error'
      ? `Агент ${who} остановился с ошибкой — откройте чат, чтобы продолжить или принять результат`
      : `Агент ${who} закончил ход без отчёта — откройте чат, чтобы продолжить или принять результат`;
    const open = db.notifications.find((n) => n.kind === 'escalation' && n.sessionId === s.id && !n.read);
    if (!open) return notify({ kind: 'escalation', sessionId: s.id, taskId: s.taskId, text, actions: task ? ['open', 'rework', 'accept'] : ['open'] });
    Object.assign(open, { text, at: Date.now(), count: (open.count || 1) + 1 });
    store.save();
    bus.send({ t: 'notify', n: open });
    return open;
  }

  sessions.hooks.preamble = preamble;
  sessions.hooks.sessionGone = (s, how) => {
    for (const t of db.tasks.filter((x) => x.assigneeSessionId === s.id)) {
      tasks.update(t.id, { assigneeSessionId: null, agentState: null }, 'harness'); // the column stays
      tasks.addLog(t.id, 'harness', how === 'removed' ? 'Сессия агента удалена' : 'Сессия агента перенесена в архив', 'agent_gone', { sessionId: s.id, how });
    }
  };
  sessions.hooks.turnStarted = (s) => {
    const p = s.worktreePath || s.cwd;
    if (p && db.worktreeMeta?.[wtKey(p)]?.sleeping) markWorktree(p, { sleeping: false }); // an agent at work wakes it
  };
  // a question answered in its chat: its Inbox entry is answered and read (no stale «ждёт ответа»)
  sessions.hooks.questionAnswered = (s) => {
    for (const n of db.notifications.filter((x) => x.kind === 'question' && x.sessionId === s.id && !x.answered)) {
      Object.assign(n, { answered: true, read: true });
      bus.send({ t: 'notify', n });
    }
    store.save();
  };
  sessions.hooks.notify = notify;
  sessions.hooks.sessionChanged = syncAgentState;
  sessions.hooks.turnEnded = turnEnded;

  // ---- tools ----

  const sessionInfo = (s) => ({ id: s.id, title: s.title, role: s.role, status: s.status, agent: s.agent, taskId: s.taskId, parentId: s.parentId, cwd: s.cwd, branch: s.branch, worktreePath: s.worktreePath ?? null, persistent: !!s.persistent, queued: s.queued, preview: s.preview });

  const descendants = (c) => {
    const out = [];
    const walk = (id) => {
      for (const s of db.sessions.filter((x) => x.parentId === id && !x.virtual)) {
        out.push(s);
        walk(s.id);
      }
    };
    if (c) walk(c.id);
    return out;
  };
  /** a session the caller started (directly or through its workers); 403 otherwise */
  function ownDescendant(c, id) {
    const s = sessions.get(id);
    if (c && !descendants(c).some((d) => d.id === s.id)) fail(403, `${id} — не ваш агент`);
    return s;
  }
  /** @all = live (not archived) descendants, @idle = those not running, @worktree:<path> = every session there (coordinators too) */
  function groupTargets(to, c) {
    const live = (s) => !s.archived && s.kind === 'chat';
    if (to === '@all') return descendants(c).filter(live);
    if (to === '@idle') return descendants(c).filter((s) => live(s) && s.status !== 'running'); // waiting for instructions
    const wt = to.match(/^@worktree:(.+)$/)?.[1];
    if (wt) return db.sessions.filter((s) => s.id !== c?.id && !s.archived && !s.virtual && s.kind === 'chat' && samePath(s.worktreePath || s.cwd, wt));
    fail(400, `неизвестная группа ${to}: @all, @idle или @worktree:<путь>`);
  }

  async function inspectWorker(w) {
    const task = w.taskId && tasks.find(w.taskId);
    const base = task?.targets?.[0] || config.git.defaultBase;
    const out = { id: w.id, status: w.status, state: w.stalled ? 'stalled' : w.waitingFor ? `waiting_${w.waitingFor}` : w.lastEventKind || w.phase || w.status, title: w.title, cwd: w.cwd, branch: w.branch, waitingFor: w.waitingFor ?? null, report: w.report ?? null, updatedAt: w.lastActivityAt };
    const last = sessions.messages(w.id).filter((m) => m.kind === 'assistant').at(-1);
    out.lastAssistant = last ? last.text.slice(-2000) : null;
    if (await git.isRepo(w.cwd)) {
      const st = await git.status(w.cwd).catch(() => null);
      const baseRef = await git.startPoint(w.cwd, base).catch(() => null);
      out.dirty = st ? st.files.length : null;
      out.ahead = baseRef ? ((await git.revList(w.cwd, `${baseRef}..HEAD`).catch(() => null)) || []).length : null;
      const stat = baseRef ? (await git.git(w.cwd, ['diff', '--stat', baseRef], { ok: [0, 1] }).catch(() => null))?.stdout.trim() : null;
      const untracked = st ? st.files.filter((f) => f.status === '?').length : 0;
      out.diffStat = [stat, untracked ? `untracked: ${untracked}` : null].filter(Boolean).join('\n') || null;
    }
    return out;
  }

  /** worker_retry: the same task in the same placement; a chain with 3 failed starts is circuit-broken. */
  async function retryWorker(w, worktree, c) {
    if (w.role !== 'worker' || w.ephemeral) fail(400, 'повторить можно только агента из worker_start');
    if (sessions.isRunning(w.id)) fail(409, `${w.id} ещё работает — сначала worker_stop`);
    const task = w.taskId ? tasks.get(w.taskId) : null;
    const chain = [];
    for (let s = w; s && !chain.includes(s); s = s.retryOf && sessions.find(s.retryOf)) chain.push(s);
    const failed = chain.filter((s) => ['error', 'failed', 'stopped'].includes(s.status) || s.report?.status === 'failed' || s.interrupted).length;
    if (failed >= 3) {
      const text = `${task ? `Задача ${tasks.key(task)}` : `Агент «${w.title}»`}: 3 неудачных запуска — сообщи пользователю`;
      notify({ kind: 'error', sessionId: w.id, taskId: task?.id ?? null, text });
      fail(409, text);
    }
    if (task?.assigneeSessionId === w.id) tasks.update(task.id, { assigneeSessionId: null }, c?.id || 'user');
    const first = sessions.messages(w.id).find((m) => m.kind === 'user');
    const s = await startWorker(task, {
      agent: w.agent, worktree: worktree || w.placement || 'current', workspace: w.placementWorkspace, name: w.worktreeName, retryOf: w.id, title: task ? undefined : w.title,
      ...(first && !task?.externalId ? { spec: first.text } : {}),
    }, c || (w.parentId && sessions.find(w.parentId)) || null);
    return sessionInfo(s);
  }

  const TOOLS = [
    {
      name: 'whoami',
      description: 'Your harness session: id, role (coordinator/worker/solo), parent, task, cwd, branch.',
      inputSchema: obj({}),
      run: (_, c) => (c ? { ...sessionInfo(c), taskKey: c.taskId && tasks.find(c.taskId) ? tasks.key(tasks.find(c.taskId)) : null } : { id: null, role: 'user' }),
    },
    {
      name: 'task_list',
      description: 'List tasks on the board. ready=true returns todo/backlog tasks whose deps are all done.',
      inputSchema: obj({ status: str('backlog | todo | in_progress | review | done', { enum: ['backlog', 'todo', 'in_progress', 'review', 'done'] }), ready: { type: 'boolean', description: 'only ready tasks' } }),
      run: (a) => tasks.list({ status: a.status, ready: a.ready }),
    },
    {
      name: 'task_get',
      description: 'Get one task by id.',
      inputSchema: obj({ id: str('task id, e.g. T-3') }, ['id']),
      run: (a) => tasks.get(a.id),
    },
    {
      name: 'workspace_list',
      description: 'Registered repositories [{id, name, path, isGit}] for multi-repo planning.',
      inputSchema: obj({}),
      run: () => db.workspaces,
    },
    {
      name: 'task_create',
      description: 'Create a task. Use deps for ordering, parent_id + workspace for one subtask per repository. A subtask inherits the parent targets/workspace when omitted.',
      inputSchema: obj({
        title: str('short title'),
        description: str('self-contained spec (markdown)'),
        deps: strArr('task ids that must be done first'),
        status: str('initial status (default todo)', { enum: ['backlog', 'todo', 'in_progress', 'review', 'done'] }),
        priority: str('low | medium | high', { enum: ['low', 'medium', 'high'] }),
        labels: strArr('labels'),
        parent_id: str('parent task id (subtask)'),
        workspace: str('workspace id or name (the repository of this task)'),
        targets: strArr('target branches; [0] = primary where the work happens, the rest get ports'),
      }, ['title']),
      run: (a, c) => tasks.create({
        title: a.title, description: a.description, deps: a.deps, status: a.status, priority: a.priority, labels: a.labels,
        parentId: a.parent_id, targets: a.targets,
        workspaceId: a.workspace ? workspaceRef(a.workspace).id : a.parent_id ? undefined : c?.workspaceId ?? null,
      }, c?.id || 'user'),
    },
    {
      name: 'task_update',
      description: 'Update a task (title, description, status, priority) and/or append a comment to its log.',
      inputSchema: obj({
        id: str('task id'), title: str('new title'), description: str('new description'),
        status: str('new status', { enum: ['backlog', 'todo', 'in_progress', 'review', 'done'] }),
        priority: str('low | medium | high', { enum: ['low', 'medium', 'high'] }), comment: str('text appended to the task log'),
      }, ['id']),
      run: (a, c) => {
        const task = tasks.get(a.id);
        const w = activeWorker(task);
        if (c && w && w.id !== c.id && w.parentId !== c.id) fail(409, `задача ${task.id} занята её активным агентом ${w.id}`);
        const patch = {};
        for (const k of ['title', 'description', 'status', 'priority', 'comment']) if (a[k] != null) patch[k] = a[k];
        return tasks.update(task.id, patch, c?.id || 'user');
      },
    },
    {
      name: 'task_port',
      description: 'Cherry-pick the task branch into another target branch (new worktree). Clean: done. Conflict: a worker is started to resolve it and reports like any worker.',
      inputSchema: obj({ task_id: str('task id'), target: str('target branch, one of task.targets[1..]'), agent: str('agent for a conflict-resolving worker') }, ['task_id', 'target']),
      run: (a, c) => port(tasks.get(a.task_id), a.target, { agent: a.agent }, c),
    },
    {
      name: 'worker_start',
      description: 'Start a worker (its own chat) for a task (task_id) or an ad-hoc spec, in this worktree or a new one (worktree + name, workspace for another repository). Returns at once; then END YOUR TURN: the harness wakes you with its report, question or escalation.',
      inputSchema: obj({
        task_id: str('existing task id'), spec: str('ad-hoc assignment (no board task unless task: true)'), title: str('title for an ad-hoc spec'),
        task: { type: 'boolean', description: 'with spec: also create a board task for it' },
        agent: str('agent id from the config'), workspace: str('workspace id or name to run in'),
        worktree: str('placement: current (this worktree, default) | new-child (a new worktree of your repository, nested under yours) | new-top-level (a new worktree in another repository: needs workspace); new = new-child', { enum: ['current', 'new', 'new-child', 'new-top-level'] }),
        name: str('short worktree name for a new worktree (e.g. ft-core); its folder is <repo>-worktrees/<name>'),
        branch: str('branch for a new worktree (default from the task key)'), model: str('model id'),
      }),
      run: async (a, c) => {
        let task = null;
        if (a.task_id) task = tasks.get(a.task_id);
        else if (!a.spec) fail(400, 'нужен task_id или spec');
        else if (a.task === true || !c) {
          // a board task only on request (or for a call without a caller session: nothing else would track it)
          const title = (a.title || a.spec.split('\n').find((l) => l.trim()) || 'task').trim().slice(0, 80);
          task = tasks.create({ title, description: a.spec, workspaceId: a.workspace ? workspaceRef(a.workspace).id : c?.workspaceId ?? null }, c?.id || 'user');
        }
        return sessionInfo(await startWorker(task, { ...a, spec: a.task_id ? undefined : a.spec }, c));
      },
    },
    {
      name: 'worker_run',
      description: 'Run a sub-agent in its own harness chat and wait for its result (synchronous, like the built-in agent tool). profile = an agent profile name (~/.gigacode/agents/<profile>.md).',
      inputSchema: obj({
        profile: str('agent profile name'), spec: str('the assignment'), model: str('model id or grade name'),
        approvalMode: str('approval mode'), title: str('chat title'),
        worktree: str('current (default) or new', { enum: ['current', 'new'] }), workspace: str('another repository (workspace name): a persistent child there'),
        name: str('short worktree name for worktree new'), timeoutMin: { type: 'number', description: 'minutes to wait (default 60)' },
      }, ['spec']),
      run: (a, c) => workerRun(a, c),
    },
    {
      name: 'agent',
      description: 'Start a sub-agent (same arguments as the built-in agent tool). The harness opens it as a separate chat and returns its result.',
      inputSchema: obj({
        subagent_type: str('agent type / profile name'), prompt: str('the task for the sub-agent'), model: str('model id or grade name'),
        description: str('short description'), approvalMode: str('approval mode'),
        worktree: str('current (default) or new', { enum: ['current', 'new'] }), workspace: str('another repository (workspace name): a persistent child there'),
        timeoutMin: { type: 'number', description: 'minutes to wait (default 60)' },
      }, ['prompt']),
      run: (a, c) => workerRun({ ...a, profile: a.subagent_type, spec: a.prompt }, c),
    },
    {
      name: 'worker_list',
      description: 'Your workers (direct children, also in other worktrees): status, task, worktree, persistent flag and last output. Do not poll it in a loop: the harness wakes you.',
      inputSchema: obj({}),
      run: (_, c) => (c ? sessions.children(c.id) : sessions.list().filter((s) => s.role === 'worker')).map(sessionInfo),
    },
    {
      name: 'send_message',
      description: 'Send a message to a session id, "parent", "user" or a group of your workers: "@all" (live), "@idle", "@worktree:<path>" (every session in that worktree). Wakes the target; a working one gets it at the end of its turn.',
      inputSchema: obj({ to: str('session id | "parent" | "user" | "@all" | "@idle" | "@worktree:<path>"'), body: str('message text') }, ['to', 'body']),
      run: (a, c) => {
        if (c) sessions.flag(c.id, 'communicated');
        if (String(a.to).startsWith('@')) {
          const targets = groupTargets(a.to, c);
          for (const t of targets) sessions.deliver(t.id, { from: c?.id ?? 'user', text: c ? fromSession(c, a.body) : a.body });
          return { delivered: targets.map((t) => t.id) };
        }
        const parent = a.to === 'parent' && c?.parentId ? sessions.find(c.parentId) : null;
        if (a.to === 'user' || (a.to === 'parent' && !parent)) {
          notify({ kind: 'info', sessionId: c?.id ?? null, taskId: c?.taskId ?? null, text: a.body });
          return { delivered: 'user' };
        }
        const target = parent || sessions.find(a.to) || fail(404, `сессия ${a.to} не найдена`);
        const r = sessions.deliver(target.id, { from: c?.id ?? 'user', text: c ? fromSession(c, a.body) : a.body });
        return { delivered: target.id, queued: r.queued };
      },
    },
    {
      name: 'worker_inspect',
      description: 'State of one of your workers without waiting: status, activity, branch, dirty files, commits ahead, diff stat vs its base, last answer, worker_done report. Use it instead of polling worker_list.',
      inputSchema: obj({ session_id: str('worker session id') }, ['session_id']),
      run: (a, c) => inspectWorker(ownDescendant(c, a.session_id)),
    },
    {
      name: 'worker_stop',
      description: 'Stop one of your workers (its running turn; a persistent worker keeps its chat).',
      inputSchema: obj({ session_id: str('worker session id') }, ['session_id']),
      run: (a, c) => {
        const w = ownDescendant(c, a.session_id);
        if (!sessions.isRunning(w.id)) return { stopped: false, status: 'stop_unknown', sessionStatus: w.status };
        sessions.stop(w.id);
        return { stopped: true };
      },
    },
    {
      name: 'worker_retry',
      description: 'Start one of your stopped / failed workers again: the same task and spec in the same placement (or worktree given). After 3 failed starts of one task the harness refuses: tell the user.',
      inputSchema: obj({ session_id: str('worker session id'), worktree: str('placement for the retry', { enum: ['current', 'new', 'new-child', 'new-top-level'] }) }, ['session_id']),
      run: (a, c) => retryWorker(ownDescendant(c, a.session_id), a.worktree, c),
    },
    {
      name: 'ask',
      description: 'Ask your coordinator (or the user) a question, optionally with answer options. Then END YOUR TURN: the answer arrives as your next message.',
      inputSchema: obj({ question: str('the question'), options: strArr('suggested answers (rendered as buttons)') }, ['question']),
      run: (a, c) => {
        const note = 'End your turn now; the answer will arrive as your next message.';
        const options = a.options?.length ? a.options : undefined;
        if (c) sessions.flag(c.id, 'communicated');
        const parent = c?.parentId && sessions.find(c.parentId);
        if (parent) {
          const choices = options ? `\nOptions: ${options.map((o) => `"${o}"`).join(', ')}` : '';
          sessions.deliver(parent.id, { from: c.id, options, text: fromSession(c, `Question: ${a.question}${choices}\n(Answer with send_message to "${c.id}".)`) });
          sessions.update(c.id, { waitingFor: 'answer' }); // until a reply is delivered to it
          return { delivered: parent.id, note };
        }
        notify({ kind: 'question', sessionId: c?.id ?? null, taskId: c?.taskId ?? null, text: a.question, options });
        if (c) sessions.update(c.id, { waitingFor: 'answer' });
        return { delivered: 'user', note };
      },
    },
    {
      name: 'worker_done',
      description: 'Finish your task: summary (what changed, evidence, blockers) and status done | failed.',
      inputSchema: obj({ summary: str('what changed, evidence, open blockers'), status: str('done | failed', { enum: ['done', 'failed'] }) }, ['summary', 'status']),
      run: (a, c) => {
        if (!c) fail(400, 'worker_done вызывается только из сессии harness (заголовок x-harness-session)');
        if (c.ephemeral) {
          sessions.flag(c.id, 'reported');
          sessions.setStatus(c.id, a.status);
          settleRun(sessions.get(c.id), { status: a.status, summary: a.summary });
          return { ok: true };
        }
        sessions.update(c.id, { report: { status: a.status, summary: a.summary, at: Date.now() } }); // picked up after a restart
        if (c.role === 'reviewer') return reviewerDone(a.summary, c);
        const status = a.status;
        sessions.flag(c.id, 'reported');
        sessions.setStatus(c.id, status);
        const task = c.taskId ? tasks.find(c.taskId) : null;
        const portRec = task?.ports.find((p) => p.sessionId === c.id);
        if (portRec) {
          savePort(task, { ...portRec, status });
          tasks.addLog(task.id, c.id, `Перенос в ${portRec.target}: ${status === 'done' ? 'конфликты разобраны' : 'не удалось'}`, 'port', { target: portRec.target, status, summary: a.summary });
        } else if (task) {
          // board.onWorkerDone "stay" (default): the card keeps its column, the agent badge shows the outcome
          if (config.board?.onWorkerDone === 'review') tasks.update(task.id, { status: status === 'done' ? 'review' : 'todo' }, c.id);
          tasks.addLog(task.id, c.id, status === 'done' ? 'Агент закончил' : 'Агент не справился', status === 'done' ? 'agent_done' : 'agent_failed', { summary: a.summary, sessionId: c.id });
        }
        const ready = tasks.list({ ready: true }).filter((t) => !activeWorker(t) && !t.hidden);
        const what = portRec ? ` the port of ${tasks.key(task)} to ${portRec.target}` : task ? ` task ${tasks.key(task)} "${task.title}" (${task.id})` : '';
        const report = [
          `Worker ${label(c)} finished${what} with status: ${status}.`,
          `Summary: ${a.summary}`,
          `Ready tasks: ${ready.length ? ready.map((t) => `${t.id} "${t.title}"`).join(', ') : 'none'}`,
        ].join('\n');
        if (task && !portRec && status === 'done' && c.role === 'worker' && config.orchestration?.reviewMode === 'harness') {
          // the parent hears about it after the review verdict
          startReview(task, c, report).catch((e) => notify({ kind: 'error', sessionId: c.id, taskId: task.id, text: `${tasks.key(task)}: не удалось запустить ревью: ${e.message}` }));
          return { ok: true, review: 'started', taskStatus: task.status, readyTasks: ready.map((t) => t.id) };
        }
        const parent = c.parentId && sessions.find(c.parentId);
        if (parent) sessions.deliver(parent.id, { from: c.id, text: fromSession(c, report) });
        notify({ kind: status, sessionId: c.id, taskId: task?.id ?? null, text: `${c.title}: ${a.summary}` });
        return { ok: true, taskStatus: portRec ? null : task?.status ?? null, readyTasks: ready.map((t) => t.id) };
      },
    },
  ];

  // ---- commit / PR prefill ----

  async function gitSuggest(cwd) {
    if (typeof cwd !== 'string' || !cwd) fail(400, 'нужен cwd');
    const dir = path.resolve(cwd);
    const st = await git.status(dir, config.git.excludeFromCommit);
    const work = st.files.filter((f) => !f.service); // git.excludeFromCommit: never suggested
    const g = gitCfg();
    let task = null;
    let portRec = null;
    for (const t of db.tasks) {
      portRec = t.ports.find((p) => samePath(p.cwd, dir) || (st.branch && p.branch === st.branch));
      if (portRec) {
        task = t;
        break;
      }
    }
    task ||= db.sessions
      .filter((s) => s.taskId && samePath(s.cwd, dir))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((s) => tasks.find(s.taskId))
      .find(Boolean) || null;
    if (!task && st.branch) {
      const mainPath = (await git.worktrees(dir).catch(() => []))[0]?.path;
      const inRepo = (t) => !!mainPath && !!findWs(t.workspaceId) && samePath(findWs(t.workspaceId).path, mainPath);
      const hasKey = (t) => new RegExp(`(^|[^A-Za-z0-9])${tasks.key(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i').test(st.branch);
      const cands = db.tasks.filter((t) => t.branch === st.branch || hasKey(t));
      task = cands.find((t) => inRepo(t) && t.branch === st.branch) ?? cands.find(inRepo) ?? cands.find((t) => t.branch === st.branch) ?? cands[0] ?? null;
    }
    const base = portRec?.target ?? task?.targets[0] ?? g.defaultBase;
    const key = task ? tasks.key(task) : null;
    const fallback = st.branch && st.branch !== base ? st.branch : work[0] ? `Update ${work[0].path}` : 'Update';
    const title = (tpl) => (task ? render(tpl, { key, id: task.id, title: task.title, branch: st.branch || '', target: base }) : fallback);
    const summary = task ? lastSummary(task) : null;
    const files = work.map((f) => `- ${f.path}`).join('\n');
    const baseRef = (await git.refExists(dir, base)) ? base : `origin/${base}`;
    const commits = await git.onelines(dir, `${baseRef}..HEAD`);
    const desc = task?.description?.trim();
    const limits = config.integrations?.pr?.limits || {}; // the code host's byte limits (sourcecontrol: 100 / 512)
    return {
      taskId: task?.id ?? null,
      key,
      branch: st.branch,
      base,
      commit: { title: title(g.commitTitleTemplate), body: [summary, files].filter(Boolean).join('\n\n') },
      pr: {
        title: truncateBytes(title(g.prTitleTemplate), limits.titleBytes),
        body: truncateBytes([
          desc && (desc.length > 600 ? `${desc.slice(0, 600)}...` : desc),
          task?.externalUrl,
          `Target: ${base}`,
          summary && `Summary: ${summary}`,
          commits.length && `Commits:\n${commits.map((l) => `- ${l}`).join('\n')}`,
        ].filter(Boolean).join('\n\n'), limits.bodyBytes),
        base,
      },
    };
  }

  return {
    notify,
    markWorktree,
    preamble,
    resumeReviews,
    gitSuggest,
    promptTemplate,
    reworkTemplate,
    reworkPresets,
    port: (taskId, target, o) => port(tasks.get(taskId), target, o, null),
    waitRun,
    /** MCP tool list; the built-in-compatible `agent` alias only in orchestration.subagents "harness" mode */
    get tools() {
      return this.toolsFor(null);
    },
    /** tools/list for a caller session: no `agent` in builtin mode or for a sub-agent at the depth limit */
    toolsFor(callerId) {
      const caller = callerId ? sessions.find(callerId) : null;
      const noAgent = config.orchestration?.subagents === 'builtin' || atDepthLimit(caller);
      return TOOLS.filter((t) => !(noAgent && t.name === 'agent')).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    },

    async call(name, args, callerId) {
      const tool = TOOLS.find((t) => t.name === name) || fail(404, `неизвестный инструмент «${name}»`);
      const caller = callerId ? sessions.find(callerId) || fail(400, `неизвестная вызывающая сессия ${callerId}`) : null;
      const a = args ?? {};
      checkArgs(tool.inputSchema, a);
      return tool.run(a, caller);
    },

    /** POST /api/tasks/:id/assign */
    async assign(taskId, body) {
      const task = tasks.get(taskId);
      if (!body.sessionId) return startWorker(task, { agent: body.agent, workspaceId: body.workspaceId, cwd: body.cwd, worktree: body.worktree }, null);
      const s = sessions.get(body.sessionId);
      const busy = activeWorker(task);
      if (busy && busy.id !== s.id) fail(409, `у задачи ${task.id} уже есть активный агент (${busy.id})`);
      const text = taskPrompt(task, s);
      tasks.update(task.id, { status: 'in_progress', assigneeSessionId: s.id }, 'user');
      if (s.kind === 'chat' && !s.taskId) sessions.update(s.id, { taskId: task.id });
      sessions.deliver(s.id, { from: 'user', text });
      return s;
    },

    /**
     * POST /api/tasks/:id/start ("take into work"): default agent, new worktree in the task's workspace.
     * A task with a live worker (or a start in flight) returns that session with jumped: true.
     */
    /**
     * «Доработка»: the fix request goes to the task's worker (the same CLI session, queued if it runs) or, without one,
     * to a new worker in the task's existing worktree/branch. The card goes back to in_progress.
     */
    /** GET /api/tasks/:id/rework-preview: exactly the text rework() would send now (no side effects). */
    reworkPreview(taskId, { notes = '', agent } = {}) {
      const task = tasks.get(taskId);
      const prev = task.assigneeSessionId && sessions.find(task.assigneeSessionId);
      const worker = prev && prev.kind === 'chat' && prev.role === 'worker' && !prev.archived && !prev.ephemeral ? prev : null;
      const ws = findWs(task.workspaceId);
      const target = worker || { agent: agent || config.defaultAgent, workspaceId: ws?.id, branch: task.branch, cwd: ws?.path || config.root, id: '' };
      return { text: reworkPrompt(task, target, String(notes)), agent: target.agent, sessionId: worker?.id ?? null };
    },

    async rework(taskId, { notes, agent } = {}) {
      const task = tasks.get(taskId);
      if (typeof notes !== 'string' || !notes.trim()) fail(400, 'нужен текст доработки (notes)');
      const prev = task.assigneeSessionId && sessions.find(task.assigneeSessionId);
      const worker = prev && prev.kind === 'chat' && prev.role === 'worker' && !prev.archived && !prev.ephemeral ? prev : null;
      if (!worker && !task.branch) fail(409, `${tasks.key(task)} ещё не брали в работу — сначала возьмите её в работу`);
      if (task.status !== 'in_progress') tasks.move(task.id, 'in_progress', null);
      tasks.addLog(task.id, 'user', `Доработка: ${notes.trim()}`, 'rework', { notes: notes.trim() });
      if (worker) {
        jobStep('Отправка агенту');
        sessions.deliver(worker.id, { from: 'user', text: reworkPrompt(task, worker, notes) });
        return sessions.get(worker.id);
      }
      const ws = findWs(task.workspaceId) || fail(400, `у задачи ${task.id} не выбран репозиторий — сначала выберите его`);
      const existing = ws.isGit ? (await git.worktrees(ws.path)).find((w) => w.branch === task.branch) : null;
      const a = agent || config.defaultAgent;
      // the prompt needs the session (branch, repo): render it for the worker that startWorker creates
      const spec = reworkPrompt(task, { agent: a, workspaceId: ws.id, branch: task.branch, cwd: existing?.path || ws.path, id: '' }, notes);
      return startWorker(task, { agent: a, workspaceId: ws.id, ...(existing ? { cwd: existing.path, worktree: 'current' } : { worktree: ws.isGit ? 'new' : 'current' }), spec }, null);
    },

    /**
     * «Взять в работу»: an explicit workspaceId (the request's or the task's) -> its worktree; location 'root' -> the
     * projects folder; else a HIGH-confidence suggestion; else the projects folder (never a low-confidence guess); with
     * no projects folder the only repository. A parent of subtasks is coordinated as before.
     */
    async start(taskId, { agent, notes, workspaceId, location } = {}) {
      const task = tasks.get(taskId);
      const live = activeWorker(task);
      if (live) return { ...live, jumped: true };
      if (starting.has(task.id)) return { ...(await starting.get(task.id)), jumped: true };
      if (db.tasks.some((t) => t.parentId === task.id && !t.hidden)) return startCoordinator(task, { agent, notes });
      if (workspaceId && !findWs(workspaceId)) fail(404, `рабочая папка ${workspaceId} не найдена`);
      const explicit = findWs(workspaceId) || findWs(task.workspaceId);
      const sure = task.suggestedWorkspace?.confidence === 'high' ? findWs(task.suggestedWorkspace.id) : null;
      const ws = location === 'root' ? null : explicit || sure;
      const a = agent || config.defaultAgent;
      if (ws) return startWorker(task, { agent: a, workspaceId: ws.id, worktree: ws.isGit ? 'new' : 'current', notes }, null);
      const root = db.workspaces.find((w) => w.kind === 'root');
      if (!root) {
        const repos = db.workspaces.filter((w) => !w.kind);
        if (location !== 'root' && repos.length === 1) return startWorker(task, { agent: a, workspaceId: repos[0].id, worktree: repos[0].isGit ? 'new' : 'current', notes }, null);
        fail(400, 'нет папки проектов (workspaces.root) — выберите репозиторий для задачи');
      }
      tasks.update(task.id, { location: 'root' }, 'harness');
      return startWorker(task, { agent: a, cwd: root.path, worktree: 'current', atRoot: true, notes }, null);
    },

    /**
     * Worktrees an agent created for a task started in the projects folder: a worktree of a registered repository whose
     * branch contains the task key (case-insensitive, whole word) is linked to the task (task.worktrees, and branch /
     * workspaceId when still empty). `lists`: [[workspace, worktrees]] already at hand, else every repository is read.
     */
    async linkAgentWorktrees(lists = null) {
      const open = db.tasks.filter((t) => t.location === 'root' && t.status !== 'done');
      if (!open.length) return 0;
      const pairs = lists || await Promise.all(db.workspaces.filter((w) => w.isGit).map(async (w) => [w, await git.worktrees(w.path).catch(() => [])]));
      let linked = 0;
      for (const [ws, list] of pairs) {
        if (!ws.isGit) continue;
        for (const wt of list) {
          for (const t of open) {
            const key = tasks.key(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (!wt.branch || !new RegExp(`(^|[^A-Za-z0-9])${key}($|[^A-Za-z0-9])`, 'i').test(wt.branch)) continue;
            const cur = tasks.find(t.id);
            if ((cur.worktrees || []).some((x) => samePath(x.path, wt.path))) continue;
            tasks.update(t.id, {
              worktrees: [...(cur.worktrees || []), { workspaceId: ws.id, path: wt.path, branch: wt.branch }],
              ...(cur.branch ? {} : { branch: wt.branch }),
              ...(cur.workspaceId ? {} : { workspaceId: ws.id }),
            }, 'harness');
            tasks.addLog(t.id, 'harness', `Агент создал рабочее дерево: ${ws.name} · ${wt.branch}`, 'worktree', { workspaceId: ws.id, path: wt.path, branch: wt.branch });
            if (!db.worktreeMeta?.[wtKey(wt.path)]?.createdBy) markWorktree(wt.path, { createdBy: 'agent', ...(cur.assigneeSessionId ? { createdBySession: cur.assigneeSessionId } : {}) });
            linked++;
          }
        }
      }
      return linked;
    },
  };
}
