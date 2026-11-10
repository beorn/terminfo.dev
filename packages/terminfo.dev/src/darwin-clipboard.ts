import { spawn } from "node:child_process"
import { createClipboardTransaction, type LinuxClipboardAdapter } from "./linux-clipboard.ts"

export type DarwinCommand = (file: string, args: string[], stdin?: string) => Promise<string>

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
      // System Events raises an AppleScript permission dialog inside hosted iTerm2 and the
      // collector waits on it until the 900s job limit (#33017). Do not spawn osascript.
      await input.assertOwned()
      throw new Error("Hosted Darwin title read does not use System Events")
    },
    withClipboardFixture,
    async dispose() {},
  }
}
