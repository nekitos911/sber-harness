// Run: node --test web/src/lib/format.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, folderCrumbs, reviewKind, subTitle } from './format.ts'

test('reviewer statuses: UNAPPROVED is pending, NEEDS_WORK asks for changes', () => {
  assert.equal(reviewKind('APPROVED'), 'approved')
  assert.equal(reviewKind('UNAPPROVED'), 'pending')
  assert.equal(reviewKind('NEEDS_WORK'), 'changes')
  assert.equal(reviewKind('одобрено'), 'approved')
  assert.equal(reviewKind(''), 'pending')
})

test('relative time: under a minute is «только что», later «N мин назад»', () => {
  const now = 1_000_000_000
  assert.equal(ago(now - 30e3, now), 'только что')
  assert.equal(ago(now - 5 * 60e3, now), '5 мин назад')
  assert.equal(ago(now - 3 * 3600e3, now), '3 ч назад')
})

test('sub-agent titles: «profile · task» and the older «profile: task»', () => {
  assert.deepEqual(subTitle('java-reviewer · проверь лимиты'), ['java-reviewer', 'проверь лимиты'])
  assert.deepEqual(subTitle('java-reviewer: проверь'), ['java-reviewer', 'проверь'])
  assert.equal(subTitle('Обычный чат'), undefined)
})

test('folder navigation keeps drive, share and POSIX roots intact', () => {
  const paths = (p: string) => folderCrumbs(p).map((c) => c.path)
  assert.deepEqual(paths('C:\\code\\app'), ['C:\\', 'C:\\code', 'C:\\code\\app'])
  assert.deepEqual(paths('\\\\host\\share\\code'), ['\\\\host\\share', '\\\\host\\share\\code'])
  assert.deepEqual(paths('/home/a\\b'), ['/', '/home', '/home/a\\b'])
  assert.deepEqual(paths('/'), ['/'])
})
