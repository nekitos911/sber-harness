# Integration on the target machine: GigaCode, onework, sourcecontrol

Everything else (UI, orchestration, board, git, terminals) already works and is covered by tests on mocks
(`npm test`). The facts about GigaCode and the MCP servers have already been implemented from `docs/GIGACODE-FACTS.md`.
What is left is to **verify them live** and fill in the local configuration. Each part has its own seam:

| What | Code (if anything needs fixing) | Config | How to verify |
|---|---|---|---|
| GigaCode CLI | `server/launchers.js` (launcher `gigacode`) | `agents.gigacode.*` | `--print-config`, a chat in the UI |
| Tasks from onework | `server/integrations/tasks.js` (`format: "onework-markdown"`) | `integrations.tasks.*` | "Sync" on the board |
| PRs to sourcecontrol | `server/integrations/pr.js` | `integrations.pr.*` | "Create PR" in the Changes panel |

Rules: do not edit `harness.config.json`; put machine-specific settings in `harness.config.local.json` (gitignored)
or edit them on the "Settings" screen. Secrets go only in the secrets file (`CONSOLE_MCP_SECRETS` / `HARNESS_MCP_SECRETS`;
format: `server/Name=value` lines or one bare value = `onework/Authorization`). Internal hostnames and project codes
go only in the local config, not in the repo.

## 0. Preparation

```powershell
node -v                      # >= 22
npm install                  # through the internal npm mirror
npm test; npm run build      # everything green
node server/index.js --print-config
```
`--print-config` shows the resolved `node.exe` / `cli-entry.js` of GigaCode, the MCP servers (from `~/.gigacode/settings.json`)
and which secrets exist (names only).

## 1. Fixtures: replace the reconstructions with real samples

`test/fixtures/gigacode.*`, `onework.*`, `sourcecontrol.*` are reconstructed from facts (see `test/fixtures/README.md`).
If you have the folder with raw samples (`…\IdeaProjects\.gigacode-facts\`), copy the matching files into `test/fixtures/`
(masking internal hosts, logins and project codes) and run `npm test`. If a test fails, the real format differs from the
reconstruction: fix the normalizer in `server/launchers.js` (stream) or the parsers in `server/integrations/tasks.js`
(markdown from onework) until green. Expected values in the tests may be updated only to match real data.

## 2. GigaCode

0. **Authorization.** On first run GigaCode asks you to log in through the browser/a link. Settings → "Sign in to
   GigaCode" opens interactive GigaCode in a terminal tab (links are clickable). Check and record in `docs/GIGACODE-FACTS.md`:
   what a headless `-p` prints when not logged in (stdout or stderr, link/code format, whether it waits for login
   or exits), and where the login is stored. The harness detects the link in the stream (`phase: 'auth'`, a card with
   the link in the chat, the timeout is suspended up to `authTimeoutMs`); if the real format is not detected, fix the
   regex in `server/runner.js` / `launchers.js` and the test with the `#auth` mock.
1. `agents.gigacode.command` = `C:/Program Files/.gigacode/bin/gigacode.cmd` (the default). The harness reads `ROOT=%~dp0..`
   and the identity from the shim and starts `ROOT\runtime\node\node.exe --max-old-space-size=6144 ROOT\lib\cli-entry.js …`
   without a shell. If the layout is different, set the explicit pair `agents.gigacode.node` + `agents.gigacode.cliEntry`.
2. Models: the catalog is pulled from GigaCode itself (`-p "/models"`, button "Refresh model list" in the picker
   and in Settings). Check that the discovery found all models (compare with `/models` in interactive mode); if the
   output format is not recognized, set the regex `agents.gigacode.modelsDiscovery.pattern` in the local config
   (with no code changes) or fix the parser + its test. Select the grades (`default/fast/review/explore`) in Settings,
   as in the old console. When models are renamed, nothing needs rewriting: the old ones become "unavailable", grades
   without a model fall back to the CLI default, and Settings shows a warning.
3. Check in the UI: New chat → GigaCode → "Hi, which MCP tools do you have?". Expected:
   - while the CLI is starting (30–60 s), the chat shows "Starting… waiting for MCP";
   - a "MCP: …" line with server statuses;
   - the `harness` tools (`task_list`, `worker_start`, …) are among the agent's tools;
   - the second message continues the same session (`--resume`): the agent remembers the context.
4. **Merging `mcpServers`** (not confirmed): if the agent sees `harness` but NOT onework/sourcecontrol (or the reverse),
   the CLI replaces `mcpServers` from the run file. Turn on `agents.gigacode.inheritUserMcp: true` (it copies the user's
   servers into the run file next to `harness`) and check again.
5. Task command: the default is `taskPromptTemplate: "/full-task {taskUrl}{notes}"` (a user-level command,
   `~/.gigacode/commands/full-task.md`). If you need `/full-task-ui` from the old console, copy its
   `commands/full-task-ui.md` to `~/.gigacode/commands/` and change the template. The slash command always goes as the
   first word of the prompt, and the harness preamble follows it (it reaches the command as part of `$ARGUMENTS`).
6. Error checks: a nonexistent model in the session settings must give a red error with the stderr text; a broken path
   to the shim must give a clear startup error, not hang.

## 3. Tasks from onework

1. The `onework` server is picked up from `~/.gigacode/settings.json` (`mcpServersFrom`); the `Authorization` secret comes
   from the secrets file. Check: `node scripts/mcp-call.js onework --list`.
2. Locally: `integrations.tasks.enabled: true`, `space` = the space code (e.g. what goes before `-` in task keys),
   `urlTemplate` = `https://<tracker-host>/swtr/units/all/unit/{key}`, if needed `refreshSec` (≥ 10) and `statusMap`.
3. Raw response by hand: `node scripts/mcp-call.js onework sbertrack_findIssues '{"space_code":"<SPACE>","assignee":"me","page_size":5}'`.
4. UI: "Sync" on the board → the tasks you are assigned show up, without closed ones. The task drawer loads the
   description (`getIssue`) and the list of tracker transitions (`getIssueMeta`). Change a tracker status only on a test
   task: it is an entry in the tracker.
5. Subtasks from `decomposition` links (`sbertrack_listLinks`) are not imported automatically yet; if you need them, add
   them in `importTasks()` (parentId) with a test.

## 4. PRs to sourcecontrol

1. `node scripts/mcp-call.js sourcecontrol --list`; the `SC_TOKEN` secret is in the secrets file or in the server's env.
2. `integrations.pr.enabled: true`. `project/repository` are derived from `git remote get-url origin` (the last two segments).
3. On a test branch: Changes → Push → "Create PR". Expected: the dialog with title/description pre-filled (with byte
   counters 100/512), a link to `html_url`. A repeated "Create PR" for the same branch returns the existing PR and does
   not create a second one (a second one would close the first).

## 5. Branches and releases (check against the team conventions)

- `git.defaultBase = develop`, branch `feature/{key}`, commit and PR title `{key} {title}` (no colon).
- Fix in a release: the task's targets are `["develop", "release/1.54.0"]` → the work happens on `feature/<KEY>`, and
  "Port to release/1.54.0" creates `feature/<KEY>-rel154` from the release branch and cherry-picks only the missing commits;
  a conflict is resolved by a separate agent. One PR per target branch.
- Microservices: one task = one repository; subtasks with `workspaceId` for each repository; the same key and branch in all.
  `workspaces.root` = the folder with the repositories (e.g. `C:/Users/<you>/IdeaProjects`), `repos` = the list of names
  (empty = all git repositories in the folder).

## 6. Sub-agents, questions, permissions, ACP (built on assumptions; check and fix)

Answer the "Open questions" in `docs/GIGACODE-FACTS.md` live (raw samples into `docs/target-machine/` or the
fixtures) and fix only the seams:
- **Sub-agents as chats.** With the default `orchestration.subagents: "harness"`, ask GigaCode in a chat: "start the
  repository-explorer sub-agent and find pom.xml". Expected: the agent calls `mcp__harness__agent` and a separate child chat
  appears. If the model calls the built-in `agent` anyway, a read-only sub-agent chat is shown (this needs
  `parent_tool_use_id` in the stream; if it is missing, fix the normalizer in `server/launchers.js`). Install the
  `harness-orchestration` skill in Settings (with the user's consent). If GigaCode supports hooks, fill in
  `agents.gigacode.agentToolHook` (format in `docs/ARCHITECTURE.md` → "Automatic: …") so the built-in `agent` is blocked reliably.
- **MCP timeout.** A `worker_run` sub-agent can run a long time: check that the `harness` tool call does not fail on
  GigaCode's timeout (the run file sets `mcpServers.harness.timeout`; check the units and whether `progress` is honoured).
- **Questions.** Find the name of GigaCode's built-in question tool → `agents.gigacode.questionTools`. Check that the card with options appears.
- **Permissions (headless).** In "With confirmation" mode, ask for a command that needs permission → the real denial text
  → `agents.gigacode.denialPattern`; the "Allow once" card should let the agent continue.
- **ACP.** Try `transport: "acp"` (Settings → GigaCode → Transport) on a test chat: streaming, a permission request with
  the agent waiting, Stop, continuing after a harness restart. If `--acp` in GigaCode differs from the protocol, fix
  `server/acp.js` (tests: `test/acp.test.js` + `scripts/mock-acp-agent.js`). If ACP works, decide with the user whether to
  make it the default.
- **Recovery.** Reboot the PC (or kill `node` while an agent is running): after startup the "Session recovery" window
  appears; "Continue selected" continues the sessions with context.
- **Linux** (if relevant): the actual GigaCode install layout on Linux (`docs/ARCHITECTURE.md` → "Cross-platform").

## Done when

- [ ] `npm test` and `npm run build` are green; the fixtures are replaced with real ones (or the differences are fixed in parsers).
- [ ] A GigaCode chat answers, shows tools and "MCP: …", and the second message continues the context.
- [ ] A "coordinator" role chat creates tasks and starts workers through `worker_start`; each worker has its own chat in
      the sidebar; reports (`worker_done`) wake the coordinator.
- [ ] "Take into work" on a task card starts `/full-task <url>` in a new worktree `<repo>-worktrees/<KEY>`.
- [ ] "Sync" pulls your tasks from onework; the description and transitions load in the drawer.
- [ ] "Create PR" creates a PR in sourcecontrol and shows the link; a repeat does not create a duplicate.
- [ ] Sub-agents of `/full-task` are visible as separate chats (harness or read-only); a question and a permission are answered from the UI.
- [ ] After a harness restart running agents keep going; after a PC reboot the "Session recovery" window continues them.
- [ ] The open questions in `docs/GIGACODE-FACTS.md` are answered, and the facts/fixtures are updated.
- [ ] Secrets live only in the secrets file; `git status` is clean of local configs and `data/`.
