// Sub-agents as real chats (Level 2): worker_run / the built-in-compatible harness `agent` tool, profiles, waiting,
// timeout over MCP, the context block, and installing the shipped command/skill on explicit request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CODE_ROOT } from '../server/config.js';
import { parseProfile, SUBAGENT_CONTEXT } from '../server/orchestration.js';
import { startTestServer, tmpDir, rmrf, waitFor, makeRepo } from './helpers.js';

const root = tmpDir();
const agentsDir = path.join(root, 'agents');
const commandsDir = path.join(root, 'commands');
const skillsDir = path.join(root, 'skills');
const argvFile = path.join(root, 'argv.jsonl');
const PROFILE = '---\nname: java-reviewer\ndescription: Java reviewer\nmodel: review\napprovalMode: plan\ntools:\n  - read_file\n  - grep_search\n---\nТы ревьюер Java-кода.\n';
let h;

before(async () => {
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'java-reviewer.md'), PROFILE);
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer({ agents: { mock: { agentsDir, commandsDir, skillsDir } } });
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  await h.close();
  rmrf(root);
});

const state = async () => (await h.api('GET', '/api/state')).body;
const messages = async (id) => (await h.api('GET', `/api/sessions/${id}/messages`)).body;
const chat = async (prompt) => (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt })).body;

test('profile frontmatter: scalars and a tools list, body = role prompt', () => {
  assert.deepEqual(parseProfile(PROFILE), {
    meta: { name: 'java-reviewer', description: 'Java reviewer', model: 'review', approvalMode: 'plan', tools: ['read_file', 'grep_search'] },
    body: 'Ты ревьюер Java-кода.',
  });
  assert.deepEqual(parseProfile('just a prompt'), { meta: {}, body: 'just a prompt' });
  assert.deepEqual(parseProfile('---\ntools: [a, "b"]\n---\nx').meta.tools, ['a', 'b']);
});

test('worker_run: a nested ephemeral chat with the profile, the caller gets the summary as the tool result', async () => {
  const caller = await chat('#run java-reviewer Проверь diff #done всё чисто');
  const said = await waitFor(async () => (await messages(caller.id)).find((m) => m.kind === 'assistant' && m.text.includes('worker_run result:')), { timeout: 20000, what: 'tool result' });
  assert.match(said.text, /worker_run result: всё чисто/);
  const child = (await state()).sessions.find((s) => s.parentId === caller.id && s.ephemeral);
  assert.deepEqual([child.role, child.model, child.approvalMode, child.title, child.taskId], ['worker', 'GLM-5.3-Flash-262k', 'plan', 'java-reviewer', null]);
  assert.deepEqual([child.report.status, child.report.summary, child.waiter], ['done', 'всё чисто', true]);
  const first = (await messages(child.id)).find((m) => m.kind === 'user');
  assert.match(first.text, /^Ты ревьюер Java-кода\.\n\n## Задание\nПроверь diff #done всё чисто$/);
  assert.ok(!(await state()).tasks.some((t) => /Проверь diff/.test(t.title)), 'no board task for a sub-agent');

  const quiet = await chat('#run java-reviewer просто посмотри');
  await waitFor(async () => (await messages(quiet.id)).some((m) => m.kind === 'assistant' && m.text.includes('worker_run result:')), { timeout: 20000 });
  const child2 = (await state()).sessions.find((s) => s.parentId === quiet.id && s.ephemeral);
  assert.equal(child2.report.status, 'no_report');
  assert.match(child2.report.summary, /Done\./, 'its last answer comes back');
});

test('harness `agent` alias: listed only in harness mode; builtin mode drops it and the context block', async () => {
  const caller = await chat('hi');
  await waitFor(async () => (await state()).sessions.find((s) => s.id === caller.id).status === 'idle');
  const names = async () => (await h.api('GET', '/api/agent/tools')).body.map((t) => t.name);
  assert.ok((await names()).includes('agent') && (await names()).includes('worker_run'));
  const r = await h.api('POST', '/api/agent/agent', { subagent_type: 'java-reviewer', prompt: 'проверь #done ок', description: 'ревью' }, { 'x-harness-session': caller.id });
  const child = (await state()).sessions.find((s) => s.id === r.body.sessionId);
  assert.deepEqual([child.parentId, child.ephemeral, child.model, child.title], [caller.id, true, 'GLM-5.3-Flash-262k', 'java-reviewer · ревью']);
  const done = await waitFor(async () => (await h.api('GET', `/api/agent/worker_wait?sessionId=${child.id}&timeoutMs=2000`)).body, { what: 'wait' });
  assert.ok(done.done === false || done.summary === 'ок');
  await waitFor(async () => (await h.api('GET', `/api/agent/worker_wait?sessionId=${child.id}&timeoutMs=2000`)).body.done, { what: 'settled' });

  await h.api('PUT', '/api/settings', { orchestration: { subagents: 'builtin' } });
  try {
    assert.ok(!(await names()).includes('agent') && (await names()).includes('worker_run'));
    const plain = await chat('без блока');
    const run = await waitFor(() => {
      try {
        return fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.env.HARNESS_SESSION_ID === plain.id);
      } catch {
        return null;
      }
    });
    assert.equal(run.argv[run.argv.indexOf('-p') + 1], 'без блока');
  } finally {
    await h.api('PUT', '/api/settings', { orchestration: { subagents: 'harness' } });
  }
  const withBlock = await chat('с блоком');
  const run2 = await waitFor(() => fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.env.HARNESS_SESSION_ID === withBlock.id));
  assert.equal(run2.argv[run2.argv.indexOf('-p') + 1], `${SUBAGENT_CONTEXT}\n\nс блоком`);
});

test('worker_run over MCP: progress notifications while waiting, timeout returns the session id', async () => {
  const caller = await chat('caller');
  await waitFor(async () => (await state()).sessions.find((s) => s.id === caller.id).status === 'idle');
  const mcp = spawn(process.execPath, [path.join(CODE_ROOT, 'mcp', 'harness-mcp.js')], {
    env: { ...process.env, HARNESS_URL: h.srv.url, HARNESS_TOKEN: h.srv.token, HARNESS_SESSION_ID: caller.id },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = [];
  let buf = '';
  mcp.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  try {
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'worker_run', arguments: { spec: '#silent', timeoutMin: 0.02 }, _meta: { progressToken: 'p1' } } })}\n`);
    const reply = await waitFor(() => lines.find((l) => l.id === 1), { timeout: 15000, what: 'tool reply' });
    const result = JSON.parse(reply.result.content[0].text);
    assert.equal(result.status, 'timeout');
    assert.ok(result.sessionId);
    assert.ok(lines.some((l) => l.method === 'notifications/progress' && l.params.progressToken === 'p1'));
    assert.equal((await state()).sessions.find((s) => s.id === result.sessionId).status, 'running', 'the sub-agent keeps running');
    await h.api('POST', `/api/sessions/${result.sessionId}/stop`);
  } finally {
    mcp.kill();
  }
});

test('shipped command and skill install only on request; a different file is not overwritten without force', async () => {
  let info = (await h.api('GET', '/api/agents/mock/info')).body;
  assert.deepEqual([info.commands['full-task-harness'], info.skills['harness-orchestration']], ['missing', 'missing']);
  assert.equal((await h.api('POST', '/api/agents/mock/commands/install', { name: 'full-task-harness' })).body.status, 'installed');
  assert.equal((await h.api('POST', '/api/agents/mock/skills/install', {})).body.status, 'installed');
  const target = path.join(commandsDir, 'full-task-harness.md');
  assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(path.join(CODE_ROOT, 'commands', 'full-task-harness.md'), 'utf8'));
  assert.ok(fs.existsSync(path.join(skillsDir, 'harness-orchestration', 'SKILL.md')));
  fs.writeFileSync(target, 'my own version');
  info = (await h.api('GET', '/api/agents/mock/info')).body;
  assert.deepEqual([info.commands['full-task-harness'], info.skills['harness-orchestration']], ['different', 'installed']);
  assert.equal((await h.api('POST', '/api/agents/mock/commands/install', { name: 'full-task-harness' })).status, 409);
  assert.equal(fs.readFileSync(target, 'utf8'), 'my own version');
  assert.equal((await h.api('POST', '/api/agents/mock/commands/install', { name: 'full-task-harness', force: true })).body.status, 'installed');
  assert.equal((await h.api('POST', '/api/agents/mock/commands/install', { name: 'nope' })).status, 404);
});

test('a same-worktree helper is archived once its result is in; a helper may not start its own helper', async () => {
  const caller = await chat('#run java-reviewer #run java-reviewer #done внучка');
  await waitFor(async () => (await messages(caller.id)).some((m) => m.kind === 'assistant' && m.text.includes('worker_run result:')), { timeout: 20000, what: 'result' });
  const child = (await state()).sessions.find((s) => s.parentId === caller.id && s.ephemeral);
  assert.ok(!child.persistent);
  const said = (await messages(child.id)).filter((m) => m.kind === 'assistant').map((m) => m.text).join(' ');
  assert.match(said, /worker_run failed: Субагенты не запускают своих субагентов/);
  assert.ok(!(await state()).sessions.some((s) => s.parentId === child.id && !s.virtual), 'no grandchild session');
  await waitFor(async () => (await state()).sessions.find((s) => s.id === child.id).archived, { what: 'child archived' });

  const toolsOf = async (sid) => (await h.api('GET', '/api/agent/tools', undefined, { 'x-harness-session': sid })).body.map((x) => x.name);
  assert.ok((await toolsOf(caller.id)).includes('agent'));
  assert.ok(!(await toolsOf(child.id)).includes('agent'), 'a helper at the depth limit has no agent tool');
});

test('a child in a new worktree is persistent: never archived, may start its own helper (archived after settling)', async () => {
  const repo = path.join(root, 'репо');
  makeRepo(repo);
  const caller = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: '#runwt java-reviewer #run java-reviewer #done помощник' })).body;
  await waitFor(async () => (await messages(caller.id)).some((m) => m.kind === 'assistant' && m.text.includes('worker_run result:')), { timeout: 30000, what: 'result' });
  const child = (await state()).sessions.find((s) => s.parentId === caller.id && s.ephemeral);
  assert.equal(child.persistent, true);
  assert.notEqual(child.cwd, repo, 'its own worktree');
  const helper = await waitFor(async () => (await state()).sessions.find((s) => s.parentId === child.id && s.ephemeral), { what: 'helper' });
  assert.ok(!helper.persistent);
  await waitFor(async () => (await state()).sessions.find((s) => s.id === helper.id).archived, { what: 'helper archived' });
  await waitFor(async () => (await state()).sessions.find((s) => s.id === child.id).report, { what: 'child settled' });
  assert.ok(!(await state()).sessions.find((s) => s.id === child.id).archived, 'the persistent child stays');
  for (const s of (await state()).sessions) if (s.pid) await h.api('POST', `/api/sessions/${s.id}/stop`);
});
