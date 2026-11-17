# AGENTS.md: instructions for coding agents working on this repo

A local, lightweight IDE for coding agents and tasks: agent chats, orchestration (a coordinator starts
workers, and each worker gets its own chat), a kanban board, an agents board, terminals (PowerShell / interactive
CLI) with history, files, diffs, commits and PRs. Everything runs locally on `127.0.0.1`, with no CDN and no telemetry.

## Commands

```bash
npm install          # dependencies
npm run build        # build the UI into web/dist
npm start            # server + UI at http://127.0.0.1:4777
npm run dev          # same, with Vite hot reload of the UI
npm test             # node:test, all tests must stay green
npm run typecheck    # UI types
```

Demo without GigaCode: in the UI create a chat with the `mock` agent (see `scripts/mock-agent.js`;
directives such as `#spawn`, `#done`, `#ask` in a message trigger orchestration).

## Where things live

| What | Where |
|---|---|
| Contract: data shapes, REST, WS, agent tools | `docs/ARCHITECTURE.md` (keep it in sync when you change shapes) |
| **Everything specific to an agent CLI** (argv, env, settings, stream-json parsing) | `server/launchers.js`. This is the only such file |
| Running one agent turn (spawn without a shell, NDJSON, timeouts, kill) | `server/runner.js` |
| Sessions, message queue, waking agents, terminals | `server/sessions.js` |
| Orchestration (tools for agents, preambles, worker_done) | `server/orchestration.js`, `mcp/harness-mcp.js` |
| Tasks, ordering, dependencies | `server/tasks.js` |
| **Importing tasks from the external tracker** | `server/integrations/tasks.js` + `integrations.tasks` in the config |
| **Creating PRs in the external code host** | `server/integrations/pr.js` + `integrations.pr` in the config |
| MCP client used by the harness itself (stdio/http, timeouts, secrets) | `server/mcp-client.js` |
| Git / files | `server/git.js`, `server/fs.js` |
| UI | `web/src/` (React + Vite + TS) |
| Orchestration protocol for agents | `skills/harness-orchestration/SKILL.md` |
| Mocks for GigaCode and MCP | `scripts/mock-agent.js`, `scripts/mock-mcp.js` |
| Manual call to an MCP server (tools, raw responses) | `node scripts/mcp-call.js <server> --list` / `<tool> '<json>'` |
| Facts about GigaCode/onework/sourcecontrol on the target machine | `docs/GIGACODE-FACTS.md`, fixtures `test/fixtures/` |

## Rules

1. Integrating GigaCode and the external MCP services: follow **`docs/INTEGRATION.md`** step by step.
   CLI-specific code goes only in `server/launchers.js`, service-specific code only in `server/integrations/`.
2. Do not edit `harness.config.json` for machine-specific settings: use `harness.config.local.json`
   (gitignored). Secrets go only in the secrets file (`CONSOLE_MCP_SECRETS` / `HARNESS_MCP_SECRETS` / `mcpSecretsFile`),
   never in the repo. Internal hostnames and project codes likewise go only in the local config.
3. Agent CLIs are spawned without a shell (`shell: false`) and the prompt is a separate argv element.
4. Nothing goes to the network from the harness itself: no CDN, fonts, analytics or update checks.
5. Sub-agents are created only through harness orchestration (`worker_start`), never through a CLI's built-in sub-agents.
6. Any change to stream parsing ships with a fixture of real output in `test/fixtures/` and a test.
7. Before committing: `npm test` and `npm run build` must be green.
