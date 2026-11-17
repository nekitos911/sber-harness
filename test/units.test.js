// Small pure units: prompt templates, the sub-agent registry reader, literal-secret detection.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { render } from '../server/orchestration.js';
import { readRegistry } from '../server/registry.js';
import { findLiteralSecrets } from '../server/config.js';
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
