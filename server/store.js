// JSON persistence under <dataDir>: db.json, transcripts/<sid>.json, terms/<sid>.log, runs/<sid>/, token.
// Writes are debounced and atomic (tmp + rename); flush() writes everything synchronously (turn end, exit, signals).
// db.json and transcripts keep the previous good copy in <file>.bak; an unreadable file is restored from it on load.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DEBOUNCE_MS = 200; // contract: <= 250 ms (a journal append; whole files at the turn end)
const DB_EVERY_MS = 1000; // db.json changes with every agent event: rewritten at most once a second
const JOURNAL_MAX = 4 * 1024 * 1024; // a journal bigger than this is folded into its transcript
const RETRY_MS = 1000; // a failed write (file held by another process) is retried
const MAX_LOADED = 50; // transcripts kept in memory (LRU); one with a running turn always stays
export const TERM_LOG_MAX = 2 * 1024 * 1024;

const BAK_EVERY_MS = 10000; // the .bak is the last good copy, refreshed at most this often (big transcripts stream)
const bakAt = new Map(); // file -> last backup time

export function writeAtomic(file, data, backup = false) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  if (backup && Date.now() - (bakAt.get(file) || 0) >= BAK_EVERY_MS) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
      bakAt.set(file, Date.now());
    } catch {}
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows: rename fails while another process (AV, indexer) holds the target; plain write still keeps the data.
    try {
      fs.writeFileSync(file, data);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

/** JSON of a file; a corrupt one (not a missing one) is set aside as .corrupt-<ts> and its .bak used, reported via onRestore. */
function readJson(file, fallback, onRestore = () => {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    console.error(`[store] cannot read ${file}: ${e.message}`);
    try {
      const data = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
      onRestore(file);
      return data;
    } catch {
      return fallback;
    }
  }
}

export function createStore(dataDir) {
  for (const d of ['transcripts', 'terms', 'runs']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  const dbFile = path.join(dataDir, 'db.json');
  const restored = [];
  const db = { seq: { task: 0 }, tasks: [], workspaces: [], sessions: [], notifications: [], agentMeta: {}, ...readJson(dbFile, {}, (f) => restored.push(f)) };
  let onNotice = null;
  /** A notification about a restored file (db.notifications + the live channel once index.js connects it). */
  function restoredNotice(file) {
    const n = { id: `n_${randomBytes(4).toString('hex')}`, at: Date.now(), read: false, kind: 'error', sessionId: null, taskId: null, text: `${path.basename(file)} был повреждён — восстановлено из резервной копии` };
    db.notifications.push(n);
    mark('db');
    onNotice?.(n);
  }

  const tokenFile = path.join(dataDir, 'token');
  let token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  if (!token) {
    token = randomBytes(24).toString('hex');
    writeAtomic(tokenFile, token);
  }

  const transcripts = new Map(); // sid -> Message[]
  // per-message JSON: a streaming update re-serializes one message, not a whole 5k-message transcript
  const msgJson = new WeakMap(); // message object -> its JSON (dropped by putMessage)
  const transcriptJson = (list) => `[${list.map((m) => {
    let j = msgJson.get(m);
    if (j === undefined) msgJson.set(m, (j = JSON.stringify(m)));
    return j;
  }).join(',')}]`;
  const termLogs = new Map(); // sid -> string (ring)
  const dirty = new Set(); // 'db' | 't:<sid>' | 'term:<sid>'
  let timer = null;
  let closed = false;

  const fileFor = (key) => {
    if (key === 'db') return [dbFile, () => JSON.stringify(db)]; // compact: rewritten often while agents stream
    const [kind, sid] = key.split(':');
    if (kind === 't') return [path.join(dataDir, 'transcripts', `${sid}.json`), () => transcriptJson(transcripts.get(sid) || [])];
    return [path.join(dataDir, 'terms', `${sid}.log`), () => termLogs.get(sid) || ''];
  };

  // While agents stream, a whole 8 MB transcript rewritten 5 times a second (× every running chat, each a new file the
  // antivirus scans) loaded the CPU to 100%: between full writes, only what changed is appended to a journal.
  const journalOf = (sid) => path.join(dataDir, 'transcripts', `${sid}.jsonl`); // changed messages, one per line
  const changed = new Map(); // sid -> Map(message id -> message) since the last write
  const journalSize = new Map(); // sid -> bytes in its journal
  const termTail = new Map(); // sid -> output since the last write of its log
  const termSize = new Map(); // sid -> chars in the log file
  let dbAt = 0;

  /** Cheap writes (timer): journals and appends; `full` (turn end, exit, signals): every file whole, journals folded in. */
  function flush(full = true) {
    clearTimeout(timer);
    timer = null;
    let failed = false;
    let later = false;
    const keys = new Set(dirty);
    if (full) {
      keys.add('db'); // a full flush (turn end, close, a signal) always writes what is in memory now
      dirty.add('db');
    }
    if (full) for (const sid of journalSize.keys()) if (transcripts.has(sid)) keys.add(`t:${sid}`); // an evicted one stays journaled
    for (const key of keys) {
      const [file, data] = fileFor(key);
      const [kind, sid] = key.split(':');
      try {
        if (key === 'db' && !full && Date.now() - dbAt < DB_EVERY_MS) {
          later = true;
          continue;
        }
        if (kind === 't' && !full && fs.existsSync(file) && (journalSize.get(sid) || 0) < JOURNAL_MAX) {
          const lines = [...(changed.get(sid)?.values() ?? [])].map((m) => `${msgJson.get(m) ?? JSON.stringify(m)}\n`).join('');
          fs.appendFileSync(journalOf(sid), lines);
          journalSize.set(sid, (journalSize.get(sid) || 0) + Buffer.byteLength(lines));
        } else if (kind === 'term' && !full && fs.existsSync(file) && (termSize.get(sid) || 0) + (termTail.get(sid) || '').length < TERM_LOG_MAX * 2) {
          fs.appendFileSync(file, termTail.get(sid) || '');
          termSize.set(sid, (termSize.get(sid) || 0) + (termTail.get(sid) || '').length);
        } else {
          const text = data();
          writeAtomic(file, text, kind !== 'term');
          if (kind === 't') {
            // shortcut: a crash between these two lines replays older versions over the new file (a message shows older
            // streamed text); a sequence number per line would close it if it ever matters
            fs.rmSync(journalOf(sid), { force: true });
            journalSize.delete(sid);
          }
          if (kind === 'term') termSize.set(sid, text.length);
          if (key === 'db') dbAt = Date.now();
        }
        if (kind === 't') changed.delete(sid);
        if (kind === 'term') termTail.delete(sid);
        dirty.delete(key);
      } catch (e) {
        failed = true; // stays dirty (e.g. an antivirus holds the file): written on the retry
        console.error(`[store] write ${file} failed: ${e.message}`);
      }
    }
    if ((failed || later) && !closed) timer = setTimeout(() => flush(false), failed ? RETRY_MS : DB_EVERY_MS);
    evict();
  }

  function mark(key) {
    if (closed) return;
    dirty.add(key);
    timer ||= setTimeout(() => flush(false), DEBOUNCE_MS);
  }

  let keepLoaded = () => false; // sessions.js: a transcript with a running turn is never evicted
  function messages(sid) {
    let list = transcripts.get(sid);
    if (list) {
      transcripts.delete(sid); // Map order = least recently used first
    } else {
      list = readJson(path.join(dataDir, 'transcripts', `${sid}.json`), [], restoredNotice);
      // the journal's messages, newest version last (a line cut off by a crash is skipped)
      let journal = '';
      try { journal = fs.readFileSync(journalOf(sid), 'utf8'); } catch {}
      for (const line of journal.split('\n')) {
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        const i = list.findLastIndex((x) => x.id === m.id);
        if (i >= 0) list[i] = m;
        else list.push(m);
      }
      if (journal) journalSize.set(sid, Buffer.byteLength(journal));
      setTimeout(evict, 0).unref?.(); // not now: the caller holds this list
    }
    transcripts.set(sid, list);
    return list;
  }

  /** At most MAX_LOADED transcripts stay in memory: the least recently used, saved and idle ones go. */
  function evict() {
    let over = transcripts.size - MAX_LOADED;
    for (const sid of transcripts.keys()) {
      if (over <= 0) break;
      if (dirty.has(`t:${sid}`) || keepLoaded(sid)) continue;
      transcripts.delete(sid);
      over--;
    }
  }

  const onExit = () => flush(true);
  process.on('exit', onExit);
  for (const f of restored) restoredNotice(f);

  return {
    db,
    token,
    dataDir,
    save: () => mark('db'),
    set onNotice(fn) { onNotice = fn; },
    set keepLoaded(fn) { keepLoaded = fn; },
    loadedTranscripts: () => transcripts.size,
    flush: () => flush(true),
    messages,
    putMessage(sid, msg) {
      const list = messages(sid);
      msgJson.delete(msg); // updated in place while streaming
      let i = list.length - 1; // updates are almost always to the newest messages
      while (i >= 0 && list[i].id !== msg.id) i--;
      if (i >= 0) list[i] = msg;
      else list.push(msg);
      if (!changed.has(sid)) changed.set(sid, new Map());
      changed.get(sid).set(msg.id, msg);
      mark(`t:${sid}`);
      return msg;
    },
    termLog(sid) {
      if (!termLogs.has(sid)) {
        let text = '';
        try { text = fs.readFileSync(path.join(dataDir, 'terms', `${sid}.log`), 'utf8'); } catch {}
        termSize.set(sid, text.length);
        termLogs.set(sid, text.length > TERM_LOG_MAX ? text.slice(text.length - TERM_LOG_MAX) : text); // appended past the ring
      }
      return termLogs.get(sid);
    },
    appendTermLog(sid, data) {
      let text = this.termLog(sid) + data;
      if (text.length > TERM_LOG_MAX) text = text.slice(text.length - TERM_LOG_MAX);
      termLogs.set(sid, text);
      termTail.set(sid, (termTail.get(sid) || '') + data);
      mark(`term:${sid}`);
    },
    runDir(sid) {
      const dir = path.join(dataDir, 'runs', sid);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    removeSessionFiles(sid) {
      transcripts.delete(sid);
      termLogs.delete(sid);
      dirty.delete(`t:${sid}`);
      dirty.delete(`term:${sid}`);
      changed.delete(sid);
      journalSize.delete(sid);
      termTail.delete(sid);
      termSize.delete(sid);
      fs.rmSync(journalOf(sid), { force: true });
      fs.rmSync(path.join(dataDir, 'transcripts', `${sid}.json`), { force: true });
      fs.rmSync(path.join(dataDir, 'transcripts', `${sid}.json.bak`), { force: true });
      fs.rmSync(path.join(dataDir, 'terms', `${sid}.log`), { force: true });
    },
    close() {
      flush();
      closed = true;
      clearTimeout(timer);
      timer = null;
      process.off('exit', onExit);
    },
  };
}
