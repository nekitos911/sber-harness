/**
 * The first index where `pred` holds in a list where it is false, then true (e.g. find matches in document order, «at or
 * below the top of the view»), or -1. Binary search: each `pred` call there measures a Range (a forced layout).
 */
export function firstIndex<T>(list: T[], pred: (x: T) => boolean): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pred(list[mid])) hi = mid
    else lo = mid + 1
  }
  return lo < list.length ? lo : -1
}
