// CLI chats are ordinary chats: what the agent CLI recorded itself (server/history.js) becomes a harness chat session
// (origin 'cli', externalSessionId = the record's session id), grouped like any chat and continued with --resume.
// Archived / deleted adopted chats are remembered in db.cliIgnored and never adopted again.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as git from './git.js';
import { historyMessages } from './history.js';

const HELPER_PROMPT = /^(\/models|\/context|\/compress|HARNESS_GENERATE_MESSAGE)\b/;
const HARNESS_BLOCK = /^\s*(\[harness\]|Ты работаешь внутри harness)/;
const SETTLE_MS = 15000; // after a harness turn the CLI may still write that turn into its record
const sha = (p) => createHash('sha256').update(p).digest('hex');
const inside = (dir, p) => { const r = path.relative(dir, p); return !r.startsWith('..') && !path.isAbsolute(r); };

/** The first meaningful line of a user message: harness preamble / context paragraphs left out, ≤ 80 chars. */
export function cliTitle(text) {
  const kept = String(text ?? '').split(/\n\s*\n/).filter((p) => !HARNESS_BLOCK.test(p)).join('\n');
  return kept.split('\n').map((l) => l.trim()).find(Boolean)?.replace(/^\//, '').replace(/\s+/g, ' ').slice(0, 80) || null;
}

/** A run of the harness itself or a one-command probe, not a conversation. */
export function isServiceChat(userTexts) {
  const first = String(userTexts[0] ?? '').trim();
  return !first || HELPER_PROMPT.test(first) || (userTexts.length === 1 && /^\/\S+$/.test(first));
}

export function createAdopter({ config, store, sessions, history }) {
  const db = store.db;
  let running = null;

  /** sha256 of every folder a CLI chat may belong to (projects, their worktrees, the projects root's folders, chats). */
  async function knownFolders() {
    const paths = new Set();
    for (const w of db.workspaces) {
      paths.add(w.path);
      if (w.isGit) for (const wt of await git.worktrees(w.path).catch(() => [])) paths.add(wt.path);
      if (w.kind === 'root') {
        try {
          for (const d of fs.readdirSync(w.path, { withFileTypes: true })) if (d.isDirectory()) paths.add(path.join(w.path, d.name));
        } catch {}
      }
    }
    for (const s of db.sessions) if (s.cwd && !s.virtual) paths.add(s.cwd);
    const byHash = new Map();
    for (const p of paths) {
      const abs = path.resolve(p);
      for (const v of /^[a-z]:/i.test(abs) ? [abs, abs[0].toLowerCase() + abs.slice(1), abs[0].toUpperCase() + abs.slice(1)] : [abs]) byHash.set(sha(v), abs);
    }
    return byHash;
  }

  /** The adopted chat follows its record: replaced before the first harness turn, appended after CLI-side activity. */
  function refresh(s, rec, msgs) {
    if ((rec.updatedAt || 0) <= (s.cliRecordAt || 0) || sessions.isRunning(s.id)) return false;
    if (!s.cliImportedAt) {
      sessions.importMessages(s.id, msgs);
    } else if (s.cliSyncAfter) {
      if (Date.now() < s.cliSyncAfter) return false; // the harness's own turn is still being recorded
      sessions.update(s.id, { cliSyncAfter: null, cliRecordCount: rec.messages.length, cliRecordAt: rec.updatedAt });
      return false; // those were the harness turns: nothing new from the CLI side
    } else {
      const fresh = msgs.filter((m) => Number(m.id.match(/^h_(\d+)_/)?.[1] ?? -1) >= (s.cliRecordCount || 0));
      if (!fresh.length) return false;
      sessions.importMessages(s.id, fresh, s.turnCount || 0);
    }
    sessions.update(s.id, { cliRecordAt: rec.updatedAt, cliRecordCount: rec.messages.length, lastActivityAt: Math.max(s.lastActivityAt || 0, rec.updatedAt || 0) });
    return true;
  }

  async function pass() {
    if (config.history?.adopt === false) return { adopted: 0, refreshed: 0 };
    const since = Date.now() - Number(config.history?.adoptDays ?? 14) * 86400000;
    const ignored = new Set(db.cliIgnored || []);
    const owned = new Map(db.sessions.filter((s) => s.externalSessionId).map((s) => [s.externalSessionId, s]));
    const folders = await knownFolders();
    let adopted = 0;
    let refreshed = 0;
    for (const { agent, rec } of await history.recent(since)) {
      if (rec.raw || /\.runtime\.json$/i.test(rec.file) || ignored.has(rec.id)) continue;
      const msgs = historyMessages(rec, agent);
      const users = msgs.filter((m) => m.kind === 'user').map((m) => m.text);
      if (!users.length || isServiceChat(users)) continue;
      const own = owned.get(rec.id);
      if (own) {
        if (own.origin === 'cli' && rec.startedAt && own.createdAt > rec.startedAt) sessions.update(own.id, { createdAt: rec.startedAt }); // adopted before this fix
        if (own.origin === 'cli' && refresh(own, rec, msgs)) refreshed++;
        continue; // a harness chat's own CLI session
      }
      const cwd = rec.cwd && fs.existsSync(rec.cwd) ? path.resolve(rec.cwd) : folders.get(rec.projectHash);
      if (!cwd || inside(store.dataDir, cwd)) continue; // unknown folder, or a run of the harness itself
      const s = await sessions.create({ kind: 'chat', agent, cwd, title: cliTitle(users[0]) || `Чат CLI ${String(rec.id).slice(0, 8)}` });
      sessions.importMessages(s.id, msgs);
      sessions.update(s.id, { origin: 'cli', createdAt: rec.startedAt || rec.updatedAt || s.createdAt, externalSessionId: rec.id, historyId: rec.id, lastActivityAt: rec.updatedAt || Date.now(), cliRecordAt: rec.updatedAt, cliRecordCount: rec.messages.length });
      adopted++;
    }
    return { adopted, refreshed };
  }

  return {
    /** One adoption pass (concurrent calls share it) → { adopted, refreshed }. */
    adopt() {
      running ||= pass().finally(() => { running = null; });
      return running;
    },
  };
}
