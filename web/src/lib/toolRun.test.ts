// Run: node --test web/src/lib/toolRun.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMcpStatus, mcpParts, mcpServers, runImages, toolKind, toolRunSummary } from './toolRun.ts'

const msg = (name: string, input: unknown, status = 'ok', output: string | null = null) =>
  ({ id: Math.random().toString(36), sessionId: 's', at: 0, kind: 'tool', text: '', from: null, turn: 1, tool: { id: 't', name, input, status, output } }) as never

test('kinds cover GigaCode and Claude names', () => {
  assert.equal(toolKind('replace'), 'edit')
  assert.equal(toolKind('MultiEdit'), 'edit')
  assert.equal(toolKind('Bash'), 'shell')
  assert.equal(toolKind('read_many_files'), 'read')
  assert.equal(toolKind('grep_search'), 'search')
  assert.equal(toolKind('mcp__playwright__browser_click'), 'mcp')
  assert.equal(toolKind('harness.worker_start'), 'agent', 'the harness helpers are sub-agents')
  assert.equal(toolKind('harness.ask'), 'mcp')
  assert.equal(toolKind('todo_write'), 'other')
  assert.equal(toolKind('ReadFile'), 'read') // recorded CLI history uses display names
  assert.equal(toolKind('SearchText'), 'search')
  assert.equal(toolKind('WriteFile'), 'edit')
  assert.deepEqual(mcpParts('mcp__playwright__browser_click'), ['Playwright', 'browser_click'])
  assert.deepEqual(mcpParts('onework.find'), ['onework', 'find'])
})

test('summary: plurals, distinct files, tense', () => {
  const run = [
    msg('replace', { file_path: '/r/a.js' }), msg('write_file', { file_path: '/r/a.js' }),
    ...Array.from({ length: 11 }, () => msg('run_shell_command', { command: 'ls' })),
    msg('mcp__x__a', {}), msg('mcp__x__b', {}), msg('mcp__y__c', {}),
    msg('read_file', { absolute_path: '/r/b.js' }), msg('read_file', { absolute_path: '/r/c.js' }),
  ]
  assert.equal(toolRunSummary(run, true), 'Редактирует 1 файл, выполняет 11 команд, использует 3 интеграции и читает 2 файла')
  const helpers = [{ id: 'a', tool: { name: 'mcp__harness__agent', input: {} } }, { id: 'b', tool: { name: 'harness.worker_run', input: {} } }] as never[]
  assert.equal(toolRunSummary(helpers, false), 'Запустил 2 субагента')
  assert.equal(toolRunSummary([msg('glob', {})], false), 'Сделал 1 поиск')
})

test('images from inputs and outputs', () => {
  assert.deepEqual(runImages([msg('mcp__playwright__shot', { filename: 'login.png' }, 'ok', 'Saved to C:\\tmp\\shot-2.jpeg now')]), ['login.png', 'C:\\tmp\\shot-2.jpeg'])
})

test('MCP status line: detected inside «Model: … · MCP: …», servers with reasons', () => {
  const line = 'Model: qwen · MCP: harness ✓, java-lsp ✗ (timeout 30 s), playwright ✓'
  assert.equal(isMcpStatus(line), true)
  assert.equal(isMcpStatus('Готово: тесты зелёные'), false)
  assert.deepEqual(mcpServers(line), [
    { name: 'harness', ok: true, reason: null },
    { name: 'java-lsp', ok: false, reason: 'timeout 30 s' },
    { name: 'playwright', ok: true, reason: null },
  ])
})
