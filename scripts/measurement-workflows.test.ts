/**
 * @failure A hosted measurement workflow installs changed archive bytes, retains inherited secrets,
 *   loses the owned editor launch/close ordering, or omits TERMINFO_RUN_ID and dies at collection.
 * @level l2
 * @consumer The GitHub-hosted macOS and Windows measurement collectors (27917).
 * @reach fs-walk vendor/terminfo.dev/.github/workflows/macos-measurement.yml vendor/terminfo.dev/.github/workflows/windows-measurement.yml
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { runInNewContext } from "node:vm"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { parse, stringify } from "yaml"
import { shellQuote } from "../packages/terminfo.dev/src/daemon-client.ts"
import { censusDarwinWindows } from "../packages/terminfo.dev/src/darwin-capture.ts"
import { expect, test } from "vitest"

const root = join(import.meta.dirname, "..")

// Startup evidence must precede readiness, survive early errors and append collector stderr.
// Existing argv/YAML tests never execute the generated shell, so they missed the empty archive.
test.each(["waiting", "bad-receipt", "collector", "selected"] as const)(
  "hosted command preserves startup evidence and PTY stdout through %s",
  (scenario) => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8"))
    const collect = workflow.jobs["measure-macos"].steps.find((step: { id?: string }) => step.id === "collect")
      .run as string
    // The runner parses the whole step before reaching any extracted caller (30392).
    const syntax = spawnSync("/bin/bash", ["-n"], { input: collect, encoding: "utf8" })
    expect(syntax.status, syntax.stderr).toBe(0)
    const producer = collect.match(
      /(?:PROBE_IDS_EXPORT=""\n[\s\S]*?)?cat > "\$COMMAND_PATH" <<SCRIPT\n[\s\S]*?\nSCRIPT\n/,
    )
    expect(producer, "production command producer exists").not.toBeNull()
    const directory = mkdtempSync(join(tmpdir(), "hosted-entry-"))
    const out = join(directory, "artifacts")
    const command = join(directory, "collect.command")
    const collector = join(directory, "collector.sh")
    mkdirSync(out)
    try {
      writeFileSync(
        collector,
        `printf '%s\\0' "$@" "\${TERMINFO_PROBE_IDS-unset}" "$TERMINFO_CAPTURE_RUN_ID" "$TERMINFO_RUN_ID" > ${shellQuote(join(out, "invocation"))}\nprintf 'probe-stdout\\n'\nprintf 'collector-first\\n' >&2\nprintf 'collector-second\\n' >&2\nexit 7\n`,
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
          PROBE_IDS: scenario === "selected" ? '["cursor-position","device-attributes"]' : "null",
          CAPTURE_RUN_ID: "b".repeat(32),
        },
      })
      expect(generated.status, generated.stderr).toBe(0)
      if (scenario !== "waiting") {
        writeFileSync(join(out, "collector-ready"), "")
        writeFileSync(
          join(out, "host-measured.json"),
          JSON.stringify(scenario === "collector" || scenario === "selected" ? { runId: "a".repeat(32) } : {}),
        )
      }
      const commandEnv = { ...process.env }
      delete commandEnv.TERMINFO_PROBE_IDS
      const result = spawnSync(
        "/bin/bash",
        ["-c", 'sleep() { printf "early-wait-error\\n" >&2; }; export -f sleep; /bin/bash "$1"', "fixture", command],
        { encoding: "utf8", env: commandEnv },
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
          expect(readFileSync(join(out, "invocation"), "utf8").split("\0").slice(0, -1)).toEqual([
            "test",
            "--output",
            join(out, "run.json"),
            scenario === "selected" ? '["cursor-position","device-attributes"]' : "unset",
            "b".repeat(32),
            "a".repeat(32),
          ])
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

// A successful display-capture command proves no app window. Exercise the existing evidence
// block with platform command responses, keeping real subprocess capture and artifact writes.
test.each([
  { appId: "warp", missingLaunch: false },
  { appId: "iterm2", missingLaunch: false },
  { appId: "cmux", missingLaunch: false },
  { appId: "cursor", missingLaunch: false },
  { appId: "com.microsoft.VSCode", missingLaunch: false },
  { appId: "cursor", missingLaunch: true },
])(
  "$appId failures retain bounded evidence before cleanup (missing launch: $missingLaunch)",
  ({ appId, missingLaunch }) => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8"))
    const step = workflow.jobs["measure-macos"].steps.find(
      (row: { name?: string }) => row.name === "Preserve terminal launch failure evidence",
    )
    expect(step, "existing failure owner includes Warp").toBeDefined()
    expect(step.if).toContain("matrix.id == 'warp'")
    const editor = appId === "cursor" || appId === "com.microsoft.VSCode"
    if (appId !== "iterm2") expect(step.if).toContain(`matrix.id == '${appId}'`)
    if (editor) {
      const close = workflow.jobs["measure-macos"].steps.find(
        (row: { name?: string }) => row.name === "Retain editor launch files and close only its owned GUI",
      )
      expect(close).toBeDefined()
      expect(workflow.jobs["measure-macos"].steps.indexOf(step)).toBeLessThan(
        workflow.jobs["measure-macos"].steps.indexOf(close),
      )
      expect(close.if).toContain("always()")
    }
    const source = (step.run as string).match(/^bun --eval '([\s\S]*)'\s*$/)?.[1]
    expect(source).toBeDefined()
    const directory = mkdtempSync(join(tmpdir(), "hosted-failure-"))
    const out = join(directory, "measurement-artifacts")
    mkdirSync(out)
    writeFileSync(
      join(out, "warp-launch-process.json"),
      JSON.stringify({ childPid: 4242, name: "fixture", launchStart: "2026-10-20T02:00:00Z" }),
    )
    const editorLaunch = {
      appId,
      run: { id: "a".repeat(32), directory: "/fixture/owned-run" },
      terminalWindow: {
        provider: "cli-process",
        ownerPid: 4242,
        executablePath: "/Applications/Editor.app/Contents/MacOS/Editor",
        marker: { flag: "--user-data-dir", value: "/fixture/owned-run/profile" },
        tty: "/dev/ttys001",
      },
    }
    if (!missingLaunch) writeFileSync(join(out, "editor-launch.json"), JSON.stringify(editorLaunch))
    writeFileSync(
      join(out, "host-measured.json"),
      JSON.stringify({
        runId: "b".repeat(32),
        appLaunch: {
          bundlePath: "/Applications/cmux.app",
          executablePath: "/Applications/cmux.app/Contents/MacOS/cmux",
        },
      }),
    )
    const windows = [
      {
        id: 37,
        ownerPid: 4242,
        layer: 0,
        bounds: { x: 282, y: 43, width: 460, height: 639 },
        sharingState: 0,
        memoryUsage: 2368,
      },
    ]
    const prelude = `const originalSpawn = Bun.spawn;
    Bun.spawn = (argv, options) => {
      const command = argv[0];
      if (command.endsWith("screencapture")) require("node:fs").writeFileSync(argv.at(-1), "fixture unclassified image bytes");
      const output = command.endsWith("osascript") ? ${JSON.stringify(JSON.stringify(windows))}
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
          GITHUB_WORKSPACE: root,
          COLLECT_STARTED_AT: "2026-10-20T02:00:00Z",
          ITERM_LAUNCH_START: "2026-10-20T02:00:00Z",
          ITERM_LAUNCH_END: "2026-10-20T02:00:01Z",
        },
      })
      expect(result.status, result.stderr).toBe(missingLaunch ? 1 : 0)
      const prefix = appId === "iterm2" ? "iterm" : appId === "com.microsoft.VSCode" ? "vscode" : appId
      const summary = JSON.parse(readFileSync(join(out, `${prefix}-failure-evidence.json`), "utf8"))
      expect(summary).toMatchObject({
        appId,
        childPid: appId === "warp" ? 4242 : null,
        screenContent: "unmeasured: inspect raw display for blank or desktop-only content; not owned-window proof",
      })
      const census = JSON.parse(readFileSync(join(out, `${prefix}-windows.json`), "utf8"))
      expect(census).toHaveProperty("stdout.text", JSON.stringify(windows))
      expect(census).toHaveProperty("stdout.omittedBytes", 0)
      if (appId !== "iterm2") {
        expect(JSON.parse(readFileSync(join(out, `${prefix}-processes.json`), "utf8"))).toHaveProperty(
          "stdout.text",
          expect.stringContaining("4242"),
        )
      }
      const log = JSON.parse(readFileSync(join(out, `${prefix}-log.json`), "utf8"))
      expect(log).toHaveProperty("argv", expect.arrayContaining(["2026-10-20 02:00:00+0000"]))
      expect(log).toHaveProperty("stdout.text", "[]")
      if (editor && !missingLaunch) expect(summary).toHaveProperty("editorLaunch", editorLaunch)
      if (appId === "cmux") expect(summary).toHaveProperty("receiptRunId", "b".repeat(32))
      if (missingLaunch) {
        expect(summary).toHaveProperty("failures", [expect.objectContaining({ label: "launch-record" })])
      } else expect(summary).toHaveProperty("failures", [])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

// The actual shared DMG caller must verify Warp before mount/copy, without changing Alacritty's operation.
test("shared hosted DMG caller rejects altered pinned bytes before install and preserves Alacritty arguments", async () => {
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
  for (const [app, expectedSha256] of [
    ["warp", "866204c9583007b06c0e88e399fe57187150a9ab43ad4000c5935035794025c1"],
    ["cmux", "2f4bd98df7514067408d89398f8f19059015a3bbae632d0474515d4b76d6ee36"],
  ]) {
    await expect(run(app!)).rejects.toThrow(`expected ${expectedSha256}, actual ${actual}`)
    expect(launched.map((argv) => argv[0])).toEqual(["curl"])
    // The pinned Warp bytes must use the verified static release locator; the old redirect returned 404.
    if (app === "warp") {
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
    }
    expect(JSON.parse(retained.get(`/runner/measurement-artifacts/${app}-installer.json`)!)).toMatchObject({
      expectedSha256,
      actualSha256: actual,
    })
    launched.length = 0
  }
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

test("cmux hosted caller quotes the first-surface command before one cold GUI open", async () => {
  const workflow = readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8")
  const source = workflow.split("<<'HOSTED_CMUX_START'\n")[1]?.split("\n          HOSTED_CMUX_START")[0]
  expect(source, "the production cmux launch caller exists").toBeDefined()
  const command = "/runner/Alice's files/collect.command"
  const writes = new Map<string, string>()
  const events: string[] = []
  const launches: string[][] = []
  const native: string[][] = []
  let setupFailure = ""
  const run = (status: number) =>
    runInNewContext(`(async () => {${source}\n})()`, {
      process: {
        cwd: () => root,
        env: { COMMAND_PATH: command, APP_BUNDLE: "/Applications/cmux.app", RUNNER_TEMP: "/runner" },
      },
      Bun: {
        spawn: (argv: string[]) => {
          events.push("launch")
          launches.push(argv)
          return { exited: Promise.resolve(status) }
        },
      },
      require: (id: string) => {
        if (id === "node:fs") {
          return {
            mkdirSync: () => {},
            writeFileSync: (path: string, value: string) => {
              events.push(path.endsWith("/ghostty/config") ? "config" : "evidence")
              writes.set(path, value)
            },
          }
        }
        if (id === "node:path") return { join }
        if (id === "node:os") return { homedir: () => "/Users/runner" }
        if (id === "node:child_process") {
          return {
            spawnSync: (file: string, args: string[]) => {
              native.push([file, ...args])
              events.push(`native:${args[0]}`)
              if (setupFailure === "write" && args[0] === "write") {
                return { status: 9, stdout: "", stderr: "fixture preference write denied" }
              }
              const stdout = file.endsWith("PlistBuddy")
                ? args[1] === "Print :CFBundleIdentifier"
                  ? "fixture.installed.cmux"
                  : "0.65.2"
                : args[0] === "read-type"
                  ? setupFailure === "type"
                    ? "Type is boolean"
                    : "Type is string"
                  : args[0] === "read"
                    ? setupFailure === "value"
                      ? "false"
                      : "0.65.1"
                    : ""
              return { status: 0, stdout, stderr: "" }
            },
          }
        }
        if (id.endsWith("/daemon-client.ts")) return { shellQuote }
        throw new Error(`Unexpected cmux launch dependency: ${id}`)
      },
    })
  await run(0)
  expect(native).toEqual([
    ["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", "/Applications/cmux.app/Contents/Info.plist"],
    [
      "/usr/libexec/PlistBuddy",
      "-c",
      "Print :CFBundleShortVersionString",
      "/Applications/cmux.app/Contents/Info.plist",
    ],
    ["/usr/bin/defaults", "write", "fixture.installed.cmux", "cmux.cloud.welcome.seenVersion", "-string", "0.65.1"],
    ["/usr/bin/defaults", "read", "fixture.installed.cmux", "cmux.cloud.welcome.seenVersion"],
    ["/usr/bin/defaults", "read-type", "fixture.installed.cmux", "cmux.cloud.welcome.seenVersion"],
  ])
  expect(events.indexOf("native:write")).toBeLessThan(events.indexOf("launch"))
  expect(events.indexOf("native:read-type")).toBeLessThan(events.indexOf("launch"))
  expect(events.indexOf("evidence")).toBeLessThan(events.indexOf("launch"))
  expect(events.indexOf("config")).toBeLessThan(events.indexOf("launch"))
  expect(launches).toEqual([["open", "-a", "/Applications/cmux.app"]])
  expect(JSON.parse(writes.get("/runner/measurement-artifacts/cmux-launch-setup.json")!)).toMatchObject({
    domain: "fixture.installed.cmux",
    version: "0.65.2",
    prepared: true,
  })
  const configured = writes
    .get("/Users/runner/.config/ghostty/config")!
    .trim()
    .replace(/^initial-command = /, "")
  const argv = spawnSync("/bin/bash", ["-c", `set -- ${configured}; printf '%s\\0' "$@"`], { encoding: "utf8" })
  expect(argv.status, argv.stderr).toBe(0)
  expect(argv.stdout.split("\0").slice(0, -1)).toEqual(["/bin/bash", command])
  await expect(run(7)).rejects.toThrow(/open.*7/)
  for (setupFailure of ["write", "type", "value"]) {
    launches.length = 0
    await expect(run(0)).rejects.toThrow(/cmux.*setup failed/)
    expect(launches).toHaveLength(0)
    expect(JSON.parse(writes.get("/runner/measurement-artifacts/cmux-launch-setup.json")!)).toHaveProperty(
      "prepared",
      false,
    )
  }
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
  "restore-write-error",
  "restore-wrong-value",
  "restore-wrong-type",
  "existing-settings",
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
  const settingsPath = join(home, ".warp", "settings.toml")
  if (scenario === "existing-settings") {
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, "retained existing settings")
  }
  // Fixed absolute production commands are redirected to PATH shims only in this
  // subprocess's platform boundary. The journal retains the original absolute argv.
  const shim = `#!${process.execPath}
const fs = require("node:fs");
const name = require("node:path").basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = process.env.WARP_SETUP_SCENARIO;
const key = args[2];
const marker = process.env.RUNNER_TEMP + "/written-" + key;
if (name === "PlistBuddy") console.log(scenario === "wrong-domain" ? "dev.warp.Warp-Preview" : "dev.warp.Warp-Stable");
else if (name === "ps") console.log("PID COMM\\n" + (scenario === "running" ? "4242 /Applications/Warp.app/Contents/MacOS/stable" : scenario === "success" ? "1 /usr/libexec/fixture-process\\n".repeat(3000) + "9999 /fixture/census-end" : "1 /sbin/launchd"));
else if (name === "defaults") {
  if (args[0] === "write") {
    if (scenario === "write-error" || (scenario === "restore-write-error" && key === "RestoreSession")) { console.error("fixture write denied"); process.exit(9); }
    fs.writeFileSync(marker, args[4]);
  } else if (args[0] === "read-type") console.log(scenario === "wrong-type" || (scenario === "restore-wrong-type" && key === "RestoreSession") ? "Type is boolean" : "Type is string");
  else if (fs.existsSync(marker)) console.log(scenario === "wrong-value" ? "false" : scenario === "restore-wrong-value" && key === "RestoreSession" ? "true" : fs.readFileSync(marker, "utf8"));
  else if (scenario === "existing-settings" && key === "SettingsFileMigrationComplete") console.log("true");
  else if (scenario === "present") console.log("true");
  else { console.error(scenario === "before-error" ? "fixture permission denied" : "The domain/default pair of (dev.warp.Warp-Stable, " + key + ") does not exist"); process.exit(1); }
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
      settingsFile: { path: string; exists: boolean }
    }
    const preferenceCalls = events.filter((row) => row.file === "/usr/bin/defaults")
    expect(
      preferenceCalls.every(
        (row) =>
          row.args[1] === "dev.warp.Warp-Stable" &&
          ["HasCompletedOnboarding", "RestoreSession", "SettingsFileMigrationComplete"].includes(row.args[2]!),
      ),
    ).toBe(true)
    if (scenario !== "success" && scenario !== "existing-settings") {
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
    if (scenario === "success") {
      expect(setup.commands.find((row) => row.label === "processes")?.stdout).toContain("9999 /fixture/census-end")
    }
    expect(setup.settingsFile).toEqual({ path: settingsPath, exists: scenario === "existing-settings" })
    if (scenario === "existing-settings") {
      expect(readFileSync(settingsPath, "utf8")).toBe("retained existing settings")
      expect(setup.commands.find((row) => row.label === "migration-marker")?.stdout.trim()).toBe("true")
    }
    expect(preferenceCalls.map((row) => row.args)).toEqual([
      ["read", "dev.warp.Warp-Stable", "HasCompletedOnboarding"],
      ["read", "dev.warp.Warp-Stable", "SettingsFileMigrationComplete"],
      ["read", "dev.warp.Warp-Stable", "RestoreSession"],
      ["write", "dev.warp.Warp-Stable", "HasCompletedOnboarding", "-string", "true"],
      ["read", "dev.warp.Warp-Stable", "HasCompletedOnboarding"],
      ["read-type", "dev.warp.Warp-Stable", "HasCompletedOnboarding"],
      ["write", "dev.warp.Warp-Stable", "RestoreSession", "-string", "false"],
      ["read", "dev.warp.Warp-Stable", "RestoreSession"],
      ["read-type", "dev.warp.Warp-Stable", "RestoreSession"],
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
  // createProbeRun names the script with the run id (#30518 D2), so the retained copy must follow it.
  const run = { id: "fixture-id", directory: "/private/run", scriptPath: "/private/run/serve-fixture-id.sh" }
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
      if (id === "node:path") return { basename, join, dirname }
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
  expect(copies).toContain("/runner/measurement-artifacts/editor-launch-files/serve-fixture-id.sh")
  expect(copies).toContain("/runner/measurement-artifacts/editor-launch-files/cursor-profile/logs/exthost.log")
  expect(closed).toEqual([window])
  expect(events.at(-1)).toBe("close")
})

// Selected hosted collection must use one matrix-data owner and omit empty work before expansion.
// Existing step-condition fixtures neither read dispatch defaults nor check the job-level input wiring.
test.each(["macos", "windows"])("%s workflow keeps the full matrix in its dispatch default", (os) => {
  const workflow = parse(readFileSync(join(root, `.github/workflows/${os}-measurement.yml`), "utf8"))
  const inputs = workflow.on.workflow_dispatch.inputs
  const job = workflow.jobs[`measure-${os}`]
  expect(inputs.context_matrix).toMatchObject({ type: "string", required: false })
  expect(inputs.probe_ids).toMatchObject({ type: "string", required: false, default: "null" })
  const matrix = JSON.parse(inputs.context_matrix.default)
  expect(Object.keys(matrix)).toEqual(["include"])
  if (os === "windows")
    expect(matrix.include).toEqual([{ id: "windows-terminal" }, { id: "alacritty" }, { id: "wezterm" }])
  else {
    expect(matrix.include).toHaveLength(9)
    expect(matrix.include.every((row: { id: string; bundle: string }) => row.id && row.bundle)).toBe(true)
  }
  expect(job.strategy.matrix).toBe("${{ fromJSON(inputs.context_matrix) }}")
  expect(job.if).toBe(
    "${{ toJSON(fromJSON(inputs.context_matrix).include) != '[]' && toJSON(fromJSON(inputs.probe_ids)) != '[]' }}",
  )
  expect(job.env.PROBE_IDS).toBe("${{ inputs.probe_ids }}")
})

// The native Windows child is PowerShell. Execute its actual bash producer, then inspect the
// generated child; Linux does not prove PowerShell execution or hosted scheduler behavior.
test.each(["null", '["cursor-position","device-attributes"]'])(
  "Windows collector producer carries probe input %s without changing argv or run IDs",
  (probeIds) => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/windows-measurement.yml"), "utf8"))
    const collect = workflow.jobs["measure-windows"].steps.find((step: { id?: string }) => step.id === "collect")
      .run as string
    const producer = collect.match(/(?:PROBE_IDS_EXPORT=""\n[\s\S]*?)?cat > "\$COMMAND_PATH" <<PS1\n[\s\S]*?\nPS1\n/)
    expect(producer, "production Windows command producer exists").not.toBeNull()
    const directory = mkdtempSync(join(tmpdir(), "hosted-windows-entry-"))
    const command = join(directory, "collect.ps1")
    try {
      const generated = spawnSync("/bin/bash", ["-c", producer![0]], {
        encoding: "utf8",
        env: {
          ...process.env,
          COMMAND_PATH: command,
          APP_DIR: "/stub/app",
          BUN_DIR: "/stub/bin",
          NODE_DIR: "/stub/node",
          COLLECTOR_BUN: "/stub/bun",
          COLLECTOR: "/stub/terminfo.mjs",
          WIN_OUT: "/stub/out",
          WIN_EXECUTABLE: "/stub/app/terminal.exe",
          CAPTURE_RUN_ID: "b".repeat(32),
          PROBE_IDS: probeIds,
        },
      })
      expect(generated.status, generated.stderr).toBe(0)
      const child = readFileSync(command, "utf8")
      if (probeIds === "null") expect(child).not.toContain("$env:TERMINFO_PROBE_IDS")
      else expect(child).toContain(`$env:TERMINFO_PROBE_IDS = '${probeIds}'`)
      expect(child).toContain(`$env:TERMINFO_CAPTURE_RUN_ID = "${"b".repeat(32)}"`)
      expect(child).toContain("$env:TERMINFO_RUN_ID = $receipt.runId")
      expect(child).toContain('& "/stub/bun" "/stub/terminfo.mjs" test --output "/stub/out\\run.json" *>&1')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

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

// 30624: the iTerm2 failure branch greps collector.log for the two-window census refusal and names the
// count on stderr. The producer's wording changed (e9485c2fb) and the grep went stale silently, so the
// pattern is read out of the workflow and matched against the message selectDarwinWindow actually throws.
test("macOS workflow's two-window diagnostic grep matches the census refusal the capture throws", () => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8"))
  const collect = workflow.jobs["measure-macos"].steps.find((step: { id?: string }) => step.id === "collect")
    .run as string
  const grep = /grep -q '([^']+)' "\$OUT\/collector\.log"/.exec(collect)
  if (!grep) throw new Error("the iTerm2 failure branch no longer greps collector.log for the window census")
  const [, source] = grep
  if (source === undefined) throw new Error("the collector.log grep carries no pattern")
  // Plain grep reads a basic regular expression; only literal text and `.*` mean the same thing in
  // JavaScript, so the translation below is honest only while the pattern stays inside that alphabet.
  expect(source, "the grep pattern uses only literal text and .*").toMatch(/^[A-Za-z0-9 ;.*]+$/)
  const pattern = new RegExp(source)
  const selectDarwinWindow = (rows: unknown, appPid: number) => censusDarwinWindows(rows, appPid).selected.window
  const twin = (id: number) => ({
    id,
    ownerPid: 41,
    layer: 0,
    bounds: { x: 12, y: 31, width: 1000, height: 677 },
    alpha: 1,
    onscreen: true,
  })
  expect(() => selectDarwinWindow([twin(7), twin(8)], 41)).toThrow(pattern)
  // The diagnostic names a count of two; the no-window refusal must not trip it.
  expect(() => selectDarwinWindow([], 41)).toThrow(/found 0 candidates/)
  expect(() => selectDarwinWindow([], 41)).not.toThrow(pattern)
})

// The generated-command subprocess above owns the stdout/stderr contract (27917 / 28533).
// It replaces the literal-redirection regex, which misclassified stderr append as stdout output.

// 30655: iTerm2, cmux and the two editors are their own TCC responsible process, so the image's
// Screen Recording grants never reach their screencapture. No other test runs the grant step: this
// executes it with the macOS commands as fixtures, proving it grants the bundle's own identifier in
// both TCC databases before launch and fails the job when a grant does not read back.
test.each(["granted", "unreadable"] as const)(
  "Screen Recording grant step for self-responsible apps: %s",
  (scenario) => {
    const steps = parse(readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8")).jobs[
      "measure-macos"
    ].steps as { name?: string; id?: string; if?: string; run: string }[]
    const grant = steps.find((step) => step.name?.startsWith("Grant Screen Recording"))
    if (!grant) throw new Error("the macOS workflow has no Screen Recording grant step")
    expect(steps.indexOf(grant)).toBeLessThan(steps.findIndex((step) => step.id === "collect"))
    for (const id of ["iterm2", "cmux", "cursor", "com.microsoft.VSCode"]) {
      expect(grant.if).toContain(`matrix.id == '${id}'`)
    }
    const directory = mkdtempSync(join(tmpdir(), "screen-grant-"))
    const bin = join(directory, "bin")
    const journal = join(directory, "journal")
    mkdirSync(bin)
    const fixture = (name: string, body: string) =>
      writeFileSync(join(bin, name), `#!/bin/bash\nprintf '%s\\0' ${name} "$@" >> ${shellQuote(journal)}\n${body}\n`, {
        mode: 0o755,
      })
    try {
      fixture("PlistBuddy", `case "$2" in *Identifier) echo com.example.term ;; *) echo Term ;; esac`)
      fixture("codesign", `echo 'designated => identifier "com.example.term"'`)
      fixture("csreq", `printf 'csreq' > "$3"`)
      fixture("xxd", `od -An -tx1 "$2" | tr -d ' '`)
      fixture("sudo", `exec "$@"`)
      fixture("sqlite3", `case "$2" in SELECT*) ${scenario === "granted" ? "echo 2" : "true"} ;; esac`)
      fixture("defaults", "")
      const run = spawnSync(
        "/bin/bash",
        ["-c", grant.run.replaceAll("/usr/libexec/PlistBuddy", join(bin, "PlistBuddy"))],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            HOME: directory,
            RUNNER_TEMP: directory,
            APP_BUNDLE: "/Applications/Term.app",
          },
        },
      )
      const calls = readFileSync(journal, "utf8").split("\0").join(" ")
      expect(run.status, run.stderr).toBe(scenario === "granted" ? 0 : 1)
      const system = "/Library/Application Support/com.apple.TCC/TCC.db"
      const user = `${directory}/Library/Application Support/com.apple.TCC/TCC.db`
      expect(calls).toContain(
        `sudo sqlite3 ${system} INSERT OR REPLACE INTO access VALUES('kTCCServiceScreenCapture','com.example.term',0,2,4,1,X'${Buffer.from("csreq").toString("hex")}'`,
      )
      if (scenario === "granted") {
        expect(calls).toContain(`sqlite3 ${user} INSERT OR REPLACE`)
        expect(calls).toContain("defaults write")
        expect(calls).toContain("/Applications/Term.app/Contents/MacOS/Term -date")
      } else {
        expect(run.stderr).toContain(`Screen Recording grant for com.example.term did not read back from ${system}`)
        expect(calls).not.toContain(`sqlite3 ${user}`)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
