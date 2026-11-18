// Progress of long operations without API changes: a request with header `x-job-id` runs inside a job context;
// code anywhere below it calls jobStep() and the UI gets WS frames { t: 'job', id, title, step, progress?, at } plus a
// final { t: 'job', id, done: true, error? }. Without a job (no header, timers, tests) jobStep() does nothing.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
export const JOB_ID_RE = /^[\w-]{8,64}$/;

/** Runs fn() as job `id`; `send` broadcasts a frame. Steps arriving after the end (background work) are dropped. */
export async function runJob({ id, title, send }, fn) {
  const job = { id, title, send, closed: false, held: false };
  send({ t: 'job', id, title, step: null, at: Date.now() });
  try {
    const result = await als.run(job, fn);
    if (!job.held) send({ t: 'job', id, title, done: true, at: Date.now() });
    return result;
  } catch (e) {
    send({ t: 'job', id, title, done: true, error: e.message || String(e), at: Date.now() });
    throw e;
  } finally {
    job.closed = true;
  }
}

/**
 * Keeps the current job open after its request returned (the work ends later, e.g. an agent's turn):
 * → { id, step(text), done(result), fail(error) } or null without a job. done/fail send the final frame once.
 */
export function holdJob() {
  const job = als.getStore();
  if (!job || job.closed) return null;
  job.held = true;
  let over = false;
  const frame = (o) => job.send({ t: 'job', id: job.id, title: job.title, ...o, at: Date.now() });
  const end = (o) => {
    if (over) return;
    over = true;
    frame({ done: true, ...o });
  };
  return { id: job.id, step: (step) => !over && frame({ step }), done: (result) => end({ result }), fail: (error, result) => end({ error, ...(result ? { result } : {}) }) };
}

/** A meaningful step of the current job (e.g. "Создание worktree", or a page n of total). */
export function jobStep(step, progress) {
  const job = als.getStore();
  if (!job || job.closed) return;
  job.send({ t: 'job', id: job.id, title: job.title, step, ...(progress ? { progress } : {}), at: Date.now() });
}
