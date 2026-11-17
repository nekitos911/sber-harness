// Workspace file browser: list/read/write; every path is resolved against cwd and must stay inside it.
import fs from 'node:fs';
import path from 'node:path';

const MAX_TEXT = 2 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules']);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

const inside = (root, p) => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Resolves `rel` inside `cwd`; also checks the real path so symlinks cannot escape. */
export function resolveInside(cwd, rel = '') {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) fail(400, 'cwd must be an existing absolute directory');
  if (typeof rel !== 'string') fail(400, 'path must be a string');
  const root = fs.realpathSync(cwd);
  const abs = path.resolve(root, rel);
  if (!inside(root, abs)) fail(400, 'path escapes cwd');
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {
    try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch {}
  }
  if (!inside(root, real)) fail(400, 'path escapes cwd');
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
    fail(404, `file not found: ${rel}`);
  }
  if (st.isDirectory()) fail(400, 'path is a directory');
  const res = { path: relPosix(root, abs), content: '', size: st.size, binary: false };
  if (st.size > MAX_TEXT) return { ...res, binary: true }; // too large to show as text
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return { ...res, binary: true };
  return { ...res, content: buf.toString('utf8') };
}

export function writeFile(cwd, rel, content) {
  if (typeof content !== 'string') fail(400, 'content must be a string');
  if (!rel) fail(400, 'path is required');
  const { abs } = resolveInside(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { ok: true };
}
