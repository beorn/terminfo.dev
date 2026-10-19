/**
 * @failure A hosted measurement workflow installs changed archive bytes, retains inherited secrets,
 *   loses the owned editor launch/close ordering, or omits TERMINFO_RUN_ID and dies at collection.
 * @level l2
 * @consumer The GitHub-hosted macOS and Windows measurement collectors (27917).
 * @reach fs-walk .github/workflows/macos-measurement.yml .github/workflows/windows-measurement.yml
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { runInNewContext } from "node:vm"
import { createHash } from "node:crypto"
import { expect, test } from "vitest"

const root = join(import.meta.dirname, "..")

// Archive installation is irreversible within this job: changed downloaded bytes must never reach ditto.
test("hosted editor installer reports both digests before installing altered archive bytes", async () => {
  const workflow = readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8")
  const source = workflow.split("<<'HOSTED_EDITOR_INSTALL'\n")[1]?.split("\n          HOSTED_EDITOR_INSTALL")[0]
  expect(source).toBeDefined()
  const bytes = new TextEncoder().encode("altered downloaded archive")
  const actual = createHash("sha256").update(bytes).digest("hex")
  const launched: string[][] = []
  const retained = new Map<string, string>()
  await expect(
    runInNewContext(`(async () => {${source}\n})()`, {
      process: { arch: "arm64", env: { APP_ID: "cursor", RUNNER_TEMP: "/runner" } },
      Bun: {
        spawn: (argv: string[]) => {
          launched.push(argv)
          return { exited: Promise.resolve(0) }
        },
        file: () => ({ arrayBuffer: async () => bytes.buffer }),
      },
      Uint8Array,
      require: (id: string) => {
        if (id === "node:crypto") return { createHash }
        if (id === "node:fs") return { writeFileSync: (path: string, data: string) => retained.set(path, data) }
        throw new Error(`Unexpected installer dependency: ${id}`)
      },
    }),
  ).rejects.toThrow(`expected 03c6fb01e2200b17d2bf4259c7b66c08c9d505760d2a331e26ebfb3193bbf763, actual ${actual}`)
  expect(launched.map((argv) => argv[0])).toEqual(["curl"])
  expect(JSON.parse(retained.get("/runner/measurement-artifacts/editor-installer.json")!).actualSha256).toBe(actual)
})

// Existing source-launch tests cannot observe workflow command ordering or artifact retention.
// Execute the actual inline hosted caller; its imported recipe remains owned by app.test.ts.
test("hosted editor caller writes the TTY command before launch and retains no inherited secrets", async () => {
  const workflow = readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8")
  const source = workflow.split("<<'HOSTED_EDITOR_START'\n")[1]?.split("\n          HOSTED_EDITOR_START")[0]
  expect(source, "the production hosted editor caller exists").toBeDefined()
  const events: string[] = []
  const writes = new Map<string, string>()
  const run = { id: "fixture-id", directory: "/private/run", scriptPath: "/private/run/serve.sh" }
  const secret = "inherited-workflow-secret-sentinel"
  const prepared = {
    spawnPath: "/editor/helper",
    args: ["--classic"],
    env: { TOKEN: secret },
    recipeEnvKeys: ["CURSOR_CLI_BLOCK_CURSOR_AGENT"],
    identityPath: "/private/run/owner-tty.txt",
  }
  const window = { provider: "cli-process", ownerPid: 123, tty: "/dev/ttys001" }
  await runInNewContext(`(async () => {${source}\n})()`, {
    process: { cwd: () => root, env: { APP_ID: "cursor", RUNNER_TEMP: "/runner", EDITOR_COMMAND_PATH: "/template" } },
    console: { log: (...args: unknown[]) => writes.set("console", JSON.stringify(args)) },
    Bun: { sleep: async () => {} },
    require: (id: string) => {
      if (id === "node:fs") {
        return {
          existsSync: () => true,
          readFileSync: () => "#!/bin/bash\nwait-for-collector-ready\ncollect-on-pty\n",
          writeFileSync: (path: string, content: string) => {
            events.push(`write:${path}`)
            writes.set(path, content)
          },
        }
      }
      if (id.endsWith("/daemon-client.ts")) {
        return { createProbeRun: () => run, shellQuote: (value: string) => JSON.stringify(value) }
      }
      if (id.endsWith("/app.ts")) {
        return {
          prepareCliLaunch: () => {
            events.push("prepare")
            return prepared
          },
          launchPreparedCli: () => {
            events.push("launch")
            return { proc: {}, identityPath: prepared.identityPath }
          },
          ownedCliProcessWindow: () => {
            events.push("resolve")
            return window
          },
        }
      }
      throw new Error(`Unexpected workflow dependency: ${id}`)
    },
  })
  expect(events.indexOf("prepare")).toBeLessThan(events.indexOf(`write:${run.scriptPath}`))
  expect(events.indexOf(`write:${run.scriptPath}`)).toBeLessThan(events.indexOf("launch"))
  expect(events.indexOf("launch")).toBeLessThan(events.indexOf("resolve"))
  const command = writes.get(run.scriptPath)!
  expect(command.indexOf("owner-tty.txt")).toBeLessThan(command.indexOf("wait-for-collector-ready"))
  expect(command).toContain("collect-on-pty")
  expect(JSON.stringify([...writes])).not.toContain(secret)
  const retained = JSON.parse(writes.get("/runner/measurement-artifacts/editor-launch.json")!)
  expect(retained.terminalWindow).toEqual(window)
  const cleanup = workflow.split("<<'HOSTED_EDITOR_CLOSE'\n")[1]?.split("\n          HOSTED_EDITOR_CLOSE")[0]
  expect(cleanup, "the production owned close caller exists").toBeDefined()
  const closed: unknown[] = []
  const copies: string[] = []
  await runInNewContext(`(async () => {${cleanup}\n})()`, {
    process: { cwd: () => root, env: { RUNNER_TEMP: "/runner" } },
    console,
    Bun: {
      Glob: class {
        async *scan() {
          yield "cursor-profile/logs/exthost.log"
        }
      },
    },
    require: (id: string) => {
      if (id === "node:path") return { join, dirname }
      if (id === "node:fs") {
        return {
          existsSync: () => true,
          readFileSync: () => JSON.stringify(retained),
          mkdirSync: () => {},
          copyFileSync: (_source: string, target: string) => {
            copies.push(target)
            events.push("copy")
          },
        }
      }
      if (id.endsWith("/terminal-app-window.ts")) {
        return {
          closeOwnedTerminalWindow: (owned: unknown) => {
            closed.push(owned)
            events.push("close")
          },
        }
      }
      throw new Error(`Unexpected cleanup dependency: ${id}`)
    },
  })
  expect(copies).toContain("/runner/measurement-artifacts/editor-launch-files/serve.sh")
  expect(copies).toContain("/runner/measurement-artifacts/editor-launch-files/cursor-profile/logs/exthost.log")
  expect(closed).toEqual([window])
  expect(events.at(-1)).toBe("close")
})

// serve.ts passes `process.env.TERMINFO_RUN_ID ?? ""` into createOwnedTerminal, which rejects anything
// that is not 32 lowercase hex; the run id exists only after the receipt is emitted, so the workflow must
// read it inside the launched command — after the collector-ready wait and before the collector call.
test("hosted measurement workflows export the launch run id inside the collector command", () => {
  const macos = readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8")
  const readyAt = macos.indexOf("collector-ready")
  const exportAt = macos.indexOf("export TERMINFO_RUN_ID")
  const collectorAt = macos.indexOf('"$COLLECTOR" test')
  expect(readyAt, "macOS workflow waits for the receipt").toBeGreaterThan(-1)
  expect(exportAt, "macOS workflow exports TERMINFO_RUN_ID").toBeGreaterThan(readyAt)
  expect(collectorAt, "macOS workflow invokes the collector").toBeGreaterThan(exportAt)

  const windows = readFileSync(join(root, ".github/workflows/windows-measurement.yml"), "utf8")
  const winReadyAt = windows.indexOf("collector-ready")
  const winExportAt = windows.indexOf("\\$env:TERMINFO_RUN_ID = ")
  const winCollectorAt = windows.indexOf('& "$COLLECTOR_BUN" "$COLLECTOR" test')
  expect(winReadyAt, "Windows workflow waits for the receipt").toBeGreaterThan(-1)
  expect(winExportAt, "Windows workflow sets TERMINFO_RUN_ID").toBeGreaterThan(winReadyAt)
  expect(winCollectorAt, "Windows workflow invokes the collector").toBeGreaterThan(winExportAt)
})

/**
 * @failure The macOS workflow redirects the collector's stdout into collector.log, so the collector
 *   loses the terminal: serve.ts writes every probe query to process.stdout, and the darwinHosted arm
 *   binds fd0, stdout and the controlling tty as one PTY, so a redirected stdout makes that binding
 *   impossible and every hosted macOS job dies at collect with "Owned output is not a real TTY
 *   stream" or "Hosted Darwin input, selected output and controlling TTY device identities differ".
 * @level l2
 * @consumer The GitHub-hosted macOS measurement collector (27917 / cause b7580050, 28533).
 * @reach fs-walk .github/workflows/macos-measurement.yml
 * @testonly none
 */
test("the macOS collector keeps stdout on the terminal and sends only stderr to the log", () => {
  const macos = readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8")
  const line = macos.split("\n").find((candidate) => candidate.includes('"$COLLECTOR" test')) ?? ""
  expect(line, "the macOS collector launch line exists").not.toBe("")
  // A stdout redirect is the defect: the collector's probe queries go to stdout, and the owned-terminal
  // arm verifies stdout is the same PTY as fd0 and the ps tty. Only stderr may go to collector.log.
  expect(line, "stdout must stay on the terminal, never redirected to collector.log").not.toMatch(
    /(^|[^0-9])>\s*"\$OUT\/collector\.log"/,
  )
  expect(line, "stderr still reaches the collector.log artifact").toMatch(/\b2>\s*"\$OUT\/collector\.log"/)
})
