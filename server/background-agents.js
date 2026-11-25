// The background sub-agent GigaCode's built-in `agent` tool can start (run_in_background): what it wrote into its output
// file, and when its chat may be settled.
//
// What is known for sure: the call answers at once («Background agent launched successfully … output_file: <path>.jsonl»),
// the sub-agent's own steps go to that file instead of the parent's stdout. A chat stops being «running» when its answer
// is in the file: a result line, or (GigaCode writes none) the last text-only assistant message once the file is quiet.
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
export function backgroundResult(file, { quietMs = QUIET_MS, now = Date.now() } = {}) {
  let text = '';
  let mtime = now;
  try {
    const st = fs.statSync(file);
    const size = st.size;
    mtime = st.mtimeMs;
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
  // GigaCode writes no result line (seen on the target 2026-11-25): its answer is the last assistant message — text
  // only, no functionCall (the model ended its turn) — once the file has been quiet a while (no step follows)
  if (now - mtime < quietMs) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (ev?.type !== 'assistant') return null; // the last step is a tool's answer or the person's: still at work
    const parts = Array.isArray(ev.message?.parts) ? ev.message.parts : Array.isArray(ev.message?.content) ? ev.message.content : [];
    if (parts.some((c) => c?.functionCall || c?.type === 'tool_use')) return null;
    const out = parts.map((c) => (typeof c?.text === 'string' && (c.type === undefined || c.type === 'text') ? c.text : '')).join('').trim();
    if (out) return { output: out, isError: false };
    // an empty one (parts: [], only usageMetadata — seen on the target) says nothing: the answer is before it
  }
  return null;
}
const QUIET_MS = 15000;

/**
 * The sub-agent's steps written since `offset` (bytes): its texts and tool calls, as stream-json lines carry them
 * ({ type: 'assistant', message: { content: [{ type: 'text' | 'tool_use', … }] } }). Only whole lines are taken: a line
 * still being written is read on the next look. → { offset, items: [{ kind: 'text', text } | { kind: 'tool', id, name, input }] }
 */
export function backgroundSteps(file, offset = 0) {
  let chunk = '';
  try {
    const size = fs.statSync(file).size;
    if (size <= offset) return { offset, items: [] };
    const len = Math.min(size - offset, TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      chunk = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { offset, items: [] };
  }
  const end = chunk.lastIndexOf('\n');
  if (end < 0) return { offset, items: [] };
  const items = [];
  for (const line of chunk.slice(0, end).split(/\r?\n/)) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type !== 'assistant') continue;
    // GigaCode writes Gemini-style parts ({ text } | { functionCall: { id, name, args } }, seen on the target
    // 2026-11-25); the stream-json shape (content: [{ type: 'text' | 'tool_use' }]) is read too
    const parts = Array.isArray(ev.message?.parts) ? ev.message.parts : Array.isArray(ev.message?.content) ? ev.message.content : [];
    for (const c of parts) {
      if (typeof c?.text === 'string' && c.text.trim() && (c.type === undefined || c.type === 'text')) items.push({ kind: 'text', text: c.text });
      else if (c?.functionCall?.name) items.push({ kind: 'tool', id: c.functionCall.id ?? null, name: c.functionCall.name, input: c.functionCall.args ?? null });
      else if (c?.type === 'tool_use' && c.name) items.push({ kind: 'tool', id: c.id ?? null, name: c.name, input: c.input ?? null });
    }
  }
  return { offset: offset + Buffer.byteLength(chunk.slice(0, end + 1)), items };
}
