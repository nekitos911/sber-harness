// Release references in free text («релиз 54», «release 1.54.1», «rel154», «только в релиз 54») resolved against the
// release branches of the repositories (local release/* and origin/release/*, also release-*), cached 5 min per repo.
import * as git from './git.js';

const CACHE_MS = 300000;
const cache = new Map(); // repo path -> { at, branches: Promise<{ name, version: number[] }[]> }
const REF_RE = /(?<![\p{L}\d])(?:релиз[а-яё]*|release|rel)[\s/-]*v?(\d+(?:\.\d+){0,2})/giu; // also «release/1.54.0»
const BRANCH_RE = /^(?:origin\/)?(release[/-]v?(\d+(?:\.\d+){0,2})[\w.-]*)$/;

/** Release branches of one repository: [{ name: 'release/1.54.0', version: [1, 54, 0] }] (local and origin, deduped). */
export function releaseBranches(repoPath) {
  const hit = cache.get(repoPath);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.branches;
  const branches = git.git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'], { ok: [0, 128] })
    .then((r) => {
      const out = new Map();
      for (const ref of r.stdout.split('\n')) {
        const m = ref.trim().match(BRANCH_RE);
        if (m && !out.has(m[1])) out.set(m[1], { name: m[1], version: m[2].split('.').map(Number) });
      }
      return [...out.values()];
    }, () => []);
  cache.set(repoPath, { at: Date.now(), branches });
  return branches;
}

/** «rel154» → "1.54", «rel1541» → "1.54.1", «rel54» → "54"; anything else as written. */
function versionOf(phrase, digits) {
  if (!/^rel\d+$/i.test(phrase.replace(/\s+/g, '')) || digits.includes('.')) return digits;
  if (digits.length === 3) return `${digits[0]}.${digits.slice(1)}`;
  if (digits.length === 4) return `${digits[0]}.${digits.slice(1, 3)}.${digits[3]}`;
  return digits;
}

/** The references in a text: [{ phrase, version }] + onlyRelease («только в релиз …»). */
export function findReleaseRefs(text) {
  const s = String(text ?? '');
  const refs = [];
  for (const m of s.matchAll(REF_RE)) refs.push({ phrase: m[0], version: versionOf(m[0], m[1]) });
  return { refs, onlyRelease: /только\s+в\s+релиз|only\s+(?:in(?:to)?\s+)?release/i.test(s) };
}

/** Does a branch version fit the spec? "54" = minor 54 of any major; "1.54" = that minor; "1.54.1" = exact. */
function fits(spec, v) {
  if (spec.length === 1) return v.length >= 2 ? v[1] === spec[0] : v[0] === spec[0];
  return spec.every((n, i) => v[i] === n);
}
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if ((a.version[i] ?? -1) !== (b.version[i] ?? -1)) return (b.version[i] ?? -1) - (a.version[i] ?? -1);
  return a.name.localeCompare(b.name);
};

/**
 * repos = [{ name, path }] (one workspace or every registered git repository) →
 * { refs: [{ phrase, version, branch | null, repos: [names that have it], candidates: [names, newest first] }], onlyRelease }
 */
export async function resolveReleases(text, repos) {
  const { refs, onlyRelease } = findReleaseRefs(text);
  if (!refs.length) return { refs: [], onlyRelease };
  const lists = await Promise.all(repos.map(async (r) => ({ repo: r.name, branches: await releaseBranches(r.path) })));
  const out = refs.map(({ phrase, version }) => {
    const spec = version.split('.').map(Number);
    const where = new Map(); // branch name -> { name, version, repos }
    for (const { repo, branches } of lists) {
      for (const b of branches.filter((x) => fits(spec, x.version))) {
        if (!where.has(b.name)) where.set(b.name, { ...b, repos: [] });
        where.get(b.name).repos.push(repo);
      }
    }
    const candidates = [...where.values()].sort(newer);
    return { phrase, version, branch: candidates[0]?.name ?? null, repos: candidates[0]?.repos ?? [], candidates: candidates.map((c) => c.name) };
  });
  return { refs: out, onlyRelease };
}

/** Release branches of the repos, deduped by branch, newest first → [{ branch, version: '1.54.1', repos }] (≤ limit). */
export async function listReleases(repos, limit = 10) {
  const where = new Map();
  for (const r of repos) {
    for (const b of await releaseBranches(r.path)) {
      if (!where.has(b.name)) where.set(b.name, { ...b, repos: [] });
      where.get(b.name).repos.push(r.name);
    }
  }
  return [...where.values()].sort(newer).slice(0, limit).map((b) => ({ branch: b.name, version: b.version.join('.'), repos: b.repos }));
}

/** «rel154» for release/1.54.x: the suffix of the separate porting branch (feature/<KEY>-rel154). */
export const relSuffix = (branch) => {
  const v = branch.match(/(\d+)(?:\.(\d+))?/);
  return v ? `rel${v[1]}${v[2] ?? ''}` : 'rel';
};

/**
 * Targets + the agent's note line for resolved references (or explicit targets): onlyRelease → only the release;
 * else [base, ...releases]. → { targets, line, warning } (null fields when nothing applies).
 */
export function releasePlan({ resolved, base, key = null, explicit = null }) {
  const found = (resolved?.refs || []).filter((r) => r.branch);
  const missing = (resolved?.refs || []).filter((r) => !r.branch);
  const warning = missing.length ? missing.map((r) => `ветка релиза ${r.version} не найдена`).join('; ') : null;
  const releases = explicit ? explicit.filter((b) => b !== base) : [...new Set(found.map((r) => r.branch))];
  const only = explicit ? !explicit.includes(base) : !!resolved?.onlyRelease;
  if (!releases.length) return { targets: explicit?.length ? explicit : null, line: null, warning };
  const targets = only ? releases : [base, ...releases];
  const from = explicit ? '' : ` (из «${found.map((r) => r.phrase).join('», «')}»)`;
  const rel = releases.join(' и ');
  const line = only
    ? `Целевая ветка: ${rel}${from}. Изменения нужны только в релиз.`
    : `Целевые ветки: ${base} и ${rel}${from}. Изменения нужны в обе: основная работа в ${base}, перенос в релиз — отдельной веткой feature/${key || '<КЛЮЧ>'}-${relSuffix(releases[0])} → PR в ${releases[0]}.`;
  return { targets, line, warning };
}
