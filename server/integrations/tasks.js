/**
 * ============================================================================================
 *  INTEGRATION SEAM: external task tracker (onework / sbertrack) <-> board tasks
 * ============================================================================================
 *
 *  Contract (all throw an Error with status 501 when not enabled/configured):
 *    importTasks({ config, mcp, tasks }) -> { imported, updated }
 *    getExternal({ config, mcp, tasks, task }) -> { key, title, fields, description, attributes, links }   (lazy details)
 *    importChildren({ config, mcp, tasks, task }) -> { imported, updated, failed? }   decomposition children as subtasks
 *    getTransitions({ config, mcp, tasks, task }) -> { current, transitions: [{ id, label }] }
 *    transitionTask({ config, mcp, tasks, task, transition?, status?, comment? }) -> Task       (explicit user action)
 *    syncColumn({ config, mcp, tasks, task, status }) -> { transition }   board move -> tracker (board.moveSyncsTracker):
 *      board.columnTransitions[status] if available, else the first transition whose TARGET status is in that column's
 *      trackerStatuses; throws (status 409) when none fits
 *      config  full harness config; reads config.integrations.tasks
 *      mcp     MCP manager (server/mcp-client.js): mcp.callTool(server, tool, args) -> raw MCP result
 *      tasks   task store (server/tasks.js): all(), create(fields, by), update(id, fields, by)
 *
 *  Board semantics (docs/ARCHITECTURE.md "Board <-> tracker semantics"): dedupe by source + externalId, nothing is
 *  ever deleted, new closed items are not added, the column follows statusMap(externalStatus) unless the user
 *  moved the card (statusManual), hidden tasks stay hidden, only changed tasks are updated.
 *
 *  Two modes, chosen by integrations.tasks.format:
 *   - "onework-markdown" (default config): the onework MCP tools answer MARKDOWN (docs/GIGACODE-FACTS.md §5).
 *       find: tools.find {space_code: <space>, assignee: "me", page_size: 100, page_number: n} while has_next
 *             lines "N. **<KEY>** — <summary> [<status> | <priority>] @<assignee>" (no description in the list)
 *       get:  tools.get {key} -> "- **Field**: value" list, description, "### Attributes"
 *       meta: tools.meta {key, include_fields: false, include_transitions: true} -> current status + transitions
 *       transition: tools.transition {key, transition, comment?}
       links: tools.links {key, page_size: 100, page_number: n} while has_next (<= 5 pages) -> "<SRC> **<type>** -> <DST>";
             `decomposition` links from this key point at its children
 *       Tool errors arrive as text ("... reported tool error ...", {"error":"..."}) and are raised as errors.
 *       externalUrl = urlTemplate with {key} (empty template -> null).
 *   - "json" (any other value): declarative mapping of a JSON tool result: itemsPath, map, statusMap, closedStatuses,
 *       priorityMap, transition.args template with {key} {status} {comment}.
 *
 *  To switch providers: usually config only (`node scripts/mcp-call.js <server> --list` shows the tools). Edit THIS
 *  file when the provider needs pagination of another kind, several calls per item or subtasks from links.
 * ============================================================================================
 */
import { toolResultValue } from '../mcp-client.js';
import { STATUSES, PRIORITIES } from '../tasks.js';
import { fillTemplate } from './pr.js';
import { jobStep } from '../jobs.js';

export const getPath = (obj, p) => (!p ? obj : String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));

const MAX_PAGES = 20;
export const ONEWORK_STATUS_MAP = {
  todo: 'todo', created: 'todo', new: 'todo', open: 'todo', development: 'in_progress', to_code_review: 'review', code_review: 'review', qa: 'review',
  ready_for_ift: 'review', ift: 'review', ready_for_uat: 'review', done: 'done',
};
export const ONEWORK_PRIORITY_MAP = { low: 'low', mid: 'medium', medium: 'medium', high: 'high' };
/** Tracker statuses that mean «closed» when integrations.tasks.closedStatuses is not set (onework uses `closed`). */
export const DEFAULT_CLOSED_STATUSES = ['done', 'closed', 'cancelled', 'canceled', 'declined', 'resolved', 'rejected'];
const closedSet = (cfg) => new Set((cfg?.closedStatuses ?? DEFAULT_CLOSED_STATUSES).map((x) => String(x).toLowerCase()));

/**
 * A task closed in the tracker: never taken into work (no takenAt, no assignee, no worktrees) → hidden from the board
 * (once, with a log line); taken into work → done (a human-pinned column stays). Never auto-hidden once taken.
 */
function settleClosed(tasks, t) {
  const taken = t.takenAt || t.assigneeSessionId || t.worktrees?.length;
  if (!taken) {
    if (t.hidden) return null;
    tasks.update(t.id, { hidden: true }, 'harness');
    tasks.addLog(t.id, 'harness', 'Закрыта в трекере — скрыта с доски', 'status', { externalStatus: t.externalStatus });
    return 'updated';
  }
  if (t.status === 'done' || t.statusManual) return null;
  tasks.update(t.id, { status: 'done' }, 'harness');
  return 'updated';
}

/** Startup pass: the closed rule applied to tasks imported before it existed. → number changed */
export function settleClosedTasks(config, tasks) {
  const closed = closedSet(config.integrations?.tasks);
  let n = 0;
  for (const t of tasks.all()) {
    if (t.externalId && t.externalStatus && closed.has(String(t.externalStatus).toLowerCase()) && settleClosed(tasks, t)) n++;
  }
  return n;
}

/** Board column of a tracker status: board.columns[].trackerStatuses first, statusMap as the fallback. */
export function statusFor(config, ext) {
  if (ext == null) return null;
  const col = (config.board?.columns || []).find((c) => (c.trackerStatuses || []).includes(ext));
  if (col) return col.status;
  const cfg = config.integrations?.tasks || {};
  return (cfg.statusMap || (markdown(cfg) ? ONEWORK_STATUS_MAP : {}))[ext] ?? null;
}

const asStr = (v) => (v == null ? null : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
const disabled = (what) => Object.assign(new Error(what), { status: 501 });
const markdown = (cfg) => cfg.format === 'onework-markdown';

function settings(config) {
  const cfg = config.integrations?.tasks;
  if (!cfg?.enabled) throw disabled('Интеграция с трекером выключена (integrations.tasks.enabled)');
  return cfg;
}

// ---- markdown parsing (onework) ----

/** Tool errors come back as text; raise them with the inner message. */
export function checkToolError(text) {
  if (!/reported tool error/i.test(text) && !/^\s*[[{][\s\S]*"error"\s*:\s*"/.test(text)) return;
  const inner = text.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  let message = text.slice(0, 300);
  try { if (inner) message = JSON.parse(`"${inner}"`); } catch {}
  throw Object.assign(new Error(`трекер: ${message}`), { status: 502 });
}

export function parseFindIssues(text) {
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\d+\.\s+\*\*([^*]+)\*\*\s+[—–-]\s+(.*?)\s+\[([^|\]]*?)\s*\|\s*([^\]]*?)\]\s*(?:@(\S*))?\s*$/);
    if (m) items.push({ key: m[1].trim(), summary: m[2].trim(), status: m[3].trim(), priority: m[4].trim(), assignee: m[5] ?? null });
  }
  return { items, hasNext: /has_next:\s*true/i.test(text) };
}

const fieldLine = (line) => line.match(/^\s*-\s+\*\*([^*]+)\*\*:\s*(.*)$/);

export function parseIssue(text) {
  const lines = text.split(/\r?\n/);
  const head = lines.find((l) => /^#\s/.test(l))?.match(/^#\s+(\S+)\s+[—–-]\s+(.*)$/);
  const fields = {};
  const attributes = {};
  const desc = [];
  let section = 'top'; // top -> fields -> description -> attributes
  for (const line of lines) {
    if (/^#\s/.test(line) && section === 'top') continue;
    if (/^###\s+Attributes/i.test(line)) {
      section = 'attributes';
      continue;
    }
    const f = fieldLine(line);
    if (section === 'attributes') {
      if (f) attributes[f[1].trim()] = f[2].trim();
    } else if (f && (section === 'top' || section === 'fields')) {
      section = 'fields';
      fields[f[1].trim()] = f[2].trim();
    } else if (section === 'fields' || section === 'description') {
      if (section === 'fields' && !line.trim()) continue;
      section = 'description';
      desc.push(line);
    }
  }
  return { key: head?.[1] ?? null, title: head?.[2]?.trim() ?? null, fields, description: desc.join('\n').trim(), attributes };
}

export function parseLinks(text) {
  const links = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:\d+\.\s+)?(\S+)\s+\*\*([^*]+)\*\*\s*(?:->|→)\s*(\S+)\s*$/);
    if (m) links.push({ type: m[2].trim(), from: m[1], to: m[3] });
  }
  return { links, hasNext: /has_next:\s*true/i.test(text) };
}

export function parseIssueMeta(text) {
  const cur = text.match(/Current Status:\s*(.*?)\s*(?:\(`([^`]+)`\))?\s*$/m);
  const transitions = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+`([^`]+)`\s*(?:→|->)\s*(.*?)\s*(?:\(`([^`]+)`\))?\s*$/);
    if (m) transitions.push({ id: m[1], label: m[2] || m[1], target: m[3] ?? null });
  }
  return { current: cur ? cur[2] || cur[1] : null, transitions };
}

async function callText(mcp, cfg, tool, args) {
  const value = toolResultValue(await mcp.callTool(cfg.server, tool, args));
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  checkToolError(text);
  return text;
}

const toolOf = (cfg, name) => cfg.tools?.[name] || (name === 'find' ? cfg.tool : null) || (() => { throw disabled(`не настроен integrations.tasks.tools.${name}`); })();

// ---- import ----

/** closed (sync only): a new closed issue is not imported; a known one gets the closed rule (settleClosed). */
function upsert(config, tasks, source, externalId, fields, closed, createExtra = {}) {
  const mapped = statusFor(config, fields.externalStatus);
  const existing = tasks.all().find((t) => t.source === source && t.externalId === externalId);
  if (existing) {
    const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (!existing.statusManual && STATUSES.includes(mapped)) patch.status = mapped;
    let changed = null;
    if (Object.entries(patch).some(([k, v]) => existing[k] !== v)) {
      tasks.update(existing.id, patch, 'harness');
      changed = 'updated';
    }
    return (closed && settleClosed(tasks, tasks.find(existing.id))) || changed;
  }
  if (closed) return null;
  tasks.create({ ...fields, ...createExtra, status: STATUSES.includes(mapped) ? mapped : 'todo', externalId, source }, 'harness');
  return 'imported';
}

export async function importTasks({ config, mcp, tasks }) {
  const cfg = settings(config);
  const source = cfg.source || cfg.server;
  const closed = closedSet(cfg);
  const counts = { imported: 0, updated: 0 };
  const count = (r) => { if (r) counts[r]++; };

  if (markdown(cfg)) {
    const spaces = [cfg.space].flat().filter(Boolean); // one space code or several
    if (!spaces.length) throw Object.assign(new Error('не задан integrations.tasks.space (код пространства трекера)'), { status: 400 });
    const find = toolOf(cfg, 'find');
    const limit = cfg.limit > 0 ? cfg.limit : Infinity;
    const found = new Map();
    for (const space of spaces) {
      for (let page = 0; page < MAX_PAGES && found.size < limit; page++) {
        jobStep(`Трекер ${space}: страница ${page + 1}`);
        const { items, hasNext } = parseFindIssues(await callText(mcp, cfg, find, { ...cfg.args, space_code: space, assignee: 'me', page_size: 100, page_number: page }));
        for (const it of items) if (!found.has(it.key)) found.set(it.key, it);
        if (!hasNext || !items.length) break;
      }
    }
    const priorities = cfg.priorityMap || ONEWORK_PRIORITY_MAP;
    for (const it of [...found.values()].slice(0, Number.isFinite(limit) ? limit : undefined)) {
      const fields = {
        title: it.summary || it.key,
        externalStatus: it.status,
        priority: priorities[it.priority?.toLowerCase()] ?? null,
        externalUrl: cfg.urlTemplate ? fillTemplate(cfg.urlTemplate, { key: it.key }) : null,
      };
      count(upsert(config, tasks, source, it.key, fields, closed.has(it.status.toLowerCase())));
    }
    return counts;
  }

  const tool = toolOf(cfg, 'find');
  const args = { ...cfg.args, ...(cfg.limit ? { limit: cfg.limit } : {}) };
  const value = toolResultValue(await mcp.callTool(cfg.server, tool, args));
  const items = getPath(value, cfg.itemsPath);
  if (!Array.isArray(items)) throw Object.assign(new Error(`integrations.tasks.itemsPath «${cfg.itemsPath}» — не массив в ответе ${tool}`), { status: 502 });
  const map = { externalId: 'key', title: 'summary', description: 'description', externalUrl: 'url', status: 'status', priority: 'priority', ...cfg.map };
  for (const item of items) {
    const externalId = asStr(getPath(item, map.externalId));
    if (!externalId) continue;
    const externalStatus = asStr(getPath(item, map.status));
    const rawPriority = asStr(getPath(item, map.priority));
    const priority = cfg.priorityMap?.[rawPriority] ?? rawPriority?.toLowerCase();
    const fields = {
      title: asStr(getPath(item, map.title))?.trim() || externalId,
      description: asStr(getPath(item, map.description)) || '',
      externalUrl: asStr(getPath(item, map.externalUrl)),
      externalStatus,
      priority: PRIORITIES.includes(priority) ? priority : null,
    };
    count(upsert(config, tasks, source, externalId, fields, closed.has(String(externalStatus).toLowerCase())));
  }
  return counts;
}

/**
 * One issue by key or tracker link (even if not assigned to me): getIssue -> upsert as an imported task (deduped by
 * externalId, status via the board columns / statusMap); returns the task.
 */
export async function importIssue({ config, mcp, tasks, ref }) {
  const cfg = settings(config);
  if (!markdown(cfg)) throw disabled('Импорт по ключу доступен только для трекера onework-markdown');
  const text = String(ref ?? '').trim();
  const key = text.match(/([A-Z][A-Z0-9_]+-\d+)/)?.[1];
  if (!key) throw Object.assign(new Error('нужен ключ задачи (PROJ-1234) или ссылка на неё в трекере'), { status: 400 });
  const issue = parseIssue(await callText(mcp, cfg, toolOf(cfg, 'get'), { key }));
  const priorities = cfg.priorityMap || ONEWORK_PRIORITY_MAP;
  const source = cfg.source || cfg.server;
  upsert(config, tasks, source, key, {
    title: issue.title || key,
    description: issue.description,
    externalStatus: issue.fields.Status ?? null,
    priority: priorities[String(issue.fields.Priority ?? '').toLowerCase()] ?? null,
    externalUrl: cfg.urlTemplate ? fillTemplate(cfg.urlTemplate, { key }) : /^https?:\/\//i.test(text) ? text : null,
  }, false);
  return tasks.all().find((t) => t.source === source && t.externalId === key);
}

// ---- issue details and status changes ----

function trackerKey(task) {
  if (!task.externalId) throw Object.assign(new Error(`задача ${task.id} не из трекера`), { status: 400 });
  return task.externalId;
}

async function fetchLinks(mcp, cfg, key) {
  if (!cfg.tools?.links) return [];
  const seen = new Map();
  for (let page = 0; page < 5; page++) {
    const { links, hasNext } = parseLinks(await callText(mcp, cfg, cfg.tools.links, { key, page_size: 100, page_number: page }));
    for (const l of links) {
      // one entry per linked task (decomposition wins: it marks a child); links not about this key or to itself are noise
      if ((l.from !== key && l.to !== key) || l.from === l.to) continue;
      const other = l.from === key ? l.to : l.from;
      const prev = seen.get(other);
      if (!prev || (l.type === 'decomposition' && prev.type !== 'decomposition')) seen.set(other, l);
    }
    if (!hasNext || !links.length) break;
  }
  return [...seen.values()];
}

export async function getExternal({ config, mcp, tasks, task }) {
  const cfg = settings(config);
  if (!markdown(cfg)) throw disabled('Подробности задачи доступны только для трекера onework-markdown');
  const key = trackerKey(task);
  const issue = parseIssue(await callText(mcp, cfg, toolOf(cfg, 'get'), { key }));
  // cached attributes (Component, Repository, ...) also feed the repository auto-fill
  tasks.update(task.id, { ...(!task.description && issue.description ? { description: issue.description } : {}), externalFields: issue.fields }, 'harness');
  return { ...issue, links: await fetchLinks(mcp, cfg, key) };
}

/** Children of a tracker task (decomposition links from it) as subtasks: same workspace and targets, deduped by key. */
export async function importChildren({ config, mcp, tasks, task }) {
  const cfg = settings(config);
  if (!markdown(cfg)) throw disabled('Импорт подзадач доступен только для трекера onework-markdown');
  const key = trackerKey(task);
  if (!cfg.tools?.links) throw disabled('не настроен integrations.tasks.tools.links');
  const children = [...new Set((await fetchLinks(mcp, cfg, key)).filter((l) => l.type === 'decomposition' && l.from === key).map((l) => l.to))];
  const source = task.source || cfg.source || cfg.server;
  const priorities = cfg.priorityMap || ONEWORK_PRIORITY_MAP;
  const counts = { imported: 0, updated: 0 };
  const failed = [];
  for (const [i, child] of children.entries()) {
    jobStep(`Подзадача ${child}`, { done: i, total: children.length });
    let issue;
    try {
      issue = parseIssue(await callText(mcp, cfg, toolOf(cfg, 'get'), { key: child }));
    } catch (e) {
      failed.push({ key: child, error: e.message }); // one missing child must not block the others
      continue;
    }
    const fields = {
      title: issue.title || child,
      description: issue.description,
      externalStatus: issue.fields.Status ?? null,
      priority: priorities[String(issue.fields.Priority ?? '').toLowerCase()] ?? null,
      externalUrl: cfg.urlTemplate ? fillTemplate(cfg.urlTemplate, { key: child }) : null,
      parentId: task.id,
    };
    const r = upsert(config, tasks, source, child, fields, false, { workspaceId: task.workspaceId, targets: [...task.targets] });
    if (r) counts[r]++;
  }
  return failed.length ? { ...counts, failed } : counts;
}

export async function getTransitions({ config, mcp, tasks, task }) {
  const cfg = settings(config);
  if (!markdown(cfg)) throw disabled('Переходы доступны только для трекера onework-markdown');
  const meta = parseIssueMeta(await callText(mcp, cfg, toolOf(cfg, 'meta'), { key: trackerKey(task), include_fields: false, include_transitions: true }));
  if (meta.current && meta.current !== task.externalStatus) {
    const mapped = statusFor(config, meta.current);
    tasks.update(task.id, { externalStatus: meta.current, ...(!task.statusManual && STATUSES.includes(mapped) ? { status: mapped } : {}) }, 'harness');
  }
  return meta;
}

export async function transitionTask({ config, mcp, tasks, task, transition, status, comment = '' }) {
  const cfg = settings(config);
  const key = trackerKey(task);
  if (markdown(cfg)) {
    if (!transition) throw Object.assign(new Error('нужен переход (id из GET /api/tasks/:id/transitions)'), { status: 400 });
    await callText(mcp, cfg, toolOf(cfg, 'transition'), { key, transition, ...(comment ? { comment } : {}) });
    tasks.addLog(task.id, 'user', `Статус в трекере: ${status || transition}${comment ? ` (${comment})` : ''}`, 'tracker_transition', { transition, status: status ?? null });
    await getTransitions({ config, mcp, tasks, task }); // refresh externalStatus from the tracker
    return tasks.get(task.id);
  }
  const tool = cfg.tools?.transition;
  if (!tool || !cfg.transition) throw disabled('Смена статуса в трекере не настроена (integrations.tasks.transition, tools.transition)');
  const target = status || transition;
  if (!target) throw Object.assign(new Error('нужен статус'), { status: 400 });
  await mcp.callTool(cfg.server, tool, fillTemplate(cfg.transition.args || { key: '{key}', status: '{status}' }, { key, id: task.id, status: target, comment }));
  const mapped = statusFor(config, target);
  return tasks.update(task.id, {
    externalStatus: target,
    ...(!task.statusManual && STATUSES.includes(mapped) ? { status: mapped } : {}),
    comment: `tracker status -> ${target}${comment ? `: ${comment}` : ''}`,
  }, 'user');
}

/** Board move -> tracker transition (opt-in board.moveSyncsTracker). Throws with the reason when nothing fits. */
export async function syncColumn({ config, mcp, tasks, task, status }) {
  const column = (config.board?.columns || []).find((c) => c.status === status);
  const meta = await getTransitions({ config, mcp, tasks, task });
  const explicit = config.board?.columnTransitions?.[status];
  const pick = (explicit && meta.transitions.find((t) => t.id === explicit))
    || meta.transitions.find((t) => t.target && (column?.trackerStatuses || []).includes(t.target));
  if (!pick) {
    throw Object.assign(new Error(`ни один переход трекера из «${meta.current}» не ведёт в колонку «${column?.label ?? status}» (доступны: ${meta.transitions.map((t) => `${t.id}→${t.target ?? '?'}`).join(', ') || 'none'})`), { status: 409 });
  }
  await transitionTask({ config, mcp, tasks, task: tasks.get(task.id), transition: pick.id, status: pick.target, comment: '' });
  return { transition: pick.id };
}
