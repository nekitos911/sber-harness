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

export const getPath = (obj, p) => (!p ? obj : String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));

const MAX_PAGES = 20;
export const ONEWORK_STATUS_MAP = {
  todo: 'todo', development: 'in_progress', to_code_review: 'review', code_review: 'review', qa: 'review',
  ready_for_ift: 'review', ift: 'review', ready_for_uat: 'review', done: 'done',
};
export const ONEWORK_PRIORITY_MAP = { low: 'low', mid: 'medium', medium: 'medium', high: 'high' };

const asStr = (v) => (v == null ? null : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
const disabled = (what) => Object.assign(new Error(what), { status: 501 });
const markdown = (cfg) => cfg.format === 'onework-markdown';

function settings(config) {
  const cfg = config.integrations?.tasks;
  if (!cfg?.enabled) throw disabled('Task tracker integration is disabled (integrations.tasks.enabled)');
  return cfg;
}

// ---- markdown parsing (onework) ----

/** Tool errors come back as text; raise them with the inner message. */
export function checkToolError(text) {
  if (!/reported tool error/i.test(text) && !/^\s*[[{][\s\S]*"error"\s*:\s*"/.test(text)) return;
  const inner = text.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  let message = text.slice(0, 300);
  try { if (inner) message = JSON.parse(`"${inner}"`); } catch {}
  throw Object.assign(new Error(`tracker: ${message}`), { status: 502 });
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
    const m = line.match(/^\s*-\s+`([^`]+)`\s*(?:→|->)\s*(.*?)\s*(?:\(`[^`]+`\))?\s*$/);
    if (m) transitions.push({ id: m[1], label: m[2] || m[1] });
  }
  return { current: cur ? cur[2] || cur[1] : null, transitions };
}

async function callText(mcp, cfg, tool, args) {
  const value = toolResultValue(await mcp.callTool(cfg.server, tool, args));
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  checkToolError(text);
  return text;
}

const toolOf = (cfg, name) => cfg.tools?.[name] || (name === 'find' ? cfg.tool : null) || (() => { throw disabled(`integrations.tasks.tools.${name} is not configured`); })();

// ---- import ----

function upsert(tasks, cfg, source, externalId, fields, existingOnlyIfClosed, createExtra = {}) {
  const statusMap = cfg.statusMap || (markdown(cfg) ? ONEWORK_STATUS_MAP : {});
  const mapped = statusMap[fields.externalStatus];
  const existing = tasks.all().find((t) => t.source === source && t.externalId === externalId);
  if (existing) {
    const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (!existing.statusManual && STATUSES.includes(mapped)) patch.status = mapped;
    if (!Object.entries(patch).some(([k, v]) => existing[k] !== v)) return null;
    tasks.update(existing.id, patch, 'harness');
    return 'updated';
  }
  if (existingOnlyIfClosed) return null;
  tasks.create({ ...fields, ...createExtra, status: STATUSES.includes(mapped) ? mapped : 'todo', externalId, source }, 'harness');
  return 'imported';
}

export async function importTasks({ config, mcp, tasks }) {
  const cfg = settings(config);
  const source = cfg.source || cfg.server;
  const closed = new Set((cfg.closedStatuses || []).map((x) => String(x).toLowerCase()));
  const counts = { imported: 0, updated: 0 };
  const count = (r) => { if (r) counts[r]++; };

  if (markdown(cfg)) {
    if (!cfg.space) throw Object.assign(new Error('integrations.tasks.space (tracker space code) is not set'), { status: 400 });
    const find = toolOf(cfg, 'find');
    const limit = cfg.limit > 0 ? cfg.limit : Infinity;
    const found = new Map();
    for (let page = 0; page < MAX_PAGES && found.size < limit; page++) {
      const { items, hasNext } = parseFindIssues(await callText(mcp, cfg, find, { ...cfg.args, space_code: cfg.space, assignee: 'me', page_size: 100, page_number: page }));
      for (const it of items) if (!found.has(it.key)) found.set(it.key, it);
      if (!hasNext || !items.length) break;
    }
    const priorities = cfg.priorityMap || ONEWORK_PRIORITY_MAP;
    for (const it of [...found.values()].slice(0, Number.isFinite(limit) ? limit : undefined)) {
      const fields = {
        title: it.summary || it.key,
        externalStatus: it.status,
        priority: priorities[it.priority?.toLowerCase()] ?? null,
        externalUrl: cfg.urlTemplate ? fillTemplate(cfg.urlTemplate, { key: it.key }) : null,
      };
      count(upsert(tasks, cfg, source, it.key, fields, closed.has(it.status.toLowerCase())));
    }
    return counts;
  }

  const tool = toolOf(cfg, 'find');
  const args = { ...cfg.args, ...(cfg.limit ? { limit: cfg.limit } : {}) };
  const value = toolResultValue(await mcp.callTool(cfg.server, tool, args));
  const items = getPath(value, cfg.itemsPath);
  if (!Array.isArray(items)) throw Object.assign(new Error(`integrations.tasks.itemsPath "${cfg.itemsPath}" is not an array in the ${tool} result`), { status: 502 });
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
    count(upsert(tasks, cfg, source, externalId, fields, closed.has(String(externalStatus).toLowerCase())));
  }
  return counts;
}

// ---- issue details and status changes ----

function trackerKey(task) {
  if (!task.externalId) throw Object.assign(new Error(`task ${task.id} is not from the tracker`), { status: 400 });
  return task.externalId;
}

async function fetchLinks(mcp, cfg, key) {
  if (!cfg.tools?.links) return [];
  const seen = new Map();
  for (let page = 0; page < 5; page++) {
    const { links, hasNext } = parseLinks(await callText(mcp, cfg, cfg.tools.links, { key, page_size: 100, page_number: page }));
    for (const l of links) seen.set(`${l.type} ${l.from} ${l.to}`, l);
    if (!hasNext || !links.length) break;
  }
  return [...seen.values()];
}

export async function getExternal({ config, mcp, tasks, task }) {
  const cfg = settings(config);
  if (!markdown(cfg)) throw disabled('Issue details are only available for the onework-markdown tracker');
  const key = trackerKey(task);
  const issue = parseIssue(await callText(mcp, cfg, toolOf(cfg, 'get'), { key }));
  if (!task.description && issue.description) tasks.update(task.id, { description: issue.description }, 'harness');
  return { ...issue, links: await fetchLinks(mcp, cfg, key) };
}

/** Children of a tracker task (decomposition links from it) as subtasks: same workspace and targets, deduped by key. */
export async function importChildren({ config, mcp, tasks, task }) {
  const cfg = settings(config);
  if (!markdown(cfg)) throw disabled('Importing children is only available for the onework-markdown tracker');
  const key = trackerKey(task);
  if (!cfg.tools?.links) throw disabled('integrations.tasks.tools.links is not configured');
  const children = [...new Set((await fetchLinks(mcp, cfg, key)).filter((l) => l.type === 'decomposition' && l.from === key).map((l) => l.to))];
  const source = task.source || cfg.source || cfg.server;
  const priorities = cfg.priorityMap || ONEWORK_PRIORITY_MAP;
  const counts = { imported: 0, updated: 0 };
  const failed = [];
  for (const child of children) {
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
    const r = upsert(tasks, cfg, source, child, fields, false, { workspaceId: task.workspaceId, targets: [...task.targets] });
    if (r) counts[r]++;
  }
  return failed.length ? { ...counts, failed } : counts;
}

export async function getTransitions({ config, mcp, tasks, task }) {
  const cfg = settings(config);
  if (!markdown(cfg)) throw disabled('Transitions are only available for the onework-markdown tracker');
  const meta = parseIssueMeta(await callText(mcp, cfg, toolOf(cfg, 'meta'), { key: trackerKey(task), include_fields: false, include_transitions: true }));
  if (meta.current && meta.current !== task.externalStatus) {
    const mapped = (cfg.statusMap || ONEWORK_STATUS_MAP)[meta.current];
    tasks.update(task.id, { externalStatus: meta.current, ...(!task.statusManual && STATUSES.includes(mapped) ? { status: mapped } : {}) }, 'harness');
  }
  return meta;
}

export async function transitionTask({ config, mcp, tasks, task, transition, status, comment = '' }) {
  const cfg = settings(config);
  const key = trackerKey(task);
  if (markdown(cfg)) {
    if (!transition) throw Object.assign(new Error('transition is required (an id from GET /api/tasks/:id/transitions)'), { status: 400 });
    await callText(mcp, cfg, toolOf(cfg, 'transition'), { key, transition, ...(comment ? { comment } : {}) });
    tasks.addLog(task.id, 'user', `tracker transition ${transition}${comment ? `: ${comment}` : ''}`);
    await getTransitions({ config, mcp, tasks, task }); // refresh externalStatus from the tracker
    return tasks.get(task.id);
  }
  const tool = cfg.tools?.transition;
  if (!tool || !cfg.transition) throw disabled('Tracker status change is not configured (integrations.tasks.transition, tools.transition)');
  const target = status || transition;
  if (!target) throw Object.assign(new Error('status is required'), { status: 400 });
  await mcp.callTool(cfg.server, tool, fillTemplate(cfg.transition.args || { key: '{key}', status: '{status}' }, { key, id: task.id, status: target, comment }));
  const mapped = cfg.statusMap?.[target];
  return tasks.update(task.id, {
    externalStatus: target,
    ...(!task.statusManual && STATUSES.includes(mapped) ? { status: mapped } : {}),
    comment: `tracker status -> ${target}${comment ? `: ${comment}` : ''}`,
  }, 'user');
}
