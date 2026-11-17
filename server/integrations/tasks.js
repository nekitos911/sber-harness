/**
 * ============================================================================================
 *  INTEGRATION SEAM: external task tracker (e.g. onework) -> board tasks
 * ============================================================================================
 *
 *  Contract:
 *    importTasks({ config, mcp, tasks }) -> Promise<{ imported: number, updated: number }>
 *      config  full harness config; this function reads config.integrations.tasks
 *      mcp     MCP manager from server/mcp-client.js: mcp.callTool(server, tool, args) -> raw MCP result
 *      tasks   task store from server/tasks.js: all(), create(fields, by), update(id, fields, by)
 *    Throws an Error with status 501 when integrations.tasks.enabled is not true.
 *    Dedupe key: source (= integrations.tasks.source || server) + externalId. Existing tasks get
 *    title/description/status/externalUrl/priority updated; nothing is ever deleted.
 *
 *  Default implementation is config-driven (harness.config.local.json):
 *    "integrations": { "tasks": {
 *      "enabled": true, "server": "<mcpServers key>", "tool": "<tool name>", "args": { ... },
 *      "itemsPath": "issues",                 dot-path to the array inside the tool result ("" = result itself)
 *      "map": { "externalId": "key", "title": "summary", "description": "description",
 *               "externalUrl": "url", "status": "status", "priority": "priority" },   field -> dot-path in an item
 *      "statusMap": { "Open": "todo", "In Progress": "in_progress", ... },            unknown -> "todo"
 *      "priorityMap": { "Critical": "high", ... }  optional; default: low/medium/high by name
 *    } }
 *  The tool result value is structuredContent, else JSON of the first text content (toolResultValue).
 *
 *  Switching to the real tracker usually needs config only: add the server to `mcpServers`, find the tool
 *  with `node scripts/mcp-call.js <server> --list`, look at a raw response, then fill the block above.
 *  Edit THIS function instead when one call is not enough: pagination, several tools, a non-JSON response,
 *  or creating subtasks per repository (create with { parentId, workspaceId }).
 * ============================================================================================
 */
import { toolResultValue } from '../mcp-client.js';
import { STATUSES, PRIORITIES } from '../tasks.js';

export const getPath = (obj, p) => (!p ? obj : String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));

const asStr = (v) => (v == null ? null : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));

export async function importTasks({ config, mcp, tasks }) {
  const cfg = config.integrations?.tasks;
  if (!cfg?.enabled) throw Object.assign(new Error('Task import is disabled (integrations.tasks.enabled)'), { status: 501 });
  const source = cfg.source || cfg.server;
  const value = toolResultValue(await mcp.callTool(cfg.server, cfg.tool, cfg.args || {}));
  const items = getPath(value, cfg.itemsPath);
  if (!Array.isArray(items)) throw Object.assign(new Error(`integrations.tasks.itemsPath "${cfg.itemsPath}" is not an array in the tool result`), { status: 502 });

  const map = { externalId: 'key', title: 'summary', description: 'description', externalUrl: 'url', status: 'status', priority: 'priority', ...cfg.map };
  let imported = 0;
  let updated = 0;
  for (const item of items) {
    const externalId = asStr(getPath(item, map.externalId));
    if (!externalId) continue;
    const rawStatus = asStr(getPath(item, map.status));
    const rawPriority = asStr(getPath(item, map.priority));
    const priority = cfg.priorityMap?.[rawPriority] ?? rawPriority?.toLowerCase();
    const fields = {
      title: asStr(getPath(item, map.title))?.trim() || externalId,
      description: asStr(getPath(item, map.description)) || '',
      externalUrl: asStr(getPath(item, map.externalUrl)),
      status: STATUSES.includes(cfg.statusMap?.[rawStatus]) ? cfg.statusMap[rawStatus] : 'todo',
      priority: PRIORITIES.includes(priority) ? priority : null,
    };
    const existing = tasks.all().find((t) => t.source === source && t.externalId === externalId);
    if (existing) {
      tasks.update(existing.id, fields, 'harness');
      updated++;
    } else {
      tasks.create({ ...fields, externalId, source }, 'harness');
      imported++;
    }
  }
  return { imported, updated };
}
