// JSON persistence under <dataDir>: db.json, transcripts/<sid>.json, terms/<sid>.log, runs/<sid>/, token.
// Writes are debounced and atomic (tmp + rename); flush() writes everything synchronously (exit, SIGINT).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DEBOUNCE_MS = 200;
export const TERM_LOG_MAX = 2 * 1024 * 1024;

export function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows: rename fails while another process (AV, indexer) holds the target; plain write still keeps the data.
    fs.writeFileSync(file, data);
    fs.rmSync(tmp, { force: true });
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[store] cannot read ${file}: ${e.message}`);
    return fallback;
  }
}

export function createStore(dataDir) {
  for (const d of ['transcripts', 'terms', 'runs']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  const dbFile = path.join(dataDir, 'db.json');
  const db = { seq: { task: 0 }, tasks: [], workspaces: [], sessions: [], notifications: [], ...readJson(dbFile, {}) };

  const tokenFile = path.join(dataDir, 'token');
  let token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  if (!token) {
    token = randomBytes(24).toString('hex');
    writeAtomic(tokenFile, token);
  }

  const transcripts = new Map(); // sid -> Message[]
  const termLogs = new Map(); // sid -> string (ring)
  const dirty = new Set(); // 'db' | 't:<sid>' | 'term:<sid>'
  let timer = null;

  const fileFor = (key) => {
    if (key === 'db') return [dbFile, () => JSON.stringify(db, null, 1)];
    const [kind, sid] = key.split(':');
    if (kind === 't') return [path.join(dataDir, 'transcripts', `${sid}.json`), () => JSON.stringify(transcripts.get(sid) || [])];
    return [path.join(dataDir, 'terms', `${sid}.log`), () => termLogs.get(sid) || ''];
  };

  function flush() {
    clearTimeout(timer);
    timer = null;
    for (const key of dirty) {
      const [file, data] = fileFor(key);
      try {
        writeAtomic(file, data());
      } catch (e) {
        console.error(`[store] write ${file} failed: ${e.message}`);
      }
    }
    dirty.clear();
  }

  function mark(key) {
    dirty.add(key);
    timer ||= setTimeout(flush, DEBOUNCE_MS);
  }

  function messages(sid) {
    if (!transcripts.has(sid)) transcripts.set(sid, readJson(path.join(dataDir, 'transcripts', `${sid}.json`), []));
    return transcripts.get(sid);
  }

  const onExit = () => flush();
  process.on('exit', onExit);

  return {
    db,
    token,
    dataDir,
    save: () => mark('db'),
    flush,
    messages,
    putMessage(sid, msg) {
      const list = messages(sid);
      const i = list.findIndex((m) => m.id === msg.id);
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
      fs.rmSync(path.join(dataDir, 'terms', `${sid}.log`), { force: true });
    },
    close() {
      flush();
      process.off('exit', onExit);
    },
  };
}
