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

Read first: docs/HANDOFF.md (what has been done and how it works), AGENTS.md, docs/INTEGRATION.md (the
step-by-step plan, follow it exactly), docs/GIGACODE-FACTS.md, docs/ARCHITECTURE.md (the contract).

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
7. Section 6 of INTEGRATION.md: answer the open questions of docs/GIGACODE-FACTS.md live (mcpServers merge, hooks,
   the agent schema and parent_tool_use_id, MCP timeout, the question tool, the denial text, --acp, /models, long
   prompts, authorization), install the harness-orchestration skill (ask the user first), and check sub-agents as chats,
   questions/permissions, ACP on a test chat, and recovery after a restart. Record the facts in GIGACODE-FACTS.md.

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

---

## Prompt: drop the local «CLI» screen (CLI chats are now ordinary chats)

```text
In sber-harness on this machine I added a separate «CLI» screen. It is no longer needed: upstream now pulls CLI chats into
the sidebar as ordinary chats (feature cli-adopt: under their project/worktree, continued by simply writing a message
via --resume, not lost after restarts).
1. git status: save the local CLI screen to a branch (git switch -c local/cli-screen && git add -A && git commit
   -m "local CLI screen"), then git switch main.
2. git pull. If main has local commits with the CLI screen, return main to origin/main
   (git reset --hard origin/main, ONLY after the branch from step 1 is saved). Do not lose other local edits:
   show them to me before the reset.
3. npm install && npm test && npm run build, restart the harness.
4. Check: your recent GigaCode chats from the terminal are visible in the sidebar under their projects (a small
   terminal icon); open one, write "продолжи": the answer continues the same session with context. Service runs
   (/models, /context, the harness's own chats) are not in the list. If the CLI chat record format differs and nothing
   is adopted, fix only server/history.js (the reader and the filters) with a test, then commit and push.
Report: how many CLI chats were adopted, whether continuation worked, what was fixed.
```

## Prompt for updating an existing installation (the machine already has the harness)

```text
In the sber-harness repository on this machine, pull the latest changes from GitHub and check them live.

1. git status: if there are uncommitted local edits, show them to me and commit or stash them
   (harness.config.local.json and data/ are not in git and do not need touching). Then git pull.
   On conflicts, keep the upstream version wherever upstream solves the same problem (auto approval,
   models by baseId, permissions, sidebar); carry your own facts over into docs/GIGACODE-FACTS.md.
2. npm install, npm test, npm run build. Restart the harness (stop the old node server/index.js process first).
3. In harness.config.local.json remove the overrides that are no longer needed: a "models" array with a single model
   (the catalog is now discovered automatically), and hand-written approvalModeMap / auto → auto-edit (the harness now does
   that itself if the sandbox does not start).
4. Check live and record the facts in docs/GIGACODE-FACTS.md (section "Confirmed"):
   a) "Full access" = auto + tools.sandbox=workspace: does the agent run commands and edit files without asking;
      if the sandbox does not start, does the notification appear and does the turn re-run as "Auto-edit"
      (exact stderr text);
   b) --allowed-tools: run "run git status" in "Auto-edit" mode; does the command run without a card
      (the default allow-list); if not — the real flag name and pattern syntax from gigacode --help, then fix
      allowedToolsFlag/allowedToolsJoin in server/launchers.js and the test;
   c) a denied command → the card "the CLI denied" → "Allow and retry": does the command run on the retry;
   d) the turn ends right after the reply (no hanging "Writing the reply"), and no console windows appear;
   e) "Take into work" on a test task with "Where" = "All projects": the agent starts in the projects folder with
      /full-task, creates the worktree itself, and the harness links it to the task;
   f) sub-agents: the agent starts helpers via mcp__harness__agent (separate chats), they go to the archive when finished;
      a child orchestrator in another worktree (new-child) stays;
   g) ACP (Settings → GigaCode → Transport → ACP) on a test chat: MCP starts once, permissions wait for an answer;
   h) recovery: kill node while an agent is running → after startup the "Session recovery" window.
   Fix anything that does not match only in server/launchers.js / server/acp.js / server/integrations/ (with a test).
5. npm test and npm run build are green → a commit with a clear message → git push (if this machine has access).
Report: what was checked (with evidence), what was fixed, what remains open.
```
