// The background sub-agent GigaCode's built-in `agent` tool can start (run_in_background): what it wrote into its output
// file, and when its chat may be settled.
//
// What is known for sure: the call answers at once («Background agent launched successfully … output_file: <path>.jsonl»),
// the sub-agent's own steps go to that file instead of the parent's stdout, and the CLI process that started it writes
// its final result THERE. So a chat stops being «running» when such a result is in the file — nothing of the work itself
// reaches the harness while it runs.
import fs from 'node:fs';
import { readTail } from './runner.js';

const TAIL_BYTES = 256 * 1024;

/** «Background agent launched successfully … output_file: C:\….jsonl» → { taskId, outputFile } or null. */
export function backgroundLaunch(output) {
  const text = String(output ?? '');
  if (!/^\s*\**Background agent launched successfully/im.test(text)) return null;
  const file = outputFileIn(text);
  if (!file) return null; // no file: nowhere to look for the result
  return { taskId: /task_id[^:：]*[:：]\s*\**([\w.-]+)/.exec(text)?.[1] ?? null, outputFile: file };
}

/**
 * The output file a background call names — with or without markdown emphasis, as the CLI may render it. The path is
 * taken to the end of its line (and may itself contain spaces or Cyrillic); a `.jsonl` right before it is the path.
 */
export function outputFileIn(text) {
  const m = /(?:output_file|output file)\**`?[ \t]*:?[ \t]*\**`?[ \t]*([^\n\r]+)/i.exec(String(text ?? ''));
  const line = m?.[1]?.trim().replace(/^`|`$/g, '');
  if (!line) return null;
  return /^(.+?\.jsonl)/.exec(line)?.[1] ?? null;
}

/** The sub-agent's final answer, from the tail of its output file (null while it has not said one). */
export function backgroundResult(file) {
  let text = '';
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev;
    try {
      ev = JSON.parse(lines[i]); // the first line of a cut tail is usually broken
    } catch {
      continue;
    }
    if (ev?.type !== 'result') continue;
    const isError = ev.is_error === true || ev.subtype === 'error' || (typeof ev.subtype === 'string' && ev.subtype.startsWith('error'));
    const out = typeof ev.result === 'string' ? ev.result : typeof ev.response === 'string' ? ev.response : '';
    return { output: out || (isError ? readTail(file, 2000).trim() || 'фоновый субагент завершился с ошибкой' : '(no output)'), isError: !!isError };
  }
  return null;
}
