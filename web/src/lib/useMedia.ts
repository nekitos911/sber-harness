import { useSyncExternalStore } from 'react'

/** A CSS media query as React state (window width breakpoints). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (f) => { const m = window.matchMedia(query); m.addEventListener('change', f); return () => m.removeEventListener('change', f) },
    () => window.matchMedia(query).matches,
  )
}

/** Below 1200 px the right panel slides over the content; below 1000 px the sidebar is an icon rail. */
export const useCompact = () => useMedia('(max-width: 1199px)')
export const useRail = () => useMedia('(max-width: 999px)')
