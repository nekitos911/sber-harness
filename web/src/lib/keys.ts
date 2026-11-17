import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

type NavigatorUAData = { platform?: string }

/** macOS uses ⌘ where Windows and Linux use Ctrl. */
export const isMac = (() => {
  const nav = navigator as Navigator & { userAgentData?: NavigatorUAData }
  return /mac/i.test(nav.userAgentData?.platform ?? navigator.platform ?? '')
})()

/** The primary modifier is down (⌘ on macOS, Ctrl elsewhere). */
export const modKey = (e: KeyboardEvent | ReactKeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey)

/** Label for a shortcut: mod('K') → «⌘K» on macOS, «Ctrl+K» elsewhere; shift adds ⇧. */
export const shortcut = (key: string, shift = false) =>
  isMac ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? '⇧+' : ''}${key}`
