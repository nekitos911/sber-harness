// Model catalogue that survives renames: tolerant id parser, discovery via the agent CLI ("/models"), availability,
// grade fallback in run settings, pick-model cards, auto-refresh after a "model not present" failure.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseModelIds, profileGrade, resolveSubagentModel } from '../server/models.js';
import { startTestServer, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
after(() => rmrf(root));
const IDS = ['Qwen3.8-Flash-Next-262k', 'DeepSeek-V4.1-Flash-1017-262k', 'GLM-5.3-Flash-262k', 'Qwen3.6-35B-262k', 'GigaChat-3.5-Ultra-Preview-128k'];
const discovery = { agents: { mock: { modelsDiscovery: { prompt: '/models', maxAgeHours: 24 } } } };
// the grades a sub-agent gets by its type; the ids are the ones the mock CLI lists (fixtures/gigacode.models.txt)
const GRADED = { default: 'DeepSeek-V4.1-Flash-1017', fast: 'DeepSeek-V4.1-Flash-1017', strong: 'DeepSeek-V4.1-Flash-1017', review: 'GLM-5.3-Flash-262k', explore: 'Qwen3.6-35B-262k' };

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

test('sub-agent model by grade: role grade, an explicit grade or id, a gone model is a note and the default', () => {
  const agentCfg = { settings: { agents: { modelGrades: GRADED } } };
  const known = new Set(IDS);
  const pick = (o) => resolveSubagentModel({ agentCfg, known, ...o });

  // an empty model: the profile's role grade; with no role — the caller's own model (the orchestrator's), not a grade
  assert.deepEqual(pick({ grade: 'review' }), { model: 'GLM-5.3-Flash-262k', grade: 'review', note: null });
  assert.deepEqual(pick({ grade: 'explore' }), { model: 'Qwen3.6-35B-262k', grade: 'explore', note: null });
  assert.deepEqual(pick({ fallback: 'DeepSeek-V4.1-Flash-1017-262k' }), { model: 'DeepSeek-V4.1-Flash-1017-262k', grade: null, note: null });
  // no role and no model of the caller: a grade that is there, else none (the CLI default) — still a start
  assert.deepEqual(pick({}), { model: 'DeepSeek-V4.1-Flash-1017-262k', grade: 'default', note: null });
  const noDefault = { settings: { agents: { modelGrades: { review: 'GLM-5.3-Flash-262k' } } } };
  assert.deepEqual(resolveSubagentModel({ agentCfg: noDefault, known, fallback: 'Model-From-The-Caller-262k' }), { model: 'Model-From-The-Caller-262k', grade: null, note: null });
  assert.deepEqual(resolveSubagentModel({ agentCfg: noDefault, known }), { model: 'GLM-5.3-Flash-262k', grade: 'review', note: null });

  // the config id without the context suffix takes the catalogue's own spelling
  assert.deepEqual(pick({ wanted: 'fast' }), { model: 'DeepSeek-V4.1-Flash-1017-262k', grade: 'fast', note: null });
  // an explicit id is matched with or without the suffix, an unknown one is passed as typed
  assert.equal(pick({ wanted: 'glm-5.3-flash' }).model, 'GLM-5.3-Flash-262k');
  assert.equal(pick({ wanted: 'Some-New-Model-262k' }).model, 'Some-New-Model-262k');
  // «inherit» is not an id: the sub-agent keeps its own model, same as with nothing asked — the CLI dies on such an argv
  // («The selected model 'inherit' is not present in the current backend catalogue»)
  assert.deepEqual(pick({ wanted: 'inherit', grade: 'review' }), { model: 'GLM-5.3-Flash-262k', grade: 'review', note: null });
  assert.deepEqual(pick({ wanted: 'Inherit', fallback: 'DeepSeek-V4.1-Flash-1017-262k' }), { model: 'DeepSeek-V4.1-Flash-1017-262k', grade: null, note: null });

  // a grade whose model left the catalogue: no model (the CLI default) plus a note naming the grade and the model, never an error
  const gone = pick({ wanted: 'strong', known: new Set(['GLM-5.3-Flash-262k']) });
  assert.equal(gone.model, null);
  assert.equal(gone.note, 'Модель уровня «strong» (DeepSeek-V4.1-Flash-1017) не найдена в каталоге — запуск с моделью по умолчанию');
  // the catalogue changed under us: a role grade gone from it still starts the sub-agent on a grade that is there
  assert.deepEqual(pick({ grade: 'review', known: new Set(['Qwen3.6-35B-262k']) }), { model: 'Qwen3.6-35B-262k', grade: 'explore', note: null });
  // every grade model gone: the caller's own model, else none (the CLI default) — still a start, never an error
  assert.deepEqual(pick({ grade: 'review', fallback: 'Model-From-The-Caller-262k', known: new Set(['Brand-New-Model-262k']) }), { model: 'Model-From-The-Caller-262k', grade: null, note: null });
  assert.deepEqual(pick({ grade: 'review', known: new Set(['Brand-New-Model-262k']) }), { model: null, grade: null, note: null });
  const noGradesThere = { settings: { agents: { modelGrades: { review: 'Gone-A-262k', fast: 'Gone-B-262k' } } } };
  assert.deepEqual(resolveSubagentModel({ agentCfg: noGradesThere, grade: 'review', fallback: 'Model-From-The-Caller-262k', known: new Set(['Brand-New-Model-262k']) }), { model: 'Model-From-The-Caller-262k', grade: null, note: null });
  assert.deepEqual(resolveSubagentModel({ agentCfg: noGradesThere, grade: 'review', known: new Set(['Brand-New-Model-262k']) }), { model: null, grade: null, note: null });
  // no discovery at all: nothing is called missing, grades resolve by their config
  assert.deepEqual(pick({ wanted: 'review', known: new Set() }), { model: 'GLM-5.3-Flash-262k', grade: 'review', note: null });

  // profiles by role: reviewers review, searchers fast, a read-only explorer explore, file workers fast, a plain one no role
  assert.equal(profileGrade({ name: 'java-reviewer' }), 'review');
  assert.equal(profileGrade({ name: 'helper', description: 'Independent review of the diff' }), 'review');
  assert.equal(profileGrade({ name: 'auditor', tools: ['Read', 'Grep', 'Glob'], approvalMode: 'plan' }), 'review');
  assert.equal(profileGrade({ name: 'explore', approvalMode: 'plan' }), 'explore');
  assert.equal(profileGrade({ name: 'repository-explorer', description: 'Finds the code', approvalMode: 'plan', tools: ['read_file', 'grep_search'] }), 'explore');
  assert.equal(profileGrade({ name: 'browser-explorer', description: 'Finds the code', approvalMode: 'auto', tools: ['read_file', 'run_shell_command'] }), 'fast');
  assert.equal(profileGrade({ name: 'browser-file-worker' }), 'fast');
  assert.equal(profileGrade({ name: 'general-purpose', description: 'General-purpose agent', approvalMode: 'auto', tools: ['read_file', 'run_shell_command'] }), null);
  assert.equal(profileGrade({ name: 'backend-engineer', tools: ['Read', 'Edit', 'Bash'] }), null);
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
    assert.deepEqual(merged[0], { id: 'Old-Model-1-128k', label: 'Старая', context: '128k', available: false });

    // /models says DeepSeek-V4.1-Flash-1017-262k, the config (and the CLI) DeepSeek-V4.1-Flash-1017: one entry
    await h.api('PUT', '/api/settings', { agents: { mock: { models: [{ id: 'DeepSeek-V4.1-Flash-1017', label: 'DeepSeek' }] } } });
    const deduped = (await h.api('GET', '/api/state')).body.agents.find((a) => a.id === 'mock').models.filter((m) => /^deepseek/i.test(m.id));
    assert.deepEqual(deduped, [{ id: 'DeepSeek-V4.1-Flash-1017', label: 'DeepSeek', context: '262k', available: true }]);
    await h.api('PUT', '/api/settings', { agents: { mock: { models: [{ id: 'Old-Model-1-128k', label: 'Старая' }] } } });
    const info = (await h.api('GET', '/api/agents/mock/info')).body;
    assert.ok(info.catalog.at > 0 && info.catalog.error === null);
    assert.equal(info.models.length, merged.length);

    // the grades are the harness's own table (the CLI would validate ids it does not know): not in its settings file
    const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: 'hi' })).body;
    const settings = JSON.parse(fs.readFileSync(s.settingsPath, 'utf8'));
    assert.equal(settings.agents, undefined);
    await waitFor(async () => (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === s.id).status === 'idle');

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

test('sub-agents by API: the model follows the profile grade, a gone grade model is a note, `strong` saves as a grade', async () => {
  const agentsDir = path.join(root, 'агенты');
  fs.mkdirSync(agentsDir, { recursive: true });
  const profile = (name, extra) => fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\n${extra}---\nТело профиля.\n`);
  profile('code-reviewer-qwen', 'description: Reviews a diff and reports findings\napprovalMode: plan\ntools:\n  - read_file\n  - grep_search\n');
  profile('browser-explorer', 'description: Finds the code and the files behind a feature\napprovalMode: auto\ntools:\n  - read_file\n  - run_shell_command\n');
  profile('implementer', 'description: Implements one step of a task and runs its tests\napprovalMode: auto\ntools:\n  - read_file\n  - run_shell_command\n');
  const h = await startTestServer({ agents: { mock: { modelsDiscovery: discovery.agents.mock.modelsDiscovery, agentsDir } } });
  try {
    assert.equal((await h.api('PUT', '/api/settings', { agents: { mock: { modelGrades: GRADED } } })).status, 200);
    // a grade saved from the settings screen is accepted, including the new one
    const strong = (await h.api('GET', '/api/settings')).body.agents.mock.modelGrades.strong;
    assert.equal(strong, 'DeepSeek-V4.1-Flash-1017', 'the new grade is saved like any other');
    assert.equal((await h.api('PUT', '/api/settings', { agents: { mock: { modelGrades: { turbo: 'x' } } } })).status, 400, 'an unknown grade is still a typo');
    await h.api('POST', '/api/agents/mock/models/refresh');

    const caller = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root })).body;
    const hdr = { 'x-harness-session': caller.id };
    const child = async (body) => {
      const r = await h.api('POST', '/api/agent/worker_run', body, hdr);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.sessionId;
    };
    const modelOf = async (sid) => (await h.api('GET', '/api/state')).body.sessions.find((s) => s.id === sid).model;
    // the profile names the role and the grade it works on; a caller's model as the fallback needs its own profile
    assert.equal(await modelOf(await child({ profile: 'code-reviewer-qwen', spec: '#done ок' })), 'GLM-5.3-Flash-262k', 'a reviewer runs on the review grade');
    assert.equal(await modelOf(await child({ profile: 'browser-explorer', spec: '#done нашёл' })), 'DeepSeek-V4.1-Flash-1017-262k', 'search runs on fast');
    assert.equal(await modelOf(await child({ profile: 'implementer', spec: '#done сделал' })), 'DeepSeek-V4.1-Flash-1017-262k', 'no role: the default grade');
    // an explicit id keeps the catalogue spelling; a context suffix is the same model
    assert.equal(await modelOf(await child({ profile: 'implementer', model: 'deepseek-v4.1-flash-1017', spec: '#done ок' })), 'DeepSeek-V4.1-Flash-1017-262k');

    // a grade with no model in the catalogue: the CLI default plus a note in the chat
    assert.equal((await h.api('PUT', '/api/settings', { agents: { mock: { modelGrades: { ...GRADED, review: 'Gone-Model-9-128k' } } } })).status, 200);
    await h.api('POST', '/api/agents/mock/models/refresh');
    const sid = await child({ model: 'review', spec: '#done ок' });
    assert.equal(await modelOf(sid), null);
    const msgs = (await h.api('GET', `/api/sessions/${sid}/messages`)).body;
    const note = msgs.find((m) => m.kind === 'system' && m.text.startsWith('Модель уровня'));
    assert.match(note.text, /«review» \(Gone-Model-9-128k\) не найдена в каталоге — запуск с моделью по умолчанию/);
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
    await waitFor(() => fs.existsSync(path.join(h.dataDir, 'chats', 'helper', 'discovery', 'mock', 'discovery.log')), { what: 'automatic discovery' });
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

test('discovery tries the light run (quickArgs) first, the full one only if it found nothing; stderr warnings are not the error', async () => {
  const argvFile = path.join(root, 'discovery-argv.ndjson');
  const empty = path.join(root, 'no-models.txt');
  fs.writeFileSync(empty, 'нет моделей\n');
  Object.assign(process.env, { MOCK_AGENT_ARGV_FILE: argvFile, MOCK_AGENT_SAFE_NO_SLASH: '1', MOCK_AGENT_MCP_WARNING: '1' });
  const h = await startTestServer({ agents: { mock: { modelsDiscovery: { prompt: '/models', maxAgeHours: 24 }, quickArgs: ['--safe-mode'] } } });
  try {
    const found = (await h.api('POST', '/api/agents/mock/models/refresh')).body;
    assert.ok(!found.error && found.models.some((m) => m.id === IDS[0]), JSON.stringify(found));
    const runs = fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).argv);
    assert.deepEqual(runs.map((a) => a.includes('--safe-mode')), [true, false], 'light run first, then the full one');

    process.env.MOCK_AGENT_MODELS_FILE = empty; // the CLI answers, but with no model ids
    const failed = (await h.api('POST', '/api/agents/mock/models/refresh')).body;
    assert.equal(failed.error, 'в ответе нет id моделей', 'the java-lsp warning is not shown as the reason');
  } finally {
    for (const k of ['MOCK_AGENT_ARGV_FILE', 'MOCK_AGENT_SAFE_NO_SLASH', 'MOCK_AGENT_MCP_WARNING', 'MOCK_AGENT_MODELS_FILE']) delete process.env[k];
    await h.close();
  }
});
