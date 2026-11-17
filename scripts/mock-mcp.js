#!/usr/bin/env node
// Fake MCP server (stdio) standing in for the task tracker and the PR service in tests and demos.
// Tools: list_issues -> { issues: [...] } (3 samples), create_pull_request -> { url: "http://pr.local/<repo>/<n>" }.
import readline from 'node:readline';

const ISSUES = [
  { key: 'DEMO-1', summary: 'Add health endpoint', description: 'Expose GET /health returning {"ok":true}.', url: 'http://tracker.local/DEMO-1', status: 'Open', priority: 'High' },
  { key: 'DEMO-2', summary: 'Fix login redirect', description: 'After login the user lands on /undefined.', url: 'http://tracker.local/DEMO-2', status: 'In Progress', priority: 'Medium' },
  { key: 'DEMO-3', summary: 'Update README', description: 'Document the new setup steps.', url: 'http://tracker.local/DEMO-3', status: 'Done', priority: 'Low' },
];

const TOOLS = [
  { name: 'list_issues', description: 'List issues assigned to the current user', inputSchema: { type: 'object', properties: { assignee: { type: 'string' } } } },
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
  if (name === 'list_issues') return { issues: ISSUES };
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
      return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        const value = callTool(msg.params?.name, msg.params?.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    default:
      return write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});
