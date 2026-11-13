import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createClipboardTransaction, type LinuxClipboardAdapter } from "./linux-clipboard.ts"

export type DarwinCommand = (file: string, args: string[], stdin?: string) => Promise<string>

/** Declared beside the hosted subject. The reader branches on this value only. */
export type DarwinTitleRead = "system-events" | "none"

/** pbcopy reads stdin. execFile does not open stdin, so this uses spawn. */
export function runDarwinCommand(file: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${file} timed out`))
    }, 5000)
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`${file} exited ${code}: ${Buffer.concat(err).toString("utf8")}`))
        return
      }
      resolve(Buffer.concat(out).toString("utf8"))
    })
    child.stdin.end(stdin ?? "")
  })
}

function pasteboardText(raw: string): string {
  return raw.replace(/\n$/u, "")
}

/**
 * Owned clipboard and title for a github-hosted Darwin run. The runner is the receipt's app.
 * The general pasteboard is saved and restored around one probe. No CGEvent.
 */
/**
 * The pasteboard types a plain-text round trip puts back exactly. Anything else — an image, a file promise, styled
 * text — survives `pbpaste`/`pbcopy` as text or not at all, so a run that wrote over it would "restore" something
 * else and report success (@cto 2026-11-13, F2 on f3f5e725b).
 */
const TEXT_RESTORABLE_TYPES = new Set([
  "«class utf8»",
  "«class ut16»",
  "«class TEXT»",
  "string",
  "public.utf8-plain-text",
  "public.utf16-plain-text",
  "public.text",
])

/**
 * `osascript -e 'clipboard info'` reduced to TYPE NAMES. Its sizes are dropped here and never leave this function:
 * a size is a length of someone's pasteboard, which the same ruling forbids publishing.
 */
export function parsePasteboardTypes(output: string): string[] {
  return output
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !/^\d+$/u.test(part))
}

/** The types a text round trip cannot restore. Empty means every present type is plain text this probe can put back. */
export function unrestorablePasteboardTypes(types: readonly string[]): string[] {
  return types.filter((type) => !TEXT_RESTORABLE_TYPES.has(type))
}

export async function createDarwinClipboardAdapter(input: {
  appComm: string
  /**
   * The app id this pasteboard belongs to — the same id the run's subject carries, resolved from the
   * receipt's executable path before the receipt is trusted. Reaching the pasteboard at all proves the
   * run owns this app, so the binding a gate needs is this field, not the summary sentence (#31741).
   */
  appId: string
  titleRead: DarwinTitleRead
  /**
   * The named refusal this route returns instead of a title, when the window-title instrument cannot
   * observe the app at all (33821). It must say WHY in measured terms — the window name that was
   * observed and the calibration outcome — because "no title" alone cannot be told from a bug.
   */
  titleUnavailable?: string
  assertOwned: () => Promise<void>
  run?: DarwinCommand
  /**
   * The pasteboard belongs to a machine the fleet shares (codimac), not to a disposable runner
   * (@cto 2026-11-13). Its contents are never read: the run writes its own sentinel first, grades
   * only values it wrote itself, and leaves the pasteboard empty when it is done - success or
   * failure. Saving and restoring the earlier contents is refused for the same reason: it would
   * mean reading them.
   */
  ownedHost?: boolean
  /**
   * The disposable-host fact (#30724, @cto 41cd2559): the receipt this run was admitted on names a
   * github-hosted-runner, so the machine runs this one job and its pasteboard holds nothing worth
   * preserving. The arm therefore takes the SAME sentinel path as an owned host - never reading
   * foreign contents, restoring nothing - and adds what a shared machine refuses: the sentinel is
   * read back before any grade, and a read that is not it refuses by name. Without that readback a
   * pasteboard that silently accepts nothing would grade every row as "did not write".
   */
  disposableHost?: { readonly receiptKind: "github-hosted-runner" }
  /**
   * The pasteboard belongs to the person using the app (ordinary open, @cto 2026-11-13). Marking a run
   * this way REQUIRES the digest mode by type, so a future caller cannot silently publish a fingerprint
   * or a length of someone's clipboard: only "read present" / "read empty" survive.
   */
  personClipboard?: { readonly foreignReadDigest: "absent" }
}): Promise<LinuxClipboardAdapter> {
  const run = input.run ?? runDarwinCommand
  if (input.ownedHost && input.disposableHost) {
    throw new Error(
      "Darwin pasteboard adapter: disposableHost and ownedHost cannot both be claimed; shared and disposable are different machines",
    )
  }
  if (input.personClipboard && (input.ownedHost || input.disposableHost)) {
    throw new Error(
      "Darwin pasteboard adapter: a person's pasteboard is neither an owned host nor a disposable runner; claim only one",
    )
  }
  const sentinelRoute = input.ownedHost === true || input.disposableHost !== undefined
  // A person's pasteboard publishes neither its digest nor its length (@cto 2026-11-13), and the trace is a
  // retained file like any other: on this route the events carry which operation happened and when, nothing else.
  const personMode = input.personClipboard !== undefined
  const disposable = input.disposableHost
  const sentinel = "terminfo owned pasteboard " + randomUUID()
  if (sentinelRoute) {
    await input.assertOwned()
    await run("/usr/bin/pbcopy", [], sentinel)
  }
  const baseline = sentinelRoute ? sentinel : pasteboardText(await run("/usr/bin/pbpaste", []))
  const transaction = createClipboardTransaction(
    baseline,
    {
      async readText(trace, kind, verify) {
        await input.assertOwned()
        await verify()
        const text = pasteboardText(await run("/usr/bin/pbpaste", []))
        trace(
          personMode
            ? { kind, at: new Date().toISOString() }
            : { kind, at: new Date().toISOString(), length: text.length },
        )
        return text
      },
      async writeText(text, trace, kind, verify) {
        await input.assertOwned()
        await verify()
        await run("/usr/bin/pbcopy", [], text)
        trace(
          personMode
            ? { kind, at: new Date().toISOString() }
            : { kind, at: new Date().toISOString(), length: text.length },
        )
      },
    },
    {
      foreignReadDigest: input.personClipboard?.foreignReadDigest ?? (sentinelRoute ? "omit" : "record"),
    },
  )
  // @dev/8 R1: the sentinel readback belongs INSIDE the fixture, where a failure refuses the probes
  // that need the pasteboard and leaves the rest of the run standing. Thrown at construction it
  // would kill all 273 rows over one feature's fixture, which is what unified.ts:653 forbids.
  const withClipboardFixture: LinuxClipboardAdapter["withClipboardFixture"] = personMode
    ? async (work, trace, verify) => {
        await input.assertOwned()
        // Types only, and before the first write: a clipboard holding an image or styled text would come back as
        // plain text, which is "left changed" without ever saying so.
        const unrestorable = unrestorablePasteboardTypes(
          parsePasteboardTypes(await run("/usr/bin/osascript", ["-e", "clipboard info"])),
        )
        if (unrestorable.length > 0) {
          const reason =
            "the person's clipboard holds content this probe cannot restore " +
            `(${unrestorable.join(", ")}), so nothing was written`
          return { pass: false, note: reason, tests: [{ id: "prerequisite", status: "probe-todo" as const, reason }] }
        }
        return transaction(work, trace, verify)
      }
    : disposable === undefined
      ? transaction
      : async (work, trace, verify) => {
          await input.assertOwned()
          const roundtrip = pasteboardText(await run("/usr/bin/pbpaste", []))
          if (roundtrip !== sentinel) {
            const reason =
              `Disposable pasteboard sentinel self-roundtrip failed on a ${disposable.receiptKind}: wrote a ` +
              `${Buffer.byteLength(sentinel)}-byte sentinel and read back ${Buffer.byteLength(roundtrip)} bytes ` +
              `that are not it, so no clipboard grade under this configuration can be trusted`
            return { pass: false, note: reason, tests: [{ id: "criterion", status: "probe-invalid" as const, reason }] }
          }
          return transaction(work, trace, verify)
        }
  return {
    profile: "default",
    pasteboard: "darwin",
    pasteboardApp: input.appId,
    config: null,
    permissions: "clipboard: read=allow,write=allow",
    summary:
      (input.ownedHost ? "darwin owned" : input.disposableHost ? "darwin disposable" : "darwin hosted") +
      " pasteboard for " +
      input.appComm,
    assertOwned: input.assertOwned,
    async readTitle() {
      await input.assertOwned()
      // A route that knows it cannot observe the title refuses before spawning anything: the hosting
      // app is not going to answer a System Events prompt, and a 5 s timeout reads like a bug.
      if (input.titleUnavailable !== undefined) throw new Error(input.titleUnavailable)
      // `none` never spawns osascript. The subject row records why that subject declares it.
      if (input.titleRead === "none") {
        throw new Error("Hosted Darwin title read does not use System Events")
      }
      const script = `tell application "System Events" to get name of window 1 of process ${JSON.stringify(input.appComm)}`
      return (await run("/usr/bin/osascript", ["-e", script])).replace(/\n$/u, "")
    },
    withClipboardFixture,
    async dispose() {
      if (!sentinelRoute) return
      // Emptying is a write to the machine's pasteboard like any other, so it needs the same proof
      // (@dev/3 R2 at 2fe85988d106b). A run whose window is gone is not entitled to empty it, and a
      // value we can no longer vouch for is the lesser harm; cleanup never throws, so the skip is
      // named on stderr instead.
      try {
        await input.assertOwned()
      } catch (error) {
        console.error(
          `darwin owned pasteboard: not cleared; the run no longer owns its window (${error instanceof Error ? error.message : String(error)})`,
        )
        return
      }
      await run("/usr/bin/pbcopy", [], "")
    },
  }
}
