---
name: harness-orchestration
description: >-
  Starting a sub-agent inside the harness, or coordinating / working as a worker there. Use when you run inside
  the local agent harness (env HARNESS_SESSION_ID is set, an MCP server named "harness" is available, or your first
  prompt carries a "[harness]" preamble or "Ты работаешь внутри harness") and you are about to start a sub-agent
  (reviewer, explorer, parallel executor), split work between agents, assign board tasks, or report a task as done.
  Inside the harness every sub-agent is started with mcp__harness__agent / worker_run, never with the built-in agent
  tool, so each sub-agent gets its own chat in the harness UI.
---

# Harness orchestration

The harness is a local UI (chats, task board, agents board, git). Every agent session gets an MCP server named
`harness` with the tools below. Without MCP the same tools work from a shell:
`node <harness-repo>/mcp/harness-mcp.js call <tool> '<json-args>'`.

## The one rule: sub-agents go through the harness

Inside the harness, start EVERY sub-agent with **`mcp__harness__agent`** (same arguments as the built-in `agent`:
`subagent_type`, `prompt`, `model`, optional `description`) or **`mcp__harness__worker_run`** (`profile`, `spec`,
`model`, optional `approvalMode`, `title`, `worktree: "current" | "new"`, `timeoutMin`). Do not use the built-in
`agent` / `fork` tool: the harness opens each sub-agent as its own chat the user can watch, message and stop, and
returns its result to you exactly like the built-in tool (`{ status, summary, sessionId }`). `subagent_type` /
`profile` is the agent name (its profile `~/.gigacode/agents/<name>.md` gives the role prompt and default model);
`model` may be a model id or a grade name (`review`, `fast`, …). Several sub-agents in parallel = several calls in
one turn. A command that tells you to use the built-in agent tool (e.g. `/full-task`) still works this way: keep its
steps, swap the tool.

| tool | use it to |
|---|---|
| `agent` / `worker_run` | run a sub-agent synchronously in its own chat and get its result |
| `whoami` | your session id, role (`coordinator` / `worker` / `solo`), parent, task, cwd |
| `task_list` / `task_get` | read the board (`ready: true` = tasks whose deps are done) |
| `task_create` / `task_update` | add tasks (with `deps` for a DAG), change status, add a `comment` |
| `worker_start` | start a long-running worker for a board task (`task_id`) or an ad-hoc `spec`; opens a new chat; returns at once |
| `worker_list` | your workers and their status |
| `send_message` | message a session (`to`: id, `parent` or `user`); wakes it |
| `ask` | ask your coordinator (or the user) a question; the answer arrives as your next message |
| `worker_done` | finish your task: `summary` + `status` (`done` / `failed`) |

## If you are the coordinator

1. Split the goal into tasks with `task_create`. Put ordering into `deps`, not into prose. Each task spec must be
   self-contained: target, change, constraints, files the worker may edit, and the evidence that proves it is done
   (tests to run, output to capture). Say whether a non-zero exit means failure or is the deliverable.
2. Start every ready task with `worker_start`. Use `worktree: "new"` when workers would edit the same files at once;
   otherwise `current`. Pass `agent`/`model` only if the user named one.
3. **End your turn** after starting workers. Do not poll, sleep, or loop on `worker_list`: the harness wakes you with
   a message for every report (`worker_done`), question (`ask`) or escalation (a worker stopped without reporting).
4. On wake: answer questions with `send_message` when the answer follows from the task or the user's instructions,
   otherwise ask the user (`send_message` to `user`) and end your turn. Start tasks that became ready. Send fixes to
   the worker that did the work instead of doing them yourself.
5. When every task is settled, report to the user per task: outcome, evidence, open blockers.

**Several repositories (microservices).** One task = one repository. If a spec touches several repos, create a
subtask per repo: `workspace_list` → `task_create({ parent_id, workspace, title, description })`. Subtasks share the
parent's key, so every repo gets the same branch `feature/<KEY>`. Use `deps` between subtasks when one service must
change first (for example API before its consumer).

**Several target branches (hotfix into a release and develop).** `task.targets[0]` is where the work happens
(usually `develop`); the rest (for example `release/1.54.0`) receive ports. Once the work is committed, call
`task_port({ task_id, target })` for each other target. A clean cherry-pick needs nothing more; a conflict starts a
worker that resolves it and reports like any other worker. One PR per repo per target.

Never: use a built-in sub-agent tool inside the harness, type into a worker's terminal, or mark a reported failure
as done.

## If you are a worker (or a sub-agent started with `agent` / `worker_run`)

Your first prompt carries a `[harness]` preamble naming your task (or assignment), session and parent.

- Do only that task, only inside your working directory.
- Need a decision? Call `ask`, then end your turn. The answer arrives as your next message.
- Do not commit, push or change the tracker unless the task says so (the user commits from the harness UI); when
  you must commit, the message is `<KEY> <summary>`.
- Finish with exactly one `worker_done`: what changed, the evidence (commands run and their result), and any open
  blocker. Use `status: "failed"` if you could not finish — never claim success without evidence. For a sub-agent
  the summary is what the caller receives as the tool result.
- Ending a turn without `worker_done` is reported to your coordinator as an escalation (for a sub-agent: your last
  answer is returned as `no_report`).
