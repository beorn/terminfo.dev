type Encoded =
  | null
  | boolean
  | string
  | number
  | { kind: "number" | "bigint" | "bytes"; value: string }
  | { kind: "undefined" | "function" | "accessor" }
  | { kind: "regexp"; value: string; flags: string }
  | { kind: "set"; values: Encoded[] }
  | { kind: "array"; values: Encoded[]; entries: Array<[string, Encoded]> }
  | { kind: "object"; entries: Array<[string, Encoded]> }

export interface CallTiming {
  startedAtMs: number
  startedPerformanceMs: number
  settledAtMs?: number
  settledPerformanceMs?: number
}

interface Outcome {
  timing: CallTiming
  finished: boolean
  asynchronous: boolean
  value?: Encoded
  error?: { name: string; message: string }
}

interface CallbackCall extends Outcome {
  argument: number
  args: Encoded[]
  path: string
}

export interface MethodCall extends Outcome {
  id: number
  path: string
  args: Encoded[]
  callbacks: CallbackCall[]
  effectiveDeadlineMs?: number
}

export interface ReplayTiming {
  id: number
  path: string
  startedAt: number
  finishedAt?: number
  startedMonotonic: number
  finishedMonotonic?: number
  effectiveDeadlineMs?: number
}

export interface CallLog {
  version: 1
  root: Encoded
  calls: MethodCall[]
}

export class IncompleteReplay extends Error {
  constructor(message: string) {
    super(`Incomplete: ${message}`)
    this.name = "IncompleteReplay"
  }
}

export function createCallLog(): CallLog {
  return { version: 1, root: null, calls: [] }
}

function namedError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "ThrownValue", message: String(error) }
}

function restoredError(error: { name: string; message: string }): Error {
  const constructors: Record<string, new (message: string) => Error> = {
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    URIError,
    EvalError,
  }
  const Constructor = constructors[error.name] ?? Error
  const restored = new Constructor(error.message)
  restored.name = error.name
  return restored
}

function promise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise
}

function startTiming(): CallTiming {
  return { startedAtMs: Date.now(), startedPerformanceMs: performance.now() }
}

function settleTiming(timing: CallTiming): void {
  timing.settledAtMs = Date.now()
  timing.settledPerformanceMs = performance.now()
}

function effectiveDeadline(path: string, args: unknown[]): number | undefined {
  if (path === "context.queryWithSentinelOutcome" || path === "context.queryWithSentinel") {
    return args[2] === undefined ? 2000 : (args[2] as number)
  }
  if (path === "context.query" || path === "context.queryOutcome") {
    return args[2] === undefined ? 1000 : (args[2] as number)
  }
  if (path === "context.readInput") return args[1] === undefined ? 1000 : (args[1] as number)
  return undefined
}

export function withCallLog<Subject extends object>(
  subject: Subject | null,
  options: { mode: "record" | "replay"; log: CallLog },
): { context: Subject; finish: () => void; replayTimings: ReplayTiming[] } {
  const { mode, log } = options
  const originals = new WeakMap<object, object>()
  let cursor = 0
  let pending = 0
  let failure: IncompleteReplay | undefined
  const replayTimings: ReplayTiming[] = []

  function incomplete(message: string): never {
    failure ??= new IncompleteReplay(message)
    throw failure
  }

  function encode(input: unknown, seen = new Set<object>()): Encoded {
    const value = input && typeof input === "object" ? (originals.get(input) ?? input) : input
    if (value === null || typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number") return Number.isFinite(value) ? value : { kind: "number", value: String(value) }
    if (typeof value === "undefined") return { kind: "undefined" }
    if (typeof value === "bigint") return { kind: "bigint", value: String(value) }
    if (typeof value === "function") return { kind: "function" }
    if (typeof value !== "object") throw new Error(`Scratch call log cannot encode ${typeof value}`)
    if (seen.has(value)) throw new Error("Scratch call log cannot encode cyclic values")
    seen.add(value)
    try {
      if (value instanceof RegExp) return { kind: "regexp", value: value.source, flags: value.flags }
      if (value instanceof Set) {
        return { kind: "set", values: [...Set.prototype.values.call(value)].map((item) => encode(item, seen)) }
      }
      if (value instanceof Uint8Array) return { kind: "bytes", value: Buffer.from(value).toString("base64") }
      if (Array.isArray(value)) {
        return {
          kind: "array",
          values: value.map((item) => encode(item, seen)),
          entries: Object.entries(value)
            .filter(([key]) => !/^(0|[1-9][0-9]*)$/.test(key))
            .map(([key, entry]) => [key, encode(entry, seen)]),
        }
      }
      const prototype: unknown = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`Scratch call log cannot encode prototype ${Object.prototype.toString.call(value)}`)
      }
      return {
        kind: "object",
        entries: Object.entries(Object.getOwnPropertyDescriptors(value))
          .filter(([, descriptor]) => descriptor.enumerable)
          .map(([key, descriptor]) => [
            key,
            "value" in descriptor ? encode(descriptor.value, seen) : { kind: "accessor" },
          ]),
      }
    } finally {
      seen.delete(value)
    }
  }

  function decode(value: Encoded): unknown {
    if (value === null || typeof value !== "object") return value
    switch (value.kind) {
      case "undefined":
        return undefined
      case "number":
        return Number(value.value)
      case "bigint":
        return BigInt(value.value)
      case "function":
        return () => {
          throw new Error("Replay method escaped its decorator")
        }
      case "regexp":
        return new RegExp(value.value, value.flags)
      case "set":
        return new Set(value.values.map(decode))
      case "bytes":
        return new Uint8Array(Buffer.from(value.value, "base64"))
      case "array":
        return Object.assign(
          value.values.map(decode),
          Object.fromEntries(value.entries.map(([key, entry]) => [key, decode(entry)])),
        )
      case "object": {
        const restored: Record<string, unknown> = {}
        for (const [key, entry] of value.entries) {
          if (entry !== null && typeof entry === "object" && entry.kind === "accessor") {
            Object.defineProperty(restored, key, {
              enumerable: true,
              configurable: true,
              get() {
                throw new Error("Replay accessor escaped its decorator")
              },
            })
          } else {
            Object.defineProperty(restored, key, {
              enumerable: true,
              configurable: true,
              writable: true,
              value: decode(entry),
            })
          }
        }
        return restored
      }
      default:
        throw new Error(`Unknown scratch value kind ${value.kind}`)
    }
  }

  function finishOutcome(outcome: Outcome, value: unknown): unknown {
    outcome.value = encode(value)
    outcome.finished = true
    settleTiming(outcome.timing)
    return value
  }

  function failOutcome(outcome: Outcome, error: unknown): never {
    outcome.error = namedError(error)
    outcome.finished = true
    settleTiming(outcome.timing)
    throw error
  }

  function settle(outcome: Outcome, work: () => unknown): unknown {
    let value: unknown
    try {
      value = work()
    } catch (error) {
      return failOutcome(outcome, error)
    }
    if (!promise(value)) return finishOutcome(outcome, value)
    outcome.asynchronous = true
    pending++
    return value
      .then(
        (result) => finishOutcome(outcome, result),
        (error) => failOutcome(outcome, error),
      )
      .finally(() => {
        pending--
      })
  }

  function recordCall(target: object, method: (...args: unknown[]) => unknown, path: string, args: unknown[]): unknown {
    const timing = startTiming()
    const call: MethodCall = {
      id: log.calls.length,
      path,
      args: args.map((value) => encode(value)),
      timing,
      effectiveDeadlineMs: effectiveDeadline(path, args),
      finished: false,
      asynchronous: false,
      callbacks: [],
    }
    log.calls.push(call)
    const supplied = args.map((value, argument) => {
      if (typeof value !== "function") return value
      return (...callbackArgs: unknown[]) => {
        const callback: CallbackCall = {
          argument,
          args: callbackArgs.map((entry) => encode(entry)),
          path: `${path}#${call.id}.callback${call.callbacks.length}`,
          timing: startTiming(),
          finished: false,
          asynchronous: false,
        }
        call.callbacks.push(callback)
        return settle(callback, () =>
          Reflect.apply(
            value,
            undefined,
            callbackArgs.map((entry, index) => wrap(entry, `${callback.path}.arg${index}`)),
          ),
        )
      }
    })
    const result = settle(call, () => Reflect.apply(method, target, supplied))
    const resultPath = `${path}#${call.id}.result`
    return promise(result) ? result.then((value) => wrap(value, resultPath)) : wrap(result, resultPath)
  }

  function replayCallback(callback: CallbackCall, args: unknown[]): unknown {
    const work = args[callback.argument]
    if (typeof work !== "function") return incomplete(`missing callback argument at ${callback.path}`)
    const callbackArgs = callback.args.map((entry, index) => wrap(decode(entry), `${callback.path}.arg${index}`))
    const acceptError = (error: unknown) => {
      if (!callback.error || JSON.stringify(namedError(error)) !== JSON.stringify(callback.error)) {
        return incomplete(`callback outcome changed at ${callback.path}: ${String(error)}`)
      }
    }
    const acceptValue = (value: unknown) => {
      if (callback.error) return incomplete(`callback no longer throws at ${callback.path}`)
      if (JSON.stringify(encode(value)) !== JSON.stringify(callback.value)) {
        return incomplete(`callback outcome changed at ${callback.path}`)
      }
      return value
    }
    let result: unknown
    try {
      result = Reflect.apply(work, undefined, callbackArgs)
    } catch (error) {
      return acceptError(error)
    }
    if (promise(result) !== callback.asynchronous) return incomplete(`callback async shape changed at ${callback.path}`)
    if (promise(result)) return result.then(acceptValue, acceptError)
    return acceptValue(result)
  }

  function replayCallOutcome(path: string, args: unknown[]): unknown {
    const call = log.calls[cursor]
    if (!call) return incomplete(`missing call ${cursor}: ${path}`)
    if (call.path !== path) return incomplete(`method ${cursor}: expected ${call.path}, received ${path}`)
    if (JSON.stringify(call.args) !== JSON.stringify(args.map((value) => encode(value)))) {
      return incomplete(`arguments at call ${cursor}: ${path}`)
    }
    if (!call.finished) return incomplete(`unfinished call ${cursor}: ${path}`)
    cursor++
    const result = () => {
      if (call.error) throw restoredError(call.error)
      if (call.value === undefined) return incomplete(`missing outcome at call ${call.id}: ${path}`)
      return wrap(decode(call.value), `${path}#${call.id}.result`)
    }
    if (call.asynchronous) {
      return (async () => {
        for (const callback of call.callbacks) await replayCallback(callback, args)
        return result()
      })()
    }
    for (const callback of call.callbacks) {
      if (callback.asynchronous) return incomplete(`detached async callback unsupported at ${callback.path}`)
      replayCallback(callback, args)
    }
    return result()
  }

  function replayCall(path: string, args: unknown[]): unknown {
    const call = log.calls[cursor]
    const timing: ReplayTiming = {
      id: cursor,
      path,
      startedAt: Date.now(),
      startedMonotonic: performance.now(),
      effectiveDeadlineMs: call?.effectiveDeadlineMs,
    }
    replayTimings.push(timing)
    const finishTiming = () => {
      timing.finishedAt = Date.now()
      timing.finishedMonotonic = performance.now()
    }
    try {
      const result = replayCallOutcome(path, args)
      if (promise(result)) {
        pending++
        return result.finally(() => {
          finishTiming()
          pending--
        })
      }
      finishTiming()
      return result
    } catch (error) {
      finishTiming()
      throw error
    }
  }

  function wrap(value: unknown, path: string): unknown {
    if (value === null || typeof value !== "object") return value
    const proxy = new Proxy(value, {
      get(target, property) {
        const memberPath = `${path}.${typeof property === "symbol" ? String(property) : property}`
        const descriptor = Object.getOwnPropertyDescriptor(target, property)
        if (descriptor && !("value" in descriptor)) {
          return mode === "record"
            ? recordCall(target, descriptor.get ?? (() => undefined), `${memberPath}#get`, [])
            : replayCall(`${memberPath}#get`, [])
        }
        const member: unknown = Reflect.get(target, property, target)
        if (typeof member === "function") {
          return (...args: unknown[]) =>
            mode === "record"
              ? recordCall(target, member as (...args: unknown[]) => unknown, memberPath, args)
              : replayCall(memberPath, args)
        }
        return wrap(member, memberPath)
      },
    })
    originals.set(proxy, value)
    return proxy
  }

  if (mode === "record") {
    if (!subject) throw new Error("Record mode requires its live subject")
    if (log.calls.length) throw new Error("Record mode requires a fresh scratch log")
    log.root = encode(subject)
  } else if (subject !== null) throw new Error("Replay refuses a live subject")
  const context = wrap(mode === "record" ? subject : decode(log.root), "context") as Subject
  return {
    context,
    replayTimings,
    finish() {
      if (failure) throw failure
      if (
        pending ||
        log.calls.some((call) => !call.finished || call.callbacks.some((callback) => !callback.finished))
      ) {
        throw new Error("Scratch call log has unfinished asynchronous calls")
      }
      if (mode === "replay" && cursor !== log.calls.length) incomplete(`${log.calls.length - cursor} unconsumed calls`)
    },
  }
}
