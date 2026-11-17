import { useSyncExternalStore } from 'react'

// One shared 30 s clock for relative timestamps.
let now = Date.now()
const subs = new Set<() => void>()
let timer = 0

function subscribe(cb: () => void) {
  subs.add(cb)
  if (!timer) timer = window.setInterval(() => { now = Date.now(); subs.forEach((s) => s()) }, 30_000)
  return () => {
    subs.delete(cb)
    if (!subs.size) { window.clearInterval(timer); timer = 0 }
  }
}

export const useNow = () => useSyncExternalStore(subscribe, () => now)
