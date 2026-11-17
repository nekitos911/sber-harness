# Prompt for the agent on the target machine

Clone the repository, open the folder in GigaCode (or another agent), and give it the text below.
Replace `<...>` first.

---

```text
You are working in the sber-harness repository: a local, lightweight IDE for coding agents (GigaCode chats with
history, orchestration where a coordinator starts workers and each worker gets its own chat, a kanban task board,
an agents board, PowerShell terminals, files/diff/commit/PR). Everything is built and covered by tests on mocks.
The facts about GigaCode, onework and sourcecontrol on this machine have already been implemented (docs/GIGACODE-FACTS.md).
Your task: verify the integration live, fill in the local config, and fix only what turns out to differ in reality.

Read first: AGENTS.md, docs/INTEGRATION.md (the step-by-step plan, follow it exactly), docs/GIGACODE-FACTS.md,
docs/ARCHITECTURE.md (the contract).

Data on this machine:
- raw GigaCode/MCP samples: <PATH_TO .gigacode-facts, e.g. C:\Users\<login>\IdeaProjects\.gigacode-facts>
- the old console (working solutions for launching gigacode, MCP and secrets): <PATH_TO_OLD_CONSOLE>
- the secrets file: <PATH_TO_CONSOLE_MCP_SECRETS> (give it via env CONSOLE_MCP_SECRETS; never copy secrets anywhere)
- the folder with service repositories: <for example C:\Users\<login>\IdeaProjects>, the tracker space code: <SPACE>,
  the link to a task in the tracker: https://<tracker-host>/swtr/units/all/unit/{key}
- a test repository and a test task for checking PRs and statuses: <REPOSITORY>, <TASK_KEY>

Order (each step ends with evidence: the command and its output, or a description of what is visible in the UI):
0. node -v (>= 22), npm install, npm test, npm run build, node server/index.js --print-config.
1. Fixtures: replace the reconstructed test/fixtures/gigacode.*, onework.*, sourcecontrol.* with real files from
   .gigacode-facts (mask internal hosts/logins/codes), run npm test, fix the normalizer/parsers until green
   (docs/INTEGRATION.md section 1).
2. Local config harness.config.local.json: workspaces.root/repos, agents.gigacode.models + settings.agents.modelGrades/
   allowedGrades (as in the old console), integrations.tasks (enabled, space, urlTemplate), integrations.pr.enabled.
   Do not edit harness.config.json.
3. GigaCode (section 2): npm start → http://127.0.0.1:4777, a chat with GigaCode, the harness tools are visible, --resume
   works. Check the mcpServers merge; if needed turn on agents.gigacode.inheritUserMcp. Decide /full-task vs
   /full-task-ui (taskPromptTemplate).
4. Tasks (section 3): mcp-call onework, "Sync" on the board, description and transitions in the drawer.
5. PRs (section 4): on a test branch of <REPOSITORY>, create a PR, check that a repeat does not create a duplicate.
6. Full scenario: "Take into work" on <TASK_KEY> → a worktree <repo>-worktrees/<KEY>, a chat with /full-task, agent
   statuses in the sidebar; then a coordinator with two workers in different repositories.

Constraints:
- Do not change the UI, orchestration or the API contract without need; if you have to, update docs/ARCHITECTURE.md
  and both sides (server/ and web/) together.
- CLI-specific code only in server/launchers.js, service-specific code only in server/integrations/.
- No secrets, internal hosts or project codes in the repository; only in the local config and the secrets file.
- The harness itself does not go to the network; agents start without a shell; commit/push/PR and tracker writes only
  on explicit request.
- After each step: npm test and npm run build are green, then a commit with a clear message.

Done when: the checklist at the end of docs/INTEGRATION.md is fully complete. At the end, a short report: what was
checked (with evidence), which settings were set (without secrets), which fixtures/tests were replaced or added, and
what remains open.
```
