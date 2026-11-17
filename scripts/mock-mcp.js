#!/usr/bin/env node
// Fake MCP server (stdio) standing in for the task tracker and the PR service in tests and demos.
// Tools: list_issues -> { issues: [...] } (4 samples, one Closed), update_issue_status -> { ok, key, status },
//        create_pull_request -> { url: "http://pr.local/<repo>/<n>" }.
// MOCK_MCP_ISSUES (JSON file path) replaces the sample issues, so tests can change the tracker between syncs.
// Fixture mode: `mock-mcp.js --fixtures <dir> --server <name>` serves <dir>/<name>.<tool>.json as the result of <tool>;
// <name>.<tool>.<variant>.json wins when variant = args.page_number or args.key. A file with `content` is returned
// as the MCP result as is (e.g. onework markdown), anything else is wrapped as JSON text + structuredContent.
// MOCK_MCP_LOG (file path): every tools/call is appended as { tool, args } (tests assert the arguments).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const fixtures = opt('--fixtures');
const serverName = opt('--server');

function fixtureTools() {
  const prefix = `${serverName}.`;
  const names = fs.readdirSync(fixtures).filter((n) => n.startsWith(prefix) && n.endsWith('.json')).map((n) => n.slice(prefix.length, -5).split('.')[0]);
  return [...new Set(names)].map((name) => ({ name, description: `fixture ${name}`, inputSchema: { type: 'object' } }));
}

function fixtureCall(name, args = {}) {
  const variant = args.page_number ?? args.key ?? args.state;
  const file = [variant != null && `${serverName}.${name}.${variant}.json`, `${serverName}.${name}.json`]
    .filter(Boolean).map((n) => path.join(fixtures, n)).find((p) => fs.existsSync(p));
  if (!file) throw new Error(`no fixture for ${name}`);
  let value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(value?.pulls) && args.head) {
    // demo: a pull request for whatever branch is asked about, shaped like the fixture
    const mine = value.pulls.filter((p) => p.head?.name === args.head);
    const open = !args.state || /^open$/i.test(args.state);
    const index = 600 + ([...String(args.head)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 300, 0));
    const fake = value.pulls[0] && { ...value.pulls[0], index, title: `${args.head} (демо)`, head: { ...value.pulls[0].head, name: args.head },
      html_url: String(value.pulls[0].html_url).replace(/\/pulls\/\d+$/, `/pulls/${index}`), state: 'open' };
    value = { ...value, pulls: mine.length ? mine : open && fake ? [fake] : [] };
  }
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
