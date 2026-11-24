// CLI chats are ordinary chats: what the agent CLI recorded itself (server/history.js) becomes a harness chat session
// (origin 'cli', externalSessionId = the record's session id), grouped like any chat and continued with --resume.
// Archived / deleted adopted chats are remembered in db.cliIgnored and never adopted again.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as git from './git.js';
import { historyMessages, historyFolder, globDirs, FOLDER_LINE } from './history.js';

const HELPER_PROMPT = /^(\/models|\/context|\/compress|HARNESS_GENERATE_MESSAGE)\b/;
const HARNESS_BLOCK = /^\s*(\[harness\]|Ты работаешь внутри harness)/;
// a helper / worker / reviewer the harness ran: its result already reached its parent — never a chat of its own again
// (over ACP the CLI's record id is not the harness session's, so the owner match alone misses it)
const HELPER_RUN = /\[harness\] (Ты — субагент|You are a (WORKER|REVIEWER))|^Субагенты не запускают своих субагентов/;
/** A record of a helper the harness ran (a sticky `lastIndex` of the shared regex would skip the next record). */
const isHelperRun = (text) => { HELPER_RUN.lastIndex = 0; return HELPER_RUN.test(text); };
const SETTLE_MS = 15000; // after a harness turn the CLI may still write that turn into its record
/** A chat of the agent CLI: continued with --resume, never given the harness preamble. */
export const CLI_ORIGIN = 'cli';
const sha = (p) => createHash('sha256').update(p).digest('hex');
const inside = (dir, p) => { const r = path.relative(dir, p); return !r.startsWith('..') && !path.isAbsolute(r); };
const same = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** The first meaningful line of a user message: harness preamble / context paragraphs left out, ≤ 80 chars. */
export function cliTitle(text) {
  const kept = String(text ?? '').split(/\n\s*\n/).filter((p) => !HARNESS_BLOCK.test(p)).join('\n');
  return kept.split('\n').map((l) => l.trim()).find(Boolean)?.replace(/^\//, '').replace(/\s+/g, ' ').slice(0, 80) || null;
}

/** A run of the harness itself or a one-command probe, not a conversation. */
export function isServiceChat(userTexts, answers = 0) {
  const first = String(userTexts[0] ?? '').trim();
  // a probe: one message to the agent and nothing back that a person would read (these runs are never worth a chat)
  // (a GigaCode record opens its first message with the folder on a line of its own)
  const lines = first.split(/\n/);
  const text = lines.length > 1 && FOLDER_LINE(lines[0]) ? lines.slice(1).join('\n').trim() : first;
  if (!text || HELPER_PROMPT.test(text)) return true;
  const [lead, ...rest] = text.split(/\n\s*\n/);
  // a helper's run opens with «Субагенты не …» and is either the whole message or the block above the [harness] one;
  // a top-level chat keeps its preamble instead, so the rest of its message decides
  const helper = isHelperRun(text) && (/^Субагенты не/.test(lead) ? !rest.length || rest.every((p) => HARNESS_BLOCK.test(p)) : !HARNESS_BLOCK.test(lead));
  if (helper || (userTexts.length === 1 && answers === 0 && /^\//.test(text))) return true;
  return userTexts.length === 1 && answers === 0;
}

export function createAdopter({ config, store, sessions, history }) {
  const db = store.db;
  let running = new Map(); // days (null = the default window) -> the pass in flight

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

  /** Folders the CLI keeps its records in (config history.dirs): not a run of the harness, even inside its data folder. */
  function recordFolders() {
    const dirs = [config.history?.dirs, ...Object.values(config.agents).map((a) => a?.history?.dirs)].flat().filter(Boolean);
    return dirs.flatMap(globDirs);
  }

  /**
   * The folder of a record none of the known folders claims: a real one the CLI ran in (its own `cwd`, or the one named
   * where the record keeps it) that is not a run folder of the harness. It becomes the chat's folder as is.
   */
  async function adoptableFolder(rec, msgs, records) {
    const named = [rec.cwd, historyFolder(rec)].find((p) => typeof p === 'string' && path.isAbsolute(p));
    if (!named) return null;
    let real;
    try { real = await fs.promises.realpath(named); } catch { return null; }
    const harnessRun = (inside(store.dataDir, real) || inside(real, store.dataDir)) && !records.some((d) => inside(d, real));
    return harnessRun ? null : real;
  }

  /** The title of an adopted chat: the first meaningful line of what the person wrote (the record's folder line is gone). */
  function adoptedTitle(rec, msgs) {
    return cliTitle(String(msgs.find((m) => m.kind === 'user')?.text ?? '')) || `Чат CLI ${String(rec.id).slice(0, 8)}`;
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
    // the CLI itself wrote this: the chat is read-only here for a while (sessions.cliLive)
    sessions.update(s.id, { cliRecordAt: rec.updatedAt, cliRecordCount: rec.messages.length, cliLiveAt: rec.updatedAt || null, lastActivityAt: Math.max(s.lastActivityAt || 0, rec.updatedAt || 0) });
    return true;
  }

  /** Records touched since `since` (the adoptDays window); `since` null reads every record ever written. */
  async function recent(since) {
    const all = await history.recent(0);
    return since == null ? all : all.filter(({ rec }) => (rec.updatedAt || 0) >= since);
  }

  async function pass({ since = Date.now() - Number(config.history?.adoptDays ?? 14) * 86400000 } = {}) {
    if (config.history?.adopt === false) return { adopted: 0, refreshed: 0 };
    const ignored = new Set(db.cliIgnored || []);
    const owned = new Map(db.sessions.filter((s) => s.externalSessionId).map((s) => [s.externalSessionId, s]));
    const folders = await knownFolders();
    const records = recordFolders();
    let adopted = 0;
    let refreshed = 0;
    // the chats a record belongs to: what a later pass must not adopt again while the record is still there
    const touched = new Map(); // chat id -> the record's id
    for (const { agent, rec } of await recent(since)) {
      if (rec.raw || /\.runtime\.json$/i.test(rec.file) || ignored.has(rec.id)) continue;
      const msgs = historyMessages(rec, agent);
      const own = owned.get(rec.id);
      // adopted before this fix: a helper's run shown as a CLI chat goes to the archive (still openable)
      if (own?.origin === 'cli' && !own.archived && isHelperRun(msgs.find((m) => m.kind === 'user')?.text ?? '')) { sessions.archive(own.id, true); continue; }
      // a chat already of this record — a harness chat opened from it in the UI, or one adopted before — is not adopted again
      if (own) {
        const users = msgs.filter((m) => m.kind === 'user').map((m) => m.text);
        const answers = msgs.filter((m) => m.kind === 'assistant' && m.text.trim()).length;
        // a run the CLI recorded before it said anything worth a chat does not own the chat: its real content is still
        // to be refreshed into it (the record of a probe the harness itself ran must not freeze the chat for good)
        if (isServiceChat(users, answers)) continue;
        touched.set(own.id, rec.id);
        if (own.origin !== 'cli') continue; // a harness chat's own CLI session
        if (rec.startedAt && own.createdAt > rec.startedAt) sessions.update(own.id, { createdAt: rec.startedAt }); // adopted before this fix
        if (refresh(own, rec, msgs)) refreshed++;
        continue;
      }
      const users = msgs.filter((m) => m.kind === 'user').map((m) => m.text);
      const answers = msgs.filter((m) => m.kind === 'assistant' && m.text.trim()).length;
      if (!users.length || isServiceChat(users, answers)) continue;
      let cwd = rec.cwd && fs.existsSync(rec.cwd) ? path.resolve(rec.cwd) : folders.get(rec.projectHash);
      // a folder no project has yet is a project too: the CLI was used there before the board ever was
      const runOfHarness = !!cwd && inside(store.dataDir, cwd) && !records.some((d) => inside(d, cwd));
      if (!cwd || runOfHarness) cwd = await adoptableFolder(rec, msgs, records);
      if (!cwd) continue; // unknown folder, or a run of the harness itself
      const s = await sessions.create({ kind: 'chat', agent, cwd, title: adoptedTitle(rec, msgs), origin: CLI_ORIGIN });
      sessions.importMessages(s.id, msgs);
      sessions.update(s.id, { createdAt: rec.startedAt || rec.updatedAt || s.createdAt, externalSessionId: rec.id, historyId: rec.id, lastActivityAt: rec.updatedAt || Date.now(), cliRecordAt: rec.updatedAt, cliRecordCount: rec.messages.length, cliLiveAt: rec.updatedAt || null });
      touched.set(s.id, rec.id);
      adopted++;
    }
    // a chat deleted from the harness while its record stays is not a record of the person to adopt: the record is
    // remembered as ignored, so it never comes back as a «CLI chat» of the same or another folder
    for (const [chatId, recordId] of touched) if (!sessions.find(chatId)) sessions.ignoreCli({ externalSessionId: recordId });
    return { adopted, refreshed };
  }

  return {
    /** One pass over the records touched within `adoptDays` (or over all of them) → { adopted, refreshed }. */
    adopt(days) {
      const key = days ?? null;
      const run = running.get(key) || pass(days == null ? {} : { since: Date.now() - days * 86400000 });
      running.set(key, run);
      run.finally(() => { if (running.get(key) === run) running.delete(key); }).catch(() => {});
      return run;
    },
  };
}
