// JSON persistence under <dataDir>: db.json, transcripts/<sid>.json, terms/<sid>.log, runs/<sid>/, token.
// Writes are debounced and atomic (tmp + rename); flush() writes everything synchronously (turn end, exit, signals).
// db.json and transcripts keep the previous good copy in <file>.bak; an unreadable file is restored from it on load.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DEBOUNCE_MS = 200; // contract: <= 250 ms
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
    fs.writeFileSync(file, data);
    fs.rmSync(tmp, { force: true });
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

  function flush() {
    clearTimeout(timer);
    timer = null;
    let failed = false;
    for (const key of [...dirty]) {
      const [file, data] = fileFor(key);
      try {
        writeAtomic(file, data(), !key.startsWith('term:'));
        dirty.delete(key);
      } catch (e) {
        failed = true; // stays dirty (e.g. an antivirus holds the file): written on the retry
        console.error(`[store] write ${file} failed: ${e.message}`);
      }
    }
    if (failed && !closed) timer = setTimeout(flush, RETRY_MS);
    evict();
  }

  function mark(key) {
    if (closed) return;
    dirty.add(key);
    timer ||= setTimeout(flush, DEBOUNCE_MS);
  }

  let keepLoaded = () => false; // sessions.js: a transcript with a running turn is never evicted
  function messages(sid) {
    let list = transcripts.get(sid);
    if (list) {
      transcripts.delete(sid); // Map order = least recently used first
    } else {
      list = readJson(path.join(dataDir, 'transcripts', `${sid}.json`), [], restoredNotice);
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

  const onExit = () => flush();
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
    flush,
    messages,
    putMessage(sid, msg) {
      const list = messages(sid);
      msgJson.delete(msg); // updated in place while streaming
      let i = list.length - 1; // updates are almost always to the newest messages
      while (i >= 0 && list[i].id !== msg.id) i--;
      if (i >= 0) list[i] = msg;
      else list.push(msg);
      mark(`t:${sid}`);
      return msg;
    },
    termLog(sid) {
      if (!termLogs.has(sid)) {
        let text = '';
        try { text = fs.readFileSync(path.join(dataDir, 'terms', `${sid}.log`), 'utf8'); } catch {}
        termLogs.set(sid, text);
      }
      return termLogs.get(sid);
    },
    appendTermLog(sid, data) {
      let text = this.termLog(sid) + data;
      if (text.length > TERM_LOG_MAX) text = text.slice(text.length - TERM_LOG_MAX);
      termLogs.set(sid, text);
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
      fs.rmSync(path.join(dataDir, 'transcripts', `${sid}.json`), { force: true });
      fs.rmSync(path.join(dataDir, 'transcripts', `${sid}.json.bak`), { force: true });
      fs.rmSync(path.join(dataDir, 'terms', `${sid}.log`), { force: true });
    },
    close() {
      flush();
      closed = true;
      process.off('exit', onExit);
    },
  };
}
