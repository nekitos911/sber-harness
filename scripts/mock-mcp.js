#!/usr/bin/env node
// Fake MCP server (stdio) standing in for the task tracker and the PR service in tests and demos.
// Tools: list_issues -> { issues: [...] } (4 samples, one Closed), update_issue_status -> { ok, key, status },
//        create_pull_request -> { url: "http://pr.local/<repo>/<n>" }.
// MOCK_MCP_ISSUES (JSON file path) replaces the sample issues, so tests can change the tracker between syncs.
// Fixture mode: `mock-mcp.js --fixtures <dir> --server <name>` serves <dir>/<name>.<tool>.json as the result of <tool>;
// <name>.<tool>.<variant>.json wins when variant = args.page_number or args.key. A file with `content` is returned
// as the MCP result as is (e.g. onework markdown), anything else is wrapped as JSON text + structuredContent.
// Without a <variant> file an issue tool asked about another key answers for THAT key: getIssue/getIssueMeta/listLinks
// take the fixture's key over, title and status from the findIssues fixtures (links deduped, no self-links).
// Pull requests: list_pull_requests returns the fixture PRs of the asked head plus the PRs create_pull_request made
// (kept in --state <file>, in memory without it); no PR is invented for other branches.
// MOCK_MCP_LOG (file path): every tools/call is appended as { tool, args } (tests assert the arguments).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const fixtures = opt('--fixtures');
const serverName = opt('--server');
const stateFile = opt('--state');
let memState = { pulls: [] };
const loadState = () => { try { return stateFile ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : memState; } catch { return { pulls: [] }; } };
const saveState = (st) => { if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(st, null, 1)); else memState = st; };
const KEY_RE = /\b[A-Z][A-Z0-9_]*-\d+\b/;

/** key -> { title, status } from every findIssues fixture ("1. **KEY** — Title [status | prio]"). */
function knownIssues() {
  const out = new Map();
  for (const n of fs.readdirSync(fixtures).filter((x) => x.includes('findIssues') && x.endsWith('.json'))) {
    const text = (JSON.parse(fs.readFileSync(path.join(fixtures, n), 'utf8')).content || []).map((c) => c.text || '').join('\n');
    for (const m of text.matchAll(/\*\*([A-Z][A-Z0-9_]*-\d+)\*\* — (.+?) \[([^|\]]+?)\s*(?:\||\])/g)) out.set(m[1], { title: m[2].trim(), status: m[3].trim() });
  }
  return out;
}

/** The generic fixture of an issue tool, rewritten for the asked key. */
function forKey(name, value, key) {
  if (!Array.isArray(value?.content)) return value;
  const known = knownIssues().get(key);
  const content = value.content.map((c) => {
    if (typeof c.text !== 'string') return c;
    let text = c.text;
    const base = text.match(KEY_RE)?.[0];
    if (base && base !== key) text = text.split(base).join(key);
    if (/getIssueMeta/.test(name) && known) text = text.replace(/^## Current Status: .*$/m, `## Current Status: ${known.status} (\`${known.status}\`)`);
    if (/getIssue$/.test(name) && known) {
      text = text.replace(/^# .+$/m, `# ${key} — ${known.title}`).replace(/^- \*\*Status\*\*: .*$/m, `- **Status**: ${known.status}`);
    }
    if (/listLinks/.test(name)) {
      const seen = new Set();
      text = text.split('\n').filter((l) => {
        const m = l.match(/^\d+\. (\S+) \*\*(.+?)\*\* -> (\S+)/);
        if (!m) return true;
        const sig = `${m[1]} ${m[2]} ${m[3]}`;
        if (m[1] === m[3] || seen.has(sig)) return false;
        seen.add(sig);
        return true;
      }).join('\n');
    }
    return { ...c, text };
  });
  return { ...value, content };
}

function pullRequests(name, value, args) {
  const st = loadState();
  if (/create_pull_request/.test(name)) {
    const head = args.head ?? args.source ?? args.source_branch;
    const open = st.pulls.find((p) => p.head?.name === head && p.state === 'open' && (!args.base || p.base?.name === args.base));
    if (open) return open;
    let index = Number(value.index) || 700; // the first one is the fixture's own number
    while (st.pulls.some((p) => p.index === index)) index++;
    const where = args.project && args.repository ? `${args.project}/${args.repository}` : null;
    const url = String(value.html_url || '').replace(/\/pulls\/\d+$/, `/pulls/${index}`);
    const pr = {
      ...value, index, title: args.title ?? value.title, body: args.body ?? '', state: 'open',
      head: { ...value.head, name: head }, base: { ...value.base, name: args.base ?? args.target ?? value.base?.name },
      html_url: where ? url.replace(/\/[^/]+\/[^/]+\/pulls\//, `/${where}/pulls/`) : url, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    saveState({ ...st, pulls: [...st.pulls, pr] });
    return pr;
  }
  if (/decline_pull_request/.test(name)) {
    const pr = st.pulls.find((p) => p.index === Number(args.index ?? args.pull_index ?? args.id));
    if (pr) {
      pr.state = 'declined';
      saveState(st);
    }
    return value;
  }
  if (!Array.isArray(value?.pulls)) return value;
  const repoOf = (p) => !args.project || !args.repository || !p.html_url || String(p.html_url).includes(`/${args.project}/${args.repository}/pulls/`);
  const want = (p) => repoOf(p) && (!args.head || p.head?.name === args.head) && (!args.state || String(p.state).toLowerCase() === String(args.state).toLowerCase());
  const fixtureOnes = value.pulls.filter((p) => repoOf(p) && (!args.head || p.head?.name === args.head));
  return { ...value, pulls: [...fixtureOnes, ...st.pulls.filter(want)] };
}

function fixtureTools() {
  const prefix = `${serverName}.`;
  const names = fs.readdirSync(fixtures).filter((n) => n.startsWith(prefix) && n.endsWith('.json')).map((n) => n.slice(prefix.length, -5).split('.')[0]);
  return [...new Set(names)].map((name) => ({ name, description: `fixture ${name}`, inputSchema: { type: 'object' } }));
}

function fixtureCall(name, args = {}) {
  const variant = args.page_number ?? args.key ?? args.state;
  const spaced = args.space_code != null && variant != null && `${serverName}.${name}.${args.space_code}.${variant}.json`; // several spaces
  const file = [spaced, variant != null && `${serverName}.${name}.${variant}.json`, `${serverName}.${name}.json`]
    .filter(Boolean).map((n) => path.join(fixtures, n)).find((p) => fs.existsSync(p));
  if (!file) throw new Error(`no fixture for ${name}`);
  let value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const generic = path.basename(file) === `${serverName}.${name}.json`;
  if (generic && args.key) value = forKey(name, value, String(args.key));
  value = pullRequests(name, value, args);
  return value && Array.isArray(value.content) ? { isError: false, ...value } : { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

const ISSUES = [
  { key: 'DEMO-1', summary: 'Add health endpoint', description: 'Expose GET /health returning {"ok":true}.', url: 'http://tracker.local/DEMO-1', status: 'Open', priority: 'High' },
  { key: 'DEMO-2', summary: 'Fix login redirect', description: 'After login the user lands on /undefined.', url: 'http://tracker.local/DEMO-2', status: 'In Progress', priority: 'Medium' },
  { key: 'DEMO-3', summary: 'Update README', description: 'Document the new setup steps.', url: 'http://tracker.local/DEMO-3', status: 'Done', priority: 'Low' },
  { key: 'DEMO-4', summary: 'Old idea', description: 'Declined long ago.', url: 'http://tracker.local/DEMO-4', status: 'Closed', priority: 'Low' },
];

const TOOLS = [
  { name: 'list_issues', description: 'List issues assigned to the current user', inputSchema: { type: 'object', properties: { assignee: { type: 'string' }, limit: { type: 'number' } } } },
  {
    name: 'update_issue_status',
    description: 'Change the status of an issue',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, status: { type: 'string' }, comment: { type: 'string' } }, required: ['key', 'status'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string' }, source: { type: 'string' }, target: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } },
      required: ['repo', 'source', 'target', 'title'],
    },
  },
];

let prSeq = 0;
function callTool(name, args = {}) {
  if (name === 'list_issues') {
    const issues = process.env.MOCK_MCP_ISSUES ? JSON.parse(fs.readFileSync(process.env.MOCK_MCP_ISSUES, 'utf8')) : ISSUES;
    return { issues: args.limit ? issues.slice(0, args.limit) : issues };
  }
  if (name === 'update_issue_status') {
    if (!args.key || !args.status) throw new Error('key and status are required');
    return { ok: true, key: args.key, status: args.status };
  }
  if (name === 'create_pull_request') {
    for (const k of ['repo', 'source', 'target', 'title']) if (!args[k]) throw new Error(`${k} is required`);
    return { url: `http://pr.local/${args.repo}/${++prSeq}`, source: args.source, target: args.target };
  }
  throw new Error(`unknown tool ${name}`);
}

const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id == null) return;
  const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '0.1.0' } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: fixtures ? fixtureTools() : TOOLS });
    case 'tools/call':
      try {
        if (process.env.MOCK_MCP_LOG) fs.appendFileSync(process.env.MOCK_MCP_LOG, `${JSON.stringify({ tool: msg.params?.name, args: msg.params?.arguments ?? {} })}\n`);
        if (fixtures) return reply(fixtureCall(msg.params?.name, msg.params?.arguments));
        const value = callTool(msg.params?.name, msg.params?.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    default:
      return write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});
