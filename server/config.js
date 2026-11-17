// Loads the config file (HARNESS_CONFIG or <root>/harness.config.json), deep-merges its ".local" sibling
// (harness.config.local.json) and programmatic overrides on top.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Objects merge recursively; arrays and scalars from `b` replace those in `a`. */
export function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
  return out;
}

export function expandHome(p) {
  return typeof p === 'string' && (p === '~' || p.startsWith('~/') || p.startsWith('~\\'))
    ? path.join(os.homedir(), p.slice(1))
    : p;
}

export function readJsonFile(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${e.message}`);
  }
}

export const localFileFor = (file) => file.replace(/(\.json)?$/i, '.local.json');

/** @returns {object} config with absolute `root`, `dataDir`, `configFile`, `localConfigFile` */
export function loadConfig({ root = CODE_ROOT, overrides = {}, dataDir, configFile } = {}) {
  const file = path.resolve(root, expandHome(configFile || process.env.HARNESS_CONFIG || 'harness.config.json'));
  const localFile = localFileFor(file);
  let cfg = readJsonFile(file);
  cfg = deepMerge(cfg, readJsonFile(localFile));
  cfg = deepMerge(cfg, overrides);
  cfg.root = root;
  cfg.configFile = file;
  cfg.localConfigFile = localFile;
  cfg.dataDir = path.resolve(root, expandHome(dataDir || cfg.dataDir || './data'));
  cfg.host ||= '127.0.0.1';
  cfg.agents ||= {};
  cfg.agentMcpServers ||= {};
  cfg.mcpServers ||= {};
  cfg.integrations ||= {};
  cfg.git = { defaultBase: 'main', excludeFromCommit: ['.superpowers/'], networkTimeoutSec: 120, ...cfg.git };
  cfg.session = { idleWindowSec: 90, stallSec: 300, ...cfg.session };
  cfg.terminal = { autoRespawn: true, ...cfg.terminal };
  cfg.orchestration = { workerMayCommit: false, reviewMode: 'builtin', subagents: 'harness', ...cfg.orchestration };
  cfg.orchestration.review = { grade: 'review', approvalMode: 'plan', maxRounds: 2, agent: null, ...cfg.orchestration.review };
  cfg.board = {
    columns: [
      { status: 'todo', label: 'To do', trackerStatuses: [] },
      { status: 'in_progress', label: 'In progress', trackerStatuses: [] },
      { status: 'review', label: 'Review', trackerStatuses: [] },
    ],
    onWorkerDone: 'stay',
    moveSyncsTracker: false,
    columnTransitions: {},
    ...cfg.board,
  };
  for (const a of Object.values(cfg.agents)) if (a && a.models !== undefined) a.models = normalizeModels(a.models);
  const shell = cfg.shell || {};
  if (process.platform !== 'win32' && (!shell.command || /powershell(\.exe)?$/i.test(shell.command))) {
    cfg.shell = { command: process.env.SHELL || '/bin/bash', args: [] };
  } else {
    cfg.shell = { command: shell.command || 'powershell.exe', args: shell.args || [] };
  }
  return cfg;
}

/** Model catalogue entries are objects { id, label?, context?, description? }; a plain string means { id }. */
export function normalizeModels(list) {
  if (!Array.isArray(list)) throw Object.assign(new Error('models must be an array'), { status: 400 });
  return list.map((m) => {
    const entry = typeof m === 'string' ? { id: m } : m;
    if (!isObj(entry) || typeof entry.id !== 'string' || !entry.id.trim()) throw Object.assign(new Error('each model needs a non-empty string id'), { status: 400 });
    const out = { id: entry.id.trim() };
    for (const k of ['label', 'context', 'description']) {
      if (entry[k] == null) continue;
      if (typeof entry[k] !== 'string') throw Object.assign(new Error(`model ${out.id}: ${k} must be a string`), { status: 400 });
      out[k] = entry[k];
    }
    return out;
  });
}

const SECRET_KEY =/token|secret|password|passwd|authorization|api[-_]?key/i;

/** Config strings that look like a literal credential (they belong in the secrets file). */
export function findLiteralSecrets(obj, prefix = '') {
  const hits = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) hits.push(...findLiteralSecrets(v, p));
    else if (typeof v === 'string' && SECRET_KEY.test(k) && v.length >= 16 && !v.includes('$') && /^[\w+/=.:-]+(\s[\w+/=.:-]+)?$/.test(v) && new Set(v).size >= 10) hits.push(p);
  }
  return hits;
}
