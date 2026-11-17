// CLI session history: chats the agent CLI recorded itself (chatRecording), e.g. sessions started in a terminal outside
// the harness. Read-only; VERIFY the real GigaCode location/format (docs/GIGACODE-FACTS.md, open question 12).
// Expected Gemini/Qwen-style records: <dir>/<projectHash>/chats/*.json = { sessionId, projectHash, startTime, lastUpdated,
// messages: [{ id, timestamp, type: 'user'|'gemini'|'assistant', content, thoughts?, toolCalls?, model? }] }.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expandHome } from './config.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** `*` in any path segment (e.g. ~/.gigacode/tmp/*\/chats); directories only. */
export function globDirs(pattern) {
  const abs = path.resolve(expandHome(pattern));
  const { root } = path.parse(abs);
  let found = [root];
  for (const seg of abs.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    if (!seg.includes('*')) {
      found = found.map((d) => path.join(d, seg)).filter((d) => fs.existsSync(d));
      continue;
    }
    const re = new RegExp(`^${seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
    found = found.flatMap((d) => {
      try {
        return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && re.test(e.name)).map((e) => path.join(d, e.name));
      } catch {
        return [];
      }
    });
  }
  return found.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return content?.text ?? '';
};

/** One file -> a record { id, projectHash, cwd, startedAt, updatedAt, model, messages } or { raw: true, ... }. */
export function parseHistoryFile(file, text) {
  const base = path.basename(file).replace(/\.(jsonl?|ndjson)$/i, '');
  const dirHash = path.basename(path.dirname(path.dirname(file))); // <hash>/chats/<file>
  let rec = null;
  try {
    const obj = JSON.parse(text);
    if (obj && Array.isArray(obj.messages)) rec = obj;
  } catch {
    // JSONL: one message (or event) per line
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
    if (lines.length && lines.every(Boolean)) rec = { sessionId: lines.find((l) => l.sessionId)?.sessionId, messages: lines.filter((l) => l.type || l.role) };
  }
  if (!rec) return { id: base, raw: true, text: text.slice(0, 20000), projectHash: dirHash, messages: [] };
  const stamps = rec.messages.map((m) => Date.parse(m.timestamp)).filter(Number.isFinite);
  return {
    id: String(rec.sessionId || rec.id || base),
    projectHash: rec.projectHash || dirHash,
    cwd: rec.cwd || rec.projectRoot || null,
    startedAt: Date.parse(rec.startTime) || stamps[0] || null,
    updatedAt: Date.parse(rec.lastUpdated) || stamps.at(-1) || null,
    model: rec.model || rec.messages.findLast?.((m) => m.model)?.model || null,
    messages: rec.messages,
  };
}

/** Recorded messages -> transcript Message shapes (user / thought / assistant / tool), read-only. */
export function historyMessages(rec, agent) {
  if (rec.raw) return [{ id: 'h_raw', kind: 'system', text: `Нераспознанный формат истории (${rec.id}):\n${rec.text}`, at: null, imported: true }];
  const out = [];
  rec.messages.forEach((m, i) => {
    const at = Date.parse(m.timestamp) || null;
    const id = (k) => `h_${i}_${k}`;
    const type = String(m.type || m.role || '').toLowerCase();
    if (type === 'user') {
      out.push({ id: id('u'), kind: 'user', text: textOf(m.content), from: 'user', at, imported: true });
      return;
    }
    if (!['gemini', 'assistant', 'model'].includes(type)) return; // info/error events of the CLI are skipped
    for (const t of m.thoughts || []) {
      const text = typeof t === 'string' ? t : [t.subject, t.description].filter(Boolean).join(': ');
      if (text) out.push({ id: id(`t${out.length}`), kind: 'thought', text, at, imported: true });
    }
    const said = textOf(m.content);
    if (said) out.push({ id: id('a'), kind: 'assistant', text: said, at, imported: true });
    for (const c of m.toolCalls || []) {
      const output = c.resultDisplay ?? c.result ?? null;
      out.push({
        id: id(`c${out.length}`), kind: 'tool', text: c.name, at, imported: true,
        tool: { id: c.id || id('c'), name: c.displayName || c.name, input: c.args ?? null, output: typeof output === 'string' ? output : output == null ? null : JSON.stringify(output), status: /error|fail|cancel/i.test(c.status || '') ? 'error' : 'ok' },
      });
    }
  });
  return out.map((m) => ({ ...m, agent }));
}

/** Per-agent history readers (async) with a file-mtime cache and a per-folder index of explicit cwds. */
export function createHistory(config) {
  const cache = new Map(); // file -> { mtimeMs, rec }
  const dirIndex = new Map(); // <hash>/chats folder -> { mtimeMs, cwds } — the explicit cwds its records name

  async function readRec(file) {
    let st;
    try { st = await fs.promises.stat(file); } catch { return null; }
    let hit = cache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      let rec;
      try { rec = parseHistoryFile(file, await fs.promises.readFile(file, 'utf8')); } catch { return null; }
      hit = { mtimeMs: st.mtimeMs, rec: { ...rec, file, updatedAt: rec.updatedAt || st.mtimeMs } };
      cache.set(file, hit);
    }
    return hit.rec;
  }

  async function dirRecords(dir) {
    let files = [];
    try { files = (await fs.promises.readdir(dir)).filter((f) => /\.(jsonl?|ndjson)$/i.test(f)); } catch {}
    return (await Promise.all(files.map((name) => readRec(path.join(dir, name))))).filter(Boolean);
  }

  /** Records of `agent`; with `wanted(hash, cwds)` only the folders it accepts are read (the others: a stat). */
  async function records(agent, wanted = null) {
    const out = [];
    for (const dir of (config.agents[agent]?.history?.dirs || []).flatMap(globDirs)) {
      if (wanted) {
        let st;
        try { st = await fs.promises.stat(dir); } catch { continue; }
        let idx = dirIndex.get(dir);
        if (!idx || idx.mtimeMs !== st.mtimeMs) {
          idx = { mtimeMs: st.mtimeMs, cwds: [...new Set((await dirRecords(dir)).map((r) => r.cwd).filter(Boolean))] };
          dirIndex.set(dir, idx);
        }
        if (!wanted(path.basename(path.dirname(dir)), idx.cwds)) continue;
      }
      out.push(...(await dirRecords(dir)));
    }
    return out;
  }

  /** sha256 of the cwd and its main-worktree root (Windows: both drive-letter cases, as CLIs differ). */
  function hashesFor(paths) {
    const set = new Set();
    for (const p of paths.filter(Boolean)) {
      const abs = path.resolve(p);
      set.add(sha256(abs));
      if (/^[a-z]:/i.test(abs)) {
        set.add(sha256(abs[0].toLowerCase() + abs.slice(1)));
        set.add(sha256(abs[0].toUpperCase() + abs.slice(1)));
      }
    }
    return set;
  }

  const same = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  const agentsWithHistory = () => Object.keys(config.agents).filter((id) => config.agents[id]?.history?.dirs?.length && config.agents[id].enabled !== false);

  return {
    /** Recorded sessions of `paths` (the cwd and its main worktree), newest first. */
    async list(paths, linkedFor) {
      const hashes = hashesFor(paths);
      const ours = (cwd) => paths.some((p) => p && same(p, cwd));
      const out = [];
      for (const agent of agentsWithHistory()) {
        // only this project's <hash>/chats folders, plus folders whose records name this cwd explicitly
        for (const rec of await records(agent, (hash, cwds) => hashes.has(hash) || cwds.some(ours))) {
          const mine = rec.cwd ? paths.some((p) => p && same(p, rec.cwd)) : hashes.has(rec.projectHash);
          if (!mine) continue;
          const firstUser = rec.messages.find((m) => String(m.type || m.role).toLowerCase() === 'user');
          out.push({
            id: rec.id, agent, cwd: rec.cwd || paths[0], file: rec.file, model: rec.model,
            title: (firstUser ? textOf(firstUser.content) : path.basename(rec.file)).replace(/\s+/g, ' ').trim().slice(0, 80),
            startedAt: rec.startedAt ?? null, updatedAt: rec.updatedAt ?? null, messages: rec.messages.length,
            linkedSessionId: linkedFor(agent, rec.id), ...(rec.raw ? { raw: true } : {}),
          });
        }
      }
      return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    async get(agent, id) {
      if (!config.agents[agent]) fail(404, `агент ${agent} не найден`);
      return (await records(agent)).find((r) => r.id === id) || fail(404, `сессия истории ${id} не найдена`);
    },
  };
}
