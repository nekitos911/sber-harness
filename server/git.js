// git CLI wrappers (execFile, never a shell). Errors become { status: 400 } with git's stderr as message.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { expandHome } from './config.js';
import { killTree, spawnOptions } from './runner.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// never a prompt nobody can answer: no terminal/GUI credential prompts, ssh in batch mode
const gitEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0', // reads (status, diff, ...) never refresh/rewrite the index: its mtime is not activity
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=15',
});
const AUTH_RE = /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(publickey|Access denied|HTTP Basic|returned error: 40[13]|Host key verification failed/i;

/** timeoutSec: network operations (push/fetch/...) are killed (whole tree) after it, with a clear message. */
export function git(cwd, args, { ok = [0], timeoutSec = 0 } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) fail(400, `cwd должен быть существующей абсолютной папкой: ${cwd}`);
  if (timeoutSec > 0) return gitNetwork(cwd, args, ok, timeoutSec);
  return new Promise((resolve, reject) => {
    execFile('git', args, spawnOptions({ cwd, maxBuffer: 64 * 1024 * 1024, env: gitEnv() }), (err, stdout, stderr) => {
      const code = err ? err.code : 0;
      if (err && typeof code !== 'number') return reject(Object.assign(new Error(`ошибка запуска git: ${err.message}`), { status: 500 }));
      if (!ok.includes(code)) return reject(Object.assign(new Error((stderr || stdout || err.message).trim()), { status: 400 }));
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * A network operation that can never hang: git aborts stalled HTTP itself (lowSpeed*), the whole tree (POSIX: the
 * process group incl. git-remote-http) is killed at the deadline, and we settle on 'exit' (a surviving helper may keep
 * the pipes open, so 'close' alone is not enough), with a hard deadline after the kill.
 */
function gitNetwork(cwd, args, ok, timeoutSec) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'http.lowSpeedLimit=1000', '-c', `http.lowSpeedTime=${timeoutSec}`, ...args], spawnOptions({ cwd, env: gitEnv() }, { group: true }));
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let hard = null;
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hard);
      child.stdout.destroy();
      child.stderr.destroy();
      if (timedOut) return reject(Object.assign(new Error(`Нет ответа от удалённого репозитория за ${timeoutSec} с`), { status: 504 }));
      if (error) return reject(Object.assign(new Error(`ошибка запуска git: ${error.message}`), { status: 500 }));
      if (ok.includes(code)) return resolve({ code, stdout, stderr });
      const text = (stderr || stdout || `git завершился с кодом ${code}`).trim();
      if (AUTH_RE.test(text)) return reject(Object.assign(new Error(`Git требует авторизацию — выполните ${args[0]} в терминале этого рабочего дерева.\n${text}`), { status: 401 }));
      reject(Object.assign(new Error(text), { status: 400 }));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) killTree(child.pid); // never a reused pid
      hard = setTimeout(() => finish(null), 5000);
    }, timeoutSec * 1000);
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));
    child.on('exit', (code) => setTimeout(() => finish(code), 500).unref()); // output normally arrives before this
  });
}

const out = async (cwd, args) => (await git(cwd, args)).stdout.trim();

function fileStatus(x, y) {
  if (x === '?') return '?';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'U';
  if (x === 'R' || y === 'R') return 'R';
  if (x === 'A') return 'A';
  if (x === 'D' || y === 'D') return 'D';
  return 'M';
}

/**
 * git.excludeFromCommit: "dir/" = that folder at the repository top, "*.ext" = such files anywhere (an agent's build
 * output and logs: git's own pathspec «*» crosses folders too), otherwise a top-relative path.
 */
export const isService = (file, patterns = []) => patterns.some((p) => (p.startsWith('*') ? file.endsWith(p.slice(1))
  : p.endsWith('/') ? file.startsWith(p) : file === p || file.startsWith(`${p}/`)));
const excludeSpecs = (patterns = []) => patterns.map((p) => `:(top,exclude)${p}`);

export async function status(cwd, exclude = []) {
  const { stdout } = await git(cwd, ['status', '--porcelain=v1', '-b', '-z', '-uall']);
  const res = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('## ')) {
      const head = p.slice(3);
      const unborn = head.match(/^(?:No commits yet|Initial commit) on (.+)$/);
      if (unborn) res.branch = unborn[1];
      else if (!head.startsWith('HEAD (no branch)')) {
        const m = head.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
        res.branch = m[1];
        res.upstream = m[2] || null;
        res.ahead = Number(m[3]?.match(/ahead (\d+)/)?.[1] || 0);
        res.behind = Number(m[3]?.match(/behind (\d+)/)?.[1] || 0);
      }
      continue;
    }
    const [x, y] = p;
    if (x === 'R' || x === 'C') i++; // -z puts the original path of a rename in the next field
    const file = p.slice(3);
    // staged: the index side changed (git add was done for it)
    res.files.push({ path: file, x, y, status: fileStatus(x, y), staged: x !== ' ' && x !== '?', ...(isService(file, exclude) ? { service: true } : {}) });
  }
  return res;
}

const hasHead = async (cwd) => (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: [0, 1, 128] })).code === 0;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const UNTRACKED_MAX = { files: 200, bytes: 1024 * 1024 };

/**
 * Lines added/removed per file of a status (worktree + index vs HEAD: one `git diff --numstat`; an untracked file
 * counts its lines as added — at most 200 files of ≤ 1 MB, binary = null) → files with added/removed + totals.
 */
export async function lineStats(cwd, st) {
  const base = (await hasHead(cwd)) ? 'HEAD' : EMPTY_TREE;
  const { stdout } = await git(cwd, ['diff', base, '--numstat', '-z']);
  const counts = new Map();
  const parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    let file = m[3];
    if (!file) { file = parts[i + 2]; i += 2; } // a rename: "\0old\0new"
    counts.set(file, m[1] === '-' ? { added: null, removed: null } : { added: Number(m[1]), removed: Number(m[2]) });
  }
  let budget = UNTRACKED_MAX.files;
  const files = st.files.map((f) => {
    if (f.x !== '?') return { ...f, ...(counts.get(f.path) ?? { added: 0, removed: 0 }) };
    if (budget-- <= 0) return { ...f, added: null, removed: 0 };
    try {
      const abs = path.join(cwd, f.path);
      if (fs.statSync(abs).size > UNTRACKED_MAX.bytes) return { ...f, added: null, removed: 0 };
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) return { ...f, added: null, removed: 0 };
      const text = buf.toString('utf8');
      return { ...f, added: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, removed: 0 };
    } catch {
      return { ...f, added: null, removed: 0 };
    }
  });
  const totals = { added: 0, removed: 0 };
  for (const f of files.filter((x) => !x.service)) {
    totals.added += f.added || 0;
    totals.removed += f.removed || 0;
  }
  return { files, totals };
}

/** git add for paths (or all, minus git.excludeFromCommit). */
export async function stage(cwd, { paths, all = false }, exclude = []) {
  if (all) await git(cwd, ['add', '-A', '--', ':/', ...excludeSpecs(exclude)]);
  else await git(cwd, ['add', '-A', '--', ...paths]);
}

/** Back out of the index (the worktree keeps the change); before the first commit: git rm --cached. */
export async function unstage(cwd, { paths, all = false }) {
  const spec = all ? [':/'] : paths;
  if (await hasHead(cwd)) await git(cwd, ['restore', '--staged', '--', ...spec]);
  else await git(cwd, ['rm', '--cached', '-r', '-q', '--', ...spec], { ok: [0, 128] });
}

/**
 * Throws away the changes of paths: tracked → back to HEAD (index and worktree), added → out of the index and
 * deleted, untracked → deleted. `files` = the current status files (decides which is which); `remove(path)` deletes one
 * file (the caller guards it inside cwd).
 */
export async function discard(cwd, paths, files, remove) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const tracked = [];
  for (const p of paths) {
    const f = byPath.get(p);
    if (!f) continue;
    if (f.x === '?') remove(p);
    else if (f.x === 'A') {
      await git(cwd, ['rm', '--cached', '-q', '--', p]);
      remove(p);
    } else tracked.push(p);
  }
  // «Отменить все»: hundreds of paths would pass Windows' 32K command line, so in batches
  for (let i = 0; i < tracked.length; i += 100) await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked.slice(i, i + 100)]);
}

/** A commit's own changes (its first parent's view for a merge), as the diff of a working tree: { diff }. */
export async function commitDiff(cwd, rev, file) {
  const r = await git(cwd, ['show', '--format=', '--no-color', '--first-parent', '-m', rev, ...(file ? ['--', file] : [])], { ok: [0, 128] });
  if (r.code) throw Object.assign(new Error(`нет такого коммита: ${rev}`), { status: 404 });
  return { diff: r.stdout };
}

export async function diff(cwd, file) {
  const spec = file ? ['--', `:(literal)${file}`] : [];
  const head = await hasHead(cwd);
  if (!head && (await git(cwd, ['rev-parse', '--is-inside-work-tree'], { ok: [0, 128] })).stdout.trim() !== 'true') {
    fail(400, 'В этой папке нет рабочего дерева Git.');
  }
  let text = head
    ? (await git(cwd, ['diff', 'HEAD', ...spec])).stdout
    : (await git(cwd, ['diff', '--cached', ...spec])).stdout + (await git(cwd, ['diff', ...spec])).stdout;
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...spec])).stdout.split('\0').filter(Boolean);
  // shortcut: only the first 200 untracked files are rendered as added; enough for a review panel.
  for (const f of untracked.slice(0, 200)) text += (await git(cwd, ['diff', '--no-index', '--', '/dev/null', f], { ok: [0, 1] })).stdout;
  return { diff: text };
}

export async function log(cwd, n = 50) {
  const r = await git(cwd, ['log', `-n${n}`, '--format=%H%x1f%s%x1f%an%x1f%at'], { ok: [0, 128] });
  if (r.code) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [hash, subject, author, at] = l.split('\x1f');
    return { hash, subject, author, at: Number(at) * 1000 };
  });
}

/** `git log --oneline <range>` lines; [] when the range does not resolve. */
export async function onelines(cwd, range) {
  const r = await git(cwd, ['log', '--oneline', range], { ok: [0, 128] });
  return r.code ? [] : r.stdout.split('\n').filter(Boolean);
}

export async function commit(cwd, message, paths, exclude = [], { staged = false } = {}) {
  if (typeof message !== 'string' || !message.trim()) fail(400, 'нужно сообщение коммита');
  if (staged) {
    // only what is in the index, nothing added here
    if ((await git(cwd, ['diff', '--cached', '--quiet'], { ok: [0, 1] })).code === 0) fail(400, 'нет проиндексированных изменений');
    await git(cwd, ['commit', '-m', message]);
  } else if (paths?.length) {
    const keep = paths.filter((p) => !isService(p, exclude));
    if (!keep.length) fail(400, `выбраны только служебные файлы (git.excludeFromCommit: ${exclude.join(', ')}); harness их не коммитит`);
    await git(cwd, ['add', '-A', '--', ...keep]);
    await git(cwd, ['commit', '-m', message, '--', ...keep]);
  } else if (exclude.length) {
    // commit-all minus service files; the pathspec form also skips service files staged earlier
    const spec = [':/', ...excludeSpecs(exclude)];
    await git(cwd, ['add', '-A', '--', ...spec]);
    await git(cwd, ['commit', '-m', message, '--', ...spec]);
  } else {
    await git(cwd, ['add', '-A']);
    await git(cwd, ['commit', '-m', message]);
  }
  return { hash: await out(cwd, ['rev-parse', 'HEAD']) };
}

/** → { summary: «Отправлено в origin/x» | «Новая ветка x в origin» | «Уже в origin/x — нечего отправлять», output: raw git }. */
export async function push(cwd, { timeoutSec = 120 } = {}) {
  const up = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { ok: [0, 128] });
  const r = await git(cwd, up.code === 0 ? ['push'] : ['push', '-u', 'origin', 'HEAD'], { timeoutSec });
  const output = `${r.stdout}${r.stderr}`.trim();
  if (up.code !== 0) return { summary: `Новая ветка ${await currentBranch(cwd)} в origin`, output };
  const remote = up.stdout.trim();
  return { summary: /Everything up-to-date/i.test(output) ? `Уже в ${remote} — нечего отправлять` : `Отправлено в ${remote}`, output };
}

export async function currentBranch(cwd) {
  try {
    const r = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { ok: [0, 1] });
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function isRepo(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'], { ok: [0, 128] })).stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export const refExists = async (cwd, ref) => (await git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { ok: [0, 1, 128] })).code === 0;
export const branchExists = async (cwd, b) => (await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { ok: [0, 1] })).code === 0;

/** Local branch if present, else origin/<b>, else null (caller falls back to HEAD). */
export async function startPoint(cwd, b) {
  if (!b) return null;
  if (await branchExists(cwd, b)) return b;
  if (await refExists(cwd, `origin/${b}`)) return `origin/${b}`;
  return null;
}

export function sanitizeBranch(name) {
  return String(name)
    .replace(/[^A-Za-z0-9._/-]/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-./]+|[-./]+$/g, '')
    .replace(/\.lock$/i, '-lock') || 'branch';
}

/** `base` if free (or equal to `own`), else base-2, base-3, ... */
export async function uniqueBranch(cwd, base, own = null) {
  if (base === own) return base;
  let b = base;
  for (let n = 2; await branchExists(cwd, b); n++) b = `${base}-${n}`;
  return b;
}

export async function worktrees(cwd) {
  const { stdout } = await git(cwd, ['worktree', 'list', '--porcelain']);
  return stdout.split(/\r?\n\r?\n/).filter((b) => b.trim()).map((block, i) => {
    const wt = { path: '', branch: null, head: '', main: i === 0 };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) wt.path = path.resolve(line.slice(9));
      else if (line.startsWith('HEAD ')) wt.head = line.slice(5);
      else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'detached') wt.detached = true;
    }
    wt.detached = !!wt.detached || !wt.branch;
    return wt;
  });
}

const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/**
 * Local branches + origin/* branches without a local twin (name without "origin/", remote: true), newest first.
 * `worktree` = path of the worktree that has the branch checked out (this one included), else null.
 */
export async function branches(cwd, { allRemotes = false } = {}) {
  const current = await currentBranch(cwd);
  const checkedOut = new Map((await worktrees(cwd)).filter((w) => w.branch).map((w) => [w.branch, w.path]));
  const { stdout } = await git(cwd, ['for-each-ref', '--format=%(refname)%09%(upstream:short)%09%(committerdate:unix)', 'refs/heads', allRemotes ? 'refs/remotes' : 'refs/remotes/origin']);
  const local = [];
  const remote = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [ref, upstream, at] = line.split('\t');
    const lastCommitAt = Number(at) * 1000 || 0;
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length);
      local.push({ name, remote: false, current: name === current, upstream: upstream || null, lastCommitAt, worktree: checkedOut.get(name) ?? null });
    } else {
      const full = ref.slice('refs/remotes/'.length);
      const name = allRemotes ? full : full.slice('origin/'.length);
      if (!full.endsWith('/HEAD')) remote.push({ name, remote: true, current: false, upstream: full, lastCommitAt, worktree: null });
    }
  }
  const names = new Set(local.map((b) => b.name));
  const byDate = (a, b) => b.lastCommitAt - a.lastCommitAt || a.name.localeCompare(b.name);
  return { current, branches: [...local.sort(byDate), ...remote.filter((b) => allRemotes || !names.has(b.name)).sort(byDate)] };
}

/**
 * Switches cwd to `branch`: create -> `git switch -c <branch> <from|HEAD>`; existing local -> `git switch`;
 * only on origin -> `git switch --track origin/<branch>`. 409 if another worktree has it checked out.
 */
export async function checkout(cwd, { branch, create = false, from = null }) {
  const name = String(branch || '').replace(/^origin\//, '');
  if (!name) fail(400, 'нужна ветка');
  if ((await git(cwd, ['check-ref-format', '--branch', name], { ok: [0, 1, 128] })).code) fail(400, `недопустимое имя ветки: ${name}`);
  const here = (await out(cwd, ['rev-parse', '--show-toplevel'])).replace(/\//g, path.sep);
  const elsewhere = (await worktrees(cwd)).find((w) => w.branch === name && !samePath(w.path, here));
  if (elsewhere) fail(409, `${name} уже выбрана в другом рабочем дереве: ${elsewhere.path}`);
  if (create) await git(cwd, ['switch', '-c', name, from || 'HEAD']);
  else if (await branchExists(cwd, name)) await git(cwd, ['switch', name]);
  else if (await refExists(cwd, `origin/${name}`)) await git(cwd, ['switch', '--track', `origin/${name}`]);
  else fail(404, `ветка ${name} не найдена (ни локально, ни в origin)`);
  return { branch: name };
}

/** Default worktree root: <repoParent>/<repoName>-worktrees (short paths: Windows MAX_PATH is 260). */
export const worktreeRootFor = (mainRepo, worktreeRoot) => (worktreeRoot
  ? path.resolve(mainRepo, expandHome(worktreeRoot))
  : path.join(path.dirname(mainRepo), `${path.basename(mainRepo)}-worktrees`));

/**
 * Creates a worktree for `branch` in <worktreeRoot>/<dirName> (dirName defaults to the branch's last segment).
 * Existing branch: its existing worktree is reused, else it is checked out; new branch: created from `start`.
 */
export async function addWorktree(cwd, { branch, start = null, worktreeRoot = null, dirName = null }) {
  const list = await worktrees(cwd);
  const existing = list.find((w) => w.branch === branch);
  if (existing) return existing;
  const main = list[0].path;
  const root = worktreeRootFor(main, worktreeRoot);
  const base = path.join(root, String(dirName || branch.split('/').pop()).replace(/[^\w.-]+/g, '-'));
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n++) dir = `${base}-${n}`;
  fs.mkdirSync(root, { recursive: true });
  const args = (await branchExists(main, branch))
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, ...(start ? [start] : [])];
  await git(main, args);
  return { path: dir, branch, head: await out(dir, ['rev-parse', 'HEAD']).catch(() => ''), main: false };
}

/**
 * Removes a folder even while an antivirus/indexer holds files in it: rename to <dir>.stale-<ts> first (that works on
 * Windows), then delete with retries. Leftovers are swept on the next start (sweepStale).
 */
export async function removeDir(dir) {
  if (!fs.existsSync(dir)) return true;
  let target = dir;
  try {
    target = `${dir}.stale-${Date.now()}`;
    fs.renameSync(dir, target);
  } catch {
    target = dir;
  }
  try {
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort removal of <parent>/*.stale-<ts> folders left by removeDir. */
export async function sweepStale(parent) {
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return; }
  await Promise.all(names.filter((n) => /\.stale-\d+$/.test(n))
    .map((n) => fs.promises.rm(path.join(parent, n), { recursive: true, force: true, maxRetries: 3 }).catch(() => {})));
}

/**
 * `worktree remove --force`, then whatever is left of the folder, then `prune --expire now`. A worktree git refused to
 * remove (locked, ...) is left as is: its folder is never deleted behind git's back.
 */
export async function removeWorktree(cwd, wtPath) {
  const dir = path.resolve(wtPath);
  const r = await git(cwd, ['worktree', 'remove', '--force', dir], { ok: [0, 1, 128, 255] });
  if (r.code && (await worktrees(cwd)).some((w) => samePath(w.path, dir))) {
    fail(400, `git не удалил рабочее дерево ${dir}: ${(r.stderr || r.stdout).trim()}`);
  }
  // git unregistered it but may have left files (Windows: a file held open by another process)
  const gone = await removeDir(dir);
  await git(cwd, ['worktree', 'prune', '--expire', 'now'], { ok: [0, 128] });
  if (!gone) fail(400, `рабочее дерево снято с учёта git, но папку ${dir} удалить не удалось (файлы заняты другим процессом?)`);
}

/** project + repository = the last two path segments of the origin URL (ssh://, https://, scp-like), without .git. */
export function parseRemote(url) {
  const p = String(url).trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '') // scheme://user@host:port
    .replace(/^[^@/\\]+@[^:/]+:/, '') // git@host:
    .replace(/\.git\/?$/i, '')
    .replace(/\/+$/, '');
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? { project: parts.length > 1 ? parts.at(-2) : null, repository: parts.at(-1) } : null;
}

/** { project, repository, repo } of cwd's origin; falls back to the folder name. */
export async function remoteInfo(cwd) {
  const r = await git(cwd, ['remote', 'get-url', 'origin'], { ok: [0, 2, 128] });
  const parsed = r.code ? null : parseRemote(r.stdout);
  const repository = parsed?.repository || path.basename(await out(cwd, ['rev-parse', '--show-toplevel']));
  const project = parsed?.project ?? null;
  return { project, repository, repo: project ? `${project}/${repository}` : repository };
}

export const repoName = async (cwd) => (await remoteInfo(cwd)).repo;

/** release/1.54.0 -> rel154; anything else -> a branch-safe slug of the target. */
export function targetSlug(target) {
  const m = String(target).match(/^release\/(\d+)\.(\d+)/);
  return m ? `rel${m[1]}${m[2]}` : sanitizeBranch(target).replace(/\//g, '-');
}

/** Commits of `branch` whose change is not in `target` yet (patch-id aware), oldest first; null if a ref is missing. */
export async function missingCommits(cwd, target, branch) {
  const r = await git(cwd, ['log', '--cherry-pick', '--right-only', '--no-merges', '--reverse', '--format=%H', `${target}...${branch}`], { ok: [0, 128] });
  return r.code ? null : r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

export async function revList(cwd, range) {
  const r = await git(cwd, ['rev-list', '--reverse', range], { ok: [0, 128] });
  return r.code ? null : r.stdout.split('\n').filter(Boolean);
}

/** @returns {'clean'|'conflict'} ; a conflicted cherry-pick is left in progress */
export async function cherryPick(cwd, commits) {
  if (!commits.length) return 'clean';
  const r = await git(cwd, ['cherry-pick', '-x', ...commits], { ok: [0, 1] });
  if (r.code === 0) return 'clean';
  if (await refExists(cwd, 'CHERRY_PICK_HEAD')) return 'conflict';
  fail(400, `cherry-pick не удался: ${(r.stderr || r.stdout).trim()}`);
}
