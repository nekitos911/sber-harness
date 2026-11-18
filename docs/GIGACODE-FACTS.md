# GigaCode and MCP: facts from the target machine

Collected by live runs on the target machine (GigaCode 26.10.x). Raw samples are in `test/fixtures/` (reconstructed and
neutralized: project codes, hostnames, logins and secrets replaced). If you have the raw `.gigacode-facts/` folder,
replace the reconstructed fixtures with it and keep the tests green.

## 1. Launch

- Install root `ROOT = C:\Program Files\.gigacode`: `bin\gigacode.cmd` (shim), `runtime\node\node.exe` (bundled Node 26.x —
  the system Node 22 must NOT run cli-entry), `lib\cli-entry.js`.
- Shim text (identity masked):
  ```bat
  @echo off
  setlocal
  set "ROOT=%~dp0.."
  set "GIGACODE_PACKAGE_IDENTITY=<64 hex>"
  set "GIGACODE_PACKAGE_LAUNCHER=%~f0"
  "%ROOT%\runtime\node\node.exe" --max-old-space-size=6144 "%ROOT%\lib\cli-entry.js" %*
  exit /b %ERRORLEVEL%
  ```
  So node.exe/cli-entry.js are relative to `%~dp0..` (the shim's PARENT dir), not to the shim's dir.
- `.cmd` cannot be used as the process: `shell:false` → EINVAL; `shell:true` → `'C:\Program' is not recognized`;
  `cmd.exe` + `%ERRORLEVEL%` after a `.cmd` → always 0. Only `node.exe cli-entry.js` + identity env gives honest exit codes.
- Without identity env: stderr `GigaCode launcher error: the public launcher and standalone payload identities do not match`,
  **0 bytes stdout and exit 0** — a silent failure; must be detected from stderr / missing events.
- argv: `[--max-old-space-size=6144, cli-entry.js, (--resume <id>)?, -p, <prompt>, --approval-mode, <mode>, --output-format, stream-json, (--model <m>)?]`.
  Approval modes: `plan | default | auto-edit | auto`. Other useful flags from `--help`: `-c/--continue`, `--fallback-model`,
  `--acp`, `--safe-mode` (disables context files, hooks, extensions, skills, MCP — not for task runs), `--worktree` (its own
  worktree under `<repo>/.gigacode/worktrees` — we do NOT use it, the harness manages worktrees).
- Cold start: the `system/init` event can take 30–60 s (hundreds of tools, ~9 MCP servers). First-event timeout must be ≥ 120 s
  and the UI should say "starting / waiting for MCP".
- stderr at exit 0 may carry warnings, e.g. `Warning: MCP server(s) failed to start: java-lsp. Continuing with built-in tools…`
  → show as a warning in the feed, not an error.

## 2. stream-json (Qwen-Code / Claude-style)

One JSON object per line. Every event has `session_id` (equal to the init `uuid` on the first run; unchanged on `--resume`).

| type | meaning |
|---|---|
| `system` + `subtype:"init"` | first event: `session_id`, `cwd`, `tools[]`, `mcp_servers[{name,status}]`, `model` (without the `-262k` suffix), `permission_mode`, `qwen_code_version`, `agents[]`, `slash_commands[]` |
| `stream_event` | wrapper; observed only `event.type:"goal_state"` (`{v, goal, activity}`). SEEN 2026-11-18 with `--include-partial-messages`: 2 of 3 parallel tool calls stayed without arguments (read_file, run_shell_command) — the flag is opt-in until a raw capture shows the shape |
| `assistant` | `message.content[]`: `{type:"text",text}` and/or `{type:"tool_use",id,name,input}`; `message.usage` per step |
| `user` | tool results: `message.content[{type:"tool_result",tool_use_id,is_error,content}]` (not a human message) |
| `result` | end of run: `subtype:"success"`, `is_error`, `duration_ms`, `num_turns`, `result` (final text), `usage{input_tokens,output_tokens,cache_read_input_tokens,total_tokens}` |

- Every event carries `parent_tool_use_id` (null for the main agent). Non-null = an event of a built-in sub-agent started by that
  tool call; must not be merged into the main assistant message.
- Tokens: count from `result.usage` (cumulative for the run). `assistant.message.usage` is per step and does NOT add up to it.
- Fatal error (e.g. unknown model): **stdout empty, exit 1**, full text in stderr
  (`An unexpected critical error occurred:\nError: The selected model 'x' is not present in the current backend catalogue …`).
  → empty stdout + exit ≠ 0 → error immediately from stderr; do not wait for `result`.

## 3. Per-run settings.json (`GIGACODE_SYSTEM_SETTINGS_PATH`)

```json
{ "agents": { "modelGrades": { "default": "<model>", "fast": "<model>", "review": "<model>", "explore": "<model>" },
              "allowedGrades": ["default", "fast", "review", "explore"] },
  "chatRecording": true }
```
- `agents.modelGrades`: object, `mergeStrategy: shallow_merge`, any string keys (grade names are the team's convention, used by
  the built-in `agent` tool as `{model: "<grade>"}`); `agents.allowedGrades`: whitelist for the `agent` tool (`[]` = sub-agents
  cannot choose a model). `chatRecording` is required for `--resume`. Never write `permissions`.
- Model ids come from `/models` on the machine (5 models, 128k–262k context); `modelGrades` may use ids with or without the
  `-262k` suffix. Fallback models exist (`--fallback-model`).
- Whether `mcpServers` in this file is MERGED with or REPLACES `~/.gigacode/settings.json` is **not confirmed**. Without the file
  all user servers are loaded. Do not rely on merging: config flag `agents.gigacode.inheritUserMcp` copies the user's
  `mcpServers` into the run file next to `harness` (turn it on if the merge test shows replacement).
- CONFIRMED on the target: headless `--approval-mode auto` fails with "Error: Auto approval is allowed only under an
  active action sandbox; enable it via settings.tools.sandbox = 'workspace' or 'workspace-offline'." (exit 1,
  `Config.assertAutoApprovalAvailable`). The harness maps `auto` → `auto-edit` (`agents.<id>.approvalModeMap`) unless
  `agents.<id>.autoSandbox` is set, which writes `{ "tools": { "sandbox": "<value>" } }` into the run settings and keeps
  `auto`. VERIFY: the sandbox restricts file/shell tools to the workspace, so `--include-directories` and worktrees
  outside the cwd may be blocked.
- CONFIRMED: a grade pointing at an id the backend does not know crashes the CLI ("modelGrades.default is not present in
  the current backend catalogue") — the committed config has no default grades; they are set in Settings from the
  discovered catalogue.
- CONFIRMED: `/models` lists ids WITH the context suffix (`DeepSeek-V4.1-Flash-1017-262k`) while the CLI and configs use
  them without (`DeepSeek-V4.1-Flash-1017`): the harness compares models by base id (suffix `-<n>k|m` stripped).
  CONFIRMED again (ACP chat, 2026-11-18): `--model DeepSeek-V4.1-Flash-1017-262k` kills the CLI at start («not present in
  the current backend catalogue»). The gigacode launcher (`stripModelSuffix`) passes `--model` and the run settings'
  `modelGrades` without the suffix, whatever id the picker or a grade holds.

## 4. Custom commands and built-in sub-agents

- User commands: `~/.gigacode/commands/<name>.md` (frontmatter + body). `/full-task` lives there (75 KB). `/full-task-ui` is a
  thin wrapper that existed only as a project command of the old console repo (`commands/full-task-ui.md`).
- Slash commands work in headless mode, **only as the first word of the prompt**: `-p "/full-task <url><notes>"`; the rest of
  the prompt becomes `$ARGUMENTS`. The command expands into the `skill` tool (`{"skill":"full-task","args":"<url>"}`).
- `{taskUrl}` = full tracker link (`https://<tracker>/swtr/units/all/unit/<KEY>` and variants) or just the key; `{notes}` =
  appended after the link with a leading space/newline, usually empty.
- `/full-task` body (user-level, ~370 lines): "Ты — оркестратор"; task text arrives as `{{args}}`. §0 hard rules (git
  read-only, no tracker/CI writes, minimal diff, secrets); §1 domain by repo markers (pom.xml/build.gradle → Java
  sub-agents; package.json → TS flow; pyproject → Python; YAML → config flow); §2 context mode NORMAL / SDD_EXISTING /
  SDD_NEW / FOLLOW_UP; §4 own worktree `..\<repo>-worktrees\<task-id>` (reuse if `git worktree list` has it; branch by the
  repo convention), work stays uncommitted; §5 risk FAST / STANDARD / STRICT; §6 Java sub-agents java-fast-engineer /
  backend-engineer / sdd-engineer / repository-explorer / Explore; §8 cross-model review: first pass `java-reviewer`
  (GLM), second pass `java-reviewer-qwen` (Qwen) with explicit models per implementer family; §9 OpenSpec skills
  (`openspec-*`), changes in a separate store; §11 superpowers skills by trigger; §13 sub-agent check with a verdict file
  `<worktree>\.superpowers\sdd\<plan>\verdicts\task-<N>.md` (`status: PASS|FAIL|ESCALATION_REQUIRED|INDEPENDENT_VERIFICATION_REQUIRED`,
  `files_changed`, `commands`, `open_questions`, `implementer_model`, `reviewer_model`, `second_review_model`, `notes`)
  + ledger `progress.md`; `.superpowers/` is never committed; §14 DONE gate with fresh evidence, final message lists
  implementer/reviewer models; PR description ≤ 300 chars; §15 loops are separate from full-task.
- `/full-task` rules: no commit/push/merge/PR/tracker writes without an explicit request; worktree per task; modes
  NORMAL/SDD_EXISTING/SDD_NEW/FOLLOW_UP; scope FAST/STANDARD/STRICT; cross-model review by a sub-agent of another model family;
  DONE requires fresh evidence; "observe and propose" loops only.
- Built-in sub-agents: tool `agent` (also `fork` via `subagent_type:"fork"`), definitions in `~/.gigacode/agents/<name>.md`
  (e.g. java-reviewer, repository-explorer, sdd-engineer…). **They cannot be disabled by a setting** — only limited:
  `agents.allowedGrades: []`, `agents.maxParallelAgents`, `agents.maxParallelAgentsByModel`, or a `permissions` deny on `agent`
  (we never write permissions). `/full-task` relies on them for review, so the harness allows them as internal helpers and shows
  them read-only (registry / `parent_tool_use_id`); harness workers (own chats) are started only via `worker_start`.
- Registry written by the orchestrating agent: `<registryDir>/<agentId>/agent.json` with ISO-8601 timestamps
  (`startedAt`, `lastActivity`, `settledAt`, `activity.since`), e.g.
  `{"id":"java-reviewer-1","name":"java-reviewer","role":"review","model":"…","parentId":null,"worktree":"…","state":"working","startedAt":"2026-11-17T16:02:11.000Z","lastActivity":"2026-11-17T16:07:43.000Z","settledAt":null,"activity":{"tool":"grep_search","since":"…"},"tokensIn":184320,"tokensOut":2411}`;
  `log.jsonl`: `{"ts":"…","event":"queued|spawned|activity|done","state":"…","note"?,"sessionId"?,"tool"?,"settledAt"?}`.

## 5. MCP onework (task tracker) — tools return MARKDOWN, not JSON

- Server: `onework` (HTTP, `Authorization` header). The standalone `sbertrack` server answers 403 on reading tasks — never use it.
- Envelope: `content: [{ type: "text", text: "<markdown>" }]`. Tool errors also arrive as text:
  `MCP tool 'sbertrack_getIssue' reported tool error for function call: {…} with response: [{"functionResponse":{…,"response":{"error":"…"}}}]`
  → detect `reported tool error` / `"error":"` and treat as an error.
- `sbertrack_findIssues` — flat args (no `filters` wrapper; unknown keys are dropped silently; at least one filter required):
  `space_code, text, statuses, exclude_statuses, assignee, reporter, priorities, suit, labels, created_after/before,
  updated_after/before, page_size (1–100, default 100), page_number (0-based)`.
  "Mine, not closed": `{ space_code: "<SPACE>", assignee: "me", page_size: 100 }` — `assignee:"me"` combines only with
  `space_code`; filter closed statuses on the harness side.
  Response:
  ```
  Found 5 issues on this page (page 0, 5 per page, has_next: True, more pages available)

  1. **<KEY>** — <summary> [<status> | <priority>] @<assignee>
  ```
  No description and no links in search results.
- `sbertrack_getIssue {key}` — markdown: a list of fields `- **Space**`, `- **Type**`, `- **Status**`, `- **Priority**`,
  `- **Labels**`, `- **Assignee**`, `- **Reporter**`, `- **Created**`, `- **Updated**`, then the description (markdown), then
  `### Attributes` (~90 custom fields).
- `sbertrack_getIssueMeta {key, include_fields, include_transitions}`:
  ```
  ## Current Status: development (`development`)

  ## Available Transitions

  - `to_code_review` → to_code_review (`to_code_review`)
  ```
- `sbertrack_updateIssueStatus {key, transition, assignee?, comment?}` — `transition` is an action id from getIssueMeta.
- `sbertrack_getUser {login} | {self:true}` (exactly one). `sbertrack_listLinks {key, page_size, page_number}`:
  `<SRC> **<link_type>** -> <DST>`; types seen: `wiki_page_mention`, `decomposition` (parent→child), `plain_connection`.
- Key = `<space_code>-<number>`. Statuses seen: `todo, development, qa, done, cancelled`; transitions also
  `to_code_review, ready_for_uat, ready_for_ift, ift, stop_progress, discover_issue`. Closed: `done, cancelled, declined`.
  Priorities seen: `low, mid` (+ high). No global status dictionary is available from the tools.

## 6. MCP sourcecontrol (code host) — real JSON

- stdio server (`node …/mcp-sourcecontrol/dist/index.js`, env `SC_TOKEN`); 36 tools: `git_ping, git_list_repositories,
  git_list_branches, git_create_branch, git_get_branch, git_delete_branch, git_list_commits, git_list_pull_requests,
  git_create_pull_request, git_get_pull_request, git_merge_pull_request, git_decline_pull_request, git_update_pull_request,
  git_get_pull_request_diff, git_list_pull_request_files, git_list_pull_request_commits, git_list_pull_request_comments,
  git_add_pull_request_comment, git_get_file_content, git_list_files, …review/webhook/sonar settings…, git_get_user`.
- All schemas have `additionalProperties: false`; pagination is `page` (1-based) + `limit` (not page_size).
- `git_create_pull_request {project, repository, head, base, title, body?}` (required: project, repository, head, base, title).
  Limits (from live 400s): `title` ≤ 100 BYTES UTF-8 (~50 Cyrillic chars), `body` ≤ 512 bytes (`invalid_pr_title_length` /
  `invalid_pr_body_length`); an empty PR (no diff) is rejected; **a second PR from the same head auto-closes the previous one**.
- Human link = `html_url` (`url` is an internal API endpoint — never show it).
- `git_list_pull_requests {project, repository, state: OPEN|MERGED|DECLINED, targetBranch?, author?, page, limit}` →
  `{ pagination, pulls: [{ index, title, body, state, head:{name}, base:{name, protected}, mergeable, reviewers[{status}], html_url }] }`.
- `project/repository` from `git remote get-url origin`: the last two path segments without `.git`
  (`ssh://host:7998/PROJ/repo.git`, `https://host/PROJ/repo.git`, `git@host:PROJ/repo.git` → `PROJ`, `repo`).
- No CI status tool (CI is a separate system).

## 7. Secrets file (`CONSOLE_MCP_SECRETS`)

Text, one secret per line, `#` comments: either a single bare value (= `onework/Authorization`) or `server/Name=value`
(split on the first `=`). HTTP servers get `headers[Name]`, stdio servers get `env[Name]`. Config refs `${env:NAME}` and
`$secret:server/Name`; both are exported to children as `MCP_SECRET_<NAME>`. Missing secret → that server gets a `problem`,
others work. Transport per call. GigaCode's own encrypted store (`~/.gigacode/mcp-secrets-v1.json`) is not readable.

## 8. Team git conventions

- Base branch `develop` everywhere. Releases: `release/x.y.z` (e.g. `release/1.54.0`).
- Branches: `feature/<KEY>` or `feature/<KEY>-<slug>`; `bugfix/…`, `hotfix/…` same form. A release copy of a fix:
  `feature/<KEY>-rel<major><minor>` (e.g. `feature/PROJ-14822-rel154`) → PR into `release/1.54.0`.
- Commit message: `<KEY> <summary from the tracker>` — key first, then a space (no colon), no `feat:`/`fix:` prefixes,
  no `Co-authored-by`, no AI/GigaCode mentions; optional free-text body.
- PR title: `<KEY> <summary>`.
- Porting: by commits, only the missing ones (`git log --cherry-pick --right-only <target>...<branch>`), done by the author,
  separate PR per release branch. No automatic develop→release merge. No local hooks; conventions are not enforced by CI.

## Confirmed on the target (live)

- Headless denial text (tool_result error): `GigaCode requires permission to use "run_shell_command", but that permission was
  declined (non-interactive mode cannot prompt for confirmation).` — the call is already denied when it is reported; the
  agent continues the turn.
- `--approval-mode auto` in headless fails unless `tools.sandbox` is enabled (`Auto approval is allowed only under an active
  action sandbox; enable it via settings.tools.sandbox = 'workspace' or 'workspace-offline'.`) → harness maps auto → auto-edit.
- `auto-edit` does NOT allow `run_shell_command` in headless → shell commands need an explicit allow-list
  (`--allowed-tools`, VERIFY the exact flag and pattern syntax, e.g. `run_shell_command(git)`), the sandbox, or ACP.
- `Warning: MCP server(s) failed to start: java-lsp. …` is printed to stderr on EVERY headless run (each run restarts MCP).

## Open questions (verify on the target; each changes the implementation)

1. `mcpServers` in the run settings file: merged with `~/.gigacode/settings.json` or replacing it? (→ `inheritUserMcp`)
    SEEN on the target (ACP chat, 2026-11-18): the agent searched for `mcp__harness__agent` and found only built-ins
    (`create_sub_session`, `send_message`, `task_stop`, `cron_create`, `loop_wakeup`) — the harness server was not in its
    registry. Check the same in a headless chat; if it is missing there too, the run settings file is not read or replaces
    nothing — find out which.
2. Hooks in settings (PreToolUse-like): key, events, format, can deny a tool with a message? (→ `agentToolHook` to force
   `mcp__harness__agent` instead of the built-in `agent`)
3. Built-in `agent` / `fork` exact inputSchema; do sub-agent events appear in stream-json with non-null
   `parent_tool_use_id`? (→ harness `agent` alias schema; Level 1 virtual chats)
4. MCP tool-call timeout default; `mcpServers.<name>.timeout` units; does `notifications/progress` reset it? (→ long
   `worker_run` waits)
5. Parallel tool calls in one turn — concurrent? (→ parallel harness sub-agents)
6. Headless `-p` without authorization: output, link format, waits or exits, exit code; where the login is stored.
7. `-p "/models"` raw output (→ model discovery parser).
8. stdin + `-p` order with slash commands; max argv length on Windows (40K chars?) (→ long prompts via stdin).
9. `auto` approval mode in headless when the classifier wants a confirmation: event? deny/skip/stop? Exact denial text
   (→ `denialPattern`).
10. The built-in structured question tool (asking the human with options): exact name and inputSchema; what headless
    returns for it (→ `questionTools`).
12. Where `chatRecording` stores sessions (path pattern, e.g. `~/.gigacode/tmp/<hash>/chats/`), the file format (one
    sample, secrets masked), how `<hash>` is derived from the project path, and `gigacode sessions --help` (list/show
    subcommands, JSON output?) (→ `agents.gigacode.history`, the "GigaCode history" panel).
    VERIFY — the harness currently assumes Gemini/Qwen records: `~/.gigacode/tmp/<sha256(project path)>/chats/*.json`
    with `{ sessionId, projectHash, startTime, lastUpdated, messages: [{ type: user|gemini, content, thoughts, toolCalls }] }`;
    anything else is listed as raw.
13. The headless allow-list flag and pattern syntax: is it `--allowed-tools`, repeated or comma-separated, and does
    `run_shell_command(git)` match `git status`? (→ `allowedToolsFlag`, `allowedToolsJoin`, the permission patterns)
14. The key that excludes MCP servers for one run (in the per-run settings): `mcp.excluded` or Gemini-style
    `excludeMCPServers`? (→ `mcpExcludeKey`)
11. `--acp` mode: does it work with the identity env + per-session settings; `initialize` capabilities (loadSession?),
    `session/request_permission` for tool confirmations, MCP servers passed in `session/new`, auth behaviour
    (→ `transport: "acp"` for real interactive permissions).
15. Context commands in headless mode: does `--resume <id> -p "/compress"` compress that session (and what does the
    stream-json show: a result text, new usage?), and does `-p "/context"` print a token breakdown WITHOUT adding a
    turn to the chat history? (→ `agents.gigacode.compressCommand` / `contextCommand`, the context ring's actions.)
    Also: is `assistant.message.usage.input_tokens` the whole prompt incl. the cached part (the ring uses
    input + output per step), and does ACP's `session/prompt` result carry `usage`?

## 9. Machine pitfalls

- Console output in CP866 (Cyrillic garbled) — never rely on console text; read bytes, write files with explicit UTF-8.
- Antivirus/indexer holds files: `rmSync` → ENOTEMPTY/EBUSY; `rmdir /s /q` fails even on ASCII paths. Delete by renaming to
  `<dir>.stale-<ts>` first (works even while files are held), then remove element-wise; sweep `.stale-*` on startup.
- MAX_PATH 260: keep worktrees short — `<parent>\<repo>-worktrees\<KEY>`, not under `~/.gigacode/worktrees/<hash>`.
- Port already taken by an old process (`EADDRINUSE`): print the port and how to find the PID (`netstat -ano | findstr :<port>`).
- Two harness processes on one `data/`: refuse to start (single-instance lock per data dir).
- npm registry is an internal mirror (no Docker on the machine). System Node 22.16, bundled GigaCode Node 26.4.
