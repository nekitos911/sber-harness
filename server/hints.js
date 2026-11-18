// «Где это в коде»: for a task started in the projects folder, the API paths it names are looked up in every registered
// repository (git grep over tracked files — seconds, local) so the agent starts in the right service instead of
// searching seventeen folders by itself. Only a hint: the agent checks it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { spawnOptions } from './runner.js';

/** What to look for: the last segments of API paths in the text (`/api/task/api/v1/templates/employee` → `templates/employee`). */
export function needlesOf(text) {
  const out = new Set();
  for (const [p] of String(text || '').matchAll(/\/[\w{}.-]+(?:\/[\w{}.-]+)+/g)) {
    const segs = p.split('/').filter(Boolean).filter((s) => !/^(api|v\d+|https?:?|www\..*)$/i.test(s) && !/^\{.*\}$/.test(s));
    if (segs.length >= 2) out.add(segs.slice(-2).join('/'));
    else if (segs.length === 1 && segs[0].length >= 6) out.add(segs[0]);
  }
  return [...out].slice(0, 4);
}

function grep(cwd, needle) {
  return new Promise((resolve) => {
    const p = spawn('git', ['grep', '-n', '-I', '-F', '-m', '2', '--', needle], spawnOptions({ cwd }));
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (out.length > 4000) p.kill(); });
    const t = setTimeout(() => p.kill(), 8000);
    p.on('error', () => { clearTimeout(t); resolve([]); });
    p.on('close', () => { clearTimeout(t); resolve(out.split('\n').filter(Boolean).slice(0, 3).map((l) => l.split(':').slice(0, 2).join(':'))); });
  });
}

/** → [{ repo, needle, hits: ['src/…/Controller.java:42'] }], the repositories where the paths are found, best first. */
export async function codeHints(text, repos) {
  const needles = needlesOf(text);
  if (!needles.length || !repos.length) return [];
  const found = [];
  await Promise.all(repos.map(async (w) => {
    for (const needle of needles) {
      const hits = await grep(w.path, needle);
      if (hits.length) { found.push({ repo: w.name, needle, hits, rank: needles.indexOf(needle) }); break; }
    }
  }));
  return found.sort((a, b) => a.rank - b.rank || a.repo.localeCompare(b.repo)).slice(0, 4).map(({ rank, ...h }) => h);
}

/** The preamble line: where the task's API paths are found. */
export const hintsLine = (hints) => (hints?.length
  ? `Подсказка харнесса (поиск по коду): ${hints.map((h) => `«${h.needle}» — ${h.repo} (${h.hits.join(', ')})`).join('; ')}. Начни с этого сервиса, но проверь сам.`
  : null);

/**
 * A link into a repository cloned here (its name in the URL path) → its local folder, and the file the link points at
 * when the URL says it (…/browse/<path>, …/blob/<ref>/<path>, …/-/blob/<ref>/<path>, …/src/<ref>/<path>). null: not here.
 */
export function localCopyOf(url, repos) {
  let segs;
  try { segs = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  for (let i = segs.length - 1; i >= 0; i--) {
    const name = segs[i].replace(/\.git$/i, '').toLowerCase();
    const ws = repos.find((w) => w.name.toLowerCase() === name || path.basename(w.path).toLowerCase() === name);
    if (!ws) continue;
    const rest = segs.slice(i + 1);
    const at = rest.findIndex((x) => ['browse', 'blob', 'src', 'tree', 'raw'].includes(x));
    const file = at < 0 ? [] : rest[at] === 'browse' ? rest.slice(at + 1) : rest.slice(at + 2);
    const local = path.join(ws.path, ...file);
    return fs.existsSync(local) ? local : ws.path;
  }
  return null;
}
