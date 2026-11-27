// The safety net: an agent that ended its turn «жду …» with nothing of its own at work in the harness gets a nudge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
let h;
before(async () => {
  h = await startTestServer({ chat: { waitNudgeMin: 0.02 } }); // ~1 s instead of 10 min
});
after(async () => {
  await h.close();
  rmrf(root);
});

const messages = async (id) => (await h.api('GET', `/api/sessions/${id}/messages`)).body;
const nudges = async (id) => (await messages(id)).filter((m) => m.kind === 'user' && /Ты закончил ход тем, что ждёшь/.test(m.text));

test('«жду …» with nothing at work in the harness: nudged once the wait has gone quiet; a plain answer is not', async () => {
  const waiting = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: 'запусти #say Тесты идут в фоне, жду результат.' })).body;
  const plain = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: 'ответь #say Готово, всё сделано.' })).body;
  // a mention of what ran in the background is no wait (seen on the target: a nudge after «прогон в фоне завершился»)
  const told = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: 'ответь #say Фоновый прогон в фоне завершился с кодом 0, ничего нового делать не нужно. Ничего не жду — задача завершена.' })).body;
  await waitFor(async () => (await nudges(waiting.id)).length >= 1, { timeout: 20000, what: 'the nudge' });
  assert.equal((await nudges(plain.id)).length, 0, 'an answer that waits for nothing is left alone');
  assert.equal((await nudges(told.id)).length, 0, 'nor one that only tells what ran in the background');
});

const shellWakes = async (id) => (await messages(id)).filter((m) => m.kind === 'user' && /Фоновая команда/.test(m.text));
const shellCard = async (id) => (await messages(id)).find((m) => m.tool?.bgShell)?.tool.bgShell;

test('a background shell command: its card works on, its end wakes the agent with the last lines of its output', async () => {
  const cwd = tmpDir();
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd, prompt: 'запусти тесты #bgshell' })).body;
  await waitFor(async () => (await shellCard(s.id))?.state === 'running', { timeout: 10000, what: 'the running card' });
  await waitFor(async () => (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === s.id)?.status === 'idle', { timeout: 10000, what: 'the turn end' });
  assert.equal((await shellWakes(s.id)).length, 0, 'nothing while it runs');
  fs.writeFileSync(path.join(cwd, 'shell-mock.status'), 'status: completed\nexit_code: 0\n');
  await waitFor(async () => (await shellWakes(s.id)).length === 1, { timeout: 15000, what: 'the wake' });
  const [wake] = await shellWakes(s.id);
  assert.match(wake.text, /`mvn test` закончилась, код выхода 0/);
  assert.match(wake.text, /Tests run: 42/);
  assert.equal((await shellCard(s.id)).state, 'completed');
  rmrf(cwd);
});

test('a background shell whose process is gone without a final status: «оборвалась», never a silent wait', async () => {
  const cwd = tmpDir();
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd, prompt: 'запусти тесты #bgshell dead' })).body;
  await waitFor(async () => (await shellWakes(s.id)).length === 1, { timeout: 25000, what: 'the wake' });
  assert.match((await shellWakes(s.id))[0].text, /оборвалась/);
  assert.equal((await shellCard(s.id)).state, 'lost');
  rmrf(cwd);
});
