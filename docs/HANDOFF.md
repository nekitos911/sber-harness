# Handoff: what has been done and how it works

A document for the agent (or developer) who continues the work. Read it first, then `AGENTS.md`, `docs/INTEGRATION.md`
(what to do on the target machine), `docs/GIGACODE-FACTS.md` (facts and open questions about GigaCode/MCP) and
`docs/ARCHITECTURE.md` (the full contract: data, REST, WS, agent tools, behaviour).

## 1. What it is

A local, lightweight IDE for coding agents (GigaCode CLI first of all) and tasks, modelled on Orca. It is cross-platform
(Windows, Linux, macOS), Node ≥ 22, with no Docker, no CDN and no telemetry. The server listens on `127.0.0.1` and is
protected by a token plus a Host check.

| Area | What the user gets |
|---|---|
| Chats | Every turn is a GigaCode run (headless `-p … --output-format stream-json`, continued with `--resume`) or a persistent ACP session. A turn shows a "Working 14s" timer, the current action ("Thinking", "Running: Edit…"), "Reasoned 11s", grouped steps with details and thumbnails, a "Changed N files" card, an "New" divider, question and permission cards |
| Orchestration | Coordinator → `worker_start` → each worker is its own chat (nested in the sidebar). The agent starts sub-agents itself via `mcp__harness__agent` (same arguments as the built-in `agent`), and each one is a separate interactive chat. Built-in GigaCode sub-agents are shown as read-only chats from the stream. Ask/reply, `worker_done`, escalations, an optional harness review loop (`reviewMode: harness`) |
| Tasks | A board with the team's columns (To do / In progress / Testing), drag-and-drop, sync from onework (assigned to me, several spaces), "+ By key", agent badges. "Take into work" runs `/full-task <url> [notes]` in the worktree `<repo>-worktrees/<KEY>`. "Rework" runs `/full-task <url> The task is done, but changes are needed: …`. Subtasks across repositories via a coordinator. Optional tracker transitions on card moves |
| Git | Changes with `+N −M`, inline diffs, commit and PR pre-filled (`<KEY> <title>`, 100/512-byte limits, an existing PR is not duplicated, decline), branch switching and creation, ports into `release/x.y.z` (`feature/<KEY>-rel154`, only missing commits, conflicts are resolved by an agent), `.superpowers/` and `.gigacode/tmp/` are never committed; «Комментарий агенту»: «+» at a diff line (Shift+click — a range) or «Агенту» in the file editor sends «what to change + file:lines + the lines» to a chat that sees the file (the one open in the worktree first, or a new one; queued if busy) |
| Workspaces | "All projects" (the projects folder), projects and their worktrees, any folder, extra folders per chat (`--include-directories` = `/dir add`), a worktree menu (open folder, sleep, pin, delete with checks, bulk cleanup), each worktree with its own tabs |
| GigaCode | Correct launch (`node.exe` + `cli-entry.js` + identity from the shim; on POSIX the script directly), per-session settings file, self-healing model catalog (`/models`, unavailable models greyed out, grades with fallback), first-time authorization (link card, "Sign in to GigaCode" button), skill installation, checking model names in agent files, the `/full-task` verdicts panel |
| Reliability | Agent runs survive a harness restart (detached + reattach checked by pid + start time), the delivery queue on disk, `.bak` copies, a "Session recovery" window after a reboot, terminals restarted with history (`gigacode -c`), drafts in the browser, git never hangs on prompts, step-by-step progress for long operations, a "stalled" state, error boundaries (a failure in one panel never takes down the screen), feature flags for client/server version skew |
| UI | Russian, dark (Orca-like) and light themes, a custom component kit (Select/Combobox/Popover/Menu/Dialog/...), Ctrl/⌘ shortcuts, desktop notifications, `@` files and `/` commands in the input, model and branch pickers, a GigaCode-first Settings page with "Auto: …" values |

## 2. Stack and layout

- `server/`: Node.js ESM with no build step. `node:http` + `ws` + `@lydell/node-pty`. Storage is JSON in `data/` (atomic + `.bak`).
  Modules: `index.js` (routes, security, `FEATURES`, jobs), `config.js`, `store.js`, `bus.js`, `launchers.js` (**all CLI
  specifics**), `runner.js` (headless turn: spawn detached → files → tail, timeouts, auth, denials, kill, reattach),
  `acp.js` (ACP transport), `sessions.js` (sessions, queue, terminals, virtual sub-agent sessions, states), `orchestration.js`
  (agent tools, preambles, worker_run, review loop, ports, rework, recovery), `tasks.js`, `git.js`, `fs.js`, `registry.js`,
  `models.js` (model catalog), `mcp-client.js`, `integrations/tasks.js` (onework, markdown), `integrations/pr.js` (sourcecontrol).
- `web/`: React 19 + Vite + TS, built into `web/dist`. `views/` (Board, Agents, PRs, Inbox, Settings, Chat, Terminal, File,
  Diff, WorktreeHome), `components/` (Sidebar, WorkspacePanel: Files/Changes/Verdicts, board/*, chat/*, pickers/*, ui/*),
  `store.ts`, `ws.ts`, `api.ts`, `types.ts`.
- `mcp/harness-mcp.js`: the MCP server with the orchestration tools (and a CLI); injected into every session.
- `skills/harness-orchestration/SKILL.md`: the protocol for agents; installed into GigaCode as a skill.
- `commands/full-task-harness.md`: an optional wrapper (not needed in auto mode).
- `scripts/`: `mock-agent.js` (fake GigaCode headless; directives below), `mock-acp-agent.js`, `mock-mcp.js` (fake
  onework/sourcecontrol, with a `--fixtures` mode), `mcp-call.js` (manual MCP calls).
- `test/`: ~30 `node:test` files, real git in temp folders with Cyrillic and spaces, `test/fixtures/` (stream, onework,
  sourcecontrol, sdd; the GigaCode ones are reconstructed, see `test/fixtures/README.md`).

## 3. Key scenarios (in detail in `docs/ARCHITECTURE.md`)

- **Chat turn (headless).** deliver → queue (on disk) → launcher (resolve, settings file, argv, env: identity,
  `GIGACODE_SYSTEM_SETTINGS_PATH`, `MCP_SECRET_*`, `HARNESS_*`) → detached spawn with stdout/stderr to files → tail →
  normalization (Qwen/Claude-style stream; sub-agent events with `parent_tool_use_id` go to virtual chats) → Messages → WS.
  `phase: starting` until the first event (cold start 30–60 s), `auth` when a login link appears, `stalled` when there is no output.
- **Take into work.** If a worker is already running, its session is returned (`jumped`). Otherwise the repository is
  determined (explicit, suggested, or the only one), dependencies are checked, the worktree `<repo>-worktrees/<KEY>` and the
  branch `feature/<KEY>` are created from `targets[0]`, then a worker starts with `/full-task <url> <notes>` + a short
  preamble (worktree, no commits, `worker_done`, sub-agents through the harness). A parent task with subtasks gets a
  coordinator in the projects folder.
- **Sub-agents.** Auto mode: the context block steers the model to `mcp__harness__agent` → `worker_run` (profile from
  `~/.gigacode/agents/<name>.md`) → an ephemeral child chat → the result returns to the orchestrator as a tool result
  (long-poll + progress, survives a harness restart). If the model uses the built-in `agent`, a virtual read-only chat is
  built from the stream.
- **Questions/permissions.** `ask` and GigaCode's question tool become a card with options. GigaCode has no yolo, so
  three layers keep it from asking: "Full access" = auto-edit + the allow-list by default (fast); real `auto` +
  `tools.sandbox: workspace` is opt-in in Settings because the sandbox slowed runs down on the real machine
  (self-healing: if the sandbox does not start, auto-edit plus the allow-list is used and the user is notified); a default allow-list of routine
  commands (`--allowed-tools run_shell_command(git)` …) on every auto-edit/default turn; denials that are left become a
  card "the CLI denied" with "Allow and retry" (a grant for one turn, the session or the project via `--allowed-tools`).
  In ACP mode the agent really waits for the answer to `request_permission`. Exactly how the turn ran is in `runInfo`
  on the user message.
- **Turn end.** The turn ends for the user at the `result` event; a CLI process that lingers is killed after
  `exitGraceMs`. Prompts over ~30K characters go through a file (the Windows command-line limit).
- **Rework.** Into the same worker session (`--resume`, context preserved) or a new one in the same worktree; the task goes back to "In progress".
- **Release ports, commit/PR, tracker:** see the `README` and `docs/ARCHITECTURE.md`, sections "Branches", "Board ↔ tracker".
- **Restarts.** Harness: agents keep running and are reattached. Reboot/crash: sessions are marked `interrupted` and
  the "Session recovery" window offers to continue them (or `recovery.autoResume`).

### Task without a sure repository: start in the projects folder

«Взять в работу» uses an explicit repository (chosen in the card) or a HIGH-confidence suggestion (the repo name in the
task's component/service/repository field or text); otherwise the agent starts in the projects folder with the task
prompt (e.g. `/full-task <url>`) and a note to pick the repositories from the SDD (or ask) and create worktrees by its
own rules (`..\<repo>-worktrees\<KEY>`, `feature/<KEY>`). The harness links every worktree whose branch carries the task
key to the task (task.worktrees, branch, repository) and logs «Агент создал рабочее дерево …»; Changes / commit / PR then
work per worktree.

### Seeing what the agents do (UI)

- Sidebar: "Needs attention" at the top (permission, question, login, no output); projects → worktrees (one line, a
  summary on the right) → agents (state, current action, model, time); same-worktree sub-agents with `↳`, archived once
  finished; children in other worktrees shown under their own worktree; terminals as `⌨N`; service sessions in
  "Service". "Workspace settings": grouping, sorting, filters.
- Board: a card shows the live state of its agent, ± changes and, after the agent finishes, "Diff · Commit · PR · Rework".
- "Waiting for me" (Inbox): one entry per session with inline actions; pending counts in the tab title.
- Chat: Orca-style turns (timer, current action, "Reasoned", step groups, "Changed N files", "New"), the composer
  scrolls to the bottom when you send.

## 4. What has been checked and how

| What | How it was checked |
|---|---|
| The whole server (≈170 tests): launch, stream, orchestration, sub-agents, review, board, git, ports, branches, MCP, integrations, durability, recovery, ACP, folders, attention, permissions | `npm test` on Windows (Node 24) and Linux (Node 22, Docker) |
| Independent audit | a separate review of the server code (11 bugs found and fixed with regression tests) and a separate QA pass over the UI at 7 widths (768–1920), dark/light — the findings are fixed |
| Real machine (partly) | the user's agent: launch via `node.exe`+`cli-entry.js`, MCP servers, the `auto` + sandbox and denial texts (see GIGACODE-FACTS "Confirmed") |
| Full chat cycle, `--resume`, harness MCP tools inside the agent | live, with Claude Code as a stand-in for GigaCode |
| UI | by hand in a browser against a live server with the mock agent and fixture-backed onework/sourcecontrol: questions, permissions, folders, rework, stalled, job progress, recovery, PRs, sync |
| GigaCode, onework, sourcecontrol, ACP mode of GigaCode | **not live**: built from facts (`docs/GIGACODE-FACTS.md`); the open questions are listed there |

## 5. What to do on the target machine

Follow `docs/INTEGRATION.md`; the ready prompt is in `docs/SETUP-PROMPT.md`. In short: answer the open questions in
`docs/GIGACODE-FACTS.md` (mcpServers merge, hooks, the built-in `agent` schema and `parent_tool_use_id` in the stream, MCP
timeouts, the question tool, the denial text, `--acp`, `/models`, long prompts, authorization), replace the fixtures with
real samples, fill in the local config, install the harness skill into GigaCode (with the user's consent), and go through
the "done when" checklist.

## 6. Known gaps and ideas

- ACP mode for GigaCode, the hook that enforces sub-agents through the harness, and the exact formats of questions/denials need confirmation.
- No CI status (sourcecontrol does not provide it); "observe and propose" loops for PR/CI are not implemented.
- GigaCode's built-in sub-agents cannot be turned off; the harness steers away from them and shows them.
- In ACP mode a session has no `pid`, so "stalled" does not apply there.
- On Windows, node-pty's delayed `process.kill(shellPid)` fallback on terminal close is disabled (it could kill another
  process that had reused the pid) by patching a private field (`killPty` in `server/sessions.js`). **Re-check it when
  upgrading `@lydell/node-pty`.** Every kill the harness performs goes through a single function that checks the process is
  still alive and records the reason (`killReason`).

## 7. Development and debugging

```bash
npm test                     # all tests
npm run dev                  # server + Vite HMR (http://127.0.0.1:4777)
npm run demo                 # offline demo: mock agent, onework/sourcecontrol from fixtures, test repositories (port 4778)
node server/index.js --print-config   # resolved paths, launcher, models, secrets (names only)
node scripts/mcp-call.js <server> --list | <tool> '<json>'
```
Mock agent directives in a message: `#spawn <spec>`, `#done <summary>`, `#fail`, `#ask <q> | <opt> | …`,
`#question`, `#deny <tool>`, `#subdeny`, `#run <profile> <spec>`, `#runwt`, `#auth`, `#crash`, `#silent`, `#slow`,
`#linger`, `#sandboxfail`, `#raw`, `/models` (the up-to-date list is in the header of `scripts/mock-agent.js`).
Rules: `AGENTS.md`. Contract: `docs/ARCHITECTURE.md` (keep it in sync). Optional server features are announced in
`/api/state.features`; the UI calls only what is listed there.
