// Read-only reader of an agent-internal sub-agent registry: <registryDir>/<agentId>/agent.json (+ log.jsonl tail).
// Some task commands run their own sub-agents and record them there; the harness only displays them.
// Rules: broken record -> skipped and listed in `problems`; `working` with no activity for idleWindowSec ->
// shown as `unverifiable` (the file is never rewritten); terminal states without settledAt are flagged.
import fs from 'node:fs';
import path from 'node:path';

export const STATES = ['queued', 'working', 'restarting', 'compacting', 'waiting', 'blocked', 'idle', 'done', 'failed', 'interrupted', 'unverifiable'];
const TERMINAL = ['done', 'failed', 'interrupted'];
const OPTIONAL = ['model', 'role', 'parentId', 'worktree', 'lastText', 'lastActivity', 'activity', 'settledAt'];

const LOG_TAIL = 16 * 1024;

/** Last parseable event of an append-only log.jsonl ({ ts, event, state, note?, tool? }), read from the file tail. */
function lastLogEvent(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, LOG_TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev && typeof ev === 'object') return ev;
      } catch {} // the first line of a tail window is usually cut
    }
  } catch {} finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

/** ISO string or epoch (s or ms) -> ms, else NaN */
function toMs(v) {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  return typeof v === 'string' ? Date.parse(v) : NaN;
}

export function readRegistry(dir, { idleWindowSec = 90, now = Date.now() } = {}) {
  const items = [];
  const problems = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return { items, problems };
  }
  for (const e of entries) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'agent.json'), 'utf8').replace(/^﻿/, ''));
      if (!rec || typeof rec !== 'object') throw new Error('not an object');
      for (const k of ['id', 'name', 'startedAt', 'state']) if (rec[k] == null || rec[k] === '') throw new Error(`missing ${k}`);
      if (!STATES.includes(rec.state)) throw new Error(`unknown state "${rec.state}"`);
      const item = { id: String(rec.id), name: String(rec.name), startedAt: rec.startedAt, state: rec.state, flags: [] };
      for (const k of OPTIONAL) item[k] = rec[k] ?? null;
      item.tokensIn = Number.isFinite(rec.tokensIn) ? rec.tokensIn : 0;
      item.tokensOut = Number.isFinite(rec.tokensOut) ? rec.tokensOut : 0;
      const ev = lastLogEvent(path.join(dir, e.name, 'log.jsonl'));
      item.lastEvent = ev ? { ts: ev.ts ?? null, event: ev.event ?? null, state: ev.state ?? null, note: ev.note ?? null, tool: ev.tool ?? null } : null;
      item.lastText ??= ev?.note ?? null;
      const last = toMs(rec.lastActivity ?? rec.startedAt);
      if (rec.state === 'working' && Number.isFinite(last) && now - last > idleWindowSec * 1000) {
        item.state = 'unverifiable';
        item.flags.push('stale: no activity within the idle window');
      }
      if (TERMINAL.includes(rec.state) && rec.settledAt == null) item.flags.push('missing settledAt');
      items.push(item);
    } catch (err) {
      problems.push({ agentId: e.name, error: err.code === 'ENOENT' ? 'agent.json missing' : err.message });
    }
  }
  items.sort((a, b) => (toMs(a.startedAt) || 0) - (toMs(b.startedAt) || 0));
  return { items, problems };
}
