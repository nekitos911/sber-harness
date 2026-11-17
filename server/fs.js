// Workspace file browser: list/read/write; every path is resolved against cwd and must stay inside it.
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { git } from './git.js';
import { spawnOptions } from './runner.js';

const MAX_TEXT = 2 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules']);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

const inside = (root, p) => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Resolves `rel` inside `cwd`; also checks the real path so symlinks cannot escape. */
export function resolveInside(cwd, rel = '') {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) fail(400, 'cwd должен быть существующей абсолютной папкой');
  if (typeof rel !== 'string') fail(400, 'path: нужна строка');
  const root = fs.realpathSync(cwd);
  const abs = path.resolve(root, rel);
  if (!inside(root, abs)) fail(400, 'путь выходит за пределы папки');
  // the real path of the deepest existing ancestor + the parts still missing: a junction/symlink anywhere above is seen
  let real = abs;
  const missing = [];
  for (;;) {
    try {
      real = path.join(fs.realpathSync(real), ...missing);
      break;
    } catch {
      const up = path.dirname(real);
      if (up === real) break;
      missing.unshift(path.basename(real));
      real = up;
    }
  }
  if (!inside(root, real)) fail(400, 'путь выходит за пределы папки');
  return { root, abs };
}

const relPosix = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

export function list(cwd, rel = '') {
  const { root, abs } = resolveInside(cwd, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    fail(e.code === 'ENOENT' ? 404 : 400, e.message);
  }
  return entries
    .filter((e) => !SKIP.has(e.name))
    .map((e) => {
      const p = path.join(abs, e.name);
      let size = 0;
      let dir = e.isDirectory();
      try {
        const st = fs.statSync(p);
        dir = st.isDirectory();
        size = dir ? 0 : st.size;
      } catch {}
      return { name: e.name, path: relPosix(root, p), dir, size };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export function readFile(cwd, rel) {
  const { root, abs } = resolveInside(cwd, rel);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    fail(404, `файл не найден: ${rel}`);
  }
  if (st.isDirectory()) fail(400, 'это папка, а не файл');
  const res = { path: relPosix(root, abs), content: '', size: st.size, binary: false };
  if (st.size > MAX_TEXT) return { ...res, binary: true }; // too large to show as text
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return { ...res, binary: true };
  return { ...res, content: buf.toString('utf8') };
}

export function writeFile(cwd, rel, content) {
  if (typeof content !== 'string') fail(400, 'content: нужна строка');
  if (!rel) fail(400, 'нужен путь (path)');
  const { abs } = resolveInside(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { ok: true };
}

// ---- @-mention search ----

const SEARCH_TTL_MS = 10000;
const WALK_CAP = 50000;
const fileCache = new Map(); // cwd -> { at, files }

function walk(root) {
  const files = [];
  const stack = [''];
  while (stack.length && files.length < WALK_CAP) {
    const rel = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(p);
      else files.push(p);
    }
  }
  return files;
}

/** Workspace files (git ls-files incl. untracked, not ignored; else a walk), cached per cwd for ~10 s. */
async function workspaceFiles(cwd) {
  const hit = fileCache.get(cwd);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.files;
  let files;
  try {
    files = (await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  } catch {
    files = walk(cwd);
  }
  files = [...new Set(files)];
  fileCache.set(cwd, { at: Date.now(), files });
  return files;
}

/** Subsequence match of q in text (both lower case): null or a score favouring consecutive and word-start hits. */
function subsequence(text, q) {
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const i = text.indexOf(ch, from);
    if (i < 0) return null;
    score += 1;
    if (i === prev + 1) score += 5;
    if (i === 0 || '/_-. '.includes(text[i - 1])) score += 3;
    prev = i;
    from = i + 1;
  }
  return score;
}

/** Fuzzy score of `query` in a path (null = no match): the better of a whole-path match and a file-name-only match. */
export function fuzzyScore(file, query) {
  const p = file.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const base = p.slice(p.lastIndexOf('/') + 1);
  const whole = subsequence(p, q);
  if (whole === null) return null;
  const inBase = subsequence(base, q);
  const best = Math.max(whole, inBase === null ? -Infinity : inBase + 10 + (base.includes(q) ? 20 : 0));
  return Math.round((best - p.length * 0.01) * 100) / 100;
}

export async function searchFiles(cwd, query = '', limit = 30) {
  resolveInside(cwd, '');
  const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const files = await workspaceFiles(path.resolve(cwd));
  if (!query.trim()) return files.slice().sort().slice(0, n).map((p) => ({ path: p, score: 0 }));
  const hits = [];
  for (const p of files) {
    const score = fuzzyScore(p, query);
    if (score !== null) hits.push({ path: p, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path)).slice(0, n);
}

// ---- folder browser (GET /api/fs/dirs): any folder on the machine, directories only ----
let rootsCache = null; // { at, roots }

/** Windows: drive letters (wmic, else probing A-Z); POSIX: / and the home folder. */
async function fsRoots() {
  if (process.platform !== 'win32') return ['/', os.homedir()];
  if (rootsCache && Date.now() - rootsCache.at < 60000) return rootsCache.roots;
  const out = await new Promise((resolve) => {
    execFile('wmic', ['logicaldisk', 'get', 'name'], spawnOptions({ timeout: 3000, encoding: 'utf8' }), (e, text) => resolve(e ? '' : text));
  });
  let roots = [...out.matchAll(/^([A-Z]):/gm)].map((m) => `${m[1]}:${path.sep}`);
  if (!roots.length) roots = [...'CDEFGHIJKLMNOPQRSTUVWXYZAB'].map((l) => `${l}:${path.sep}`).filter((r) => fs.existsSync(r));
  rootsCache = { at: Date.now(), roots };
  return roots;
}

export async function listDirs(dir, { hidden = false } = {}) {
  const p = path.resolve(dir || os.homedir());
  if (!path.isAbsolute(dir || p)) throw Object.assign(new Error('путь должен быть абсолютным'), { status: 400 });
  let entries;
  try {
    entries = await fs.promises.readdir(p, { withFileTypes: true });
  } catch (e) {
    throw Object.assign(new Error(`не удалось открыть ${p}: ${e.code || e.message}`), { status: e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 404 : 400 });
  }
  const parent = path.dirname(p);
  return {
    path: p,
    parent: parent === p ? null : parent,
    entries: entries
      .filter((d) => d.isDirectory() && (hidden || !/^[.$]/.test(d.name)))
      .map((d) => ({ name: d.name, path: path.join(p, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    roots: await fsRoots(),
  };
}

// ---- images for chat thumbnails (GET /api/fs/raw) ----
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
export const RAW_MAX = 10 * 1024 * 1024;

/** An image inside one of `bases` (the session cwd, then its includeDirs); same guard as every fs route. */
export function rawImage(bases, rel) {
  if (typeof rel !== 'string' || !rel) fail(400, 'нужен путь (path)');
  const type = IMAGE_TYPES[path.extname(rel).toLowerCase()] || fail(400, 'отдаются только картинки png, jpg, jpeg, gif, webp и svg');
  let abs = null;
  for (const base of bases) {
    try {
      abs = resolveInside(base, rel).abs;
      break;
    } catch {}
  }
  if (!abs) fail(400, 'путь вне папки сессии и её дополнительных папок');
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    fail(404, `не найдено: ${rel}`);
  }
  if (!st.isFile()) fail(404, `не файл: ${rel}`);
  if (st.size > RAW_MAX) fail(413, 'картинка больше 10 МБ');
  return { abs, type, size: st.size, mtimeMs: st.mtimeMs };
}
