// Every optional API group advertised in /api/state features has its route (the UI calls them only when flagged).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FEATURES } from '../server/index.js';
import { startTestServer, makeRepo, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
after(() => rmrf(root));

test('each feature flag has a working route (not 404/405)', async () => {
  const repo = makeRepo(path.join(root, 'репо'));
  const h = await startTestServer({ agents: { mock: { skillsDir: path.join(root, 'skills'), commandsDir: path.join(root, 'commands') } } });
  try {
    const st = (await h.api('GET', '/api/state')).body;
    assert.deepEqual(st.features, FEATURES);
    const q = encodeURIComponent(repo);
    const task = (await h.api('POST', '/api/tasks', { title: 'probe' })).body;
    const chat = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: 'hi' })).body;
    await waitFor(async () => (await h.api('GET', '/api/state')).body.sessions.find((s) => s.id === chat.id).status === 'idle');
    const probes = {
      branches: ['GET', `/api/git/branches?cwd=${q}`],
      'fs-search': ['GET', `/api/fs/search?cwd=${q}&q=read`],
      'pr-status': ['GET', `/api/git/pr-status?cwd=${q}`],
      'agent-info': ['GET', '/api/agents/mock/info'],
      'models-refresh': ['POST', '/api/agents/mock/models/refresh'],
      'tracker-links': ['POST', `/api/tasks/${task.id}/import-children`],
      'board-columns': ['GET', '/api/settings', (b) => Array.isArray(b.board?.columns)],
      'review-loop': ['GET', '/api/settings', (b) => !!b.orchestration?.review],
      subagents: ['GET', '/api/agent/tools', (b) => b.some((t) => t.name === 'agent')],
      'virtual-sessions': ['GET', `/api/sessions/${chat.id}/messages`],
      'worker-run': ['GET', `/api/agent/worker_wait?sessionId=${chat.id}&timeoutMs=0`],
      'skills-install': ['POST', '/api/agents/mock/skills/install', null, {}],
      demo: ['GET', '/api/state', (b) => typeof b.demo === 'boolean'],
      'worktree-meta': ['PATCH', '/api/worktrees/meta', null, { path: repo, label: 'x' }],
      open: ['POST', '/api/open', null, { cwd: repo, target: 'nope' }],
      health: ['GET', '/api/health', (b) => b.ok === true && b.pid === process.pid],
      folders: ['GET', `/api/fs/dirs?path=${q}`, (b) => Array.isArray(b.entries) && Array.isArray(b.roots)],
      'include-dirs': ['PATCH', `/api/sessions/${chat.id}`, (b) => Array.isArray(b.includeDirs), { includeDirs: [] }],
      'mcp-connections': ['GET', '/api/mcp/config', (b) => Array.isArray(b.servers)],
      'agent-reconnect': ['POST', `/api/sessions/${chat.id}/restart`, (b) => b.id === chat.id, { keepContext: true }],
      'cli-live': ['POST', `/api/sessions/${chat.id}/messages`, null, { text: 'ещё', force: true }],
      pin: ['PATCH', `/api/sessions/${chat.id}`, (b) => b.pinnedAt > 0, { pinned: true }],
      questions: ['GET', `/api/sessions/${chat.id}/messages`],
      permissions: ['POST', `/api/sessions/${chat.id}/permission`, null, {}],
      activity: ['GET', '/api/settings', (b) => Number.isInteger(b.session?.stallSec)],
      rework: ['POST', `/api/tasks/${task.id}/rework`, null, { notes: 'x' }],
      'review-retry': ['POST', `/api/tasks/${task.id}/review`], // 409 here: reviewMode is builtin
      'fs-raw': ['GET', `/api/fs/raw?cwd=${q}&path=..%2Fout.png`],
      'tracker-import': ['POST', '/api/tasks/import', null, { ref: 'PROJ-1' }],
      'pr-decline': ['POST', '/api/git/pr/decline', null, { cwd: repo, index: 1 }],
      'task-suggest': ['GET', '/api/state', (b) => b.tasks.every((t) => 'suggestedWorkspaceId' in t)],
      recovery: ['GET', '/api/recovery', (b) => Array.isArray(b.sessions)],
      acp: ['GET', '/api/settings', (b) => typeof b.agents === 'object'],
      'worktree-lazy': ['GET', `/api/worktrees/info?path=${q}`],
      'cli-history': ['GET', `/api/history?cwd=${q}`, (b) => Array.isArray(b)],
      sdd: ['GET', `/api/sdd?cwd=${q}`, (b) => Array.isArray(b.plans)],
      'prs-mine': ['GET', '/api/prs?scope=mine'],
      'prs-filters': ['GET', '/api/prs?scope=review&state=all'], // 501 here: no PR server
      'git-generate': ['POST', '/api/git/generate', null, { cwd: repo, kind: 'commit' }], // 400 here: nothing to commit
      'git-via-agent': ['POST', '/api/git/commit', null, { cwd: repo, message: '', via: 'agent' }], // 400: no message
      'git-stage': ['POST', '/api/git/unstage', null, { cwd: repo, all: true }],
      handoff: ['POST', '/api/handoff', null, { input: 'сделай X' }], // 400 here: no projects folder
      'release-resolve': ['GET', '/api/releases/resolve?text=' + encodeURIComponent('релиз 54'), (b) => Array.isArray(b.refs)],
      'cli-adopt': ['POST', '/api/history/adopt', (b) => Number.isInteger(b.adopted)], // 501 here: no sourcecontrol server (enabled auto)
      'handoff-dry-run': ['POST', '/api/handoff', null, { input: 'сделай X', dryRun: true }], // dry run: nothing is created
      'pr-detail': ['GET', '/api/prs/detail?workspaceId=x', null], // 400: no index
      'pr-actions': ['POST', '/api/prs/merge', null, { workspaceId: 5 }], // 400: never merges anything in this probe
      'open-file': ['POST', '/api/open', null, { target: 'reveal', path: path.join(repo, '..', 'нет.txt') }], // 400: outside, nothing opens
      'bind-task': ['POST', `/api/sessions/${chat.id}/task`, null, { ref: 'нет ключа' }], // 400: no key
      revive: ['POST', `/api/sessions/${chat.id}/revive`, null, {}], // the chat runs or not: 200/409, never 404
      checks: ['POST', '/api/checks/run', null, { workspaceId: 5 }], // 400: never runs anything in this probe
      'pick-folder': ['POST', '/api/fs/pick-folder', null, { title: 5 }], // 400: never opens a real window in tests
      'integrations-check': ['GET', '/api/integrations/check', (b) => typeof b.tasks.found === 'boolean' && Array.isArray(b.servers)],
    };
    for (const flag of FEATURES) {
      const probe = probes[flag];
      assert.ok(probe, `no probe for the advertised flag "${flag}"`);
      const [method, url, ok, body] = probe;
      const res = await h.api(method, url, body ?? (method === 'POST' ? {} : undefined));
      assert.ok(res.status !== 404 && res.status !== 405, `${flag}: ${method} ${url} -> ${res.status} ${JSON.stringify(res.body)}`);
      if (ok) assert.ok(ok(res.body), `${flag}: unexpected body`);
    }
  } finally {
    await h.close();
  }
});
