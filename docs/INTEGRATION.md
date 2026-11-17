# Integration: GigaCode CLI, task tracker, PR service

This document is for the agent finishing integration on the target machine. Everything else (UI, orchestration,
board, git, terminals) already works and is covered by tests on mocks. You need to connect three things, and each
lives in its own seam:

| # | What | Code (the only place to edit) | Config (`harness.config.local.json`) | How to verify |
|---|---|---|---|---|
| 1 | GigaCode CLI as an agent | `server/launchers.js` (launcher `gigacode`) | `agents.gigacode.*` | `npm test` + a chat with GigaCode in the UI |
| 2 | Importing tasks from the tracker (onework) | `server/integrations/tasks.js` | `mcpServers.<name>`, `integrations.tasks` | "Sync" button on the board |
| 3 | Creating PRs (sourcecontrol) | `server/integrations/pr.js` | `mcpServers.<name>`, `integrations.pr` | "Create PR" button in the Changes panel |

General rules: do not edit `harness.config.json` (those are the committed defaults); put everything
machine-specific in `harness.config.local.json` (gitignored, deep-merged on top). Put secrets (tokens, passwords)
only in the secrets file `data/mcp-secrets.json` or the file named by `HARNESS_MCP_SECRETS`, in the format
`{ "<server>": { "env": {...}, "headers": {...} } }`. Never put them in the config or the repo.

Wherever the existing console on this machine already solves a problem (how it launches GigaCode, which env var
the settings path goes in, how it calls onework/sourcecontrol), **take the working solution from there** instead of guessing.

---

## 1. GigaCode CLI

How it works now: each chat turn is a separate CLI process
`gigacode [--resume <id>] -p <prompt> --output-format stream-json --approval-mode <mode> [--model <m>]`
in the session's `cwd`, with `<env settingsEnv> = data/runs/<sessionId>/settings.json`. The CLI session id is
taken from the stream (the `session` event) and stored in `session.externalSessionId`; the next turn goes out with
`--resume`. The settings file (`chatRecording: true` + `mcpServers`, including `harness`) is the same for every
turn of a session.

Steps:

1. **Executable.** `Get-Command gigacode` / `where gigacode`. Set `agents.gigacode.command` to a string
   (looked up via PATH; npm `.cmd` shims are resolved to `node <entry.js>` automatically) or to an argv array
   such as `["node", "C:/.../gigacode/dist/index.js"]` if the shim is not recognized.
2. **Flags.** `gigacode --help`. Check `-p`, `--output-format stream-json`, `--resume`, the names of the
   `--approval-mode` values and `--model`. If anything differs, fix `buildArgs` of the `gigacode` launcher in
   `server/launchers.js` and `agents.gigacode.approvalModes` in the config.
3. **Settings env var.** Find out which env var gives the CLI its settings.json path (look at how the existing
   console does it). Put the name in `agents.gigacode.settingsEnv`. Check: in a chat, ask the agent to list its MCP
   tools; the `harness` tools (`task_list`, `worker_start`, ...) must be among them.
   Any extra settings needed (for example `agents.modelGrades`, `allowedGrades`) go in `agents.gigacode.settings`.
4. **Stream format.** Capture real output, including a tool call:
   ```powershell
   gigacode -p "List the files in the current folder with a tool and answer OK" --output-format stream-json --approval-mode yolo > test/fixtures/gigacode.stream.ndjson
   ```
   The fixture currently holds an **assumed** format. Replace it with the real one, update the expectations in the
   normalizer test (`test/`, search for `gigacode.stream.ndjson`) and fix the `parse` of the launcher in
   `server/launchers.js` until `npm test` is green. Events must normalize into
   `session | text | thought | tool_call | tool_result | error | result` (see `docs/ARCHITECTURE.md`).
5. **Continuation.** In a UI chat, send two messages. The second turn must continue the same CLI session (the agent
   remembers the context). If not, check `chatRecording`, that the settings path is the same, and the session id
   capture (`data/runs/<sessionId>/stderr.log`, `externalSessionId` field in `GET /api/state`).
6. **Built-in sub-agents off.** Sub-agents are allowed only through `worker_start`. Find out the name of
   GigaCode's built-in sub-agent tool and the settings key that disables tools (in Qwen Code/Gemini CLI forks it is
   `tools.exclude` / `excludeTools`), and add it to `agents.gigacode.settings`.
7. **First-event timeout.** If GigaCode starts slowly, raise `agents.gigacode.firstEventTimeoutMs`.
8. **Orchestration check.** Create a chat with role "coordinator": "Create two tasks on the board and start a
   worker for each one; the workers should create files a.txt and b.txt and report back." Expected: two worker
   chats nested under the coordinator; after `worker_done` the tasks are in Review and the coordinator wakes with
   the reports.

9. **The `full-task` command.** When a task is taken into work ("Take into work" on the board or `worker_start`),
   the worker's first prompt is built from the template `agents.gigacode.taskPromptTemplate` (falling back to
   `tasks.promptTemplate`). To run your command, which takes the task and its SDD, set
   `"taskPromptTemplate": "/full-task {key}"` (variables: `{key} {id} {title} {description} {url} {targets} {branch} {repo}`).
   **Check** that GigaCode runs custom slash commands in headless mode (`gigacode -p "/full-task KEY-1"`). If it does
   not, put the expanded text of the command in the template (or have the command text read from its file:
   find where custom commands are stored and add that substitution to the `gigacode` launcher's `buildArgs` in
   `server/launchers.js`).

Interactive mode (a TUI in a terminal) needs nothing: "New terminal" → command `gigacode`. For a terminal agent to
see the `harness` tools, add the server to `~/.gigacode/settings.json` once:
`"harness": { "command": "node", "args": ["<repo>/mcp/harness-mcp.js"] }`. It reads the URL and token from
`data/server.json` and `data/token`, and the session id from `HARNESS_SESSION_ID`, which the harness sets in its terminals.

## 2. Tasks from the tracker (onework)

1. Add the server to `mcpServers` (the same command or URL the existing console uses):
   ```jsonc
   "mcpServers": { "onework": { "enabled": true, "transport": "stdio", "command": "...", "args": [], "timeoutMs": 15000 } }
   // or { "transport": "http", "url": "https://...", "headers": {} }; secrets go in the secrets file
   ```
2. Check the connection and list the tools:
   `node scripts/mcp-call.js onework --list`
3. Call the issue-list tool by hand and look at the raw response:
   `node scripts/mcp-call.js onework <tool> '{"assignee":"me"}'`
4. Fill in `integrations.tasks`: `server`, `tool`, `args`, `itemsPath` (path to the array in the response),
   `map` (task field to dot-path in an item), `statusMap` (tracker status to `backlog|todo|in_progress|review|done`),
   `enabled: true`.
5. If the response cannot be described declaratively (pagination, several calls, a non-JSON response), edit
   `importTasks()` in `server/integrations/tasks.js`. Its contract is in the file header. Deduplication by
   `source + externalId` is already done.
6. Test: save the real response to `test/fixtures/` and add a case modeled on the existing integrations test
   (it uses `scripts/mock-mcp.js`).
7. UI: the "Sync" button on the board.

## 3. PRs (sourcecontrol)

1. Server in `mcpServers` (as above) → `node scripts/mcp-call.js sourcecontrol --list`.
2. Fill in `integrations.pr`: `tool`, `args` with the templates `{repo} {branch} {base} {title} {body}`
   (`{repo}` comes from `git remote get-url origin`; if the service needs a different repo identifier, change
   how it is computed in `server/integrations/pr.js`), `urlPath` (path to the PR link in the response),
   `defaultBase`, `enabled: true`.
3. UI: Changes panel → "Push" → "Create PR". Expected: a toast with the PR link.

## 4. Branches, releases, multiple repositories (already implemented, only check config and conventions)

- `git.defaultBase` = `develop`; auto-created branches are `feature/{key}`, where `{key}` is the tracker task key
  (`externalId`, e.g. `JIRA-1234`). If the team uses other prefixes (`bugfix/`, `hotfix/`), change
  `git.branchTemplate` / `git.portBranchTemplate`.
- Fix in a release and develop: the task's `targets` = `["release-1.54.0", "develop"]`. The work happens on
  the first one, and the others get a cherry-pick port ("Port to …" button / the `task_port` tool). If the team
  ports the other way (develop to release), just change the order of `targets`.
- Microservices: one task per repository, subtasks through `parentId`, all with one key and one branch name.
  When importing from the tracker, if the issue already lists repositories/components, you can create subtasks
  right away in `importTasks()` (the `map` field plus a small piece of code that creates subtasks with the right
  `workspaceId`).
- Commit/PR templates: `git.commitTitleTemplate`, `git.prTitleTemplate` (default `{key}: {title}`). Check them
  against the commit message format the hooks/CI of your repositories expect.

## Done when

- [ ] `npm test` and `npm run build` are green; the fixture `test/fixtures/gigacode.stream.ndjson` holds real output.
- [ ] A GigaCode chat answers, shows tool calls, and the second message continues the context.
- [ ] A coordinator starts workers through `worker_start`, each worker has its own chat, and reports wake the coordinator.
- [ ] "Sync" pulls tasks from onework onto the board without duplicates.
- [ ] "Create PR" creates a PR in sourcecontrol and shows the link.
- [ ] Secrets live only in the secrets file; `git status` is clean of local configs and `data/`.
