// Run: node --test web/src/lib/attachments.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isImagePath, splitAttachments, withAttachments } from './attachments.ts'

test('attachments go as a numbered list of paths at the end and come back out of the text', () => {
  const paths = ['C:\\data\\runs\\s_1\\attachments\\shot 1.png', 'C:\\data\\runs\\s_1\\attachments\\log.txt']
  const msg = withAttachments('Картинку видишь?', paths)
  assert.equal(msg, 'Картинку видишь?\n\nВложения:\n1. C:\\data\\runs\\s_1\\attachments\\shot 1.png\n2. C:\\data\\runs\\s_1\\attachments\\log.txt')
  assert.deepEqual(splitAttachments(msg), { text: 'Картинку видишь?', paths })
  assert.deepEqual(splitAttachments(withAttachments('', paths)), { text: '', paths }, 'only files, no text')
  assert.equal(withAttachments('просто текст', []), 'просто текст')
  assert.deepEqual(splitAttachments('Вложения: в середине\nне список'), { text: 'Вложения: в середине\nне список', paths: [] })
  assert.deepEqual([isImagePath('a.JPEG'), isImagePath('a.txt')], [true, false])
})

test('a file attached where the caret is gets its mention there; removing it renumbers the later ones', async () => {
  const { attRef, insertRef, dropRef } = await import('./attachments.ts')
  let r = insertRef('Почему тут ошибка', 'Почему тут'.length, attRef(1, true))
  assert.deepEqual(r, { text: 'Почему тут [Изображение №1] ошибка', caret: 'Почему тут [Изображение №1]'.length })
  r = insertRef(r.text, r.text.length, attRef(2, false))
  assert.equal(r.text, 'Почему тут [Изображение №1] ошибка [Файл №2] ')
  assert.equal(insertRef('', 0, attRef(1, true)).text, '[Изображение №1] ')
  assert.equal(dropRef('a [Изображение №1] b [Файл №2] c [Изображение №3]', 1), 'a b [Файл №1] c [Изображение №2]')
  assert.equal(dropRef('a [Изображение №1] b [Файл №2]', 2), 'a [Изображение №1] b')
})

test('a mention is one token: Backspace / Delete next to it removes it whole, the caret never stops inside', async () => {
  const { deleteRefs, snapCaret } = await import('./attachments.ts')
  const t = 'a [Изображение №1] b [Файл №2] c'
  const end1 = 'a [Изображение №1]'.length
  assert.deepEqual(deleteRefs(t, end1, end1, true), { text: 'a b [Файл №1] c', caret: 1, refs: [1] }, 'Backspace right after it')
  assert.deepEqual(deleteRefs(t, 2, 2, false), { text: 'a b [Файл №1] c', caret: 1, refs: [1] }, 'Delete right before it')
  assert.deepEqual(deleteRefs(t, 5, 5, true), { text: 'a b [Файл №1] c', caret: 1, refs: [1] }, 'from inside')
  assert.equal(deleteRefs(t, 1, 1, true), null, 'plain text deletes as usual')
  assert.equal(deleteRefs(t, end1 + 1, end1 + 1, true), null, 'the space after it is plain text')
  // a selection that cuts into both: both go, their numbers come back for the files
  assert.deepEqual(deleteRefs(t, 6, t.indexOf('№2'), true), { text: 'a c', caret: 1, refs: [2, 1] })
  assert.deepEqual(deleteRefs('[Файл №1] x', 0, 0, false), { text: 'x', caret: 0, refs: [1] })
  assert.deepEqual(deleteRefs('x [Файл №1] ', 'x [Файл №1]'.length, 'x [Файл №1]'.length, true), { text: 'x ', caret: 1, refs: [1] })
  assert.equal(snapCaret(t, 5, -1), 2)
  assert.equal(snapCaret(t, 5, 1), end1)
  assert.equal(snapCaret(t, end1 - 1), end1, 'nearer edge')
  assert.equal(snapCaret(t, 1), 1)
})
