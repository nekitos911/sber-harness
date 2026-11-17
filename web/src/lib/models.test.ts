// Run: node --test web/src/lib/models.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickerModels } from './models.ts'

test('every catalogue model is listed; unavailable last; settings labels win', () => {
  const state = [
    { id: 'qwen', available: null }, { id: 'deepseek', available: false }, { id: 'glm', available: true }, 'gigachat', { id: 'old', available: false },
  ] as never
  const settings = [{ id: 'glm', label: 'GLM 5.3' }, 'custom-only'] as never
  assert.deepEqual(pickerModels(state, settings).map((m) => m.id), ['qwen', 'glm', 'gigachat', 'custom-only', 'deepseek', 'old'])
  assert.equal(pickerModels(state, settings).find((m) => m.id === 'glm')?.label, 'GLM 5.3')
})

test('an empty or partial settings list never hides the catalogue', () => {
  assert.equal(pickerModels([{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never, []).length, 3)
  assert.equal(pickerModels([{ id: 'a' }, { id: 'b' }] as never, [{ id: 'b', label: 'B' }] as never).length, 2)
  assert.deepEqual(pickerModels(undefined, ['x']).map((m) => m.id), ['x'])
})
