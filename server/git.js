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

export async function status(cwd) {
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
    res.files.push({ path: p.slice(3), x, y, status: fileStatus(x, y) });
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

export async function commit(cwd, message, paths) {
  if (typeof message !== 'string' || !message.trim()) fail(400, 'commit message is required');
  if (paths?.length) {
    await git(cwd, ['add', '-A', '--', ...paths]);
    await git(cwd, ['commit', '-m', message, '--', ...paths]);
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

/**
 * Creates a worktree for `branch` under <worktreeRoot> (default <repo>/../<repoName>.worktrees), directory named
 * after the branch. Existing branch: checked out (or its existing worktree reused); new branch: created from `start`.
 */
export async function addWorktree(cwd, { branch, start = null, worktreeRoot = null }) {
  const list = await worktrees(cwd);
  const existing = list.find((w) => w.branch === branch);
  if (existing) return existing;
  const main = list[0].path;
  const root = worktreeRoot ? path.resolve(main, expandHome(worktreeRoot)) : path.join(path.dirname(main), `${path.basename(main)}.worktrees`);
  const base = path.join(root, branch.replace(/[\\/]/g, '-'));
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n++) dir = `${base}-${n}`;
  fs.mkdirSync(root, { recursive: true });
  const args = (await branchExists(main, branch))
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, ...(start ? [start] : [])];
  await git(main, args);
  return { path: dir, branch, head: await out(dir, ['rev-parse', 'HEAD']).catch(() => ''), main: false };
}

/** `worktree remove --force` + `prune --expire now`, then whatever is left of the folder. */
export async function removeWorktree(cwd, wtPath) {
  const dir = path.resolve(wtPath);
  const r = await git(cwd, ['worktree', 'remove', '--force', dir], { ok: [0, 128] });
  await git(cwd, ['worktree', 'prune', '--expire', 'now'], { ok: [0, 128] });
  if (!fs.existsSync(dir)) return;
  let target = dir;
  if (process.platform === 'win32') {
    // a locked folder can still be renamed; the stale copy is removed with retries and never blocks a new worktree
    try {
      target = `${dir}.stale-${Date.now()}`;
      fs.renameSync(dir, target);
    } catch {
      target = dir;
    }
  }
  try {
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    if (r.code) fail(400, `cannot remove worktree ${dir}: ${r.stderr.trim() || e.message}`);
  }
}

/** Repository id for PR services: "owner/name" from the origin URL, else the folder name. */
export async function repoName(cwd) {
  const r = await git(cwd, ['remote', 'get-url', 'origin'], { ok: [0, 2, 128] });
  const url = r.code ? '' : r.stdout.trim();
  const m = url.match(/^(?:[a-z+]+:\/\/[^/]+\/|[^@/]+@[^:]+:)(.+?)(?:\.git)?\/?$/i);
  if (m) return m[1];
  if (url) return path.basename(url).replace(/\.git$/, '');
  return path.basename(await out(cwd, ['rev-parse', '--show-toplevel']));
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
