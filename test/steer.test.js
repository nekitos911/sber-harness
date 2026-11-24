// chat.steerAfterMs: a person's message does not wait for a step that only waits for sub-agents.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test, after } from 'node:test';
import { startTestServer, makeRepo, tmpDir, rmrf, waitFor, waitPidGone } from './helpers.js';
import { steerNotice, STEER_NOTICE } from '../server/steer.js';

const root = tmpDir();
const repo = makeRepo(path.join(root, 'repo'));
const steerMs = 1500;
const h = await startTestServer({ chat: { steerAfterMs: steerMs } });
const state = async () => (await h.api('GET', '/api/state')).body;
const chat = async (sid) => (await state()).sessions.find((s) => s.id === sid);

after(async () => {
  for (const s of (await state()).sessions.filter((x) => x.kind === 'chat' && x.pid)) {
    await h.api('POST', `/api/sessions/${s.id}/stop`).catch(() => {});
    await waitPidGone(s.pid, 5000);
  }
  await h.close();
  rmrf(root);
});

test('the notice goes only to the turn of the message that cut the step', () => {
  const r = { steerAt: 3 };
  assert.equal(steerNotice({ steer: { cut: true, at: 3 } }, r), STEER_NOTICE);
  assert.equal(steerNotice({ steer: { cut: true, at: 2 } }, r), '', 'a cut of another turn');
  assert.equal(steerNotice({ text: 'просто сообщение' }, r), '', 'the step ended by itself');
  assert.equal(steerNotice({ steer: { cut: true, at: 3 } }, {}), '', 'never cut');
});

test('a call waiting for a sub-agent ends at chat.steerAfterMs and the message goes next turn', async () => {
  // the call waits (noWait: the bridge polls it like its own worker_run) while the step is busy with its own work
  // (#hang 5 s): nothing can tell the call to end but the deadline, and the step is never cut — only the wait is
  const main = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: '#waitagent Explore разведка #hang 5000' })).body;
  const helper = await waitFor(async () => (await state()).sessions.find((s) => s.parentId === main.id && !s.virtual), { timeout: 25000, what: 'the sub-agent' });
  await waitFor(async () => (await chat(helper.id)).awaitedBy === main.id && (await chat(main.id)).status === 'running', { timeout: 25000, what: 'the call waits' });
  assert.deepEqual((await h.api('POST', `/api/sessions/${main.id}/messages`, { text: 'и ещё sowa поправь' })).body, { queued: true });
  // the deadline ends the wait: the call returns at once, the helper goes on in the background and the message is read
  await waitFor(async () => !(await chat(helper.id)).awaitedBy, { timeout: steerMs + 20000, what: 'the call released' });
  await waitFor(async () => { const x = await chat(main.id); return x.queue?.length === 0 && x.turnCount >= 2; }, { timeout: 20000, what: 'the message read next turn' });
  await waitFor(async () => (await h.api('GET', `/api/sessions/${main.id}/messages`)).body.some((m) => m.kind === 'user' && m.text.includes('и ещё sowa поправь')), { what: 'the message in its transcript' });
  const h2 = await chat(helper.id);
  assert.equal(!!h2.pid || h2.status === 'archived', true, 'nothing was killed');
  const msgs = (await h.api('GET', `/api/sessions/${main.id}/messages`)).body;
  assert.equal(msgs.some((m) => m.text === 'Остановлено пользователем'), false, 'the person stopped nothing');
  // its own work ran to the end: the step was not cut, only the call that waited
  assert.ok(msgs.some((m) => m.kind === 'assistant' && m.text.includes('Done.')), 'its own step ran to the end');
  await waitFor(async () => (await chat(main.id)).status !== 'running', { timeout: 25000, what: 'main settled' });
});

test('«Ответь ему: send_message»: an answer to a helper ends the call it waits in, not its own work', async () => {
  // the caller long-polls in its call (bridge of the agent tool); the reply to the helper must end that call at once,
  // not at the deadline, and the helper's own work goes on to the end
  const caller = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: '#agentmcp Explore разведка #hang 8000' })).body;
  const child = await waitFor(async () => (await state()).sessions.find((s) => s.parentId === caller.id && !s.virtual), { timeout: 25000, what: 'the sub-agent' });
  await waitFor(async () => (await chat(child.id))?.pid && (await chat(child.id)).awaitedBy === caller.id, { timeout: 25000, what: 'the child works' });
  // the sub-agent streams before its own #hang: the call to it reaches the caller's transcript only then
  await waitFor(async () => (await h.api('GET', `/api/sessions/${caller.id}/messages`)).body.some((m) => m.tool?.name === 'agent'), { timeout: 25000, what: 'the caller shows its call' });
  const sent = await h.api('POST', '/api/agent/send_message', { to: child.id, body: 'ответь портом 8080' }, { 'x-harness-session': caller.id });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.queued, true, 'the message itself waits behind the running turn');
  // ended by the release (`released` is what the long-poll reads) or, if its poll got there first, by that poll itself:
  // either way no deadline was waited for — the deadline alone would take steerAfterMs
  const moved = await waitFor(async () => { const x = await chat(child.id); return x && !x.awaitedBy ? x : null; }, { timeout: 4000, what: 'the call ended without a deadline' });
  assert.ok(moved.released !== undefined, 'the call is off the wait of the caller');
  // the note comes back as the result of the call itself (the bridge returns it in place of the sub-agent's report)
  const output = await waitFor(async () => {
    const call = (await h.api('GET', `/api/sessions/${caller.id}/messages`)).body.find((m) => m.kind === 'tool' && m.tool?.name === 'agent');
    return /Тебе написали/.test(String(call?.tool?.output ?? '')) ? call.tool.output : null;
  }, { timeout: 15000, what: 'the caller got the note with the call\'s end' });
  assert.match(output, /итог придёт/);
  await waitFor(async () => (await h.api('GET', `/api/sessions/${child.id}/messages`)).body.some((m) => m.kind === 'user' && m.text.includes('ответь портом 8080')), { what: 'the reply in its transcript' });
  assert.ok((await h.api('GET', `/api/sessions/${child.id}/messages`)).body.some((m) => m.kind === 'assistant' && m.text.includes('Done.')), 'its own work ran to the end');
});

test('a message from another session ends the call it waits in — by the deadline, its own work not cut', async () => {
  // an orchestrator's reply cannot be read in this turn (ACP: one session/prompt): the call ends, the step done with
  // its own work ends by itself, the reply is read next turn — nobody waits for the sub-agent's whole run
  const other = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: '#agentmcp Explore разведка #hang 5000' })).body;
  const child = await waitFor(async () => (await state()).sessions.find((s) => s.parentId === other.id && !s.virtual), { timeout: 25000, what: 'the sub-agent' });
  await waitFor(async () => (await chat(child.id))?.pid && (await chat(child.id)).awaitedBy === other.id, { timeout: 25000, what: 'the child works' });
  const sent = await h.api('POST', '/api/agent/send_message', { to: child.id, body: 'ответь портом 8080' }, { 'x-harness-session': other.id });
  assert.equal(sent.body.queued, true, 'the message waits behind the running turn');
  await waitFor(async () => !(await chat(child.id)).awaitedBy, { timeout: steerMs + 20000, what: 'the call ended' });
  await waitFor(async () => (await h.api('GET', `/api/sessions/${child.id}/messages`)).body.some((m) => m.kind === 'user' && m.text.includes('ответь портом 8080')), { timeout: 20000, what: 'the reply read next turn' });
  const msgs = (await h.api('GET', `/api/sessions/${other.id}/messages`)).body;
  assert.ok(msgs.some((m) => m.kind === 'assistant' && m.text.includes('Done.')), 'its own work ran to the end');
});

test('a step working by itself is never cut: the message comes right after it', async () => {
  const main = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: '#hang 4000' })).body;
  await waitFor(async () => (await chat(main.id))?.status === 'running' && (await chat(main.id)).pid, { what: 'main running' });
  assert.deepEqual((await h.api('POST', `/api/sessions/${main.id}/messages`, { text: 'ещё вопрос' })).body, { queued: true });
  // 4 s is well past the deadline (1.5 s): its own work still ends by itself, nothing is cut
  await waitFor(async () => (await h.api('GET', `/api/sessions/${main.id}/messages`)).body.some((m) => m.kind === 'user' && m.text === 'ещё вопрос'), { timeout: 20000, what: 'the message read' });
  const msgs = (await h.api('GET', `/api/sessions/${main.id}/messages`)).body;
  assert.equal(msgs.some((m) => m.text === 'Остановлено пользователем'), false);
  assert.ok(msgs.some((m) => m.kind === 'assistant' && m.text.includes('Done.')), 'its own step ran to the end');
  await waitFor(async () => (await chat(main.id)).status !== 'running', { timeout: 20000, what: 'main settled' });
});
