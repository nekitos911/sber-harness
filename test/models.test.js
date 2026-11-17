// Model catalogue that survives renames: tolerant id parser, discovery via the agent CLI ("/models"), availability,
// grade fallback in run settings, pick-model cards, auto-refresh after a "model not present" failure.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseModelIds } from '../server/models.js';
import { startTestServer, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
after(() => rmrf(root));
const IDS = ['Qwen3.8-Flash-Next-262k', 'DeepSeek-V4.1-Flash-1017-262k', 'GLM-5.3-Flash-262k', 'Qwen3.6-35B-262k', 'GigaChat-3.5-Ultra-Preview-128k'];
const discovery = { agents: { mock: { modelsDiscovery: { prompt: '/models', maxAgeHours: 24 } } } };

test('parser: markdown table, bullet list, plain lines, single table rows, custom pattern; no dates/codes/urls', () => {
  const table = parseModelIds(fs.readFileSync(new URL('./fixtures/gigacode.models.txt', import.meta.url), 'utf8'));
  assert.deepEqual(table.map((m) => m.id), IDS);
  assert.deepEqual(table.at(-1), { id: 'GigaChat-3.5-Ultra-Preview-128k', context: '128k' });
  assert.deepEqual(parseModelIds('Models:\n- GLM-5.3-Flash-262k (262k)\n* Qwen3.6-35B-262k — default\n'), [{ id: 'GLM-5.3-Flash-262k', context: '262k' }, { id: 'Qwen3.6-35B-262k' }]);
  assert.deepEqual(parseModelIds('Qwen3.8-Flash-Next-262k\nGigaChat-3.5-Ultra-Preview-128k').map((m) => m.id), ['Qwen3.8-Flash-Next-262k', 'GigaChat-3.5-Ultra-Preview-128k']);
  assert.deepEqual(parseModelIds('| Qwen3.6-35B-262k | 262k |'), [{ id: 'Qwen3.6-35B-262k', context: '262k' }]);
  assert.deepEqual(parseModelIds('updated 2026-11-17, code ABCD-EFGH, see https://x.example/m-1-2'), []);
  assert.deepEqual(parseModelIds('model=alpha-one; model=beta-two', 'model=([a-z-]+)'), [{ id: 'alpha-one' }, { id: 'beta-two' }]);
});

test('discovery through the agent CLI, availability against config entries, grades and pick-model cards', async () => {
  const h = await startTestServer(discovery);
  try {
    const refreshed = (await h.api('POST', '/api/agents/mock/models/refresh')).body;
    assert.ok(refreshed.at > 0 && !refreshed.error, JSON.stringify(refreshed));
    assert.deepEqual(refreshed.models.filter((m) => IDS.includes(m.id)).map((m) => [m.id, m.available]), IDS.map((id) => [id, true]));
    assert.equal(refreshed.models.find((m) => m.id === 'GLM-5.3-Flash-262k').context, '262k');

    // a renamed model stays in the config catalogue: shown greyed, never dropped; its label is kept
    await h.api('PUT', '/api/settings', { agents: { mock: { models: [{ id: 'Old-Model-1-128k', label: 'Старая' }], modelGrades: { review: 'Old-Model-1-128k' } } } });
    const merged = (await h.api('GET', '/api/state')).body.agents.find((a) => a.id === 'mock').models;
    assert.deepEqual(merged[0], { id: 'Old-Model-1-128k', label: 'Старая', available: false });
    const info = (await h.api('GET', '/api/agents/mock/info')).body;
    assert.ok(info.catalog.at > 0 && info.catalog.error === null);
    assert.equal(info.models.length, merged.length);

    // run settings: the grade pointing at the missing model is left out, with one ⚠ note per session
    const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: 'hi' })).body;
    const settings = JSON.parse(fs.readFileSync(s.settingsPath, 'utf8')).agents;
    assert.ok(!('review' in settings.modelGrades) && !settings.allowedGrades.includes('review'), JSON.stringify(settings));
    assert.equal(settings.modelGrades.fast, 'DeepSeek-V4.1-Flash-1017-262k');
    await waitFor(async () => (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === s.id).status === 'idle');
    await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'again' });
    await waitFor(async () => (await h.api('GET', `/api/sessions/${s.id}/messages`)).body.filter((m) => m.kind === 'assistant' && /turn 2/.test(m.text)).length > 0);
    const notes = (await h.api('GET', `/api/sessions/${s.id}/messages`)).body.filter((m) => m.text.startsWith('⚠ Недоступные модели'));
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /review → Old-Model-1-128k/);

    // a session pinned to a model the fresh catalogue does not list: a pick-model card instead of a doomed spawn
    await h.api('PATCH', `/api/sessions/${s.id}`, { model: 'Old-Model-1-128k' });
    await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'third' });
    const card = await waitFor(async () => (await h.api('GET', `/api/sessions/${s.id}/messages`)).body.find((m) => m.kind === 'error'));
    assert.equal(card.action, 'pick-model');
    assert.match(card.text, /Old-Model-1-128k/);
  } finally {
    await h.close();
  }
});

test('"model not present" failure: pick-model action and an automatic re-discovery', async () => {
  const h = await startTestServer(discovery);
  try {
    // no catalogue yet: the run is attempted and the CLI rejects the model like GigaCode does
    const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, model: 'Gone-Model-9-128k', prompt: 'hi' })).body;
    const err = await waitFor(async () => (await h.api('GET', `/api/sessions/${s.id}/messages`)).body.find((m) => m.kind === 'error'), { what: 'failure' });
    assert.equal(err.action, 'pick-model');
    assert.match(err.text, /not present in the current backend catalogue/);
    await waitFor(() => fs.existsSync(path.join(h.dataDir, 'chats', 'discovery', 'mock', 'discovery.log')), { what: 'automatic discovery' });
    const info = await waitFor(async () => {
      const i = (await h.api('GET', '/api/agents/mock/info')).body;
      return i.catalog.at ? i : null;
    }, { what: 'catalogue' });
    assert.deepEqual(info.models.filter((m) => m.available).map((m) => m.id).sort(), [...IDS].sort());
    assert.equal(info.models.find((m) => m.id === 'Gone-Model-9-128k'), undefined, 'a rejected model was never seen at init');
  } finally {
    await h.close();
  }
});
