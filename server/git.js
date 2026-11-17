// git CLI wrappers (execFile, never a shell). Errors become { status: 400 } with git's stderr as message.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { expandHome } from './config.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function git(cwd, args, { ok = [0] } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) fail(400, `cwd must be an existing absolute directory: ${cwd}`);
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      const code = err ? err.code : 0;
      if (err && typeof code !== 'number') return reject(Object.assign(new Error(`git failed: ${err.message}`), { status: 500 }));
      if (!ok.includes(code)) return reject(Object.assign(new Error((stderr || stdout || err.message).trim()), { status: 400 }));
      resolve({ code, stdout, stderr });
    });
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

/** git.excludeFromCommit: "dir/" = that folder at the repository top, otherwise a top-relative path. */
export const isService = (file, patterns = []) => patterns.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p || file.startsWith(`${p}/`)));
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
    res.files.push({ path: file, x, y, status: fileStatus(x, y), ...(isService(file, exclude) ? { service: true } : {}) });
  }
  return res;
}

const hasHead = async (cwd) => (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: [0, 1, 128] })).code === 0;

export async function diff(cwd, file) {
  const spec = file ? ['--', file] : [];
  let text = (await hasHead(cwd))
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

export async function commit(cwd, message, paths, exclude = []) {
  if (typeof message !== 'string' || !message.trim()) fail(400, 'commit message is required');
  if (paths?.length) {
    const keep = paths.filter((p) => !isService(p, exclude));
    if (!keep.length) fail(400, `only service files selected (git.excludeFromCommit: ${exclude.join(', ')}); they are never committed by the harness`);
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

export async function push(cwd) {
  const hasUpstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { ok: [0, 128] })).code === 0;
  const r = await git(cwd, hasUpstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']);
  return { output: `${r.stdout}${r.stderr}`.trim() };
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
    }
    return wt;
  });
}

const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/**
 * Local branches + origin/* branches without a local twin (name without "origin/", remote: true), newest first.
 * `worktree` = path of the worktree that has the branch checked out (this one included), else null.
 */
export async function branches(cwd) {
  const current = await currentBranch(cwd);
  const checkedOut = new Map((await worktrees(cwd)).filter((w) => w.branch).map((w) => [w.branch, w.path]));
  const { stdout } = await git(cwd, ['for-each-ref', '--format=%(refname)%09%(upstream:short)%09%(committerdate:unix)', 'refs/heads', 'refs/remotes/origin']);
  const local = [];
  const remote = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [ref, upstream, at] = line.split('\t');
    const lastCommitAt = Number(at) * 1000 || 0;
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length);
      local.push({ name, remote: false, current: name === current, upstream: upstream || null, lastCommitAt, worktree: checkedOut.get(name) ?? null });
    } else {
      const name = ref.slice('refs/remotes/origin/'.length);
      if (name !== 'HEAD') remote.push({ name, remote: true, current: false, upstream: `origin/${name}`, lastCommitAt, worktree: null });
    }
  }
  const names = new Set(local.map((b) => b.name));
  const byDate = (a, b) => b.lastCommitAt - a.lastCommitAt || a.name.localeCompare(b.name);
  return { current, branches: [...local.sort(byDate), ...remote.filter((b) => !names.has(b.name)).sort(byDate)] };
}

/**
 * Switches cwd to `branch`: create -> `git switch -c <branch> <from|HEAD>`; existing local -> `git switch`;
 * only on origin -> `git switch --track origin/<branch>`. 409 if another worktree has it checked out.
 */
export async function checkout(cwd, { branch, create = false, from = null }) {
  const name = String(branch || '').replace(/^origin\//, '');
  if (!name) fail(400, 'branch is required');
  if ((await git(cwd, ['check-ref-format', '--branch', name], { ok: [0, 1, 128] })).code) fail(400, `invalid branch name: ${name}`);
  const here = (await out(cwd, ['rev-parse', '--show-toplevel'])).replace(/\//g, path.sep);
  const elsewhere = (await worktrees(cwd)).find((w) => w.branch === name && !samePath(w.path, here));
  if (elsewhere) fail(409, `${name} is checked out in another worktree: ${elsewhere.path}`);
  if (create) await git(cwd, ['switch', '-c', name, from || 'HEAD']);
  else if (await branchExists(cwd, name)) await git(cwd, ['switch', name]);
  else if (await refExists(cwd, `origin/${name}`)) await git(cwd, ['switch', '--track', `origin/${name}`]);
  else fail(404, `branch ${name} not found (locally or on origin)`);
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

/** `worktree remove --force` + `prune --expire now`, then whatever is left of the folder. */
export async function removeWorktree(cwd, wtPath) {
  const dir = path.resolve(wtPath);
  const r = await git(cwd, ['worktree', 'remove', '--force', dir], { ok: [0, 128] });
  await git(cwd, ['worktree', 'prune', '--expire', 'now'], { ok: [0, 128] });
  if (!(await removeDir(dir)) && r.code) fail(400, `cannot remove worktree ${dir}: ${r.stderr.trim()}`);
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
  fail(400, `cherry-pick failed: ${(r.stderr || r.stdout).trim()}`);
}
