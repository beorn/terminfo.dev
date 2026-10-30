import { expect, type MatcherState, type RunnerTestCase, type TestContext } from "vitest"
import { IncompleteReplay } from "viprobe"

type MatcherResult = { pass: boolean; message: () => string; actual?: unknown; expected?: unknown }
type MatcherMap = Record<string, (...args: never[]) => MatcherResult>

export interface RetainedCheck {
  step: number
  kind: "assertion" | "precondition"
  matcher: string
  arguments: readonly unknown[]
  expected: unknown
  actual: unknown
  ok: boolean
}

interface Session {
  matchers: MatcherMap
  checks: RetainedCheck[]
  active?: { kind: RetainedCheck["kind"]; step: number }
  closed: boolean
  failure?: IncompleteReplay
}
const sessions = new WeakMap<Readonly<RunnerTestCase>, Session>()

declare module "vitest" {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toTerminfoCheck(matcher: string, ...args: unknown[]): R
  }
}

function incomplete(session: Session, message: string): never {
  session.failure ??= new IncompleteReplay(message)
  throw session.failure
}

// The first erase matchers accept plain cell/cursor/history data. Wider JS value shapes
// need qualification before this adapter can claim that it retains them.
function snapshot(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || value === undefined) return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || seen.has(value)) throw new IncompleteReplay("Unsupported or cyclic check value")
  seen.add(value)
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((entry) => snapshot(entry, seen)))
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new IncompleteReplay("Check value requires a qualified plain-data snapshot")
    }
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry, seen)])))
  } finally {
    seen.delete(value)
  }
}

expect.extend({
  toTerminfoCheck(this: MatcherState & { task?: RunnerTestCase }, received: unknown, name: string, ...args: unknown[]) {
    const session = this.task && sessions.get(this.task)
    if (!session) throw new IncompleteReplay("Matcher has no task-owned Terminfo check session")
    if (session.closed || !session.active) return incomplete(session, "Check invoked outside its active session")
    const matcher = session.matchers[name]
    if (typeof matcher !== "function") return incomplete(session, "Matcher is not registered: " + name)
    try {
      const actualInput = snapshot(received)
      const argumentsInput = args.map((entry) => snapshot(entry))
      const result = Reflect.apply(matcher, this, [received, ...args]) as MatcherResult
      if (typeof result?.pass !== "boolean" || typeof result.message !== "function") {
        return incomplete(session, "Matcher did not return a synchronous public result: " + name)
      }
      session.checks.push(
        Object.freeze({
          step: session.active.step,
          kind: session.active.kind,
          matcher: name,
          arguments: Object.freeze(argumentsInput),
          expected: Object.hasOwn(result, "expected") ? snapshot(result.expected) : argumentsInput[0],
          actual: Object.hasOwn(result, "actual") ? snapshot(result.actual) : actualInput,
          ok: result.pass,
        }),
      )
      return result
    } catch (error) {
      return incomplete(
        session,
        "Check integration incomplete: " + (error instanceof Error ? error.message : String(error)),
      )
    }
  },
})

/** Internal Terminfo integration; no package-root Vitest API. */
export function withChecks<M extends MatcherMap>(
  context: TestContext,
  options: { mode: "record" | "replay"; matchers: M },
): {
  check<K extends keyof M & string>(matcher: K, ...parameters: Parameters<M[K]>): boolean
  precondition<K extends keyof M & string>(matcher: K, ...parameters: Parameters<M[K]>): boolean
  finish(): readonly RetainedCheck[]
} {
  if (sessions.has(context.task)) throw new IncompleteReplay("Task already has a Terminfo check session")
  const session: Session = { matchers: options.matchers, checks: [], closed: false }
  sessions.set(context.task, session)
  let step = 0
  const run = (kind: RetainedCheck["kind"], name: string, parameters: unknown[]) => {
    if (session.failure) throw session.failure
    if (session.closed || session.active) return incomplete(session, "Check session is closed or re-entered")
    session.active = { kind, step: ++step }
    try {
      const [received, ...args] = parameters
      context.expect.soft(received).toTerminfoCheck(name, ...args)
      const retained = session.checks.at(-1)
      if (!retained || retained.step !== session.active.step) {
        return incomplete(session, "Native matcher did not retain its result")
      }
      return retained.ok
    } catch (error) {
      return incomplete(
        session,
        "Native check integration incomplete: " + (error instanceof Error ? error.message : String(error)),
      )
    } finally {
      session.active = undefined
    }
  }
  return {
    check: (name, ...parameters) => run("assertion", name, parameters),
    precondition: (name, ...parameters) => run("precondition", name, parameters),
    finish() {
      if (session.failure) throw session.failure
      if (session.active) return incomplete(session, "Check session cannot finish while its matcher is active")
      session.closed = true
      sessions.delete(context.task)
      return Object.freeze([...session.checks])
    },
  }
}
