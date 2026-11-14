import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { cmuxCommandFile, launchCmuxInitialCommand, type CmuxLaunchDeps } from "./cmux-initial-command-launch.ts"

const OPERATOR_CONFIG = "theme = espresso\nforeground = #ffffff\nfont-size = 12\n"

function fixture(config: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "cmux-launch-"))
  const configPath = join(dir, "config")
  if (config !== null) writeFileSync(configPath, config)
  const commandPath = join(dir, "cmux-command.sh")
  const startedMarkerPath = join(dir, "started.txt")
  const payloadPath = join(dir, "payload.sh")
  writeFileSync(payloadPath, "#!/bin/bash -p\nexit 0\n")
  return { dir, configPath, commandPath, startedMarkerPath, payloadPath }
}

function deps(overrides: Partial<CmuxLaunchDeps>): CmuxLaunchDeps {
  return {
    openApp: () => {},
    sleep: async () => {},
    parentChain: () => [4242],
    executableOf: () => "/Applications/cmux.app/Contents/MacOS/cmux",
    ...overrides,
  }
}

function baseOpts(f: ReturnType<typeof fixture>) {
  return {
    configPath: f.configPath,
    appBundle: "/Applications/cmux.app",
    cmuxExecutable: "/Applications/cmux.app/Contents/MacOS/cmux",
    cmuxConfigDir: f.dir,
    commandPath: f.commandPath,
    startedMarkerPath: f.startedMarkerPath,
    payloadPath: f.payloadPath,
    runId: "run-34302-test",
    timeoutMs: 50,
  }
}

test("the command file carries the literal run id and writes the started marker once", () => {
  const content = cmuxCommandFile({
    runId: "run-34302-test",
    startedMarkerPath: "/tmp/runs/x/started.txt",
    payloadPath: "/tmp/runs/x/serve.sh",
  })
  expect(content).toContain("TERMINFO_RUN_ID='run-34302-test'")
  expect(content).toContain("# terminfo-cmux-initial-command run-34302-test")
  expect(content).toContain("cmux-initial-command-already-started")
  expect(content).toContain("exec /bin/bash -p '/tmp/runs/x/serve.sh'")
})

test("launch appends one line, and restore puts the prior bytes back exactly", async () => {
  const f = fixture(OPERATOR_CONFIG)
  const launch = await launchCmuxInitialCommand(
    baseOpts(f),
    deps({
      openApp: () => writeFileSync(f.startedMarkerPath, "777 4242\n"),
    }),
  )
  expect(readFileSync(f.configPath, "utf8")).toBe(`${OPERATOR_CONFIG}initial-command = /bin/bash '${f.commandPath}'\n`)
  expect(launch.startedPid).toBe(777)
  expect(launch.removedStaleKey).toBe(false)
  launch.restore()
  expect(readFileSync(f.configPath, "utf8")).toBe(OPERATOR_CONFIG)
})

test("restore removes only our line when the config changed meanwhile", async () => {
  const f = fixture(OPERATOR_CONFIG)
  const launch = await launchCmuxInitialCommand(
    baseOpts(f),
    deps({
      openApp: () => writeFileSync(f.startedMarkerPath, "777 4242\n"),
    }),
  )
  writeFileSync(f.configPath, `${readFileSync(f.configPath, "utf8")}font-size = 14\n`)
  const outcome = launch.restore()
  expect(outcome).toBe("line-removed")
  expect(readFileSync(f.configPath, "utf8")).toBe(`${OPERATOR_CONFIG}font-size = 14\n`)
})

test("a key this launcher wrote in an earlier run is recognised, removed, and reported", async () => {
  const f = fixture(null)
  const staleCommand = join(f.dir, "old-command.sh")
  writeFileSync(
    staleCommand,
    cmuxCommandFile({
      runId: "run-old",
      startedMarkerPath: join(f.dir, "old-started.txt"),
      payloadPath: f.payloadPath,
    }),
  )
  writeFileSync(f.configPath, `${OPERATOR_CONFIG}initial-command = /bin/bash '${staleCommand}'\n`)
  const launch = await launchCmuxInitialCommand(
    baseOpts(f),
    deps({
      openApp: () => writeFileSync(f.startedMarkerPath, "777 4242\n"),
    }),
  )
  expect(launch.removedStaleKey).toBe(true)
  expect(readFileSync(f.configPath, "utf8")).toContain(`initial-command = /bin/bash '${f.commandPath}'`)
  expect(readFileSync(f.configPath, "utf8")).not.toContain("old-command")
  launch.restore()
  expect(readFileSync(f.configPath, "utf8")).toBe(OPERATOR_CONFIG)
})

test("a key this launcher did not write refuses by name and changes nothing", async () => {
  const f = fixture(`${OPERATOR_CONFIG}initial-command = /bin/zsh -l\n`)
  await expect(launchCmuxInitialCommand(baseOpts(f), deps({}))).rejects.toThrow("cmux-initial-command-foreign")
  expect(readFileSync(f.configPath, "utf8")).toBe(`${OPERATOR_CONFIG}initial-command = /bin/zsh -l\n`)
  expect(existsSync(f.commandPath)).toBe(false)
})

test("no started marker within the bound refuses not-run and restores the config", async () => {
  const f = fixture(OPERATOR_CONFIG)
  await expect(launchCmuxInitialCommand(baseOpts(f), deps({}))).rejects.toThrow("cmux-initial-command-not-run")
  expect(readFileSync(f.configPath, "utf8")).toBe(OPERATOR_CONFIG)
})

test("a started pid whose parents never reach the cmux process refuses and closes nothing", async () => {
  const f = fixture(OPERATOR_CONFIG)
  await expect(
    launchCmuxInitialCommand(
      baseOpts(f),
      deps({
        openApp: () => writeFileSync(f.startedMarkerPath, "777 999\n"),
        parentChain: () => [999, 1],
        executableOf: () => "/bin/zsh",
      }),
    ),
  ).rejects.toThrow("cmux-initial-command-parent-mismatch")
  expect(readFileSync(f.configPath, "utf8")).toBe(OPERATOR_CONFIG)
})
