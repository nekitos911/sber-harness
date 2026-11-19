---
name: harness-orchestration
description: >-
  Run work in separate harness agents and get their results back. Use when you run inside the local agent harness
  (env HARNESS_SESSION_ID is set, an MCP server named "harness" is available, or your first prompt carries a
  "[harness]" preamble or "Ты работаешь внутри harness") and you are about to start a sub-agent (reviewer, explorer,
  implementer), split work between agents or repositories, create worktrees for parallel work, assign board tasks,
  answer a worker, or report your own task. Also use when you ARE a dispatched worker (your prompt names a Task /
  Session / Parent): ask, worker_done. Inside the harness every agent you start gets its own chat in the harness UI;
  never use the built-in agent / fork tool there.
---

# Harness orchestration

The harness is a local UI (chats, task board, agents board, git) modelled on Orca. Every agent session has an MCP
server `harness` with the tools below (`mcp__harness__<tool>`). Without MCP: `node <harness>/mcp/harness-mcp.js call
<tool> '<json-args>'`.

If your prompt names a Task / Session / Parent, you are a **worker**: follow "If you are a worker". To ask your
coordinator, call `ask`: the call waits for the answer and returns it. If it returns without one, end your turn; the
harness wakes you with the answer.

## Recipe (coordinator / orchestrator)

```text
agent(subagent_type, prompt, model?)                              # a helper in YOUR worktree; returns its result
worker_start(task_id | spec, worktree?: "current" | "new-child" | "new-top-level", name?, workspace?, agent?, model?)
```

- **Helpers** (explore, review, implement one step) in your own working copy: `agent` — same arguments as the built-in
  `agent` tool (`subagent_type` = profile from `~/.gigacode/agents/<name>.md`, `prompt`, `model` = id or grade like
  `review`). It runs as its own chat and returns `{ status, summary, sessionId }`. Several in parallel = several calls
  in one turn. Helpers do not start helpers of their own; finished helpers are archived automatically.
- **Workers** for independent or parallel work: `worker_start`, returns at once. Placement (omit `worktree` and the
  harness picks it: `current` when you work in the task's repository, else `new-top-level` in the task's repository;
  the result says which, e.g. `placement: "new-top-level (auto)"`; an explicit `current` in another repository fails):
  - `current` — your working copy (only when nobody else edits the same files);
  - `new-child` — a NEW git worktree of the same repository, nested under yours in the UI; give it a short `name`
    (`ft-core-free`); use it when workers would edit files in parallel;
  - `new-top-level` — a new worktree in ANOTHER repository (`workspace` = repo name from `workspace_list`); one per
    service when a task spans several microservices. A worker there may orchestrate its own helpers.
  New worktrees are added to your readable folders, so you can read their files and diffs directly.
- Start every independent worker, then **end your turn**. "Report back" and "tell me when it's done" still mean end
  your turn: the harness wakes you with each report (`worker_done`), question (`ask`) or escalation.
- To talk to a worker in any state: `send_message(to: <session_id>, body)`. A working worker gets it when its turn
  ends; a finished one gets it as a follow-up and reports again with `worker_done`.
- Groups: `send_message(to: "@all" | "@idle" | "@worktree:<path>", body)` reaches your live workers; use only for
  deliberate fan-out.
- Need their state without waiting: `worker_inspect(session_id)` (status, activity, branch, diff stat, last text,
  report) or `worker_list` (all of yours, incl. other worktrees).
- `agent` / `model` only if the user named one.

Never:
- poll, sleep or loop on `worker_list` / `worker_inspect` — the harness wakes you;
- steer a worker by typing into its terminal — use `send_message`;
- create git worktrees yourself with `git worktree add` — let `worker_start` create them (it names, tracks and shows them);
- use the built-in `agent` / `fork` tool inside the harness;
- mark a reported failure as done.

## When the harness wakes you

- Each report / question / escalation arrives as its own message: act on it.
- Answer a worker's question with `send_message` when the answer follows from the task or the user's instructions;
  otherwise ask the user (`send_message(to: "user")`) and end your turn.
- An escalation means the worker stopped without `worker_done`: steer it with `send_message`, stop it
  (`worker_stop`) and retry (`worker_retry`), or tell the user. Three failed starts of one task break the circuit —
  report it, do not route around it.
- A `worker_done` settles its task; start the tasks that became ready (`task_list(ready: true)`).
- When every worker has settled, report to the user per task: outcome, evidence, open blockers.

## Task spec

Make each spec self-contained: target, change, constraints, files the worker may edit, and the evidence that proves it
is done (tests to run, output to capture). Say whether a non-zero exit means the task failed or capturing it is the
deliverable. Send fixes to the worker that did the work instead of doing them yourself.

**DAG.** Put ordering into `task_create(deps: [...])`, not prose. Workers editing the same files at once need separate
worktrees. **Several repositories:** one subtask per repo (`task_create(parent_id, workspace)`), same key → same branch
`feature/<KEY>` everywhere; `deps` when one service must change first. **Release + develop:** work on `targets[0]`, then
`task_port(task_id, target)` per other target.

## If you are a worker (or a helper started with `agent`)

- Do only your task, only inside your working directory (and the folders you were given).
- Need a decision? `ask(question, options?)`: it waits and returns the answer (`{ answer }`). Do not go on before it
  returns; if it returns without an answer, end your turn — the answer arrives as your next message.
- Do not commit, push, open PRs or change the tracker unless the task says so (the user commits from the harness UI);
  when you must commit, the message is `<KEY> <summary>`.
- Finish with exactly one `worker_done(summary, status: "done" | "failed")`: what changed, the evidence (commands and
  their result), open blockers. Never claim success without evidence. For a helper the summary is what the caller
  receives.
- Ending a turn without `worker_done` is reported to your coordinator as an escalation.

## Tools

| tool | use it to |
|---|---|
| `agent` / `worker_run` | run a helper synchronously in its own chat and get its result |
| `worker_start` | start a worker (task or spec) with placement `current` / `new-child` / `new-top-level`; returns at once |
| `worker_list`, `worker_inspect` | see your workers: state, activity, branch, diff stat, last text, report |
| `send_message` | message a session, `parent`, `user`, or a group (`@all`, `@idle`, `@worktree:<path>`); wakes it |
| `ask` | ask your coordinator (or the user) a question, optionally with `options` |
| `worker_stop`, `worker_retry` | stop a worker; retry its task (same placement unless given; circuit breaker after 3) |
| `worker_done` | finish your own task: `summary` + `status` |
| `whoami`, `workspace_list` | your session/role/task/cwd; registered repositories |
| `task_list` / `task_get` / `task_create` / `task_update` / `task_port` | the board, DAG, subtasks, ports |
