// Small pure units: prompt templates, the sub-agent registry reader, literal-secret detection.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { render } from '../server/orchestration.js';
import { readRegistry } from '../server/registry.js';
import { findLiteralSecrets } from '../server/config.js';
import { expandCommand } from '../server/launchers.js';
import { backgroundLaunch, backgroundResult, outputFileIn } from '../server/background-agents.js';
import { tmpDir, rmrf } from './helpers.js';

const dir = tmpDir();
after(() => rmrf(dir));

test('render: single pass, literal values, unknown placeholders kept', () => {
  const vars = { key: 'JIRA-1', description: "cost $& and $' and $$ and {key}", notes: '' };
  assert.equal(render('/full-task {key}{notes} {description} {nope}', vars), "/full-task JIRA-1 cost $& and $' and $$ and {key} {nope}");
});

test('registry: valid, stale working, broken records, unsettled terminal states, token defaults', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const put = (id, rec) => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'agent.json'), typeof rec === 'string' ? rec : JSON.stringify(rec));
  };
  put('a1', { id: 'a1', name: 'planner', startedAt: '2026-11-17T11:59:00Z', state: 'working', lastActivity: '2026-11-17T11:59:50Z', tokensIn: 5 });
  put('a2', { id: 'a2', name: 'coder', startedAt: '2026-11-17T11:00:00Z', state: 'working', lastActivity: null });
  put('a3', { id: 'a3', name: 'reviewer', startedAt: '2026-11-17T11:30:00Z', state: 'done' });
  put('a4', '{ broken json');
  put('a5', { id: 'a5', name: 'x', startedAt: '2026-11-17T11:00:00Z', state: 'dancing' });
  fs.mkdirSync(path.join(dir, 'a6'));

  const { items, problems } = readRegistry(dir, { idleWindowSec: 90, now });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(Object.keys(by).sort(), ['a1', 'a2', 'a3']);
  assert.deepEqual([by.a1.state, by.a1.tokensIn, by.a1.tokensOut, by.a1.flags], ['working', 5, 0, []]);
  assert.equal(by.a2.state, 'unverifiable');
  assert.deepEqual(by.a3.flags, ['missing settledAt']);
  assert.deepEqual(problems.map((p) => p.agentId).sort(), ['a4', 'a5', 'a6']);
  assert.deepEqual(readRegistry(path.join(dir, 'missing')), { items: [], problems: [] });
  assert.match(JSON.parse(fs.readFileSync(path.join(dir, 'a2', 'agent.json'), 'utf8')).state, /^working$/, 'file never rewritten');
});

test('literal credentials in config are detected; references are not', () => {
  const hits = findLiteralSecrets({
    mcpServers: { a: { headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9abcdefXYZ' } }, b: { headers: { Authorization: '$secret:b/Authorization' } } },
    integrations: { tasks: { token: 'short' } },
  });
  assert.deepEqual(hits, ['mcpServers.a.headers.Authorization']);
});

test('registry: the agent.json example from the target machine, ISO timestamps, note from log.jsonl', () => {
  const reg = path.join(dir, 'facts-registry');
  const put = (id, rec, logLines = []) => {
    fs.mkdirSync(path.join(reg, id), { recursive: true });
    fs.writeFileSync(path.join(reg, id, 'agent.json'), JSON.stringify(rec));
    if (logLines.length) fs.writeFileSync(path.join(reg, id, 'log.jsonl'), `${logLines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  };
  put('java-reviewer-1', {
    id: 'java-reviewer-1', name: 'java-reviewer', role: 'review', model: 'm-review', parentId: null, worktree: 'C:/w/PROJ-1',
    state: 'working', startedAt: '2026-11-17T16:02:11.000Z', lastActivity: '2026-11-17T16:07:43.000Z', settledAt: null,
    activity: { tool: 'grep_search', since: '2026-11-17T16:07:40.000Z' }, tokensIn: 184320, tokensOut: 2411,
  }, [
    { ts: '2026-11-17T16:02:11.000Z', event: 'spawned', state: 'working' },
    { ts: '2026-11-17T16:07:43.000Z', event: 'activity', state: 'working', note: 'checking the DAO layer', tool: 'grep_search' },
  ]);
  const fresh = readRegistry(reg, { idleWindowSec: 90, now: Date.parse('2026-11-17T16:08:00.000Z') }).items[0];
  assert.deepEqual([fresh.state, fresh.tokensIn, fresh.tokensOut, fresh.activity.tool], ['working', 184320, 2411, 'grep_search']);
  assert.equal(fresh.lastText, 'checking the DAO layer');
  assert.deepEqual(fresh.lastEvent, { ts: '2026-11-17T16:07:43.000Z', event: 'activity', state: 'working', note: 'checking the DAO layer', tool: 'grep_search' });
  const stale = readRegistry(reg, { idleWindowSec: 90, now: Date.parse('2026-11-17T16:30:00.000Z') }).items[0];
  assert.equal(stale.state, 'unverifiable');
});

test('excludeFromCommit: nested service folders (.gigacode/tmp/) are service files, the rest of .gigacode is not', async () => {
  const { isService } = await import('../server/git.js');
  const pats = ['.superpowers/', '.gigacode/tmp/'];
  assert.ok(isService('.gigacode/tmp/acp-backup.js', pats));
  assert.ok(isService('.gigacode/tmp/oldwt/.gitattributes', pats));
  assert.ok(!isService('.gigacode/commands/full-task.md', pats));
  assert.ok(!isService('server/index.js', pats));
  // an agent's build output and logs, anywhere in the tree
  const junk = [...pats, '*.class', '*.log'];
  assert.ok(isService('AgentClient.class', junk));
  assert.ok(isService('target/x/a/b/Dto$Attribute.class', junk));
  assert.ok(isService('.proj-42-r3-targeted.log', junk));
  assert.ok(!isService('src/main/java/a/Client.java', junk));
  assert.ok(!isService('docs/class-diagram.md', junk));
  // another tool's temp files at the top: «name*»
  assert.ok(isService('.openai-logs-cleanup-8f2a', ['.openai-logs-cleanup-*']));
  assert.ok(!isService('src/.openai-logs-cleanup-8f2a', ['.openai-logs-cleanup-*']));
});

test('expandCommand: the command file\'s text with the arguments, the project\'s first; null leaves it to the CLI', () => {
  const user = path.join(dir, 'cmd-user');
  const cwd = path.join(dir, 'cmd-proj');
  fs.mkdirSync(path.join(user, 'git'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.gigacode', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(user, 'a.md'), 'Сделай: $ARGUMENTS и {{args}}');
  fs.writeFileSync(path.join(user, 'plain.md'), '\uFEFF---\ndescription: x\n---\nПросто текст.\n');
  fs.writeFileSync(path.join(user, 'git', 'commit.md'), 'Коммит {{args}}');
  fs.writeFileSync(path.join(user, 'shell.md'), 'Статус: !{git status}');
  fs.writeFileSync(path.join(user, 'task.md'), 'Выполни задачу до конца.\n\nЗадача:\nПравила: коротко.\n');
  fs.writeFileSync(path.join(user, 'same.md'), 'пользовательская');
  fs.writeFileSync(path.join(cwd, '.gigacode', 'commands', 'same.md'), 'проектная {{args}}');
  const x = (p, o = {}) => expandCommand(p, { cwd, home: '.gigacode', commandsDir: user, ...o });
  assert.equal(x('/a PROJ-1 $&').text, 'Сделай: PROJ-1 $& и PROJ-1 $&', 'every slot, the arguments literally');
  assert.equal(x('/plain').text, 'Просто текст.', 'BOM and frontmatter dropped');
  assert.equal(x('/plain и ещё').text, 'Просто текст.', 'no slot and no «Задача:» line: the text as is, the CLI\'s own rule for the arguments');
  assert.equal(x('/task PROJ-7 сверь').text, 'Выполни задачу до конца.\n\nЗадача:\nPROJ-7 сверь\nПравила: коротко.', 'no slot: the task goes to its own «Задача:» line, not to the end of a long command');
  assert.equal(x('/task').text, 'Выполни задачу до конца.\n\nЗадача:\nПравила: коротко.', 'no arguments: the text as is');
  assert.equal(x('/git:commit fix').text, 'Коммит fix');
  assert.equal(x('/same 1').text, 'проектная 1', 'the project\'s command first');
  assert.equal(x('/shell'), null, 'shell injection: the CLI runs it');
  assert.equal(x('/nope x'), null);
  assert.equal(x('не команда /a'), null);
  assert.equal(x('/a', { commandsDir: null, home: null }), null, 'no folders: nothing');
});

test('expandCommand: a commandsDir in the settings does not hide the project\'s own command; a skill name with «-» expands', () => {
  const project = path.join(dir, 'cmd-both');
  const commands = path.join(project, '.gigacode', 'commands');
  fs.mkdirSync(commands, { recursive: true });
  fs.mkdirSync(path.join(project, 'agents', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(commands, 'full-task.md'), 'проектная {{args}}');
  fs.writeFileSync(path.join(project, 'agents', 'commands', 'full-task.md'), 'из настроек {{args}}');
  fs.writeFileSync(path.join(project, 'agents', 'commands', 'agent-only.md'), 'только в настройках {{args}}');
  const x = (p) => expandCommand(p, { cwd: project, home: '.gigacode', commandsDir: path.join(project, 'agents', 'commands') });
  assert.equal(x('/full-task T-1').text, 'проектная T-1', 'the project\'s own first, as in the CLI');
  assert.equal(x('/agent-only T-1').text, 'только в настройках T-1', 'the settings folder is still read');
  assert.equal(x('/agent-only').file, path.join(project, 'agents', 'commands', 'agent-only.md'));
});

test('a background sub-agent call: its output file is read to the end of its line (spaces and Cyrillic are a path too)', () => {
  const at = (p) => `Background agent launched successfully. task_id: general-purpose-fd3fe923 (internal ID — do not mention to the user.) The agent is working in the background.\noutput_file: ${p}`;
  const win = 'C:\\Users\\dev\\AppData\\Local\\Temp\\харнесс тест 41Qsxy\\agent-general-purpose-fd3fe923.jsonl';
  assert.deepEqual(backgroundLaunch(at(win)), { taskId: 'general-purpose-fd3fe923', outputFile: win });
  const posix = '/home/dev/.gigacode/projects/demo/agent-1.jsonl';
  assert.deepEqual(backgroundLaunch(`**Background agent launched successfully.**\n**output_file:** ${posix}`), { taskId: null, outputFile: posix });
  assert.equal(outputFileIn('`output_file`: `/tmp/a b/c.jsonl` trailing words'), '/tmp/a b/c.jsonl', 'a path in backticks');
  assert.equal(backgroundLaunch('Background agent launched successfully, but nowhere to write'), null, 'no file: nothing to watch');
  assert.equal(backgroundLaunch('Ran the tests: 12 passed'), null);
});

test('a background sub-agent settles on the result in its file: the last one, an error read from the file tail', () => {
  const file = path.join(dir, 'agent-bg.jsonl');
  fs.writeFileSync(file, '{"type":"assistant","message":"step"}\n');
  assert.equal(backgroundResult(file), null, 'nothing yet: the chat is still running');
  fs.writeFileSync(file, '{"type":"assistant","message":"step"}\n{"type":"result","subtype":"success","is_error":false,"result":"готово: 2 маршрута"}\n');
  assert.deepEqual(backgroundResult(file), { output: 'готово: 2 маршрута', isError: false });
  fs.writeFileSync(file, '{"type":"result","subtype":"success","result":"старый"}\n{"type":"result","subtype":"error_during_execution","is_error":true}\n');
  const failed = backgroundResult(file);
  assert.equal(failed.isError, true);
  assert.match(failed.output, /error_during_execution/, 'an error says what the file tail says');
  assert.equal(backgroundResult(path.join(dir, 'no-such-file.jsonl')), null);
});
