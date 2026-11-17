/**
 * ============================================================================================
 *  INTEGRATION SEAM: external task tracker (onework / sbertrack) <-> board tasks
 * ============================================================================================
 *
 *  Contract:
 *    importTasks({ config, mcp, tasks }) -> Promise<{ imported: number, updated: number }>
 *      config  full harness config; reads config.integrations.tasks
 *      mcp     MCP manager (server/mcp-client.js): mcp.callTool(server, tool, args) -> raw MCP result
 *      tasks   task store (server/tasks.js): all(), create(fields, by), update(id, fields, by)
 *    transitionTask({ config, mcp, tasks, task, status, comment }) -> Promise<Task>
 *      changes the status IN THE TRACKER (explicit user action); moving a card never does that.
 *    Both throw an Error with status 501 when not enabled/configured.
 *
 *  Board semantics (docs/ARCHITECTURE.md "Board <-> tracker semantics"):
 *    - dedupe key: source (= integrations.tasks.source || server) + externalId; nothing is ever deleted
 *    - new items whose raw status is in closedStatuses are not added (existing tasks are still updated)
 *    - status column = statusMap[externalStatus] unless the user moved the card (task.statusManual)
 *    - hidden tasks stay hidden; only tasks whose fields changed are updated (and broadcast)
 *
 *  Default implementation is config-driven (harness.config.local.json):
 *    "integrations": { "tasks": {
 *      "enabled": true, "server": "onework",
 *      "tools": { "find": "<list tool>", "transition": "<status tool>", ... },   tool names are config data
 *      "args": { ... }, "limit": 30,            limit goes into the find tool args
 *      "itemsPath": "issues",                   dot-path to the array in the find result ("" = result itself)
 *      "map": { "externalId": "key", "title": "summary", "description": "description",
 *               "externalUrl": "url", "status": "status", "priority": "priority" },   field -> dot-path in an item
 *      "statusMap": { "Open": "todo", ... }, "closedStatuses": ["Closed", ...],
 *      "priorityMap": { "Critical": "high" }     optional; default: low/medium/high by name
 *      "transition": { "args": { "key": "{key}", "status": "{status}", "comment": "{comment}" } }
 *    } }
 *  The tool result value is structuredContent, else JSON of the first text content (toolResultValue).
 *
 *  Switching to the real tracker usually needs config only: find the tools with
 *  `node scripts/mcp-call.js onework --list`, look at a raw response, fill the block above.
 *  Edit THIS file instead when one call is not enough (pagination, a get per item for the description,
 *  links to repositories -> subtasks created with { parentId, workspaceId }).
 * ============================================================================================
 */
import { toolResultValue } from '../mcp-client.js';
import { STATUSES, PRIORITIES } from '../tasks.js';
import { fillTemplate } from './pr.js';

export const getPath = (obj, p) => (!p ? obj : String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));

const asStr = (v) => (v == null ? null : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
const disabled = (what) => Object.assign(new Error(what), { status: 501 });

export async function importTasks({ config, mcp, tasks }) {
  const cfg = config.integrations?.tasks;
  if (!cfg?.enabled) throw disabled('Task import is disabled (integrations.tasks.enabled)');
  const tool = cfg.tools?.find || cfg.tool;
  if (!tool) throw disabled('integrations.tasks.tools.find is not configured');
  const source = cfg.source || cfg.server;
  const args = { ...cfg.args, ...(cfg.limit ? { limit: cfg.limit } : {}) };
  const value = toolResultValue(await mcp.callTool(cfg.server, tool, args));
  const items = getPath(value, cfg.itemsPath);
  if (!Array.isArray(items)) throw Object.assign(new Error(`integrations.tasks.itemsPath "${cfg.itemsPath}" is not an array in the ${tool} result`), { status: 502 });

  const map = { externalId: 'key', title: 'summary', description: 'description', externalUrl: 'url', status: 'status', priority: 'priority', ...cfg.map };
  const closed = new Set(cfg.closedStatuses || []);
  let imported = 0;
  let updated = 0;
  for (const item of items) {
    const externalId = asStr(getPath(item, map.externalId));
    if (!externalId) continue;
    const externalStatus = asStr(getPath(item, map.status));
    const rawPriority = asStr(getPath(item, map.priority));
    const priority = cfg.priorityMap?.[rawPriority] ?? rawPriority?.toLowerCase();
    const mapped = cfg.statusMap?.[externalStatus];
    const fields = {
      title: asStr(getPath(item, map.title))?.trim() || externalId,
      description: asStr(getPath(item, map.description)) || '',
      externalUrl: asStr(getPath(item, map.externalUrl)),
      externalStatus,
      priority: PRIORITIES.includes(priority) ? priority : null,
    };
    const existing = tasks.all().find((t) => t.source === source && t.externalId === externalId);
    if (existing) {
      if (!existing.statusManual && STATUSES.includes(mapped)) fields.status = mapped;
      if (Object.entries(fields).some(([k, v]) => existing[k] !== v)) {
        tasks.update(existing.id, fields, 'harness');
        updated++;
      }
    } else if (!closed.has(externalStatus)) {
      tasks.create({ ...fields, status: STATUSES.includes(mapped) ? mapped : 'todo', externalId, source }, 'harness');
      imported++;
    }
  }
  return { imported, updated };
}

export async function transitionTask({ config, mcp, tasks, task, status, comment = '' }) {
  const cfg = config.integrations?.tasks;
  const tool = cfg?.tools?.transition;
  if (!cfg?.enabled || !tool || !cfg.transition) throw disabled('Tracker status change is not configured (integrations.tasks.transition, tools.transition)');
  if (!task.externalId) throw Object.assign(new Error(`task ${task.id} is not from the tracker`), { status: 400 });
  const args = fillTemplate(cfg.transition.args || { key: '{key}', status: '{status}' }, { key: task.externalId, id: task.id, status, comment });
  await mcp.callTool(cfg.server, tool, args);
  const mapped = cfg.statusMap?.[status];
  return tasks.update(task.id, {
    externalStatus: status,
    ...(!task.statusManual && STATUSES.includes(mapped) ? { status: mapped } : {}),
    comment: `tracker status -> ${status}${comment ? `: ${comment}` : ''}`,
  }, 'user');
}
