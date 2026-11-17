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
import { getPath } from './tasks.js';

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
  if (!cfg?.enabled) throw Object.assign(new Error('PR creation is disabled (integrations.pr.enabled)'), { status: 501 });
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
    const listed = toolResultValue(await mcp.callTool(cfg.server, cfg.listTool, fillTemplate(cfg.listArgs || LIST_ARGS, vars)));
    const pulls = getPath(listed, cfg.listItemsPath ?? 'pulls');
    const same = Array.isArray(pulls) && pulls.find((p) => p?.head?.name === branch && p?.base?.name === vars.base);
    const url = same && getPath(same, cfg.urlPath ?? 'url');
    if (url) return { url, existing: true };
  }

  const value = toolResultValue(await mcp.callTool(cfg.server, cfg.tool, fillTemplate(cfg.args || {}, vars)));
  const url = getPath(value, cfg.urlPath ?? 'url');
  if (typeof url !== 'string' || !url) {
    throw Object.assign(new Error(`integrations.pr.urlPath "${cfg.urlPath}" not found in the tool result: ${JSON.stringify(value).slice(0, 300)}`), { status: 502 });
  }
  return { url, existing: false };
}
