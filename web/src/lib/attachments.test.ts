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
