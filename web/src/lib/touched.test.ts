// Run: node --test web/src/lib/touched.test.ts (touchedRoots lives in toolRun.ts: pure, no imports)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { touchedRoots } from './toolRun.ts'
import type { Message } from '../types'

const tool = (name: string, input: unknown, status = 'ok') => ({ kind: 'tool', tool: { name, input, status } }) as unknown as Message

test('a chat in the projects folder: the projects it edits and the ones it only reads, the deepest root wins', () => {
  const roots = [
    { path: 'C:\\Projects\\sowa', name: 'sowa' },
    { path: 'C:\\Projects\\sowa-worktrees\\T-1', name: 'sowa', branch: 'feature/T-1' },
    { path: 'C:\\Projects\\task-service', name: 'task-service' },
    { path: 'C:\\Projects\\process-service', name: 'process-service' },
  ]
  const msgs = [
    tool('read_file', { absolute_path: 'C:\\Projects\\task-service\\src\\A.java' }),
    tool('run_shell_command', { command: 'git -C C:\\Users\\x\\..\\..\\Projects\\nowhere status' }),
    tool('run_shell_command', { command: 'git -C C:\\Projects\\process-service show d488518 --stat' }),
    tool('grep_search', { pattern: 'x', dir_path: 'c:/projects/sowa' }),
    tool('replace', { file_path: 'C:\\Projects\\sowa-worktrees\\T-1\\src\\Dto.java' }),
    tool('write_file', { file_path: 'C:\\Projects\\task-service\\src\\B.java' }, 'error'), // refused: changed nothing
  ]
  const r = touchedRoots(msgs, roots)
  assert.deepEqual(r.edited.map((x) => x.path), ['C:\\Projects\\sowa-worktrees\\T-1'])
  assert.deepEqual(r.seen.map((x) => x.name).sort(), ['process-service', 'sowa', 'task-service'])
  assert.equal(touchedRoots([tool('write_file', { file_path: 'C:\Projects\sowa-worktrees\T-2\a.txt' })], roots).outside, 1, 'a worktree the lists do not know yet')
})
