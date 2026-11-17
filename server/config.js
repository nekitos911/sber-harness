// Loads harness.config.json, deep-merges harness.config.local.json and programmatic overrides on top.
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

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

/** @returns {object} config with absolute `root` and `dataDir` */
export function loadConfig({ root = CODE_ROOT, overrides = {}, dataDir } = {}) {
  let cfg = readJson(path.join(root, 'harness.config.json'));
  cfg = deepMerge(cfg, readJson(path.join(root, 'harness.config.local.json')));
  cfg = deepMerge(cfg, overrides);
  cfg.root = root;
  cfg.dataDir = path.resolve(root, expandHome(dataDir || cfg.dataDir || './data'));
  cfg.host ||= '127.0.0.1';
  cfg.agents ||= {};
  cfg.agentMcpServers ||= {};
  cfg.mcpServers ||= {};
  cfg.integrations ||= {};
  const shell = cfg.shell || {};
  if (process.platform !== 'win32' && (!shell.command || /powershell(\.exe)?$/i.test(shell.command))) {
    cfg.shell = { command: process.env.SHELL || '/bin/bash', args: [] };
  } else {
    cfg.shell = { command: shell.command || 'powershell.exe', args: shell.args || [] };
  }
  return cfg;
}
