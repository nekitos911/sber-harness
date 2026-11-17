# Prompt for the agent on the target machine

Give the text below to the agent (GigaCode / DeepSeek / Qwen / GLM) in the folder of the cloned repository.
Replace the angle-bracket placeholders first.

---

```text
You are working in the sber-harness repository: a local, lightweight IDE for coding agents (agent chats,
orchestration where a coordinator starts workers and each worker gets its own chat, a kanban task board,
an agents board, PowerShell terminals with history, files/diff/commit/PR). The UI, orchestration, board,
git and terminals are already built and covered by tests on mocks (scripts/mock-agent.js, scripts/mock-mcp.js).
Your task: connect the real systems on this machine without breaking what works.

Read first: AGENTS.md, docs/INTEGRATION.md (the step-by-step plan, follow it exactly), docs/ARCHITECTURE.md (the contract).

The source of truth for how to do things on this machine is the existing console: <PATH_TO_EXISTING_CONSOLE>.
Take the working solutions from it instead of guessing:
- how it launches gigacode: the path to the CLI, flags (-p, --resume, --approval-mode, --model,
  --output-format stream-json), the env var that passes the run's settings.json path, the settings.json contents
  (chatRecording, agents.modelGrades/allowedGrades, mcpServers), the real format of the stream-json events;
- how it connects the MCP servers onework (tasks), sourcecontrol (PRs) and sbertrack: transport, command/URL,
  tool names and arguments, response format;
- where it keeps secrets (CONSOLE_MCP_SECRETS): use the same file via HARNESS_MCP_SECRETS or the
  mcpSecretsFile setting. Do not copy secrets into the repo.

Order of work:
0. node -v (need >= 22), npm install, npm test, npm run build: everything must be green before you change anything.
1. GigaCode CLI: section 1 of docs/INTEGRATION.md. Code changes ONLY in server/launchers.js; settings in
   harness.config.local.json (agents.gigacode). Capture real stream-json output into
   test/fixtures/gigacode.stream.ndjson, update the normalizer test and the parser until it is green.
   Check in the UI (npm start, http://127.0.0.1:4777): the chat answers, tool calls are visible, the second
   message continues the context (--resume), the agent sees the harness MCP tools. Turn off GigaCode's built-in
   sub-agents (sub-agents only through worker_start).
2. Tasks from onework: section 2. Add the server to mcpServers, check with node scripts/mcp-call.js onework --list,
   look at the raw response of the issue-list tool, fill in integrations.tasks (itemsPath, map, statusMap).
   Edit server/integrations/tasks.js only if the mapping cannot be expressed in config. Add a test with a
   fixture of the real response. Check the "Sync" button on the board.
3. PRs in sourcecontrol: section 3. integrations.pr (+ server/integrations/pr.js if needed). Check
   "Create PR" in the Changes panel on a test branch of <TEST_REPOSITORY>.
4. If sbertrack or other MCP servers are needed by agents during their work, add them to agentMcpServers
   (or make sure they are inherited from ~/.gigacode/settings.json via inheritUserMcpFrom).
4a. The full-task command: set agents.gigacode.taskPromptTemplate = "/full-task {key}" and check that headless
   gigacode -p "/full-task <KEY>" really runs the command (task + SDD). If not, see section 1 step 9 of INTEGRATION.md.
4b. Branches: check git.defaultBase (develop), git.branchTemplate (feature/{key}), and the commit/PR templates
   against the team's conventions and the repositories' hooks/CI (section 4 of INTEGRATION.md).
5. Full check: a chat with role "coordinator" in <TEST_REPOSITORY>: "Create two tasks on the board and start a
   worker for each; worker 1 creates a.txt, worker 2 creates b.txt; each commits and reports." Expected: two
   worker chats under the coordinator, tasks in Review, the coordinator woke with the reports.

Constraints:
- Do not edit harness.config.json (defaults); local settings go only in harness.config.local.json.
- No secrets in the repo or in configs; only in the secrets file.
- The harness itself must not go to the network: no CDN, telemetry or update checks.
- Agent CLIs are spawned without a shell; the prompt is a separate argv element.
- Do not rewrite the UI, orchestration or the API contract; if a contract change is truly needed, update
  docs/ARCHITECTURE.md and both sides (server/ and web/) together.
- After every step: npm test and npm run build are green, then a commit with a clear message.

Done when: the checklist at the end of docs/INTEGRATION.md is fully complete.
At the end, write a short report: what was connected, which config values you set (without secrets),
which fixtures and tests you added, and what remains open.
```
