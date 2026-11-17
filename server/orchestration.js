// Agent-facing orchestration API (tools for coordinator/worker agents), worker start (shared with the UI's
// assign/start), ports into extra target branches, preambles, escalation, notifications, commit/PR prefill.
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT, expandHome } from './config.js';
import * as git from './git.js';
import { jobStep } from './jobs.js';
import { newId } from './sessions.js';

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

export const SUBAGENT_CONTEXT = 'Ты работаешь внутри harness. Субагентов запускай инструментом mcp__harness__agent с теми же аргументами, что у встроенного agent (subagent_type, prompt, model) — встроенный agent не используй: harness откроет каждого субагента отдельным чатом и вернёт тебе его результат так же. Вопросы человеку — через mcp__harness__ask (варианты в options), затем заверши ход.';
const CONTEXT_LAUNCHERS = new Set(['gigacode', 'qwen', 'gemini', 'mock']);

export const render = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k] ?? '') : m));

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description });

function checkArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail(400, 'arguments must be a JSON object');
  for (const k of schema.required) if (args[k] == null || args[k] === '') fail(400, `${k} is required`);
  for (const [k, p] of Object.entries(schema.properties)) {
    const v = args[k];
    if (v == null) continue;
    const ok = p.type === 'array' ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === p.type;
    if (!ok) fail(400, `${k} must be ${p.type === 'array' ? 'an array of strings' : `a ${p.type}`}`);
    if (p.enum && !p.enum.includes(v)) fail(400, `${k} must be one of ${p.enum.join(', ')}`);
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
    return db.workspaces.find((w) => w.id === ref) || db.workspaces.find((w) => w.name.toLowerCase() === lower) || fail(404, `workspace "${ref}" not found (see workspace_list)`);
  }

  function activeWorker(task) {
    const s = task.assigneeSessionId && sessions.find(task.assigneeSessionId);
    return isActive(s) ? s : null;
  }

  function notify({ kind, sessionId = null, taskId = null, text, options, link }) {
    const n = { id: newId('n'), at: Date.now(), read: false, kind, sessionId, taskId, text, ...(options?.length ? { options } : {}), ...(link ? { link } : {}) };
    db.notifications.push(n);
    if (db.notifications.length > 500) db.notifications.splice(0, db.notifications.length - 500);
    store.save();
    bus.send({ t: 'notify', n });
    return n;
  }

  const lastSummary = (task) => {
    for (let i = task.log.length - 1; i >= 0; i--) {
      const m = task.log[i].text.match(REPORT_RE);
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
      fail(400, `config error: the task prompt template for "${agent}" contains none of ${TASK_VARS.join(' ')}, so the agent would start without the task`);
    }
    return tpl;
  }

  function taskPrompt(task, s, { notes = '' } = {}) {
    const agentCfg = config.agents[s.agent] || {};
    const ws = findWs(s.workspaceId);
    return render(promptTemplate(s.agent), {
      key: tasks.key(task),
      id: task.id,
      title: task.title,
      description: task.description,
      url: task.externalUrl || '',
      taskUrl: task.externalUrl || tasks.key(task), // local tasks have no URL; the key still identifies them
      targets: task.targets.join(', '),
      branch: s.branch || task.branch || '',
      repo: ws?.name || path.basename(s.cwd),
      notes: notes.trim() ? ` ${notes.trim()}` : '',
      runId: s.id,
      registryDir: sessions.registryDir(s.id),
      settingsPath: s.settingsPath || '',
      approvalMode: s.approvalMode || agentCfg.approvalMode || '',
    });
  }

  /** Worktree + branch for a task: branchTemplate with the task key, started from targets[0]; reused if present. */
  async function taskWorktree(task, cwd, explicitBranch) {
    if (!(await git.isRepo(cwd))) fail(400, `cannot create a worktree: ${cwd} is not a git repository`);
    let branch;
    if (explicitBranch) branch = git.sanitizeBranch(explicitBranch);
    else if (task.branch && (await git.branchExists(cwd, task.branch))) branch = task.branch;
    else branch = await git.uniqueBranch(cwd, git.sanitizeBranch(render(gitCfg().branchTemplate, { key: tasks.key(task), id: task.id })), task.branch);
    const existed = (await git.worktrees(cwd)).some((w) => w.branch === branch);
    const start = await git.startPoint(cwd, task.targets[0]);
    const wt = await git.addWorktree(cwd, { branch, start, worktreeRoot: config.worktreeRoot, dirName: tasks.key(task) });
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

  /** Creates a worker chat session for `task` and sends it the first prompt. Used by worker_start, assign, start. */
  async function startWorker(task, o, caller) {
    const busy = activeWorker(task);
    if (busy) fail(409, `task ${task.id} already has an active worker (${busy.id})`);
    if (starting.has(task.id)) fail(409, `task ${task.id} is being started right now`);
    const pending = task.deps.filter((d) => tasks.find(d)?.status !== 'done');
    if (pending.length) fail(409, `task ${task.id} has unfinished dependencies: ${pending.join(', ')}`);
    if (o.worktree && !['current', 'new'].includes(o.worktree)) fail(400, 'worktree must be "current" or "new"');
    const agent = o.agent || (caller?.kind === 'chat' ? caller.agent : null) || config.defaultAgent;
    // fail fast, before any worktree or session exists
    jobStep('Проверка агента');
    sessions.resolveAgent(agent);
    if (!o.spec) promptTemplate(agent);
    const ws = o.workspace ? workspaceRef(o.workspace) : o.workspaceId ? findWs(o.workspaceId) || fail(404, `workspace ${o.workspaceId} not found`) : findWs(task.workspaceId);

    const run = (async () => {
      let cwd = o.cwd ? path.resolve(o.cwd) : ws ? ws.path : caller?.cwd || config.root;
      let branch;
      let made = null;
      if (o.worktree === 'new') {
        jobStep('Создание worktree');
        made = await taskWorktree(task, cwd, o.branch);
        cwd = made.wt.path;
        branch = made.wt.branch;
      } else {
        branch = await git.currentBranch(cwd);
      }
      const inWorktree = !!made || (await git.worktrees(cwd).catch(() => [])).some((w) => !w.main && samePath(w.path, cwd));
      const includeDirs = await siblingDirs(task);
      const key = tasks.key(task);
      let s;
      jobStep('Запуск сессии');
      try {
        s = await sessions.create({
          kind: 'chat', agent, cwd, workspaceId: ws?.id, title: `${key}: ${task.title}`, role: 'worker',
          parentId: caller?.id ?? null, taskId: task.id, model: o.model, branch, inWorktree, includeDirs, autoIncludeDirs: true,
        });
      } catch (e) {
        if (made?.created) await git.removeWorktree(made.repo, made.wt.path).catch(() => {});
        throw e;
      }
      const by = caller?.id || 'user';
      const patch = { status: 'in_progress', assigneeSessionId: s.id };
      if (!task.workspaceId && ws) patch.workspaceId = ws.id;
      if (o.worktree === 'new' || (!task.branch && branch && !task.targets.includes(branch))) patch.branch = branch;
      if (!task.takenAt) {
        patch.takenAt = Date.now();
        patch.snapshot = { title: task.title, description: task.description, externalStatus: task.externalStatus ?? null, at: patch.takenAt };
      }
      tasks.update(task.id, patch, by);
      tasks.addLog(task.id, by, `worker ${s.id} started (${agent}) in ${cwd}${branch ? ` on ${branch}` : ''}`);
      sessions.deliver(s.id, { from: by, text: o.spec ?? taskPrompt(task, s, { notes: o.notes }) });
      return s;
    })();
    starting.set(task.id, run);
    try {
      return await run;
    } finally {
      starting.delete(task.id);
    }
  }

  /** Cherry-picks the task's commits into another target branch in a new worktree (see ARCHITECTURE.md). */
  async function port(task, target, { agent } = {}, caller = null) {
    if (typeof target !== 'string' || !target.trim()) fail(400, 'target is required');
    if (!task.branch) fail(409, `Task ${task.id} has no work branch yet: take it into work first.`);
    const primary = task.targets[0];
    if (target === primary) fail(400, `${target} is the primary target; ports go to the other targets`);
    const prev = task.ports.find((p) => p.target === target);
    if (prev?.status === 'clean' || prev?.status === 'done') return prev;
    if (prev?.status === 'conflict' && isActive(sessions.find(prev.sessionId))) fail(409, `The port of ${task.id} to ${target} is already being resolved (${prev.sessionId}).`);
    const ws = findWs(task.workspaceId);
    const repo = ws?.path || sessions.find(task.assigneeSessionId)?.cwd || config.root;
    const conflictAgent = agent || (caller?.kind === 'chat' ? caller.agent : null) || config.defaultAgent;
    const start = (await git.startPoint(repo, target)) || fail(400, `target branch ${target} not found locally or on origin`);
    const ahead = (await git.revList(repo, `${primary}..${task.branch}`)) ?? (await git.revList(repo, `origin/${primary}..${task.branch}`));
    if (!ahead) fail(400, `cannot list commits of ${task.branch} relative to ${primary}`);
    if (!ahead.length) fail(409, `Nothing to port yet: ${task.branch} has no commits ahead of ${primary}. Commit the work first.`);
    // only what the target lacks (patch-id aware), so a partial earlier port is not picked twice
    const commits = await git.missingCommits(repo, start, task.branch);
    if (!commits) fail(400, `cannot compare ${task.branch} with ${target}`);
    if (!commits.length) fail(409, `Nothing to port: ${target} already contains every change of ${task.branch}.`);
    sessions.resolveAgent(conflictAgent); // a conflict needs a worker: fail before creating the worktree
    const branch = await git.uniqueBranch(repo, git.sanitizeBranch(render(gitCfg().portBranchTemplate, { branch: task.branch, target, targetSlug: git.targetSlug(target), key: tasks.key(task) })));
    jobStep('Создание worktree');
    const wt = await git.addWorktree(repo, { branch, start, worktreeRoot: config.worktreeRoot });
    jobStep('cherry-pick', { done: 0, total: commits.length });
    const status = await git.cherryPick(wt.path, commits); // one sequence: --continue after a conflict picks the rest
    if (status === 'clean') jobStep('cherry-pick', { done: commits.length, total: commits.length });
    const rec = { target, branch, cwd: wt.path, status, sessionId: null };
    savePort(task, rec);
    const by = caller?.id || 'user';
    tasks.addLog(task.id, by, `port to ${target}: ${status} (${commits.length} commit(s) on ${branch})`);
    if (status === 'conflict') {
      jobStep('Конфликт: запуск агента');
      const s = await sessions.create({
        kind: 'chat', agent: conflictAgent, cwd: wt.path, workspaceId: ws?.id, title: `${tasks.key(task)}: port to ${target}`, role: 'worker',
        parentId: caller?.id ?? null, taskId: task.id, branch,
      });
      rec.sessionId = s.id;
      savePort(task, rec);
      sessions.deliver(s.id, { from: by, text: `Resolve the cherry-pick conflicts of ${tasks.key(task)} "${task.title}" (commits from ${task.branch}) on ${branch}, which targets ${target}.` });
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
      tasks.addLog(task.id, 'user', `coordinator ${s.id} started (${agent}) for ${subs.length} subtask(s)`);
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
  }

  async function workerRun(a, caller) {
    if (!caller) fail(400, 'worker_run must be called from a harness session (x-harness-session header)');
    if (typeof a.spec !== 'string' || !a.spec.trim()) fail(400, 'spec is required');
    const agent = caller.kind === 'chat' && config.agents[caller.agent] ? caller.agent : config.defaultAgent;
    const agentCfg = config.agents[agent] || {};
    const profile = a.profile ? loadProfile(agentCfg, a.profile) : null;
    let model = a.model ?? profile?.meta.model ?? null;
    const grades = agentCfg.settings?.agents?.modelGrades || {};
    if (model && grades[model]) model = grades[model]; // a grade name ("review") -> its model id
    if (model && sessions.unavailableModels(agent).has(model)) model = null; // the CLI default instead of a doomed run
    let mode = a.approvalMode ?? profile?.meta.approvalMode ?? null;
    if (mode && agentCfg.approvalModes?.length && !agentCfg.approvalModes.includes(mode)) mode = null;
    let cwd = caller.cwd;
    let branch = caller.branch;
    if (a.worktree === 'new') {
      const wt = await git.addWorktree(caller.cwd, { branch: git.sanitizeBranch(`sub/${a.profile || 'agent'}-${newId('x').slice(2)}`), worktreeRoot: config.worktreeRoot });
      cwd = wt.path;
      branch = wt.branch;
    }
    const s = await sessions.create({
      kind: 'chat', agent, cwd, role: 'worker', parentId: caller.id, model, approvalMode: mode, branch, ephemeral: true, autoReport: false,
      title: a.title || [a.profile || 'agent', a.description].filter(Boolean).join(' · '),
    });
    sessions.deliver(s.id, { from: caller.id, text: [profile?.body, `## Задание\n${a.spec}`].filter(Boolean).join('\n\n') });
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
    const agentCfg = config.agents[agent] || fail(400, `review agent "${agent}" is not configured`);
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
    tasks.addLog(task.id, 'harness', `review round ${round} started in ${reviewer.id}${model ? ` (${model})` : ''}`);
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
    tasks.addLog(task.id, reviewer.id, `Review round ${rv.round}: ${verdict}`);
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
    const block = config.orchestration?.subagents !== 'builtin' && CONTEXT_LAUNCHERS.has(s.launcherId) ? SUBAGENT_CONTEXT : '';
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
      // for task commands that make their own worktree (/full-task): this one is it
      ...(s.inWorktree
        ? [`Ты уже в рабочем дереве задачи \`${s.cwd}\` (ветка \`${s.branch || task.branch}\`) — это и есть worktree задачи; не создавай другой.${config.orchestration?.workerMayCommit ? '' : ' Коммиты/пуш/PR/трекер — только пользователь из UI.'} После финального сообщения твоей команды вызови worker_done с тем же текстом.`]
        : []),
      'Rules:',
      '- Do only this task and only inside the working directory.',
      '- Stay on your branch: do not switch or create branches.',
      commitRule,
      ...(config.orchestration?.reviewMode === 'harness'
        ? ['- Ревью выполняет harness другой моделью после твоего worker_done; пропусти шаги внутреннего ревью твоей команды (не запускай встроенных субагентов-ревьюеров).']
        : []),
      ...common,
    ].join('\n');
  }

  // ---- post-turn: escalation and error notifications ----

  function turnEnded(s, { reported, communicated, stopped, queueEmpty }) {
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
      notify({ kind: 'error', sessionId: s.id, taskId: s.taskId, text: `${s.title}: the agent could not run (see the chat)` });
    }
    if (s.role !== 'worker' || !s.autoReport || reported || communicated || !queueEmpty) return;
    const text = `Worker ${label(s)} ended its turn without calling worker_done (status: ${s.status}).\nLast output: ${s.preview || '(none)'}\nReply with send_message to "${s.id}" to continue it.`;
    const parent = s.parentId && sessions.find(s.parentId);
    if (parent) sessions.deliver(parent.id, { from: s.id, text: fromSession(s, text) });
    else notify({ kind: 'escalation', sessionId: s.id, taskId: s.taskId, text });
  }

  sessions.hooks.preamble = preamble;
  sessions.hooks.notify = notify;
  sessions.hooks.sessionChanged = syncAgentState;
  sessions.hooks.turnEnded = turnEnded;

  // ---- tools ----

  const sessionInfo = (s) => ({ id: s.id, title: s.title, role: s.role, status: s.status, agent: s.agent, taskId: s.taskId, parentId: s.parentId, cwd: s.cwd, branch: s.branch, queued: s.queued, preview: s.preview });

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
        if (c && w && w.id !== c.id && w.parentId !== c.id) fail(409, `task ${task.id} is locked by its active worker ${w.id}`);
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
      description: 'Start a worker agent (its own chat) for a task (task_id) or an ad-hoc spec. Then END YOUR TURN: the harness wakes you with its report.',
      inputSchema: obj({
        task_id: str('existing task id'), spec: str('ad-hoc task spec (creates a task)'), title: str('title for an ad-hoc spec'),
        agent: str('agent id from the config'), workspace: str('workspace id or name to run in'),
        worktree: str('current (default) or new (own git worktree + branch)', { enum: ['current', 'new'] }),
        branch: str('branch name for worktree "new" (default from the task key)'), model: str('model id'),
      }),
      run: async (a, c) => {
        let task;
        if (a.task_id) task = tasks.get(a.task_id);
        else if (a.spec) {
          const title = (a.title || a.spec.split('\n').find((l) => l.trim()) || 'task').trim().slice(0, 80);
          task = tasks.create({ title, description: a.spec, workspaceId: a.workspace ? workspaceRef(a.workspace).id : c?.workspaceId ?? null }, c?.id || 'user');
        } else fail(400, 'task_id or spec is required');
        return sessionInfo(await startWorker(task, { ...a, spec: a.task_id ? undefined : a.spec }, c));
      },
    },
    {
      name: 'worker_run',
      description: 'Run a sub-agent in its own harness chat and wait for its result (synchronous, like the built-in agent tool). profile = an agent profile name (~/.gigacode/agents/<profile>.md).',
      inputSchema: obj({
        profile: str('agent profile name'), spec: str('the assignment'), model: str('model id or grade name'),
        approvalMode: str('approval mode'), title: str('chat title'),
        worktree: str('current (default) or new', { enum: ['current', 'new'] }), timeoutMin: { type: 'number', description: 'minutes to wait (default 60)' },
      }, ['spec']),
      run: (a, c) => workerRun(a, c),
    },
    {
      name: 'agent',
      description: 'Start a sub-agent (same arguments as the built-in agent tool). The harness opens it as a separate chat and returns its result.',
      inputSchema: obj({
        subagent_type: str('agent type / profile name'), prompt: str('the task for the sub-agent'), model: str('model id or grade name'),
        description: str('short description'), approvalMode: str('approval mode'),
        worktree: str('current (default) or new', { enum: ['current', 'new'] }), timeoutMin: { type: 'number', description: 'minutes to wait (default 60)' },
      }, ['prompt']),
      run: (a, c) => workerRun({ ...a, profile: a.subagent_type, spec: a.prompt }, c),
    },
    {
      name: 'worker_list',
      description: 'Your worker sessions with status, task and last output.',
      inputSchema: obj({}),
      run: (_, c) => (c ? sessions.children(c.id) : sessions.list().filter((s) => s.role === 'worker')).map(sessionInfo),
    },
    {
      name: 'send_message',
      description: 'Send a message to a session id, to "parent" or to "user". Wakes the target session.',
      inputSchema: obj({ to: str('session id | "parent" | "user"'), body: str('message text') }, ['to', 'body']),
      run: (a, c) => {
        if (c) sessions.flag(c.id, 'communicated');
        const parent = a.to === 'parent' && c?.parentId ? sessions.find(c.parentId) : null;
        if (a.to === 'user' || (a.to === 'parent' && !parent)) {
          notify({ kind: 'info', sessionId: c?.id ?? null, taskId: c?.taskId ?? null, text: a.body });
          return { delivered: 'user' };
        }
        const target = parent || sessions.find(a.to) || fail(404, `session ${a.to} not found`);
        const r = sessions.deliver(target.id, { from: c?.id ?? 'user', text: c ? fromSession(c, a.body) : a.body });
        return { delivered: target.id, queued: r.queued };
      },
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
        if (!c) fail(400, 'worker_done must be called from a harness session (x-harness-session header)');
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
          tasks.addLog(task.id, c.id, `port to ${portRec.target} ${status}: ${a.summary}`);
        } else if (task) {
          // board.onWorkerDone "stay" (default): the card keeps its column, the agent badge shows the outcome
          if (config.board?.onWorkerDone === 'review') tasks.update(task.id, { status: status === 'done' ? 'review' : 'todo' }, c.id);
          tasks.addLog(task.id, c.id, `Worker report (${status}): ${a.summary}`);
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
    if (typeof cwd !== 'string' || !cwd) fail(400, 'cwd is required');
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
    preamble,
    resumeReviews,
    gitSuggest,
    promptTemplate,
    port: (taskId, target, o) => port(tasks.get(taskId), target, o, null),
    waitRun,
    /** MCP tool list; the built-in-compatible `agent` alias only in orchestration.subagents "harness" mode */
    get tools() {
      const builtin = config.orchestration?.subagents === 'builtin';
      return TOOLS.filter((t) => !(builtin && t.name === 'agent')).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    },

    async call(name, args, callerId) {
      const tool = TOOLS.find((t) => t.name === name) || fail(404, `unknown tool "${name}"`);
      const caller = callerId ? sessions.find(callerId) || fail(400, `unknown caller session ${callerId}`) : null;
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
      if (busy && busy.id !== s.id) fail(409, `task ${task.id} already has an active worker (${busy.id})`);
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
    async start(taskId, { agent, notes } = {}) {
      const task = tasks.get(taskId);
      const live = activeWorker(task);
      if (live) return { ...live, jumped: true };
      if (starting.has(task.id)) return { ...(await starting.get(task.id)), jumped: true };
      // a parent of subtasks (or a task without a repo while there are several) is coordinated, not worked on
      const hasChildren = db.tasks.some((t) => t.parentId === task.id && !t.hidden);
      if (hasChildren || (!task.workspaceId && db.workspaces.length >= 2)) return startCoordinator(task, { agent, notes });
      const ws = findWs(task.workspaceId) || (db.workspaces.length === 1 ? db.workspaces[0] : null);
      if (!ws) fail(400, `task ${task.id} has no workspace; set its workspace first`);
      return startWorker(task, { agent: agent || config.defaultAgent, workspaceId: ws.id, worktree: ws.isGit ? 'new' : 'current', notes }, null);
    },
  };
}
