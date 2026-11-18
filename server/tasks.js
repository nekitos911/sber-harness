// Task board: CRUD, column ordering (float `order`), deps/ready computation, task keys.
// Locks (one active worker per task, agents editing foreign tasks) are enforced in orchestration.js.

export const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'];
export const PRIORITIES = ['low', 'medium', 'high'];
const EDITABLE = ['title', 'description', 'status', 'order', 'priority', 'deps', 'labels', 'workspaceId', 'parentId',
  'targets', 'branch', 'ports', 'assigneeSessionId', 'externalId', 'externalUrl', 'source',
  'externalStatus', 'statusManual', 'hidden', 'takenAt', 'snapshot', 'pr', 'agentState', 'review', 'checks', 'includeDirs', 'externalFields', 'worktrees', 'location'];
const DEFAULTS = { parentId: null, targets: null, branch: null, ports: [], externalStatus: null, statusManual: false, hidden: false, takenAt: null, snapshot: null, pr: null, agentState: null, review: null, checks: null };

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const defined = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));

const STATUS_LABEL = { backlog: 'Бэклог', todo: 'К работе', in_progress: 'В работе', review: 'На проверке', done: 'Готово' };
export const LOG_TYPES = ['created', 'imported', 'status', 'started', 'agent_done', 'agent_failed', 'review', 'rework', 'port', 'pr_created', 'tracker_transition', 'comment', 'worktree', 'agent_gone'];

export function createTasks({ store, bus, defaultBase = 'main' }) {
  const db = store.db;
  let suggest = null; // (task) -> workspace id | null, set by the server (auto-fill of the repository)
  for (const t of db.tasks) {
    for (const [k, v] of Object.entries(DEFAULTS)) t[k] ??= Array.isArray(v) ? [] : v;
    t.targets ??= [defaultBase];
  }
  const find = (id) => db.tasks.find((t) => t.id === id);
  const get = (id) => find(id) || fail(404, `задача ${id} не найдена`);
  const column = (status, exceptId) => db.tasks.filter((t) => t.status === status && t.id !== exceptId).sort((a, b) => a.order - b.order);
  const endOrder = (status, exceptId) => (column(status, exceptId).at(-1)?.order ?? 0) + 1;

  function emit(task) {
    task.updatedAt = Date.now();
    // { id, confidence: 'high' | 'low', reason } while workspaceId is empty; only 'high' is ever used without asking
    task.suggestedWorkspace = !task.workspaceId && suggest ? suggest(task) ?? null : null;
    task.suggestedWorkspaceId = task.suggestedWorkspace?.id ?? null;
    store.save();
    bus.send({ t: 'task', task });
    return task;
  }

  function root(t) {
    const seen = new Set();
    while (t.parentId && !seen.has(t.id) && find(t.parentId)) {
      seen.add(t.id);
      t = find(t.parentId);
    }
    return t;
  }

  /** Key for branches and commit/PR titles: tracker key of the ROOT task, else the root's local id. */
  const key = (t) => {
    const r = root(t);
    return r.externalId || r.id;
  };

  /** true if `from` reaches `target` by following `next(task)` ids */
  function reaches(from, target, next, seen = new Set()) {
    if (from === target) return true;
    if (seen.has(from) || !find(from)) return false;
    seen.add(from);
    return next(find(from)).some((d) => reaches(d, target, next, seen));
  }

  function validate(f, selfId) {
    if ('title' in f && (typeof f.title !== 'string' || !f.title.trim())) fail(400, 'название не может быть пустым');
    for (const k of ['description', 'externalId', 'externalUrl', 'source', 'workspaceId', 'assigneeSessionId', 'parentId', 'branch', 'externalStatus']) {
      if (k in f && f[k] !== null && f[k] !== undefined && typeof f[k] !== 'string') fail(400, `${k}: нужна строка`);
    }
    if ('status' in f && !STATUSES.includes(f.status)) fail(400, `status — одно из: ${STATUSES.join(', ')}`);
    if ('priority' in f && f.priority !== null && f.priority !== undefined && !PRIORITIES.includes(f.priority)) fail(400, `priority — одно из: ${PRIORITIES.join(', ')} или null`);
    if ('order' in f && !Number.isFinite(f.order)) fail(400, 'order: нужно число');
    if ('labels' in f && !isStrArr(f.labels)) fail(400, 'labels: нужен массив строк');
    if ('worktrees' in f && f.worktrees !== undefined && !Array.isArray(f.worktrees)) fail(400, 'worktrees: нужен массив');
    if ('location' in f && f.location != null && f.location !== 'root') fail(400, 'location: "root" или null');
    if ('includeDirs' in f && f.includeDirs !== undefined && !isStrArr(f.includeDirs)) fail(400, 'includeDirs: нужен массив путей к папкам');
    if ('targets' in f && f.targets !== undefined && (!isStrArr(f.targets) || f.targets.some((t) => !t.trim()))) fail(400, 'targets: нужен массив имён веток');
    if ('ports' in f && !Array.isArray(f.ports)) fail(400, 'ports: нужен массив');
    for (const k of ['statusManual', 'hidden']) if (k in f && typeof f[k] !== 'boolean') fail(400, `${k}: нужно true или false`);
    if ('takenAt' in f && f.takenAt !== null && !Number.isFinite(f.takenAt)) fail(400, 'takenAt: число или null');
    for (const k of ['snapshot', 'pr', 'review', 'checks']) if (k in f && f[k] !== null && (typeof f[k] !== 'object' || Array.isArray(f[k]))) fail(400, `${k}: объект или null`);
    if ('deps' in f && f.deps !== undefined) {
      if (!isStrArr(f.deps)) fail(400, 'deps: нужен массив id задач');
      for (const d of f.deps) {
        if (!find(d)) fail(400, `зависимость ${d} не найдена`);
        if (selfId && reaches(d, selfId, (t) => t.deps)) fail(400, `зависимость ${d} создаст цикл`);
      }
    }
    if (f.parentId) {
      if (!find(f.parentId)) fail(400, `родительская задача ${f.parentId} не найдена`);
      if (selfId && reaches(f.parentId, selfId, (t) => (t.parentId ? [t.parentId] : []))) fail(400, 'parentId создаст цикл');
    }
    if ('comment' in f && f.comment !== undefined && typeof f.comment !== 'string') fail(400, 'comment: нужна строка');
  }

  function isReady(t) {
    return (t.status === 'todo' || t.status === 'backlog') && t.deps.every((d) => find(d)?.status === 'done');
  }

  return {
    find,
    get,
    key,
    isReady,
    all: () => db.tasks,

    list({ status, ready } = {}) {
      return db.tasks
        .filter((t) => (!status || t.status === status) && (!ready || isReady(t)))
        .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.order - b.order);
    },

    create(fields, by = 'user') {
      const f = defined(fields);
      validate(f);
      if (typeof f.title !== 'string') fail(400, 'нужно название');
      const parent = f.parentId ? find(f.parentId) : null;
      const now = Date.now();
      const task = {
        id: `T-${++db.seq.task}`,
        title: f.title.trim(),
        description: f.description || '',
        status: f.status || 'todo',
        order: 0,
        priority: f.priority ?? null,
        deps: [...new Set(f.deps || [])],
        labels: f.labels || [],
        workspaceId: f.workspaceId ?? parent?.workspaceId ?? null,
        parentId: parent?.id ?? null,
        targets: f.targets?.length ? f.targets : parent ? [...parent.targets] : [defaultBase],
        branch: f.branch ?? null,
        ports: [],
        assigneeSessionId: null,
        externalId: f.externalId ?? null,
        externalUrl: f.externalUrl ?? null,
        source: f.source ?? null,
        externalStatus: f.externalStatus ?? null,
        statusManual: false,
        hidden: false,
        takenAt: null,
        snapshot: null,
        pr: null,
        agentState: null,
        review: null,
        log: [f.source ? { at: now, by, type: 'imported', text: 'Импортирована из трекера' } : { at: now, by, type: 'created', text: 'Создана' }],
        createdAt: now,
        updatedAt: now,
      };
      task.order = endOrder(task.status);
      db.tasks.push(task);
      return emit(task);
    },

    update(id, fields, by = 'user') {
      const f = defined(fields);
      const task = get(id);
      validate(f, id);
      const statusChanged = 'status' in f && f.status !== task.status;
      for (const k of EDITABLE) if (k in f) task[k] = k === 'title' ? f.title.trim() : f[k];
      if (statusChanged && !('order' in f)) task.order = endOrder(task.status, id);
      if (statusChanged) task.log.push({ at: Date.now(), by, type: 'status', text: `Статус: ${STATUS_LABEL[task.status] ?? task.status}`, data: { to: task.status } });
      if (f.comment) task.log.push({ at: Date.now(), by, type: 'comment', text: f.comment });
      return emit(task);
    },

    /** A typed log entry: `text` is for people (Russian, no session ids or paths), `data` for the UI. */
    addLog(id, by, text, type = 'comment', data) {
      const task = get(id);
      task.log.push({ at: Date.now(), by, type, text, ...(data ? { data } : {}) });
      return emit(task);
    },
    setSuggester(fn) {
      suggest = fn;
    },

    /** Drag and drop: put the task into `status` before `beforeId`, or at the end of the column. */
    move(id, status, beforeId = null) {
      const task = get(id);
      validate({ status });
      // validated before anything changes: a bad beforeId leaves the task as it was
      const col = beforeId ? column(status, id) : null;
      const idx = col ? col.findIndex((t) => t.id === beforeId) : -1;
      if (col && idx < 0) fail(400, `beforeId ${beforeId} не в колонке ${status}`);
      if (task.status !== status) task.log.push({ at: Date.now(), by: 'user', type: 'status', text: `Статус: ${STATUS_LABEL[status] ?? status}`, data: { to: status } });
      task.status = status;
      task.statusManual = true; // a human moved the card: tracker sync no longer changes its column
      if (!beforeId) {
        task.order = endOrder(status, id);
        return emit(task);
      }
      const next = col[idx];
      const prev = col[idx - 1];
      task.order = prev ? (prev.order + next.order) / 2 : next.order - 1;
      if (prev && next.order - prev.order < 1e-9) {
        // gap exhausted by repeated inserts: renumber the column
        col.splice(idx, 0, task);
        col.forEach((t, i) => {
          t.order = i + 1;
          if (t !== task) emit(t);
        });
      }
      return emit(task);
    },

    /** Imported tasks are only hidden (re-import keeps them hidden); local tasks are deleted. */
    remove(id) {
      const task = get(id);
      if (task.source) {
        task.hidden = true;
        emit(task);
        return;
      }
      db.tasks = db.tasks.filter((t) => t.id !== id);
      for (const t of db.tasks) {
        if (t.deps.includes(id) || t.parentId === id) {
          t.deps = t.deps.filter((d) => d !== id);
          if (t.parentId === id) t.parentId = null;
          emit(t);
        }
      }
      store.save();
      bus.send({ t: 'task.del', id });
    },
  };
}
