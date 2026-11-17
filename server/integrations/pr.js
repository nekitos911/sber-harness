/**
 * ============================================================================================
 *  INTEGRATION SEAM: branch -> pull request in the code host (e.g. sourcecontrol)
 * ============================================================================================
 *
 *  Contract:
 *    createPullRequest({ config, mcp, cwd, branch, base, title, body, repo }) -> Promise<{ url: string }>
 *      cwd     worktree the PR is created from (already pushed by the user via "Push")
 *      branch  current branch of cwd; base: target branch (git.defaultBase when the UI sends none)
 *      repo    "owner/name" from `git remote get-url origin` (else the folder name), see git.repoName()
 *    Throws an Error with status 501 when integrations.pr.enabled is not true.
 *
 *  Default implementation is config-driven (harness.config.local.json):
 *    "integrations": { "pr": {
 *      "enabled": true, "server": "<mcpServers key>", "tool": "<tool name>",
 *      "args": { "repo": "{repo}", "source": "{branch}", "target": "{base}", "title": "{title}", "description": "{body}" },
 *      "urlPath": "url"        dot-path to the PR link inside the tool result
 *    } }
 *  `args` is a template: a string that is exactly "{var}" is replaced by the value (type kept), other strings get
 *  "{var}" substituted; nested objects/arrays are processed recursively. Vars: repo branch base title body cwd.
 *
 *  Switching to the real PR service usually needs config only. Edit THIS function instead when the service needs
 *  ids that are not in the vars (project key, numeric repo id: look them up with another tool call here), or
 *  when the response has no direct link (build it from the returned id).
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

export async function createPullRequest({ config, mcp, cwd, branch, base, title, body, repo }) {
  const cfg = config.integrations?.pr;
  if (!cfg?.enabled) throw Object.assign(new Error('PR creation is disabled (integrations.pr.enabled)'), { status: 501 });
  const vars = { repo, branch, base: base || config.git?.defaultBase || 'main', title, body, cwd };
  const value = toolResultValue(await mcp.callTool(cfg.server, cfg.tool, fillTemplate(cfg.args || {}, vars)));
  const url = getPath(value, cfg.urlPath ?? 'url');
  if (typeof url !== 'string' || !url) {
    throw Object.assign(new Error(`integrations.pr.urlPath "${cfg.urlPath}" not found in the tool result: ${JSON.stringify(value).slice(0, 300)}`), { status: 502 });
  }
  return { url };
}
