// Model catalogue that survives renames (docs/ARCHITECTURE.md): ids are DISCOVERED by asking the agent CLI itself
// (agents.<id>.modelsDiscovery.prompt, gigacode "/models"), merged with ids seen in system/init events and with the
// config catalogue (labels/descriptions/order only). Discovery runs headless in <dataDir>/chats/discovery/<agent>,
// one at a time per agent, in the background; failures are stored, never fatal.
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT, expandHome } from './config.js';
import { launchers } from './launchers.js';
import { runTurn } from './runner.js';
import { secretEnv } from './mcp-client.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9.-]{3,79}/g;
const CONTEXT_RE = /^\d{2,4}[kKmM]$/;

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
      if (agentCfg.transport === 'acp' && acpPrompt) {
        // a warm ACP process answers /models in a hidden session: no extra cold start of the CLI and its MCP servers
        const answer = await acpPrompt(agent, md.prompt).catch(() => null);
        const found = answer ? parseModelIds(answer, md.pattern) : [];
        if (found.length) return save(agent, { models: found, at: Date.now() });
      }
      const exe = launcher.resolve(agentCfg);
      const dir = path.join(store.dataDir, 'chats', 'discovery', agent);
      fs.mkdirSync(dir, { recursive: true });
      const env = { HARNESS_URL: getUrl(), HARNESS_TOKEN: store.token, HARNESS_SESSION_ID: '' };
      const ctx = {
        prompt: md.prompt,
        session: { id: `discovery-${agent}`, externalSessionId: null, approvalMode: null, model: null },
        agentCfg,
        settingsPath: path.join(dir, 'settings.json'),
        mcpConfigPath: path.join(dir, 'mcp.json'),
        harnessMcp: { command: process.execPath, args: [path.join(CODE_ROOT, 'mcp', 'harness-mcp.js')], env },
        agentMcpServers: {},
      };
      launcher.prepare(ctx);
      let text = '';
      let resultText = null;
      const handle = runTurn({
        launcher, ctx, command: exe, cwd: dir,
        env: { ...process.env, ...agentCfg.env, ...secretEnv(config), ...exe.env, ...launcher.env(ctx), ...env },
        firstEventTimeoutMs: agentCfg.firstEventTimeoutMs || launcher.defaults.firstEventTimeoutMs || 30000,
        authTimeoutMs: agentCfg.authTimeoutMs || 600000,
        logFile: path.join(dir, 'discovery.log'), outFile: path.join(dir, 'out.ndjson'), errFile: path.join(dir, 'err.txt'),
        onEvent: (ev) => {
          if (ev.type === 'text' || ev.type === 'raw') text += ev.delta ? ev.text : `\n${ev.text}`;
          if (ev.type === 'result' && ev.text) resultText = ev.text;
        },
      });
      entry.handle = handle;
      const res = await handle.done;
      const models = parseModelIds(resultText || text, md.pattern);
      if (models.length) return save(agent, { models, at: Date.now() });
      const why = res.error || (res.timedOut ? 'нет ответа вовремя' : res.stderrTail.trim().split('\n').slice(-3).join(' ')) || 'в ответе нет id моделей';
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
    const c = meta(agent).catalog;
    const last = Math.max(c?.at || 0, c?.errorAt || 0);
    if (!c || Date.now() - last > maxAgeMs(agent)) discover(agent).catch(() => {});
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

  /** Models known to be unavailable (fresh successful discovery only); `has()` matches with or without the suffix. */
  function unavailable(agent) {
    const gone = isFresh(agent) ? new Set(merged(agent).filter((e) => e.available === false).map((e) => baseId(e.id))) : new Set();
    return { has: (id) => !!id && gone.has(baseId(id)), size: gone.size };
  }

  return {
    useAcp(fn) {
      acpPrompt = fn;
    },
    discover,
    ensureFresh,
    merged,
    unavailable,
    isFresh,
    info: (agent) => {
      const c = meta(agent).catalog;
      return c ? { at: c.at ?? null, error: c.error ?? null, running: inflight.has(agent) } : { at: null, error: null, running: inflight.has(agent) };
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
