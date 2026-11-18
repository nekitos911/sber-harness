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

## Prompt for updating the installation (one prompt for everything; use it after every big update)

```text
In the sber-harness repository on this machine: pull the latest changes from GitHub, clean up local leftovers, and
check live what can only be checked here (real GigaCode, onework, sourcecontrol). Read docs/HANDOFF.md first.

1. Local changes and the update.
   - git status / git log origin/main..HEAD. Save local edits and local commits to a branch:
     git switch -c local/backup-<date> && git add -A && git commit -m "local backup" && git switch main.
   - The separate «CLI» screen I had added locally is no longer needed: upstream shows CLI chats in the sidebar as
     ordinary chats (feature cli-adopt). Do not carry it over.
   - git fetch && git reset --hard origin/main (ONLY after the backup branch exists; harness.config.local.json and data/
     are not in git and are not touched). If the backup has other useful changes besides the CLI screen, show them to me
     and carry them over by hand.
2. npm install && npm test && npm run build. Stop the old harness process (node server/index.js) and start it again.
3. harness.config.local.json: remove what is no longer needed — a "models" array with a single model (the catalog
   comes from /models), hand-written approvalModeMap / auto → auto-edit (now in code), a separate autoSandbox if you
   set it (the sandbox is off by default because it was slow). Keep: workspaces.root, integrations.tasks (space etc.),
   secrets in the secrets file.
4. Check live and record the results in docs/GIGACODE-FACTS.md (section "Confirmed", raw output for anything unexpected):
   a) «Главная» → paste a task link → under the field «Будет отправлено: /full-task <link>»; «Запустить» → the agent
      starts in IdeaProjects, picks the project itself, its worktree is linked to the task. Add «и в релиз 54» to the
      notes → a chip «develop + release/1.54.x» appears, and the agent gets a line about the release.
   b) No console windows on messages; the turn ends right after the reply; «Новый чат» opens instantly, and a double
      click does not create two chats.
   c) Permissions: in «Авто-правки» run "git status" — does it run without a card (default allow-list
      --allowed-tools)? If not: the exact flag name and pattern syntax from gigacode --help, fix allowedToolsFlag/
      allowedToolsJoin in server/launchers.js plus the test. A denied command → «Разрешить и повторить» → does it run.
   d) CLI chats: your recent GigaCode chats from the terminal are in the sidebar under their projects (terminal icon);
      write «продолжи» in one — it continues with context; check that the turn is not shown twice (the 15 s heuristic
      in server/history.js); /models, /context and the harness's own chats are not in the list.
   e) Changes panel: GigaCode writes the commit message itself (✨); does --safe-mode work (if not, the harness falls
      back by itself — record what happened); «Закоммитить» through the agent → the agent replies with a RESULT: line,
      the harness shows the commit hash; «Push»; «Создать PR» through the agent.
   f) «Пулл-реквесты» → «Мои»: are your open PRs visible; what git_get_user returned (if the login came from the OS
      account name and does not match, set integrations.pr.me in Settings → PR); whether git_list_pull_requests
      accepts author.
   g) Context ring next to «Отправить»: numbers look right; «Сжать контекст» (/compress) works in headless mode.
   h) Tasks: closed tasks (closed) are gone from the board, created ones are in «К работе».
   Fix anything that does not match only in server/launchers.js, server/history.js, server/integrations/, server/acp.js
   (with a test); do not change UI and orchestration without need.
5. npm test and npm run build green → a commit with a clear message → git push.
Report: what was checked (with evidence), what was fixed, what remains open.
```
