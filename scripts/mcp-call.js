#!/usr/bin/env node
// Calls a console-level MCP server by hand, to inspect tools and raw responses while wiring integrations.
//   node scripts/mcp-call.js <server> --list                 tools: name, description, inputSchema
//   node scripts/mcp-call.js <server> <tool> '<json-args>'   the tool result value (structuredContent or text)
// Same config loading as the server (HARNESS_CONFIG, harness.config.local.json, mcpServersFrom, secrets file).
// Secret values are never printed; on failure prints the server problem/error and exits 1.
import { loadConfig } from '../server/config.js';
import { createMcpManager, toolResultValue, serverDefs } from '../server/mcp-client.js';

const [server, tool, json] = process.argv.slice(2);
if (!server || !tool) {
  console.error("usage: node scripts/mcp-call.js <server> --list | <tool> '<json-args>'");
  process.exit(2);
}
try {
  const config = loadConfig();
  const def = serverDefs(config)[server];
  if (!def) throw new Error(`MCP server "${server}" is not configured (known: ${Object.keys(serverDefs(config)).join(', ') || 'none'})`);
  // enabled:false only hides a server from the UI/integrations; a manual call should still work
  config.mcpServers = { ...config.mcpServers, [server]: { ...config.mcpServers[server], enabled: true } };
  const mcp = createMcpManager(config);
  const out = tool === '--list'
    ? (await mcp.listTools(server)).map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema }))
    : toolResultValue(await mcp.callTool(server, tool, json ? JSON.parse(json) : {}));
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
} catch (e) {
  console.error(`error: ${e.problem ? `problem: ${e.message}` : e.message}`);
  process.exitCode = 1;
}
