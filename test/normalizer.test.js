import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalize, contextUsage } from '../server/launchers.js';

// a fixture may open with `//` comment lines saying where the capture came from
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).map((l) => JSON.parse(l));
const run = (objs) => {
  const state = {};
  return objs.flatMap((o) => normalize(o, state)).filter((e) => e.type !== 'meta');
};
const MCP = [{ name: 'onework', status: 'connected' }, { name: 'sourcecontrol', status: 'connected' }, { name: 'java-lsp', status: 'disconnected' }];
const init = {
  type: 'init', model: 'DeepSeek-V4.1-Flash-1017', slashCommands: ['clear', 'compress', 'full-task'], mcpServers: MCP,
  agents: ['general-purpose', 'java-reviewer'], version: '26.10.109',
};

// GigaCode (Qwen-Code / Claude style), reconstructed from the target machine: test/fixtures/README.md
test('gigacode: init note, text, the context after each step (usage), run tokens from the result only', () => {
  assert.deepEqual(run(fixture('gigacode.stream.ndjson')), [
    { type: 'session', id: '7d1e2a40-5b6c-4f1d-9a3e-0c8b2f6e1a11' },
    init,
    { type: 'text', text: 'OK', delta: false },
    { type: 'usage', contextTokens: 54991, input: 54989, output: 2, cacheRead: 0 },
    { type: 'result', text: 'OK', isError: false, tokensIn: 124394, tokensOut: 133 },
  ]);
});

test('gigacode: tool call and result', () => {
  assert.deepEqual(run(fixture('gigacode.stream-tool.ndjson')), [
    { type: 'session', id: '4f416018-e66e-4a22-bca3-bee0f23c7e39' },
    init,
    { type: 'tool_call', id: 'call_f66cd08f988b4093ad36d4dd', name: 'read_file', input: { absolute_path: 'C:\\Users\\dev\\projects\\demo\\probe.txt' } },
    { type: 'usage', contextTokens: 54140, input: 54100, output: 40, cacheRead: 0 },
    { type: 'tool_result', id: 'call_f66cd08f988b4093ad36d4dd', output: 'OK\n', isError: false },
    { type: 'text', text: 'Файл содержит: OK', delta: false },
    { type: 'usage', contextTokens: 54309, input: 54300, output: 9, cacheRead: 35328 }, // cache_read is part of input here
    { type: 'result', text: 'Файл содержит: OK', isError: false, tokensIn: 108400, tokensOut: 49 },
  ]);
});

test('gigacode: --resume keeps the session id', () => {
  assert.deepEqual(run(fixture('gigacode.resume.ndjson')), [
    { type: 'session', id: '7d1e2a40-5b6c-4f1d-9a3e-0c8b2f6e1a11' },
    init,
    { type: 'text', text: 'Ты просил ответить OK.', delta: false },
    { type: 'usage', contextTokens: 55208, input: 55200, output: 8, cacheRead: 37888 },
    { type: 'result', text: 'Ты просил ответить OK.', isError: false, tokensIn: 55200, tokensOut: 8 },
  ]);
});

test('gigacode: built-in sub-agent events are tagged with the parent tool call', () => {
  assert.deepEqual(run(fixture('gigacode.subagent.ndjson')), [
    { type: 'session', id: '4f416018-e66e-4a22-bca3-bee0f23c7e39' },
    { type: 'tool_call', id: 'call_agent_1', name: 'agent', input: { subagent_type: 'java-reviewer', prompt: 'Review the diff', model: 'review' } },
    { type: 'text', text: 'Reviewing…', delta: false, parentToolId: 'call_agent_1' },
    { type: 'tool_call', id: 'call_sub_grep', name: 'grep_search', input: { pattern: 'TODO' }, parentToolId: 'call_agent_1' },
    { type: 'tool_result', id: 'call_sub_grep', output: 'no matches', isError: false, parentToolId: 'call_agent_1' },
    { type: 'tool_result', id: 'call_agent_1', output: 'APPROVED, 0 findings', isError: false },
    { type: 'text', text: 'Ревью пройдено.', delta: false },
    { type: 'result', text: 'Ревью пройдено.', isError: false, tokensIn: 2000, tokensOut: 50 },
  ]);
});

test('gigacode: a background sub-agent call answers at once, its output_file in the answer', () => {
  const events = run(fixture('gigacode.subagent-background.ndjson')).filter((e) => e.type !== 'session');
  assert.deepEqual(events.map((e) => e.type), ['tool_call', 'tool_result']);
  assert.equal(events[0].name, 'agent');
  assert.equal(events[0].input.run_in_background, true);
  assert.equal(events[1].isError, false);
  assert.match(events[1].output, /^Background agent launched successfully/);
  assert.match(events[1].output, /output_file: C:\\Users\\dev\\\.gigacode\\projects\\/);
});

test('gigacode: slash command expands into the skill tool; a tool error is a tool result with isError', () => {
  const events = run(fixture('gigacode.slash.ndjson'));
  assert.deepEqual(events.map((e) => [e.type, e.name ?? e.id ?? null, e.isError ?? null]), [
    ['session', '00000000-0000-4000-8000-000000000041', null],
    ['init', null, null],
    ['tool_call', 'skill', null],
    ['tool_result', 'call_skill_1', false],
    ['tool_call', 'mcp__onework__sbertrack_getIssue', null],
    ['tool_result', 'call_get_1', true],
    ['text', null, null],
    ['result', null, false],
  ]);
  assert.deepEqual(events[2].input, { skill: 'full-task', args: 'https://tracker.example/swtr/units/all/unit/PROJ-99001' });
  assert.match(events[5].output, /Issue PROJ-99001 not found \(404\)/);
});

test('gigacode: a fatal error leaves stdout empty (the runner reports stderr)', () => {
  assert.equal(fs.readFileSync(new URL('./fixtures/gigacode.stream-error.ndjson', import.meta.url), 'utf8').trim(), '');
  assert.match(fs.readFileSync(new URL('./fixtures/gigacode.stream-error.stderr.txt', import.meta.url), 'utf8'), /not present in the current backend catalogue/);
});

// gemini / qwen launchers: Gemini-CLI style
test('gemini-style stream normalizes', () => {
  assert.deepEqual(run(fixture('gemini.stream.ndjson')), [
    { type: 'session', id: '7b0e6c9e-1f7a-4c1e-9d55-2b8c3f1a0001' },
    { type: 'text', text: 'Let me ', delta: true },
    { type: 'text', text: 'look.', delta: true },
    { type: 'tool_call', id: 'list_directory-1', name: 'list_directory', input: { path: '.' } },
    { type: 'tool_result', id: 'list_directory-1', output: 'README.md\nsrc', isError: false },
    { type: 'tool_call', id: 'read_file-2', name: 'read_file', input: { path: 'missing.txt' } },
    { type: 'tool_result', id: 'read_file-2', output: 'File not found: missing.txt', isError: true },
    { type: 'error', text: 'Loop detection is disabled' },
    { type: 'text', text: 'OK', delta: true },
    { type: 'result', text: null, isError: false, tokensIn: 100, tokensOut: 20 },
  ]);
});

test('claude stream (real capture) normalizes', () => {
  assert.deepEqual(run(fixture('claude.stream.ndjson')), [
    { type: 'session', id: 'c5cfa35b-dc12-4713-8b92-a065641e82bb' },
    { type: 'init', model: 'claude-opus-5-5', slashCommands: [], mcpServers: [{ name: 'harness', status: 'connected' }], agents: [], version: null },
    { type: 'tool_call', id: 'toolu_0167ojCd8j7wcE1cqdaBcn2C', name: 'Read', input: { file_path: '/work/demo/package.json' } },
    { type: 'tool_result', id: 'toolu_0167ojCd8j7wcE1cqdaBcn2C', output: '1\t{"name":"demo-pkg"}\n2\t', isError: false },
    { type: 'text', text: 'demo-pkg', delta: false },
    { type: 'result', text: 'demo-pkg', isError: false },
  ]);
});

test('claude partial messages stream as deltas and the full message is not duplicated', () => {
  const events = run([
    { type: 'stream_event', session_id: 's1', event: { type: 'message_start' } },
    { type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } } },
    { type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
    { type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
    { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
  ]);
  assert.deepEqual(events, [
    { type: 'session', id: 's1' },
    { type: 'thought', text: 'hm', delta: true },
    { type: 'text', text: 'Hel', delta: true },
    { type: 'text', text: 'lo', delta: true },
    { type: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' } },
  ]);
});

test('error results from both shapes; Claude usage adds the cache', () => {
  assert.deepEqual(normalize({ type: 'result', subtype: 'error_max_turns', is_error: true }, {}), [{ type: 'result', text: null, isError: true }]);
  assert.deepEqual(normalize({ type: 'result', status: 'error', error: { type: 'API', message: 'quota exceeded' } }, {}), [{ type: 'result', text: 'quota exceeded', isError: true }]);
  assert.deepEqual(normalize({ type: 'result', result: 'x', usage: { input_tokens: 4, cache_read_input_tokens: 10, output_tokens: 2 } }, {}), [{ type: 'result', text: 'x', isError: false, tokensIn: 14, tokensOut: 2 }]);
  assert.deepEqual(normalize({ type: 'stream_event', event: { type: 'goal_state' } }, {}), []);
  assert.deepEqual(normalize({ type: 'whatever', x: 1 }, {}), [{ type: 'meta', raw: { type: 'whatever', x: 1 } }]);
});

test('context usage: OpenAI style (cache inside input) vs Anthropic style (cache reported separately)', () => {
  const u = { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 };
  assert.equal(contextUsage(u).contextTokens, 1050);
  assert.equal(contextUsage(u, true).contextTokens, 1950);
  const claude = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: u } };
  assert.equal(normalize(claude, { usageStyle: 'anthropic' }).find((e) => e.type === 'usage').contextTokens, 1950);
  assert.ok(!normalize({ ...claude, parent_tool_use_id: 'call_1' }, {}).some((e) => e.type === 'usage'), 'a sub-agent step is its own context');
});
