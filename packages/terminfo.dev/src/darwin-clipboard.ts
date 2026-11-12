import { spawn } from "node:child_process"
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
  titleRead: DarwinTitleRead
  /**
   * The named refusal this route returns instead of a title, when the window-title instrument cannot
   * observe the app at all (33821). It must say WHY in measured terms — the window name that was
   * observed and the calibration outcome — because "no title" alone cannot be told from a bug.
   */
  titleUnavailable?: string
  assertOwned: () => Promise<void>
  run?: DarwinCommand
}): Promise<LinuxClipboardAdapter> {
  const run = input.run ?? runDarwinCommand
  const baseline = pasteboardText(await run("/usr/bin/pbpaste", []))
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
    config: null,
    permissions: "clipboard: read=allow,write=allow",
    summary: `darwin hosted pasteboard for ${input.appComm}`,
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
    async dispose() {},
  }
}
