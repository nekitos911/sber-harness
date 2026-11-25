// Model catalogue that survives renames (docs/ARCHITECTURE.md): ids are DISCOVERED by asking the agent CLI itself
// (agents.<id>.modelsDiscovery.prompt, gigacode "/models"), merged with ids seen in system/init events and with the
// config catalogue (labels/descriptions/order only). Discovery runs headless in <dataDir>/chats/helper/discovery/<agent>,
// one at a time per agent, in the background; failures are stored, never fatal.
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.js';
import { launchers } from './launchers.js';
import { runHelper } from './helper.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9.-]{3,79}/g;
const CONTEXT_RE = /^\d{2,4}[kKmM]$/;
const RETRY_MS = 3600000; // a failed discovery is tried again after an hour (or maxAgeHours, if shorter)

/**
 * Model ids in a free-form answer (markdown table, list or plain lines). A model id has letters and digits and a
 * dash (Qwen3.6-35B-262k); dates (no letters), codes and words are skipped; a bare "262k" on the line is its context.
 * With \`pattern\` (a regex with one capture group) only its matches count.
 */
export function parseModelIds(text, pattern = null) {
  const found = new Map();
  const add = (id, context) => {
    if (!found.has(id)) found.set(id, context ? { id, context } : { id });
  };
  if (pattern) {
    for (const m of String(text).matchAll(new RegExp(pattern, 'gm'))) if (m[1]) add(m[1].trim());
    return [...found.values()];
  }
  for (const line of String(text).split(/\r?\n/)) {
    if (/https?:\/\//i.test(line)) continue;
    const tokens = line.match(TOKEN_RE) || [];
    const context = tokens.find((t) => CONTEXT_RE.test(t)) || null;
    for (const t of tokens) {
      const id = t.replace(/[.-]+$/, '');
      if (id.length >= 4 && /[A-Za-z]/.test(id) && /\d/.test(id) && id.includes('-')) add(id, context);
    }
  }
  return [...found.values()];
}

/** shortcut: `<dir>/<name with *>` only (no ** or wildcard folders); enough for agents/*.md, upgrade if configs need more. */
function globFiles(pattern) {
  const p = expandHome(pattern);
  const re = new RegExp(`^${path.basename(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
  try {
    return fs.readdirSync(path.dirname(p), { withFileTypes: true }).filter((d) => d.isFile() && re.test(d.name)).map((d) => path.join(path.dirname(p), d.name)).sort();
  } catch {
    return [];
  }
}

const family = (id) => id.match(/^[A-Za-z]+/)?.[0].toLowerCase();
export const baseId = (id) => String(id).toLowerCase().replace(/-\d+[km]$/i, ''); // "-262k" context suffix is optional
const suffix = (id) => String(id).match(/-(\d+[km])$/i)?.[1] ?? null;

/** The catalogue entry an id names: the same backend model with or without its context suffix ("X-262k" ≈ "X"). */
export const catalogueHit = (ids, id) => {
  if (!id) return null;
  const want = baseId(id);
  return [...ids].find((k) => baseId(k) === want) ?? null;
};

/** Grades the harness knows (the review loop, the UI, agents.<id>.settings.agents.modelGrades). */
export const GRADES = ['default', 'fast', 'strong', 'review', 'explore'];

/**
 * The model grade of an agent profile by its role: reviewers get `review`, search/exploration helpers `fast` and only a
 * profile that merely explores (`explore`, read-only) `explore`, file workers `fast`. The name and the description
 * decide; the tools help only for a profile with a read-only `plan` approval and no writing tools. A profile that names
 * no role is null: nothing to derive, the caller's model decides.
 */
export function profileGrade(meta = {}) {
  const name = String(meta.name || '').toLowerCase();
  const description = String(meta.description || '').toLowerCase();
  const tools = (meta.tools || []).map((t) => String(t).toLowerCase());
  const readOnly = tools.length > 0 && !tools.some((t) => !/^(read|grep|glob|search|find|list|fetch|web|mcp__)/.test(t));
  const explore = /explor|разведк/.test(name) || /explor|разведк/.test(description);
  if (/review|ревью|реценз|аудит|audit/.test(name) || /review|ревью|реценз|аудит|audit/.test(description)) return 'review';
  if (explore) return meta.approvalMode === 'plan' || (readOnly && meta.approvalMode !== 'auto') ? 'explore' : 'fast';
  if (/file-worker|file_worker/.test(name)) return 'fast';
  if (meta.approvalMode === 'plan' && readOnly) return 'review';
  return null;
}

/**
 * Picks the model for a sub-agent: one place for worker_run / the `agent` tool, worker_start and the harness review.
 * `wanted` is what the caller asked for — empty, a grade name or a model id:
 *   - a grade takes its model from the catalogue; a grade whose model is gone runs with no model (the CLI default),
 *     never as an error;
 *   - an explicit id keeps the catalogue's own spelling (context suffixes do not make another model), else stays as typed;
 *   - empty: the grade of the (agent) profile (a reviewer `review`), else `fallback` — the session's own model, i.e. the
 *     orchestrator's; then a grade that is there, else the CLI default — a sub-agent always starts.
 * Without a discovered catalogue (`known` empty) nothing is checked and grades resolve by their config alone.
 */
export function resolveSubagentModel({ agentCfg = {}, wanted = null, grade = null, known = new Set(), fallback = null }) {
  const grades = agentCfg.settings?.agents?.modelGrades || {};
  const model = (g) => catalogueHit(known, grades[g] ?? null);
  const name = String(wanted ?? '').trim();
  // «inherit» is not a model id but «take mine»: GigaCode kills the process on a foreign id ("not present in the current
  // backend catalogue"), so such a value goes the way of an empty one — the profile's grade, then the caller's model
  if (name && name.toLowerCase() !== 'inherit') {
    if (Object.hasOwn(grades, name)) {
      // a grade the caller asked for is obeyed literally: its model or, when that model left the catalogue, the CLI
      // default and a note — never silently another family
      const id = grades[name] || null;
      if (!id) return { model: null, grade: name, note: `Уровень «${name}» не настроен — запуск с моделью по умолчанию` };
      const hit = model(name);
      if (hit) return { model: hit, grade: name, note: null };
      if (!known.size) return { model: id, grade: name, note: null }; // never discovered: the CLI decides
      return { model: null, grade: name, note: `Модель уровня «${name}» (${id}) не найдена в каталоге — запуск с моделью по умолчанию` };
    }
    return { model: catalogueHit(known, name) ?? name, grade: null, note: null };
  }
  // the profile's role grade; then the caller's own model (the orchestrator's) — the harness has no one default model:
  // a renamed catalogue must not quietly move a sub-agent to another workhorse; then any grade that is there
  if (grade && grades[grade]) {
    const hit = model(grade);
    if (hit) return { model: hit, grade, note: null };
    if (!known.size) return { model: grades[grade], grade, note: null };
  }
  if (fallback) return { model: catalogueHit(known, fallback) ?? fallback, grade: null, note: null };
  for (const g of GRADES) {
    if (!grades[g]) continue;
    const hit = model(g);
    if (hit) return { model: hit, grade: g, note: null };
  }
  return { model: null, grade: null, note: null };
}

/**
 * Model ids referenced by agent/command files (agents.<id>.modelRefsScan): frontmatter `model:` values that look like ids
 * and tokens of a catalogue model family (Qwen, GLM, ...). available: in the discovered catalogue, null = not discovered.
 */
export function scanModelRefs(patterns, models) {
  const families = new Set(models.map((m) => family(m.id)).filter(Boolean));
  const discovered = models.some((m) => m.available !== null) ? new Set(models.filter((m) => m.available).map((m) => baseId(m.id))) : null;
  const refs = [];
  for (const file of (Array.isArray(patterns) ? patterns : []).flatMap(globFiles)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
    const declared = front.match(/^model:\s*["']?([^"'\r\n#]+?)["']?\s*$/m)?.[1];
    const ids = new Set(declared && /\d/.test(declared) ? [declared] : []);
    for (const { id } of parseModelIds(text)) if (families.has(family(id))) ids.add(id);
    for (const model of ids) refs.push({ file, model, available: discovered ? discovered.has(baseId(model)) : null });
  }
  return refs;
}

export function createModelCatalog({ config, store, getUrl }) {
  const db = store.db;
  const inflight = new Map(); // agentId -> { promise, handle }
  const meta = (agent) => db.agentMeta[agent] || {}; // reads never create entries
  const maxAgeMs = (agent) => (config.agents[agent]?.modelsDiscovery?.maxAgeHours ?? 24) * 3600000;
  /** Discovery's own wait for the CLI's first word, longer than a chat's: a cold start with every user MCP server on a
   *  machine busy with other agents (modelsDiscovery.timeoutMs; default 2× firstEventTimeoutMs, at least 5 min). */
  const discoveryTimeoutMs = (agent) => {
    const a = config.agents[agent] || {};
    return a.modelsDiscovery?.timeoutMs || Math.max(300000, 2 * (a.firstEventTimeoutMs || launchers[a.launcher]?.defaults.firstEventTimeoutMs || 30000));
  };

  function save(agent, catalog) {
    db.agentMeta[agent] = { ...db.agentMeta[agent], catalog };
    store.save();
  }

  async function run(agent, entry) {
    const agentCfg = config.agents[agent] || fail(404, `агент ${agent} не найден`);
    const md = agentCfg.modelsDiscovery;
    if (!md?.prompt) fail(400, `не настроен agents.${agent}.modelsDiscovery.prompt`);
    const prev = meta(agent).catalog;
    try {
      const launcher = launchers[agentCfg.launcher] || fail(400, `неизвестный лаунчер «${agentCfg.launcher}»`);
      if (acpPrompt) {
        // a warm ACP process answers /models in a hidden session: no extra cold start of the CLI and its MCP servers
        // (null at once when no chat of this agent keeps one)
        const answer = await acpPrompt(agent, md.prompt).catch(() => null);
        const found = answer ? parseModelIds(answer, md.pattern) : [];
        if (found.length) return save(agent, { models: found, at: Date.now() });
      }
      // /models needs no MCP servers: the light run first (quickArgs, e.g. --safe-mode), the full one only if it answered
      // without ids — never after a timeout: a start too slow without the MCP servers is slower still with all of them
      const quick = db.agentMeta?.[agent]?.quickArgsBroken ? [] : agentCfg.quickArgs ?? launcher.defaults?.quickArgs ?? [];
      const approval = md.approvalMode ? { approvalMode: md.approvalMode } : {};
      const timeoutMs = discoveryTimeoutMs(agent);
      let res = null;
      for (const extraArgs of quick.length ? [quick, []] : [[]]) {
        const out = await runHelper({
          config, store, getUrl, agent, kind: 'discovery', prompt: md.prompt, extraArgs, ...approval, firstEventTimeoutMs: timeoutMs, onHandle: (handle) => { entry.handle = handle; },
        });
        const models = parseModelIds(out.resultText || out.text, md.pattern);
        if (models.length) return save(agent, { models, at: Date.now() });
        res = out.res;
        if (res.timedOut) break;
      }
      // a timeout is a busy machine, not a broken CLI: said as such, and tried again sooner (ensureFresh)
      if (res.timedOut) return save(agent, { models: prev?.models || [], at: prev?.at ?? null, error: `CLI не ответил за ${Math.round(timeoutMs / 1000)} с`, timedOut: true, errorAt: Date.now() });
      // stderr warnings («MCP server(s) failed to start: java-lsp») are not why no model ids came back
      const stderr = res.stderrTail.trim().split('\n').filter((l) => l.trim() && !/^\s*Warning:/i.test(l)).slice(-3).join(' ');
      const why = (res.error && !/^\s*Warning:/i.test(res.error) ? res.error : null) || stderr || 'в ответе нет id моделей';
      save(agent, { models: prev?.models || [], at: prev?.at ?? null, error: why.slice(0, 500), errorAt: Date.now() });
    } catch (e) {
      save(agent, { models: prev?.models || [], at: prev?.at ?? null, error: e.message, errorAt: Date.now() });
    }
  }

  let acpPrompt = null; // set by the server once sessions exist (warm ACP processes)

  function discover(agent) {
    if (!inflight.has(agent)) {
      const entry = { handle: null };
      inflight.set(agent, entry); // before run(): it records its process handle synchronously
      entry.promise = run(agent, entry).finally(() => inflight.delete(agent));
    }
    return inflight.get(agent).promise.then(() => meta(agent).catalog);
  }

  const isFresh = (agent) => {
    const c = meta(agent).catalog;
    return !!c?.at && Date.now() - c.at < maxAgeMs(agent);
  };

  /** Lazy refresh: starts a background discovery when the catalogue is missing/stale (failures wait maxAge too). */
  function ensureFresh(agent) {
    const a = config.agents[agent];
    if (!a || a.enabled === false || !a.modelsDiscovery?.prompt || inflight.has(agent)) return;
    // tests (test/helpers.js): never start a real CLI in the background — on a machine with GigaCode installed every
    // test server opened a browser login for it
    if (process.env.HARNESS_TEST_NO_REAL_CLI && a.launcher !== 'mock') return;
    const c = meta(agent).catalog;
    const last = Math.max(c?.at || 0, c?.errorAt || 0);
    const wait = c?.error ? Math.min(maxAgeMs(agent), RETRY_MS) : maxAgeMs(agent); // «повторю позже»
    if (!c || Date.now() - last > wait) discover(agent).catch(() => {});
  }

  /** Config entries (order, labels) + discovered + seen, deduped; available = in a successful discovery (null = unknown). */
  /**
   * One entry per base id (the /models answer says DeepSeek-V4.1-Flash-1017-262k, the CLI and the config
   * DeepSeek-V4.1-Flash-1017): id = the config id if any, else the discovered one; label from the config; context from
   * the discovered id's suffix; available = the base id is in a successful discovery (null = unknown).
   */
  function merged(agent) {
    const a = config.agents[agent] || {};
    const m = meta(agent);
    const discovered = m.catalog?.at ? m.catalog.models : null;
    const known = discovered && new Set(discovered.map((x) => baseId(x.id)));
    const byBase = new Map();
    const add = (entry, fromConfig = false) => {
      const key = baseId(entry.id);
      const cur = byBase.get(key);
      if (!cur) return void byBase.set(key, { ...entry, ...(entry.context || !suffix(entry.id) ? {} : { context: suffix(entry.id) }) });
      if (!fromConfig && (entry.context || suffix(entry.id))) cur.context = entry.context || suffix(entry.id); // the backend knows best
    };
    for (const e of a.models || []) add(e, true);
    for (const e of m.catalog?.models || []) add(e);
    for (const id of m.models || []) add({ id });
    return [...byBase.values()].map((e) => ({ ...e, available: known ? known.has(baseId(e.id)) : null }));
  }

  /** Models known to be unavailable (fresh successful discovery only); `has()` matches with or without the suffix.
   *  The model the agent is configured with is never reported missing: a bare context suffix (`X-262k` vs `X`) is the
   *  same backend model, and hiding it would silently switch the agent to something else. */
  function unavailable(agent) {
    const selected = config.agents[agent]?.model;
    const gone = isFresh(agent)
      ? new Set(merged(agent).filter((e) => e.available === false && e.id !== selected).map((e) => baseId(e.id)))
      : new Set();
    return { has: (id) => !!id && gone.has(baseId(id)), size: gone.size };
  }

  /** Ids a fresh successful discovery lists (empty: never discovered — nothing can be called missing). */
  function known(agent) {
    const m = meta(agent);
    return isFresh(agent) ? new Set((m.catalog?.models || []).map((x) => x.id)) : new Set();
  }

  return {
    useAcp(fn) {
      acpPrompt = fn;
    },
    discover,
    ensureFresh,
    merged,
    unavailable,
    known,
    isFresh,
    info: (agent) => {
      const c = meta(agent).catalog;
      return { at: c?.at ?? null, error: c?.error ?? null, timedOut: !!(c?.error && c.timedOut), running: inflight.has(agent) };
    },
    /** Stops discovery runs (they are ours, not user turns) and waits for them, so the data dir is released. */
    async close() {
      const runs = [...inflight.values()];
      for (const { handle } of runs) handle?.stop(); // the runner never signals an exited child (reused pid)
      if (!runs.length) return;
      let timer;
      await Promise.race([Promise.all(runs.map((r) => r.promise.catch(() => {}))), new Promise((r) => { timer = setTimeout(r, 5000); })]);
      clearTimeout(timer);
    },
  };
}
