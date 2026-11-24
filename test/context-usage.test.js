import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContextUsage, contextBreakdown } from '../server/context-usage.js';

// GigaCode's own «/context» before any API response: a window line and the start-up sections only
const STARTUP = `## Context Usage\x20\x20
\x20\x20
*No API response yet. Send a message to see actual usage.*\x20\x20
\x20\x20
**Estimated pre-conversation overhead**\x20\x20
Model: DeepSeek-V4.1-Flash-1017  Context window: 262.1k tokens\x20\x20
\x20\x20
  System prompt                       5.2k tokens (2.0%)\x20\x20
  Built-in tools                     14.2k tokens (5.4%)\x20\x20
  Memory files                       17.6k tokens (6.7%)\x20\x20
  Skills                             13.6k tokens (5.2%)\x20\x20
  Startup context                     1.2k tokens (0.4%)\x20\x20
\x20\x20
*Run /context detail for per-item breakdown.*`;

test('the window and the sections of a /context answer', () => {
  const r = parseContextUsage(STARTUP);
  assert.equal(r.limit, 262100);
  assert.equal(r.used, null); // no spent total in this answer
  assert.deepEqual(r.items.map((x) => [x.label, x.tokens]), [
    ['System prompt', 5200], ['Built-in tools', 14200], ['Memory files', 17600], ['Skills', 13600], ['Startup context', 1200],
  ]);
});

test('a spent total and unknown sections still parse; no window line means no report', () => {
  const r = parseContextUsage(`${STARTUP.replace('*No API response yet. Send a message to see actual usage.*', '**Free space**: 200.0k tokens (76.3%)')}
  Conversation                        40k tokens (15.3%)  `);
  assert.equal(r.used, 62100); // the window (262.1k) minus the free space
  assert.equal(r.items.at(-1).label, 'Conversation');
  assert.equal(parseContextUsage('Готово, ничего про контекст'), null);
  assert.equal(parseContextUsage('Context window: 262.1k tokens'), null); // a window without sections is not a breakdown
});

test('the breakdown: startup only is partial, the conversation comes from the reported total', () => {
  const b = contextBreakdown(parseContextUsage(STARTUP), 60000);
  assert.equal(b.limit, 262100);
  assert.equal(b.used, 60000); // the reported total wins over the start-up sections alone
  assert.equal(b.partial, true);
  assert.equal(b.unaccounted, 8200); // 60000 - the sections (5.2k + 14.2k + 17.6k + 13.6k + 1.2k)
  const withConversation = contextBreakdown(parseContextUsage(STARTUP), 400000);
  assert.equal(withConversation.unaccounted, 348200);
  const full = contextBreakdown(parseContextUsage(`${STARTUP.replace('*No API response yet. Send a message to see actual usage.*', '**Free space**: 200.0k tokens (76.3%)')}
  Conversation                        40k tokens (15.3%)  `), null);
  assert.equal(full.partial, false);
  assert.equal(full.used, 62100);
  assert.deepEqual(full.items.at(-1), { label: 'Conversation', tokens: 40000 });
});
