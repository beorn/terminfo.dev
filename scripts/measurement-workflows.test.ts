/**
 * @failure A hosted measurement workflow installs changed archive bytes, retains inherited secrets,
 *   loses the owned editor launch/close ordering, or omits TERMINFO_RUN_ID and dies at collection.
 * @level l2
 * @consumer The GitHub-hosted macOS and Windows measurement collectors (27917).
 * @reach fs-walk .github/workflows/macos-measurement.yml .github/workflows/windows-measurement.yml
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runInNewContext } from "node:vm"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { parse, stringify } from "yaml"
import { shellQuote } from "../packages/terminfo.dev/src/daemon-client.ts"
import { expect, test } from "vitest"

const root = join(import.meta.dirname, "..")

// Startup evidence must precede readiness, survive early errors and append collector stderr.
// Existing argv/YAML tests never execute the generated shell, so they missed the empty archive.
test.each(["waiting", "bad-receipt", "collector"] as const)(
  "hosted command preserves startup evidence and PTY stdout through %s",
  (scenario) => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8"))
    const collect = workflow.jobs["measure-macos"].steps.find((step: { id?: string }) => step.id === "collect")
      .run as string
    const producer = collect.match(/cat > "\$COMMAND_PATH" <<SCRIPT\n[\s\S]*?\nSCRIPT\n/)
    expect(producer, "production command producer exists").not.toBeNull()
    const directory = mkdtempSync(join(tmpdir(), "hosted-entry-"))
    const out = join(directory, "artifacts")
    const command = join(directory, "collect.command")
    const collector = join(directory, "collector.sh")
    mkdirSync(out)
    try {
      writeFileSync(
        collector,
        "printf 'probe-stdout\\n'\nprintf 'collector-first\\n' >&2\nprintf 'collector-second\\n' >&2\nexit 7\n",
      )
      const generated = spawnSync("/bin/bash", ["-c", producer![0]], {
        encoding: "utf8",
        env: {
          ...process.env,
          OUT: out,
          COMMAND_PATH: command,
          BUN_DIR: "/bin",
          NODE_DIR: "/usr/bin",
          COLLECTOR_BUN: "/bin/bash",
          COLLECTOR: collector,
          TARGET_VERSION_EXPORT: "",
        },
      })
      expect(generated.status, generated.stderr).toBe(0)
      if (scenario !== "waiting") {
        writeFileSync(join(out, "collector-ready"), "")
        writeFileSync(
          join(out, "host-measured.json"),
          JSON.stringify(scenario === "collector" ? { runId: "a".repeat(32) } : {}),
        )
      }
      const result = spawnSync(
        "/bin/bash",
        ["-c", 'sleep() { printf "early-wait-error\\n" >&2; }; export -f sleep; /bin/bash "$1"', "fixture", command],
        { encoding: "utf8" },
      )
      const log = readFileSync(join(out, "collector.log"), "utf8")
      expect(log).toMatch(/phase=entry.*utc=.*pid=.*tty=/)
      if (scenario === "waiting") {
        expect(result.status).toBe(1)
        expect(log).toContain("early-wait-error")
        expect(log).toContain("Receipt self-parse never succeeded")
        expect(log).not.toContain("phase=receipt-ready")
      } else {
        expect(log).toContain("phase=receipt-ready")
        if (scenario === "bad-receipt") {
          expect(result.status).toBe(1)
          expect(log).toContain("Receipt has no launch run ID")
          expect(log).not.toContain("phase=collector-invoked")
        } else {
          expect(log).toContain("phase=run-id-parsed")
          expect(log).toContain("phase=collector-invoked")
          expect(log).toContain("collector-first\ncollector-second\n")
          expect(log).toContain("phase=collector-exited status=7")
          expect(readFileSync(join(out, "collector-exit"), "utf8")).toBe("7\n")
          expect(result.stdout).toBe("probe-stdout\n")
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

// A successful display-capture command proves no app window. Exercise the existing evidence
// block with platform command responses, keeping real subprocess capture and artifact writes.
test.each(["warp", "iterm2"] as const)(
  "%s failures retain bounded raw window evidence without claiming screenshot content",
  (appId) => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8"))
    const step = workflow.jobs["measure-macos"].steps.find(
      (row: { name?: string }) => row.name === "Preserve terminal launch failure evidence",
    )
    expect(step, "existing failure owner includes Warp").toBeDefined()
    expect(step.if).toContain("matrix.id == 'warp'")
    const source = (step.run as string).match(/^bun --eval '([\s\S]*)'\s*$/)?.[1]
    expect(source).toBeDefined()
    const directory = mkdtempSync(join(tmpdir(), "hosted-failure-"))
    const out = join(directory, "measurement-artifacts")
    mkdirSync(out)
    writeFileSync(
      join(out, "warp-launch-process.json"),
      JSON.stringify({ childPid: 4242, name: "fixture", launchStart: "2026-10-20T02:00:00Z" }),
    )
    const prelude = `const originalSpawn = Bun.spawn;
    Bun.spawn = (argv, options) => {
      const command = argv[0];
      if (command.endsWith("screencapture")) require("node:fs").writeFileSync(argv.at(-1), "fixture unclassified image bytes");
      const output = command.endsWith("osascript") ? JSON.stringify({ windows: [{ owner: "Warp", pid: 4242, layer: 0 }] })
        : command.endsWith("ps") ? "PID PPID PGID TTY COMM\\n4242 1 4242 ?? stable\\n"
        : command.endsWith("log") ? "[]" : "";
      return originalSpawn(["/bin/bash", "-c", "printf '%s' \\\"$1\\\"", "fixture", output], options);
    };\n`
    try {
      const result = spawnSync(process.execPath, ["--eval", prelude + source], {
        encoding: "utf8",
        env: {
          ...process.env,
          APP_ID: appId,
          RUNNER_TEMP: directory,
          ITERM_LAUNCH_START: "2026-10-20T02:00:00Z",
          ITERM_LAUNCH_END: "2026-10-20T02:00:01Z",
        },
      })
      expect(result.status, result.stderr).toBe(0)
      const prefix = appId === "warp" ? "warp" : "iterm"
      const summary = JSON.parse(readFileSync(join(out, `${prefix}-failure-evidence.json`), "utf8"))
      expect(summary).toMatchObject({
        appId,
        childPid: appId === "warp" ? 4242 : null,
        screenContent: "unmeasured: inspect raw display for blank or desktop-only content; not owned-window proof",
      })
      const census = JSON.parse(readFileSync(join(out, `${prefix}-windows.json`), "utf8"))
      expect(census).toHaveProperty(
        "stdout.text",
        JSON.stringify({ windows: [{ owner: "Warp", pid: 4242, layer: 0 }] }),
      )
      expect(census).toHaveProperty("stdout.omittedBytes", 0)
      if (appId === "warp") {
        expect(JSON.parse(readFileSync(join(out, "warp-processes.json"), "utf8"))).toHaveProperty(
          "stdout.text",
          expect.stringContaining("4242"),
        )
      }
      const log = JSON.parse(readFileSync(join(out, `${prefix}-log.json`), "utf8"))
      expect(log).toHaveProperty(
        "argv",
        expect.arrayContaining([
          expect.stringContaining(appId === "warp" ? 'process == "stable"' : 'process == "appleeventsd"'),
        ]),
      )
      expect(log).toHaveProperty("stdout.text", "[]")
      expect(summary).toHaveProperty("failures", [])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

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

// Setup must finish before the cold GUI launch. The old VM-only YAML test could not
// detect a failed/mistyped preference write or an already-used host. Keep its real
// YAML/quoting assertions in this caller test; no production injection seam is added.
test.each([
  "success",
  "wrong-domain",
  "running",
  "present",
  "before-error",
  "write-error",
  "wrong-value",
  "wrong-type",
] as const)("Warp hosted caller prepares only the fresh Stable domain: %s", (scenario) => {
  const workflow = readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8")
  const source = workflow.split("<<'HOSTED_WARP_START'\n")[1]?.split("\n          HOSTED_WARP_START")[0]
  expect(source, "the production Warp launch caller exists").toBeDefined()
  const directory = mkdtempSync(join(tmpdir(), "warp-setup-"))
  const out = join(directory, "measurement-artifacts")
  const home = join(directory, "home")
  const bin = join(directory, "bin")
  const journal = join(directory, "events.jsonl")
  const command = join(directory, "Alice's files", "collect.command")
  for (const path of [out, home, bin, dirname(command)]) mkdirSync(path, { recursive: true })
  writeFileSync(command, "the actual generated command bytes")
  // Fixed absolute production commands are redirected to PATH shims only in this
  // subprocess's platform boundary. The journal retains the original absolute argv.
  const shim = `#!${process.execPath}
const fs = require("node:fs");
const name = require("node:path").basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = process.env.WARP_SETUP_SCENARIO;
const marker = process.env.RUNNER_TEMP + "/written";
if (name === "PlistBuddy") console.log(scenario === "wrong-domain" ? "dev.warp.Warp-Preview" : "dev.warp.Warp-Stable");
else if (name === "ps") console.log("PID COMM\\n" + (scenario === "running" ? "4242 /Applications/Warp.app/Contents/MacOS/stable" : scenario === "success" ? "1 /usr/libexec/fixture-process\\n".repeat(3000) + "9999 /fixture/census-end" : "1 /sbin/launchd"));
else if (name === "defaults") {
  if (args[0] === "write") {
    if (scenario === "write-error") { console.error("fixture write denied"); process.exit(9); }
    fs.writeFileSync(marker, "true");
  } else if (args[0] === "read-type") console.log(scenario === "wrong-type" ? "Type is boolean" : "Type is string");
  else if (fs.existsSync(marker)) console.log(scenario === "wrong-value" ? "false" : "true");
  else if (scenario === "present") console.log("true");
  else { console.error(scenario === "before-error" ? "fixture permission denied" : "The domain/default pair of (dev.warp.Warp-Stable, HasCompletedOnboarding) does not exist"); process.exit(1); }
} else throw new Error("Unexpected platform shim " + name);
`
  for (const name of ["defaults", "PlistBuddy", "ps"]) writeFileSync(join(bin, name), shim, { mode: 0o700 })
  const prelude = `
const fsBoundary = require("node:fs");
const childBoundary = require("node:child_process");
const nativeSpawnSync = childBoundary.spawnSync;
require("node:os").homedir = () => process.env.WARP_SETUP_HOME;
childBoundary.spawnSync = (file, args, options) => {
  fsBoundary.appendFileSync(process.env.WARP_SETUP_JOURNAL, JSON.stringify({event:"command", file, args}) + "\\n");
  if (!["/usr/bin/defaults", "/usr/libexec/PlistBuddy", "/bin/ps"].includes(file)) throw new Error("Unexpected setup executable " + file);
  return nativeSpawnSync(require("node:path").basename(file), args, options);
};
childBoundary.spawn = (file, args, options) => {
  const setupPath = process.env.RUNNER_TEMP + "/measurement-artifacts/warp-onboarding-setup.json";
  fsBoundary.appendFileSync(process.env.WARP_SETUP_JOURNAL, JSON.stringify({event:"launch", file, args, options, setupExists:fsBoundary.existsSync(setupPath), commandExists:fsBoundary.existsSync(process.env.RUNNER_TEMP + "/measurement-artifacts/collect.command")}) + "\\n");
  return {pid:4242, unref() {}};
};
`
  try {
    const result = spawnSync("/bin/bash", ["-c", 'exec "$WARP_SETUP_BUN" --eval "$WARP_SETUP_SOURCE"'], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        COMMAND_PATH: command,
        APP_BUNDLE: "/Applications/Warp.app",
        RUNNER_TEMP: directory,
        WARP_SETUP_SCENARIO: scenario,
        WARP_SETUP_HOME: home,
        WARP_SETUP_JOURNAL: journal,
        WARP_SETUP_BUN: process.execPath,
        WARP_SETUP_SOURCE: prelude + source,
      },
    })
    type CallerEvent = { event: string; file: string; args: string[]; options?: unknown; setupExists?: boolean }
    const events = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CallerEvent)
    const launches = events.filter((row) => row.event === "launch")
    const setup = JSON.parse(readFileSync(join(out, "warp-onboarding-setup.json"), "utf8")) as {
      prepared: boolean
      commands: Array<{ label: string; stdout: string }>
    }
    const preferenceCalls = events.filter((row) => row.file === "/usr/bin/defaults")
    expect(
      preferenceCalls.every(
        (row) => row.args[1] === "dev.warp.Warp-Stable" && row.args[2] === "HasCompletedOnboarding",
      ),
    ).toBe(true)
    if (scenario !== "success") {
      expect(result.status, result.stderr).not.toBe(0)
      expect(result.stderr).toContain("Warp unattended setup failed")
      expect(launches).toHaveLength(0)
      expect(setup.prepared).toBe(false)
      if (["wrong-domain", "running", "present", "before-error"].includes(scenario)) {
        expect(preferenceCalls.filter((row) => row.args[0] === "write")).toHaveLength(0)
      }
      if (scenario === "write-error") expect(JSON.stringify(setup)).toContain("fixture write denied")
      if (scenario === "before-error") expect(JSON.stringify(setup)).toContain("fixture permission denied")
      return
    }
    expect(result.status, result.stderr).toBe(0)
    expect(setup.prepared).toBe(true)
    expect(setup.commands.find((row) => row.label === "processes")?.stdout).toContain("9999 /fixture/census-end")
    expect(preferenceCalls.map((row) => row.args)).toEqual([
      ["read", "dev.warp.Warp-Stable", "HasCompletedOnboarding"],
      ["write", "dev.warp.Warp-Stable", "HasCompletedOnboarding", "-string", "true"],
      ["read", "dev.warp.Warp-Stable", "HasCompletedOnboarding"],
      ["read-type", "dev.warp.Warp-Stable", "HasCompletedOnboarding"],
    ])
    expect(JSON.stringify(setup)).toContain("does not exist")
    expect(readFileSync(join(out, "collect.command"), "utf8")).toBe("the actual generated command bytes")
    const yaml = readFileSync(join(out, "warp-launch.yaml"), "utf8")
    const config = parse(yaml)
    expect(readFileSync(join(home, ".warp/launch_configurations", config.name + ".yaml"), "utf8")).toBe(yaml)
    expect(config.windows).toHaveLength(1)
    expect(config.windows[0].tabs).toHaveLength(1)
    expect(config.windows[0].tabs[0].layout.cwd).toBe(root)
    expect(config.windows[0].tabs[0].layout.commands).toHaveLength(1)
    const quoted = config.windows[0].tabs[0].layout.commands[0].exec
    const argv = spawnSync("/bin/bash", ["-c", `set -- ${quoted}; printf '%s\\0' "$@"`], { encoding: "utf8" })
    expect(argv.status, argv.stderr).toBe(0)
    expect(argv.stdout.split("\0").slice(0, -1)).toEqual(["/bin/bash", command])
    expect(launches).toEqual([
      {
        event: "launch",
        file: "/Applications/Warp.app/Contents/MacOS/stable",
        args: ["warp://launch/" + config.name],
        options: { detached: true, stdio: "inherit" },
        setupExists: true,
        commandExists: true,
      },
    ])
    expect(JSON.parse(readFileSync(join(out, "warp-launch-process.json"), "utf8"))).toMatchObject({
      name: config.name,
      childPid: 4242,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
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

// The generated-command subprocess above owns the stdout/stderr contract (27917 / 28533).
// It replaces the literal-redirection regex, which misclassified stderr append as stdout output.
