import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalize } from '../server/launchers.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const run = (objs) => {
  const state = {};
  return objs.flatMap((o) => normalize(o, state)).filter((e) => e.type !== 'meta');
};

// gigacode.stream.ndjson holds the ASSUMED Gemini-CLI shape; replace it with a real GigaCode capture (see server/launchers.js).
test('gigacode (Gemini-style) stream normalizes', () => {
  assert.deepEqual(run(fixture('gigacode.stream.ndjson')), [
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
  const events = run(fixture('claude.stream.ndjson'));
  assert.deepEqual(events, [
    { type: 'session', id: 'c5cfa35b-dc12-4713-8b92-a065641e82bb' },
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

test('error results from both shapes', () => {
  assert.deepEqual(normalize({ type: 'result', subtype: 'error_max_turns', is_error: true }, {}), [{ type: 'result', text: null, isError: true }]);
  assert.deepEqual(normalize({ type: 'result', status: 'error', error: { type: 'API', message: 'quota exceeded' } }, {}), [{ type: 'result', text: 'quota exceeded', isError: true }]);
  assert.deepEqual(normalize({ type: 'whatever', x: 1 }, {}), [{ type: 'meta', raw: { type: 'whatever', x: 1 } }]);
});
