/**
 * Which blinks a flat blink series rules out (#34549, @cto coverage criterion ruling): the declared
 * class is a periodic square wave at 50% duty with any period from BLINK_CLASS_MIN_PERIOD_MS to
 * BLINK_CLASS_MAX_PERIOD_MS and any real phase, sampled instantaneously at each achieved capturedAt.
 * A series covers the class when every member would show a return (two transitions, A,B,A) at
 * those times. Bounding the largest gap does not establish this: samples whose phases lock to a
 * period see one state throughout however close together they are.
 *
 * The check is exact over the continuous period interval and continuous phase, in integer
 * arithmetic. With half-period h, sample i reads floor((t_i + φ) / h) mod 2, so over φ ∈ [0, 2h)
 * states change only at the edges φ ≡ -t_i (mod h). As h moves, the order of those edges changes
 * only where two coincide: (t_i - t_j) / h is an integer, h = |t_i - t_j| / k. Between consecutive
 * such h every open phase segment keeps its state vector, so the interval ends, every critical h
 * and one interior h per interval decide the whole range. Phases exactly on an edge (a set of
 * measure zero, where a real shot is ambiguous anyway) are not separately examined.
 */
export const BLINK_CLASS_MIN_PERIOD_MS = 600
export const BLINK_CLASS_MAX_PERIOD_MS = 3000

interface Half {
  a: number
  b: number
}

const gcd = (x: number, y: number): number => {
  let p = Math.abs(x)
  let q = Math.abs(y)
  while (q !== 0) [p, q] = [q, p % q]
  return p
}

const reduced = (a: number, b: number): Half => {
  const g = gcd(a, b)
  return { a: a / g, b: b / g }
}

/** Whether some open phase segment of the 50%-duty blink with half-period a/b ms shows no return. */
function blindAt(times: readonly number[], a: number, b: number): boolean {
  // Scaled by 2b, the half-period is 2a and every edge an even integer, so each segment midpoint is an
  // integer strictly inside its segment.
  const half = 2 * a
  const scaled = times.map((t) => 2 * b * t)
  const edges = new Set<number>()
  for (const x of scaled) {
    const edge = ((-x % half) + half) % half
    edges.add(edge)
    edges.add(edge + half)
  }
  const sorted = [...edges].sort((p, q) => p - q)
  sorted.push((sorted[0] ?? 0) + 2 * half)
  for (let index = 0; index < sorted.length - 1; index++) {
    const phase = ((sorted[index] ?? 0) + (sorted[index + 1] ?? 0)) / 2
    let previous: number | undefined
    let transitions = 0
    for (const x of scaled) {
      const state = Math.floor((x + phase) / half) % 2
      if (previous !== undefined && state !== previous) transitions++
      previous = state
    }
    if (transitions < 2) return true
  }
  return false
}

/**
 * A period of the declared class that `capturedAt` (whole milliseconds, in capture order) leaves
 * unseen at some phase, in ms, or undefined when every member of the class would show a return.
 * The period is a representative of the first uncovered interval, not its bound.
 */
export function uncoveredBlinkPeriod(capturedAt: readonly number[]): number | undefined {
  const times = capturedAt.filter((t) => Number.isInteger(t))
  if (times.length !== capturedAt.length || times.length < 3) return BLINK_CLASS_MIN_PERIOD_MS
  const lo = BLINK_CLASS_MIN_PERIOD_MS / 2
  const hi = BLINK_CLASS_MAX_PERIOD_MS / 2
  const critical = new Map<string, Half>()
  const add = (half: Half) => critical.set(`${String(half.a)}/${String(half.b)}`, half)
  add(reduced(lo, 1))
  add(reduced(hi, 1))
  for (let i = 0; i < times.length; i++) {
    for (let j = i + 1; j < times.length; j++) {
      const d = Math.abs((times[j] ?? 0) - (times[i] ?? 0))
      if (d === 0) continue
      for (let k = Math.ceil(d / hi); k <= Math.floor(d / lo); k++) add(reduced(d, k))
    }
  }
  const halves = [...critical.values()].sort((p, q) => p.a * q.b - q.a * p.b)
  const period = (half: Half) => (2 * half.a) / half.b
  for (let index = 0; index < halves.length; index++) {
    const at = halves[index]
    if (!at) continue
    if (blindAt(times, at.a, at.b)) return period(at)
    const next = halves[index + 1]
    if (!next) break
    const inside = reduced(at.a * next.b + next.a * at.b, 2 * at.b * next.b)
    if (blindAt(times, inside.a, inside.b)) return period(inside)
  }
  return undefined
}
