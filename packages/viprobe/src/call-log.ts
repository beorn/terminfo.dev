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

interface CallTiming {
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

interface MethodCall extends Outcome {
  id: number
  path: string
  args: Encoded[]
  callbacks: CallbackCall[]
}

interface StoredCallLog {
  format: "viprobe.call-log"
  version: 1
  root: Encoded
  calls: MethodCall[]
}

const handleBrand = Symbol("CallLog")
export interface CallLog {
  readonly [handleBrand]: true
}

interface LogState {
  data: StoredCallLog
  started: boolean
  complete: boolean
}

const handles = new WeakMap<CallLog, LogState>()

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalValue)
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .flatMap((key) => {
        const member: unknown = Reflect.get(value, key)
        return member === undefined ? [] : [[key, canonicalValue(member)]]
      }),
  )
}

class CallLogHandle implements CallLog {
  readonly [handleBrand] = true

  constructor(state: LogState) {
    handles.set(this, state)
    Object.freeze(this)
  }

  toJSON(): unknown {
    const state = handles.get(this)
    if (!state?.complete) throw new IncompleteReplay("call log recording has not completed")
    return canonicalValue(state.data)
  }
}

export class IncompleteReplay extends Error {
  constructor(message: string) {
    super(`Incomplete: ${message}`)
    this.name = "IncompleteReplay"
  }
}

export function createCallLog(): CallLog {
  return new CallLogHandle({
    data: { format: "viprobe.call-log", version: 1, root: null, calls: [] },
    started: false,
    complete: false,
  })
}

function invalidArtifact(path: string, reason: string): never {
  throw new IncompleteReplay(`call log ${path}: ${reason}`)
}

function artifactObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidArtifact(path, "expected object")
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalidArtifact(path, "unexpected prototype")
  if (Object.getOwnPropertySymbols(value).length) invalidArtifact(path, "symbol keys are not persisted fields")
  return Object.fromEntries(
    Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => {
      if (!("value" in descriptor)) invalidArtifact(`${path}.${key}`, "persisted getters are not data")
      const member: unknown = descriptor.value
      return [key, member]
    }),
  )
}

function artifactKeys(value: Record<string, unknown>, path: string, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional])
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    invalidArtifact(path, "missing or unknown fields")
  }
}

function artifactArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalidArtifact(path, "expected array")
  return value
}

function artifactString(value: unknown, path: string): string {
  if (typeof value !== "string") invalidArtifact(path, "expected string")
  return value
}

function artifactNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidArtifact(path, "expected finite number")
  return value
}

function readEncoded(input: unknown, path: string, ancestors = new Set<object>()): Encoded {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input
  if (typeof input === "number") return artifactNumber(input, path)
  const value = artifactObject(input, path)
  if (typeof input !== "object" || input === null || ancestors.has(input)) invalidArtifact(path, "cyclic encoding")
  ancestors.add(input)
  const nested = (item: unknown, name: string) => readEncoded(item, `${path}.${name}`, ancestors)
  const entries = (): Array<[string, Encoded]> => {
    const keys = new Set<string>()
    return artifactArray(value.entries, `${path}.entries`)
      .map((entry, index): [string, Encoded] => {
        const pair = artifactArray(entry, `${path}.entries[${index}]`)
        if (pair.length !== 2) invalidArtifact(path, "encoded entry must be a pair")
        const key = artifactString(pair[0], `${path}.entries[${index}].key`)
        if (keys.has(key)) invalidArtifact(path, `duplicate encoded key ${key}`)
        if (value.kind === "array" && (key === "length" || /^(0|[1-9][0-9]*)$/.test(key))) {
          invalidArtifact(path, "array extra entry overwrites indexed storage")
        }
        keys.add(key)
        return [key, nested(pair[1], `entries[${index}].value`)]
      })
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  }
  try {
    switch (value.kind) {
      case "undefined":
      case "function":
      case "accessor":
        artifactKeys(value, path, ["kind"])
        return { kind: value.kind }
      case "number":
      case "bigint":
      case "bytes": {
        artifactKeys(value, path, ["kind", "value"])
        const encoded = artifactString(value.value, `${path}.value`)
        if (value.kind === "number" && !["NaN", "Infinity", "-Infinity", "-0"].includes(encoded)) {
          invalidArtifact(path, "invalid special number")
        }
        if (value.kind === "bigint" && (!/^-?(0|[1-9][0-9]*)$/.test(encoded) || encoded === "-0")) {
          invalidArtifact(path, "invalid bigint")
        }
        if (value.kind === "bytes" && Buffer.from(encoded, "base64").toString("base64") !== encoded) {
          invalidArtifact(path, "invalid canonical base64")
        }
        return { kind: value.kind, value: encoded }
      }
      case "regexp": {
        artifactKeys(value, path, ["kind", "value", "flags"])
        const source = artifactString(value.value, `${path}.value`)
        const flags = artifactString(value.flags, `${path}.flags`)
        try {
          const expression = new RegExp(source, flags)
          if (expression.source !== source || expression.flags !== flags) invalidArtifact(path, "noncanonical regexp")
        } catch {
          invalidArtifact(path, "invalid regexp")
        }
        return { kind: "regexp", value: source, flags }
      }
      case "set":
        artifactKeys(value, path, ["kind", "values"])
        return {
          kind: "set",
          values: artifactArray(value.values, `${path}.values`).map((item, i) => nested(item, `values[${i}]`)),
        }
      case "array":
        artifactKeys(value, path, ["kind", "values", "entries"])
        return {
          kind: "array",
          values: artifactArray(value.values, `${path}.values`).map((item, i) => nested(item, `values[${i}]`)),
          entries: entries(),
        }
      case "object":
        artifactKeys(value, path, ["kind", "entries"])
        return { kind: "object", entries: entries() }
      default:
        return invalidArtifact(path, "unknown encoded value kind")
    }
  } finally {
    ancestors.delete(input)
  }
}

function readOutcome(value: Record<string, unknown>, path: string): Outcome {
  if (value.finished !== true || typeof value.asynchronous !== "boolean")
    invalidArtifact(path, "unfinished or invalid outcome")
  const timing = artifactObject(value.timing, `${path}.timing`)
  artifactKeys(timing, `${path}.timing`, ["startedAtMs", "startedPerformanceMs", "settledAtMs", "settledPerformanceMs"])
  const parsed: Outcome = {
    finished: true,
    asynchronous: value.asynchronous,
    timing: {
      startedAtMs: artifactNumber(timing.startedAtMs, `${path}.startedAtMs`),
      startedPerformanceMs: artifactNumber(timing.startedPerformanceMs, `${path}.startedPerformanceMs`),
      settledAtMs: artifactNumber(timing.settledAtMs, `${path}.settledAtMs`),
      settledPerformanceMs: artifactNumber(timing.settledPerformanceMs, `${path}.settledPerformanceMs`),
    },
  }
  if (Object.hasOwn(value, "value") === Object.hasOwn(value, "error"))
    invalidArtifact(path, "requires exactly one value or error")
  if (Object.hasOwn(value, "value")) parsed.value = readEncoded(value.value, `${path}.value`)
  else {
    const error = artifactObject(value.error, `${path}.error`)
    artifactKeys(error, `${path}.error`, ["name", "message"])
    parsed.error = {
      name: artifactString(error.name, `${path}.error.name`),
      message: artifactString(error.message, `${path}.error.message`),
    }
  }
  return parsed
}

function encodedMember(value: Encoded, key: string, path: string): Encoded {
  if (value === null || typeof value !== "object") return invalidArtifact(path, "method reference traverses a scalar")
  if (value.kind === "object" || value.kind === "array") {
    const entry = value.entries.find(([name]) => name === key)
    if (entry) return entry[1]
    if (value.kind === "array" && /^(0|[1-9][0-9]*)$/.test(key)) {
      const item = value.values[Number(key)]
      if (item !== undefined) return item
    }
  }
  const prototypes: Partial<Record<NonNullable<Exclude<Encoded, string | number | boolean>>["kind"], object>> = {
    object: Object.prototype,
    array: Array.prototype,
    set: Set.prototype,
    regexp: RegExp.prototype,
    bytes: Uint8Array.prototype,
  }
  const prototype = prototypes[value.kind]
  const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, key)
  if (descriptor && typeof descriptor.value === "function") return { kind: "function" }
  if (descriptor?.get) return { kind: "accessor" }
  return invalidArtifact(path, `missing encoded member ${key}`)
}

export function readCallLog(input: unknown): CallLog {
  const value = artifactObject(input, "artifact")
  artifactKeys(value, "artifact", ["format", "version", "root", "calls"])
  if (value.format !== "viprobe.call-log" || value.version !== 1)
    invalidArtifact("artifact", "unsupported format or version")
  const root = readEncoded(value.root, "root")
  const calls = artifactArray(value.calls, "calls").map((item, id): MethodCall => {
    const path = `calls[${id}]`
    const call = artifactObject(item, path)
    artifactKeys(
      call,
      path,
      ["id", "path", "args", "callbacks", "timing", "finished", "asynchronous"],
      ["value", "error"],
    )
    if (call.id !== id) invalidArtifact(path, "call IDs must match their ordered position")
    const method = artifactString(call.path, `${path}.path`)
    if (!method.startsWith("context.")) invalidArtifact(path, "invalid method path")
    const args = artifactArray(call.args, `${path}.args`).map((arg, i) => readEncoded(arg, `${path}.args[${i}]`))
    const callbacks = artifactArray(call.callbacks, `${path}.callbacks`).map((item, index): CallbackCall => {
      const callbackPath = `${path}.callbacks[${index}]`
      const callback = artifactObject(item, callbackPath)
      artifactKeys(
        callback,
        callbackPath,
        ["argument", "args", "path", "timing", "finished", "asynchronous"],
        ["value", "error"],
      )
      const argument = artifactNumber(callback.argument, `${callbackPath}.argument`)
      const target = args[argument]
      if (
        !Number.isSafeInteger(argument) ||
        argument < 0 ||
        !target ||
        typeof target !== "object" ||
        target.kind !== "function"
      ) {
        invalidArtifact(callbackPath, "callback must reference a function argument")
      }
      if (callback.path !== `${method}#${id}.callback${index}`) invalidArtifact(callbackPath, "invalid callback path")
      return {
        ...readOutcome(callback, callbackPath),
        argument,
        path: callback.path,
        args: artifactArray(callback.args, `${callbackPath}.args`).map((arg, i) =>
          readEncoded(arg, `${callbackPath}.args[${i}]`),
        ),
      }
    })
    return { ...readOutcome(call, path), id, path: method, args, callbacks }
  })
  // Validate every graph reference before exposing a handle or any replay callback.
  for (const call of calls) {
    let receiver = root
    let memberPath = call.path.slice("context.".length)
    for (const reference of call.path.matchAll(/#([0-9]+)/g)) {
      const parent = calls[Number(reference[1])]
      if (!parent || parent.id >= call.id || !call.path.startsWith(`${parent.path}#${parent.id}.`))
        invalidArtifact(call.path, "dangling or forward call reference")
      const suffix = call.path.slice((reference.index ?? 0) + reference[0].length)
      const result = /^\.result(?=\.|#|$)/.exec(suffix)
      const callback = /^\.callback([0-9]+)\.arg([0-9]+)(?=\.|#|$)/.exec(suffix)
      const target = result
        ? parent.value
        : callback
          ? parent.callbacks[Number(callback[1])]?.args[Number(callback[2])]
          : undefined
      if (target === undefined) invalidArtifact(call.path, "invalid outcome or callback argument reference")
      receiver = target
      const remainder = suffix.slice((result ?? callback)?.[0].length ?? 0)
      if (!remainder.startsWith(".")) invalidArtifact(call.path, "reference has no member path")
      memberPath = remainder.slice(1)
    }
    const accessor = memberPath.endsWith("#get")
    if (accessor) memberPath = memberPath.slice(0, -4)
    for (const member of memberPath.split(".")) receiver = encodedMember(receiver, member, call.path)
    if (receiver === null || typeof receiver !== "object" || receiver.kind !== (accessor ? "accessor" : "function")) {
      invalidArtifact(call.path, "method path does not identify a callable member")
    }
  }
  return new CallLogHandle({
    data: { format: "viprobe.call-log", version: 1, root, calls },
    started: true,
    complete: true,
  })
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

export function withCallLog<Subject extends object>(
  subject: Subject,
  options: { mode: "record"; log: CallLog },
): { context: Subject; finish: () => void }
export function withCallLog<Subject extends object>(
  subject: null,
  options: { mode: "replay"; log: CallLog },
): { context: Subject; finish: () => void }
export function withCallLog<Subject extends object>(
  subject: Subject | null,
  options: { mode: "record" | "replay"; log: CallLog },
): { context: Subject; finish: () => void } {
  const { mode } = options
  const state = handles.get(options.log)
  if (!state) throw new IncompleteReplay("call log handle required; persisted data must be validated first")
  const log = state.data
  const originals = new WeakMap<object, object>()
  let cursor = 0
  let pending = 0
  let closed = false
  let failure: IncompleteReplay | undefined

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
    if (typeof value !== "object") return incomplete(`call log cannot encode ${typeof value}`)
    if (seen.has(value)) return incomplete("call log cannot encode cyclic values")
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
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, entry]) => [key, encode(entry, seen)]),
        }
      }
      const prototype: unknown = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        return incomplete(`call log cannot encode prototype ${Object.prototype.toString.call(value)}`)
      }
      return {
        kind: "object",
        entries: Object.entries(Object.getOwnPropertyDescriptors(value))
          .filter(([, descriptor]) => descriptor.enumerable)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
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
    if (closed) return incomplete(`recording session already finished: ${path}`)
    const timing = startTiming()
    const call: MethodCall = {
      id: log.calls.length,
      path,
      args: args.map((value) => encode(value)),
      timing,
      finished: false,
      asynchronous: false,
      callbacks: [],
    }
    log.calls.push(call)
    const supplied = args.map((value, argument) => {
      if (typeof value !== "function") return value
      return (...callbackArgs: unknown[]) => {
        if (closed) return incomplete(`recording session already finished: ${path}`)
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
    if (closed) return incomplete(`replay session already finished: ${path}`)
    const result = replayCallOutcome(path, args)
    if (promise(result)) {
      pending++
      return result.finally(() => {
        pending--
      })
    }
    return result
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
    if (state.started) throw new IncompleteReplay("record mode requires a fresh call log")
    state.started = true
    log.root = encode(subject)
  } else {
    if (subject !== null) throw new Error("Replay refuses a live subject")
    if (!state.complete) throw new IncompleteReplay("replay requires a completed call log")
  }
  const context = wrap(mode === "record" ? subject : decode(log.root), "context") as Subject
  return {
    context,
    finish() {
      if (failure) throw failure
      if (
        pending ||
        log.calls.some((call) => !call.finished || call.callbacks.some((callback) => !callback.finished))
      ) {
        incomplete("call log has unfinished asynchronous calls")
      }
      if (mode === "replay" && cursor !== log.calls.length) incomplete(`${log.calls.length - cursor} unconsumed calls`)
      if (mode === "record") state.complete = true
      closed = true
    },
  }
}
