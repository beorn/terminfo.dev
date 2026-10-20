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
import { spawnSync } from "node:child_process"
import { parse, stringify } from "yaml"
import { shellQuote } from "../packages/terminfo.dev/src/daemon-client.ts"
import { expect, test } from "vitest"

const root = join(import.meta.dirname, "..")

// The actual shared DMG caller must verify Warp before mount/copy, without changing Alacritty's operation.
test("shared hosted DMG caller rejects altered Warp bytes before install and preserves Alacritty arguments", async () => {
  const workflow = readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8")
  const source = workflow.split("<<'HOSTED_DMG_INSTALL'\n")[1]?.split("\n          HOSTED_DMG_INSTALL")[0]
  expect(source, "the production shared DMG caller exists").toBeDefined()
  const bytes = new TextEncoder().encode("altered Warp DMG")
  const actual = createHash("sha256").update(bytes).digest("hex")
  const launched: string[][] = []
  const retained = new Map<string, string>()
  const run = (app: string) =>
    runInNewContext(`(async () => {${source}\n})()`, {
      process: { env: { APP_ID: app, RUNNER_TEMP: "/runner" } },
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
        if (id === "node:fs") {
          return {
            writeFileSync: (path: string, value: string) => retained.set(path, value),
            copyFileSync: () => {
              throw new Error("altered bytes reached artifact copying")
            },
          }
        }
        throw new Error(`Unexpected DMG dependency: ${id}`)
      },
    })
  await expect(run("warp")).rejects.toThrow(
    `expected 866204c9583007b06c0e88e399fe57187150a9ab43ad4000c5935035794025c1, actual ${actual}`,
  )
  expect(launched.map((argv) => argv[0])).toEqual(["curl"])
  // The brew redirect returned 404 for these pinned bytes. Existing checksum coverage did not
  // inspect the real download destination; keep the verified static release, not a moving latest.
  expect(launched[0]).toEqual([
    "curl",
    "--location",
    "--fail",
    "--silent",
    "--show-error",
    "https://releases.warp.dev/stable/v0.2026.10.14.08.27.stable_01/Warp.dmg",
    "--output",
    "/runner/Warp.dmg",
  ])
  expect(JSON.parse(retained.get("/runner/measurement-artifacts/warp-installer.json")!)).toMatchObject({
    expectedSha256: "866204c9583007b06c0e88e399fe57187150a9ab43ad4000c5935035794025c1",
    actualSha256: actual,
  })
  launched.length = 0
  await run("alacritty")
  expect(launched).toEqual([
    [
      "curl",
      "--location",
      "--fail",
      "--silent",
      "--show-error",
      "https://github.com/alacritty/alacritty/releases/download/v0.17.0/Alacritty-v0.17.0.dmg",
      "--output",
      "/runner/Alacritty.dmg",
    ],
    ["hdiutil", "attach", "/runner/Alacritty.dmg", "-mountpoint", "/Volumes/Alacritty"],
    ["cp", "-R", "/Volumes/Alacritty/Alacritty.app", "/Applications/"],
    ["hdiutil", "detach", "/Volumes/Alacritty"],
  ])
})

// A valid configuration must carry the real command path as ONE shell argument, not merely launch Warp.
test("Warp hosted caller writes one legacy YAML pane before one cold GUI URI launch", async () => {
  const workflow = readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8")
  const source = workflow.split("<<'HOSTED_WARP_START'\n")[1]?.split("\n          HOSTED_WARP_START")[0]
  expect(source, "the production Warp launch caller exists").toBeDefined()
  const command = "/runner/Alice's files/collect.command"
  const writes = new Map<string, string>()
  const events: string[] = []
  const launches: Array<{ file: string; args: string[]; options: unknown }> = []
  await runInNewContext(`(async () => {${source}\n})()`, {
    process: { cwd: () => "/workspace", env: { COMMAND_PATH: command, APP_BUNDLE: "/Applications/Warp.app" } },
    console: { log: () => {} },
    require: (id: string) => {
      if (id === "node:fs") {
        return {
          mkdirSync: () => {},
          writeFileSync: (path: string, value: string, options: unknown) => {
            expect(options).toMatchObject({ flag: "wx" })
            events.push("config")
            writes.set(path, value)
          },
        }
      }
      if (id === "node:path") return { join }
      if (id === "node:os") return { homedir: () => "/Users/runner" }
      if (id === "node:crypto") return { randomUUID: () => "12345678-1234-1234-1234-123456789abc" }
      if (id === "yaml") return { stringify }
      if (id.endsWith("/daemon-client.ts")) return { shellQuote }
      if (id === "node:child_process") {
        return {
          spawn: (file: string, args: string[], options: unknown) => {
            events.push("launch")
            launches.push({ file, args, options })
            return { unref: () => events.push("unref") }
          },
        }
      }
      throw new Error(`Unexpected Warp launch dependency: ${id}`)
    },
  })
  expect(events).toEqual(["config", "launch", "unref"])
  expect([...writes.keys()]).toEqual([
    "/Users/runner/.warp/launch_configurations/terminfo-12345678-1234-1234-1234-123456789abc.yaml",
  ])
  const config = parse([...writes.values()][0]!)
  expect(config.windows).toHaveLength(1)
  expect(config.windows[0].tabs).toHaveLength(1)
  expect(config.windows[0].tabs[0].layout.cwd).toBe("/workspace")
  expect(config.windows[0].tabs[0].layout.commands).toHaveLength(1)
  const quoted = config.windows[0].tabs[0].layout.commands[0].exec
  const argv = spawnSync("/bin/bash", ["-c", `set -- ${quoted}; printf '%s\\0' "$@"`], { encoding: "utf8" })
  expect(argv.status, argv.stderr).toBe(0)
  expect(argv.stdout.split("\0").slice(0, -1)).toEqual(["/bin/bash", command])
  expect(launches).toEqual([
    {
      file: "/Applications/Warp.app/Contents/MacOS/stable",
      args: ["warp://launch/terminfo-12345678-1234-1234-1234-123456789abc"],
      options: { detached: true, stdio: "inherit" },
    },
  ])
})

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
  expect(JSON.parse(retained.get("/runner/measurement-artifacts/editor-installer.json")!)).toMatchObject({
    actualSha256: actual,
  })
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
  expect(retained).toHaveProperty("terminalWindow", window)
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
