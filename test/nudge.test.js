// The safety net: an agent that ended its turn «жду …» with nothing of its own at work in the harness gets a nudge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
  await waitFor(async () => (await nudges(waiting.id)).length >= 1, { timeout: 20000, what: 'the nudge' });
  assert.equal((await nudges(plain.id)).length, 0, 'an answer that waits for nothing is left alone');
});
