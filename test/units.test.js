// Small pure units: prompt templates, the sub-agent registry reader, literal-secret detection.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { render } from '../server/orchestration.js';
import { readRegistry } from '../server/registry.js';
import { findLiteralSecrets } from '../server/config.js';
import { expandCommand } from '../server/launchers.js';
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
  assert.ok(isService('.bpmnt-14822-r3-targeted.log', junk));
  assert.ok(!isService('src/main/java/a/Client.java', junk));
  assert.ok(!isService('docs/class-diagram.md', junk));
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
  fs.writeFileSync(path.join(user, 'same.md'), 'пользовательская');
  fs.writeFileSync(path.join(cwd, '.gigacode', 'commands', 'same.md'), 'проектная {{args}}');
  const x = (p, o = {}) => expandCommand(p, { cwd, home: '.gigacode', commandsDir: user, ...o });
  assert.equal(x('/a PROJ-1 $&').text, 'Сделай: PROJ-1 $& и PROJ-1 $&', 'every slot, the arguments literally');
  assert.equal(x('/plain').text, 'Просто текст.', 'BOM and frontmatter dropped');
  assert.equal(x('/plain и ещё').text, 'Просто текст.\n\n/plain и ещё', 'no slot: the invocation after the text');
  assert.equal(x('/git:commit fix').text, 'Коммит fix');
  assert.equal(x('/same 1').text, 'проектная 1', 'the project\'s command first');
  assert.equal(x('/shell'), null, 'shell injection: the CLI runs it');
  assert.equal(x('/nope x'), null);
  assert.equal(x('не команда /a'), null);
  assert.equal(x('/a', { commandsDir: null, home: null }), null, 'no folders: nothing');
});
