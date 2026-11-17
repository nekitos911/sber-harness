// config.workspaces { root, repos }: repos are registered on startup.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rmrf, makeRepo, startTestServer } from './helpers.js';

const root = tmpDir('харнесс репы ');
after(() => rmrf(root));
makeRepo(path.join(root, 'payments svc'));
makeRepo(path.join(root, 'ledger'));
fs.mkdirSync(path.join(root, 'not-a-repo'));

test('workspaces.root without repos registers every git repo under root', async () => {
  const h = await startTestServer({ workspaces: { root, repos: [] } });
  try {
    const { body } = await h.api('GET', '/api/state');
    assert.deepEqual(body.workspaces.map((w) => w.name).sort(), ['ledger', 'payments svc']);
  } finally { await h.close(); }
});

test('workspaces.repos picks only the listed ones and skips missing paths', async () => {
  const h = await startTestServer({ workspaces: { root, repos: ['ledger', 'missing'] } });
  try {
    const { body } = await h.api('GET', '/api/state');
    assert.deepEqual(body.workspaces.map((w) => w.name), ['ledger']);
  } finally { await h.close(); }
});
