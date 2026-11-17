# Questions for the agent on the target machine (where GigaCode and the old console live)

Its answers become fixtures and facts for `server/launchers.js` and `server/integrations/`.
Put the result in `docs/target-machine/` (facts) and `test/fixtures/` (raw outputs).

---

```text
I need exact facts and raw samples (not retellings) for integrating GigaCode and MCP into the new local
harness. Mask every secret as *** (tokens, passwords, identity hashes, personal data). Answer as files:

A) target-facts.md with the sections below;
B) raw output files (as-is, line by line, secrets masked):
   gigacode.stream.ndjson        — a plain answer with no tools
   gigacode.stream-tool.ndjson   — an answer that calls at least one tool (reading a file / a shell command)
   gigacode.stream-error.ndjson  — a run that ends in an error (e.g. a bad --model), plus its stderr in a separate .txt
   gigacode.resume.ndjson        — continuation via --resume of the session from the first file
   onework.<tool>.json           — a real response for each tool from section 7
   sourcecontrol.<tool>.json     — responses of the sourcecontrol tools from section 8

target-facts.md sections:
1. Versions: gigacode (--version), node (the system one and the bundled runtime), git, PowerShell; is there
   Docker; npm registry (internal mirror? address without credentials); proxy.
2. `gigacode --help` output IN FULL. The layout of C:\Program Files\.gigacode\bin: the exact relative paths to
   node.exe and cli-entry.js; the text of gigacode.cmd with the identity value masked (the structure of the
   lines is what matters).
3. stream-json events: the list of event types with one example each; where session_id comes from; where
   input/output tokens are; how the end of a turn and an error look.
4. A full example of a run's settings.json (what the console writes): agents.modelGrades (grade names
   default/fast/review/explore and example model ids), allowedGrades, chatRecording, an mcpServers example.
   Does the CLI merge mcpServers from this file with ~/.gigacode/settings.json or replace them?
5. Custom commands: where /full-task-ui and /full-task live (path, file format), their full text or an
   accurate summary of their steps; do slash commands work in headless mode (`-p "/full-task-ui …"`);
   what goes into {taskUrl} and {notes} (examples). Does the command write the sub-agent registry
   (registryDir): an example of agent.json and 3–5 lines of log.jsonl.
6. GigaCode's built-in sub-agents: the tool name and how to turn it off in settings (exact key).
7. MCP onework: the mcpServers section from ~/.gigacode/settings.json for onework/sourcecontrol/sbertrack
   (secrets ***). For the tools sbertrack_findIssues, sbertrack_getIssue, sbertrack_getIssueMeta,
   sbertrack_updateIssueStatus, sbertrack_getUser, sbertrack_listLinks: inputSchema from tools/list and a real
   response. Specifically: how to request "assigned to me and not closed" (args), limit/pagination, where in the
   response the key/title/description/status/link are, the full list of statuses and which ones count as
   closed, how the space key (prefix like JIRA-) is formed.
8. MCP sourcecontrol: the list of tools with inputSchema; which one creates a PR, the arguments, how the
   repository id is formed from `git remote get-url origin`, where the PR link is in the response; are there
   tools for PR/CI status and review comments.
9. The format of the secrets file (CONSOLE_MCP_SECRETS) with masked values, and how the console turns it into
   headers/env for MCP.
10. Team git conventions: base branch, branch names (feature/, bugfix/, hotfix/, release-x.y.z), the commit
    message format (are there hooks/CI checks for the task key), how fixes go out to a release and develop
    (who cherry-picks onto whom).
11. What often breaks on this machine (Cyrillic/spaces in paths, antivirus holding files, long paths,
    timeouts, MCP authorization) and how the console handles it.
```
