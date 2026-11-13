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
}): Promise<LinuxClipboardAdapter> {
  const run = input.run ?? runDarwinCommand
  const sentinel = "terminfo owned pasteboard " + randomUUID()
  if (input.ownedHost) {
    await input.assertOwned()
    await run("/usr/bin/pbcopy", [], sentinel)
  }
  const baseline = input.ownedHost ? sentinel : pasteboardText(await run("/usr/bin/pbpaste", []))
  const withClipboardFixture = createClipboardTransaction(baseline, {
    async readText(trace, kind, verify) {
      await input.assertOwned()
      await verify()
      const text = pasteboardText(await run("/usr/bin/pbpaste", []))
      trace({ kind, at: new Date().toISOString(), length: text.length })
      return text
    },
    async writeText(text, trace, kind, verify) {
      await input.assertOwned()
      await verify()
      await run("/usr/bin/pbcopy", [], text)
      trace({ kind, at: new Date().toISOString(), length: text.length })
    },
  })
  return {
    profile: "default",
    pasteboard: "darwin",
    pasteboardApp: input.appId,
    config: null,
    permissions: "clipboard: read=allow,write=allow",
    summary: (input.ownedHost ? "darwin owned" : "darwin hosted") + " pasteboard for " + input.appComm,
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
      if (input.ownedHost) await run("/usr/bin/pbcopy", [], "")
    },
  }
}
