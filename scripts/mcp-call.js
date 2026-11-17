#!/usr/bin/env node
// Calls a console-level MCP server from harness config (mcpServers) by hand, to inspect raw responses.
//   node scripts/mcp-call.js <server> --list
//   node scripts/mcp-call.js <server> <tool> '<json-args>'
import { loadConfig } from '../server/config.js';
import { createMcpManager } from '../server/mcp-client.js';

const [server, tool, json] = process.argv.slice(2);
if (!server || !tool) {
  console.error("usage: node scripts/mcp-call.js <server> --list | <tool> '<json-args>'");
  process.exit(2);
}
const config = loadConfig();
// enabled:false only hides a server from the UI/integrations; a manual call should still work.
config.mcpServers[server] = { ...config.mcpServers[server], enabled: true };
const mcp = createMcpManager(config);
try {
  const result = tool === '--list' ? await mcp.listTools(server) : await mcp.callTool(server, tool, json ? JSON.parse(json) : {});
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
} finally {
  mcp.close();
}
