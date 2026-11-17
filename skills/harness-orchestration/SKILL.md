---
name: harness-orchestration
description: >-
  Coordinate or act as a worker inside the local agent harness. Use when you run inside the harness
  (env HARNESS_SESSION_ID is set, or your first prompt starts with a "[harness]" preamble), when the user
  asks to split work between agents, start sub-agents/workers, assign tasks from the board, or report a task
  as done. Sub-agents are ALWAYS started through the harness tools (worker_start), never through a built-in
  sub-agent/Task tool, so every worker gets its own chat in the harness UI.
---

# Harness orchestration

The harness is a local UI (chats, task board, agents board, git). Every agent session gets an MCP server
named `harness` with the tools below. If MCP is not available in your session, the same tools work from a
shell: `node <harness-repo>/mcp/harness-mcp.js call <tool> '<json-args>'`.

| tool | use it to |
|---|---|
| `whoami` | learn your session id, role (`coordinator` / `worker` / `solo`), parent, task, cwd |
| `task_list` / `task_get` | read the board (`ready: true` = tasks whose deps are done) |
| `task_create` / `task_update` | add tasks (with `deps` for a DAG), change status, add a `comment` |
| `worker_start` | start a sub-agent for a task (`task_id`) or an ad-hoc `spec`; opens a new chat |
| `worker_list` | see your workers and their status |
| `send_message` | message a session (`to`: id, `parent` or `user`); wakes it |
| `ask` | ask your coordinator (or the user) a question; the answer arrives as your next message |
| `worker_done` | finish your task: `summary` + `status` (`done` / `failed`) |

## If you are the coordinator

1. Split the goal into tasks with `task_create`. Put ordering into `deps`, not into prose. Each task spec must be
   self-contained: target, change, constraints, files the worker may edit, and the evidence that proves it is
   done (tests to run, output to capture). Say whether a non-zero exit means failure or is the deliverable.
2. Start every task that is ready with `worker_start`. Use `worktree: "new"` when workers would edit the same
   files at once; otherwise `current`. Pass `agent`/`model` only if the user named one.
3. **End your turn** after starting workers. Do not poll, sleep, or loop on `worker_list`: the harness wakes you
   with a message for every report (`worker_done`), question (`ask`) or escalation (a worker stopped without
   reporting).
4. On wake: answer questions with `send_message` when the answer follows from the task or the user's
   instructions, otherwise ask the user (`send_message` to `user`) and end your turn. Start tasks that became
   ready. Send fixes to the worker that did the work instead of doing them yourself.
5. When every task is settled, report to the user per task: outcome, evidence, open blockers.

**Several repositories (microservices).** One task = one repository. If a spec touches several repos, create a
subtask per repo: `workspace_list` → `task_create({ parent_id, workspace, title, description })`. Subtasks share
the parent's key, so every repo gets the same branch `feature/<KEY>`. Use `deps` between subtasks when one service
must change first (for example API before its consumer).

**Several target branches (hotfix into a release and develop).** `task.targets[0]` is where the work happens
(for example `release-1.54.0`); the rest receive ports. After the worker's `worker_done`, call
`task_port({ task_id, target })` for each other target. A clean cherry-pick needs nothing more; a conflict starts a
worker that resolves it and reports like any other worker. One PR per repo per target.

Never: use a built-in sub-agent/Task tool, type into a worker's terminal, or mark a reported failure as done.

## If you are a worker

Your first prompt starts with a `[harness]` preamble naming your Task, Session and Parent.

- Do only that task, only inside your working directory.
- Need a decision? Call `ask`, then end your turn. The answer arrives as your next message.
- Commit your changes to the current branch with clear messages. Do not push unless the task says so.
- Finish with exactly one `worker_done`: what changed, the evidence (commands run and their result), and any
  open blocker. Use `status: "failed"` if you could not finish — never claim success without evidence.
- Ending a turn without `worker_done` is reported to your coordinator as an escalation.
