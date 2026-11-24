// One-off headless runs of an agent CLI outside any chat (model discovery, commit/PR messages): no session, no harness
// preamble, nothing in the chat list, no CLI chat record (chatRecording false). The run's cwd and files are
// <dataDir>/chats/helper/<kind>/<agent> (a system folder the CLI history adoption never takes).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CODE_ROOT } from './config.js';
import { launchers } from './launchers.js';
import { runTurn } from './runner.js';
import { secretEnv } from './mcp-client.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/**
 * @returns {Promise<{ text, resultText, res }>} text = the streamed answer, resultText = the result event's text,
 *   res = runTurn's result (error, timedOut, eventCount, stderrTail, ...).
 * o = { config, store, getUrl, agent, kind, prompt, extraArgs?, approvalMode?, model?, timeoutMs?, logName?, onHandle }
 */
export function runHelper({ config, store, getUrl, agent, kind, prompt, extraArgs = [], approvalMode = null, model = null, timeoutMs = 0, logName = `${kind}.log`, onHandle }) {
  const agentCfg = config.agents[agent] || fail(404, `агент ${agent} не найден`);
  const launcher = launchers[agentCfg.launcher] || fail(400, `неизвестный лаунчер «${agentCfg.launcher}»`);
  const exe = launcher.resolve(agentCfg);
  // a helper run has no action sandbox, so a real `auto` is refused: an explicit discovery mode wins, then auto-edit
  const mode = approvalMode || launcher.defaults.approvalModeMap?.auto || 'auto-edit';
  const dir = path.join(store.dataDir, 'chats', 'helper', kind, agent);
  fs.mkdirSync(dir, { recursive: true });
  const env = { HARNESS_URL: getUrl(), HARNESS_TOKEN: store.token, HARNESS_SESSION_ID: '' };
  const ctx = {
    prompt,
    session: { id: `${kind}-${agent}`, externalSessionId: null, approvalMode: mode, model },
    agentCfg,
    settingsPath: path.join(dir, 'settings.json'),
    mcpConfigPath: path.join(dir, 'mcp.json'),
    harnessMcp: { command: process.execPath, args: [path.join(CODE_ROOT, 'mcp', 'harness-mcp.js')], env },
    agentMcpServers: {},
    extraArgs,
    chatRecording: false,
  };
  launcher.prepare(ctx);
  const run = `${Date.now()}-${randomBytes(3).toString('hex')}`; // concurrent runs never share their output files
  const files = { logFile: path.join(dir, logName), outFile: path.join(dir, `out-${run}.ndjson`), errFile: path.join(dir, `err-${run}.txt`) };
  let text = '';
  let resultText = null;
  const handle = runTurn({
    launcher, ctx, command: exe, cwd: dir,
    env: { ...process.env, ...agentCfg.env, ...secretEnv(config), ...exe.env, ...launcher.env(ctx), ...env },
    firstEventTimeoutMs: agentCfg.firstEventTimeoutMs || launcher.defaults.firstEventTimeoutMs || 30000,
    authTimeoutMs: agentCfg.authTimeoutMs || 600000,
    ...files,
    onEvent: (ev) => {
      if (ev.type === 'text' || ev.type === 'raw') text += ev.delta ? ev.text : `\n${ev.text}`;
      if (ev.type === 'result' && ev.text) resultText = ev.text;
    },
  });
  onHandle?.(handle);
  const timer = timeoutMs > 0 ? setTimeout(() => handle.stop(), timeoutMs) : null;
  return handle.done.then((res) => {
    clearTimeout(timer);
    for (const f of [files.outFile, files.errFile]) fs.rmSync(f, { force: true });
    return { text, resultText, res };
  });
}
