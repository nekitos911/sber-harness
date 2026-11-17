/**
 * ============================================================================================
 *  INTEGRATION SEAM: branch -> pull request in the code host (sourcecontrol)
 * ============================================================================================
 *
 *  Contract:
 *    createPullRequest({ config, mcp, cwd, branch, base, title, body, repo, project, repository })
 *      -> Promise<{ url: string, existing: boolean }>
 *      branch   current branch of cwd (already pushed by the user via "Push"); base: target branch
 *      project, repository: last two path segments of `git remote get-url origin` (git.remoteInfo); repo = "project/repository"
 *    Throws status 501 when integrations.pr.enabled is not true, 400 when title/body exceed integrations.pr.limits.
 *    prStatus({ config, mcp, branch, project, repository, repo }) -> { pr: { index, title, state, url, mergeable,
 *      reviewers: [{ status }], base, updatedAt } | null }   observe-only, via listTool: OPEN first, else the newest
 *      MERGED/DECLINED pull request whose head is `branch` (501 when disabled or no listTool).
 *    refreshTaskPr({ config, mcp, tasks, task, cwd }) -> boolean   keeps task.pr = { index, state, url, updatedAt } | null.
 *
 *  Default implementation is config-driven (harness.config.json, override in harness.config.local.json):
 *    "integrations": { "pr": {
 *      "enabled": true, "server": "sourcecontrol", "tool": "git_create_pull_request",
 *      "args": { "project": "{project}", "repository": "{repository}", "head": "{branch}", "base": "{base}", "title": "{title}", "body": "{body}" },
 *      "urlPath": "html_url",                    the human link (sourcecontrol's `url` is an internal API endpoint)
 *      "listTool": "git_list_pull_requests",     optional: an OPEN PR with the same head+base is returned instead of
 *      "listArgs": { ... }, "listItemsPath": "pulls",   creating a second one (sourcecontrol auto-closes the first)
 *      "limits": { "titleBytes": 100, "bodyBytes": 512 }   UTF-8 byte limits of the code host (never truncated here)
 *    } }
 *  `args` is a template: a string that is exactly "{var}" is replaced by the value (type kept), other strings get
 *  "{var}" substituted; nested objects/arrays are processed recursively.
 *  Vars: repo project repository branch head base title body cwd.
 * ============================================================================================
 */
import { toolResultValue } from '../mcp-client.js';
import { remoteInfo } from '../git.js';
import { getPath } from './tasks.js';
import { jobStep } from '../jobs.js';

export function fillTemplate(tpl, vars) {
  if (typeof tpl === 'string') {
    const whole = tpl.match(/^\{(\w+)\}$/);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
  }
  if (Array.isArray(tpl)) return tpl.map((v) => fillTemplate(v, vars));
  if (tpl && typeof tpl === 'object') return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, fillTemplate(v, vars)]));
  return tpl;
}

const LIST_ARGS = { project: '{project}', repository: '{repository}', state: 'OPEN', page: 1, limit: 100 };

export async function createPullRequest({ config, mcp, cwd, branch, base, title, body = '', repo, project = null, repository = null }) {
  const cfg = config.integrations?.pr;
  if (!cfg?.enabled) throw Object.assign(new Error('создание PR выключено (integrations.pr.enabled)'), { status: 501 });
  const { titleBytes, bodyBytes } = cfg.limits || {};
  const tb = Buffer.byteLength(title || '');
  const bb = Buffer.byteLength(body || '');
  if ((titleBytes && tb > titleBytes) || (bodyBytes && bb > bodyBytes)) {
    throw Object.assign(new Error(
      `Слишком длинный текст для сервиса PR: заголовок ${tb}/${titleBytes ?? '∞'} байт, описание ${bb}/${bodyBytes ?? '∞'} байт `
      + '(считаются байты UTF-8, кириллица занимает 2 байта на символ). Сократите текст и повторите.',
    ), { status: 400 });
  }
  const vars = { repo, project, repository, branch, head: branch, base: base || config.git?.defaultBase || 'main', title, body, cwd };

  if (cfg.listTool) {
    jobStep('Поиск существующего PR');
    const listed = toolResultValue(await mcp.callTool(cfg.server, cfg.listTool, fillTemplate(cfg.listArgs || LIST_ARGS, vars)));
    const pulls = getPath(listed, cfg.listItemsPath ?? 'pulls');
    const same = Array.isArray(pulls) && pulls.find((p) => p?.head?.name === branch && p?.base?.name === vars.base);
    const url = same && getPath(same, cfg.urlPath ?? 'url');
    if (url) return { url, existing: true };
  }

  jobStep('Создание PR');
  const value = toolResultValue(await mcp.callTool(cfg.server, cfg.tool, fillTemplate(cfg.args || {}, vars)));
  const url = getPath(value, cfg.urlPath ?? 'url');
  if (typeof url !== 'string' || !url) {
    throw Object.assign(new Error(`integrations.pr.urlPath «${cfg.urlPath}» не найден в ответе инструмента: ${JSON.stringify(value).slice(0, 300)}`), { status: 502 });
  }
  return { url, existing: false };
}

const disabled = (what) => Object.assign(new Error(what), { status: 501 });

/** sourcecontrol pull request -> the harness shape (state lower-case, html_url as url, base name, epoch ms). */
function mapPull(p, cfg) {
  return {
    index: p.index ?? null,
    title: p.title ?? '',
    state: String(p.state ?? '').toLowerCase(),
    url: getPath(p, cfg.urlPath ?? 'html_url') ?? null,
    mergeable: typeof p.mergeable === 'boolean' ? p.mergeable : null,
    reviewers: Array.isArray(p.reviewers) ? p.reviewers.map((r) => ({ status: r?.status ?? null })) : [],
    base: p.base?.name ?? null,
    updatedAt: Date.parse(p.updated_at) || null,
  };
}

export async function prStatus({ config, mcp, branch, project = null, repository = null, repo = null }) {
  const cfg = config.integrations?.pr;
  if (!cfg?.enabled) throw disabled('интеграция PR выключена (integrations.pr.enabled)');
  if (!cfg.listTool) throw disabled('не настроен integrations.pr.listTool');
  const args = fillTemplate(cfg.listArgs || LIST_ARGS, { repo, project, repository, branch, head: branch });
  const list = async (state) => {
    const pulls = getPath(toolResultValue(await mcp.callTool(cfg.server, cfg.listTool, { ...args, state })), cfg.listItemsPath ?? 'pulls');
    return Array.isArray(pulls) ? pulls.filter((p) => p?.head?.name === branch) : [];
  };
  const open = await list('OPEN');
  if (open.length) return { pr: mapPull(open[0], cfg) };
  const closed = [...(await list('MERGED')), ...(await list('DECLINED'))]
    .sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
  return { pr: closed.length ? mapPull(closed[0], cfg) : null };
}

/** Refreshes task.pr from the code host; true when it changed (only then the task is saved and broadcast). */
export async function refreshTaskPr({ config, mcp, tasks, task, cwd }) {
  const { pr } = await prStatus({ config, mcp, branch: task.branch, ...(await remoteInfo(cwd)) });
  const next = pr && { index: pr.index, state: pr.state, url: pr.url, updatedAt: pr.updatedAt };
  if (JSON.stringify(next ?? null) === JSON.stringify(task.pr ?? null)) return false;
  tasks.update(task.id, { pr: next ?? null }, 'harness');
  return true;
}

const DECLINE_ARGS = { project: '{project}', repository: '{repository}', pullRequestIndex: '{index}' };

/** Declines (closes without merging) pull request `index` of the repository at cwd: integrations.pr.declineTool. */
export async function declinePullRequest({ config, mcp, cwd, index }) {
  const cfg = config.integrations?.pr;
  if (!cfg?.enabled) throw Object.assign(new Error('интеграция PR выключена (integrations.pr.enabled)'), { status: 501 });
  if (!Number.isInteger(index) || index <= 0) throw Object.assign(new Error('index: нужно целое положительное число'), { status: 400 });
  const { project, repository } = await remoteInfo(cwd);
  if (!project || !repository) throw Object.assign(new Error(`не удалось определить проект/репозиторий по origin в ${cwd}`), { status: 400 });
  jobStep('Отклонение PR');
  const value = toolResultValue(await mcp.callTool(cfg.server, cfg.declineTool || 'git_decline_pull_request', fillTemplate(cfg.declineArgs || DECLINE_ARGS, { project, repository, index })));
  return { ok: true, index, result: typeof value === 'string' ? value : JSON.stringify(value) };
}
