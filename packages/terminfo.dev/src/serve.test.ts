/**
 * @failure An unrelated local process or web page can make the daemon emit terminal control bytes.
 * @level l3
 * @consumer Real-terminal daemon HTTP clients
 * @testonly none
 * @reach fs-walk /tmp/terminfo-serve-*
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

let child: ChildProcess | undefined
let home: string | undefined
const packageRoot = join(import.meta.dirname, "../../..")

async function startTestDaemon(
  source = `import { startDaemon } from "./packages/terminfo.dev/src/serve.ts"; await startDaemon()`,
  environment: Record<string, string | undefined> = {},
) {
  home = mkdtempSync(join(tmpdir(), "terminfo-serve-"))
  child = spawn(process.execPath, ["-e", source], {
    cwd: packageRoot,
    env: { ...process.env, HOME: home, TERM: "dumb", TERM_PROGRAM: "", ...environment },
    stdio: ["pipe", "ignore", "pipe"],
  })
  let filename!: string
  let registration!: { port: number; token?: string; runId: string; pid: number }
  await vi.waitFor(
    () => {
      const files = readdirSync(join(home!, ".terminfo-dev/daemons"))
      expect(files).toHaveLength(1)
      filename = join(home!, ".terminfo-dev/daemons", files[0]!)
      registration = JSON.parse(readFileSync(filename, "utf8")) as typeof registration
    },
    { timeout: 2000 },
  )
  return { filename, registration }
}

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill()
    await new Promise<void>((resolve) => child!.once("exit", () => resolve()))
  }
  if (home) rmSync(home, { recursive: true, force: true })
  child = undefined
  home = undefined
})

describe("daemon HTTP boundary", () => {
  // Carrier validation precedes source-suite loading. The old endpoint ignored
  // these bodies and tried to probe; authentication coverage did not detect that.
  it("refuses malformed or mismatched owner assertions before collection", async () => {
    const { registration } = await startTestDaemon()
    const url = `http://127.0.0.1:${registration.port}/probe`
    const owner = {
      asserter: "terminfo-admin",
      launchRunId: registration.runId,
      workerPid: registration.pid,
      windowId: 791,
      tabTty: "/dev/ttys004",
      intendedVersion: "2.15",
    }
    const processOwner = {
      asserter: "terminfo-admin",
      launchRunId: registration.runId,
      workerPid: registration.pid,
      provider: "kitty",
      ownerPid: 900,
      executablePath: "/Applications/kitty.app/Contents/MacOS/kitty",
      marker: { flag: "--instance-group", value: `terminfo-${registration.runId}` },
      tty: "/dev/ttys004",
      intendedVersion: "0.44.0",
    }
    const headers = { Authorization: `Bearer ${registration.token}`, "Content-Type": "application/json" }
    const unauthenticated = await fetch(url, { method: "POST", body: JSON.stringify({ terminalAppOwner: owner }) })
    expect(unauthenticated.status).toBe(403)
    for (const body of [
      "{malformed",
      JSON.stringify({ terminalAppOwner: null }),
      JSON.stringify({ terminalAppOwner: { ...owner, launchRunId: "f".repeat(32) } }),
      JSON.stringify({ terminalAppOwner: { ...owner, workerPid: registration.pid + 1 } }),
      JSON.stringify({ terminalAppOwner: { ...owner, token: registration.token } }),
      JSON.stringify({ unexpectedOwner: owner }),
      JSON.stringify({ processOwner: null }),
      JSON.stringify({ processOwner: { ...processOwner, launchRunId: "f".repeat(32) } }),
      JSON.stringify({ processOwner: { ...processOwner, workerPid: registration.pid + 1 } }),
      JSON.stringify({ processOwner: { ...processOwner, windowId: 791 } }),
      JSON.stringify({ terminalAppOwner: owner, processOwner: { ...owner, provider: "kitty" } }),
    ]) {
      const response = await fetch(url, { method: "POST", headers, body })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "Invalid or mismatched owned-terminal owner assertion" })
    }
  })

  it("refuses v2 collection without a declared source suite", async () => {
    const { registration } = await startTestDaemon()
    const response = await fetch(`http://127.0.0.1:${registration.port}/probe`, {
      headers: { Authorization: `Bearer ${registration.token}` },
    })
    expect(response.status).toBe(500)
    const body: unknown = await response.json()
    expect(body).toEqual({ error: "Probe daemon request failed" })
  })

  it("requires its private token and refuses cross-origin mutation", async () => {
    const { registration } = await startTestDaemon()
    const url = `http://127.0.0.1:${registration.port}/query`
    const body = JSON.stringify({ commands: [{ write: "test" }] })
    const unauth = await fetch(url, { method: "POST", body })
    expect(unauth.status).toBe(403)
    expect(registration.token).toMatch(/^[0-9a-f]{64}$/)
    const headers = { Authorization: `Bearer ${registration.token}` }
    const crossOrigin = await fetch(url, {
      method: "POST",
      body,
      headers: { ...headers, Origin: "https://evil.example" },
    })
    expect(crossOrigin.status).toBe(403)
    const authorized = await fetch(url, { method: "POST", body, headers })
    expect(authorized.status).toBe(200)
  }, 5000)

  it("names a malformed registration instead of silently omitting it", () => {
    home = mkdtempSync(join(tmpdir(), "terminfo-serve-"))
    const dir = join(home, ".terminfo-dev/daemons")
    mkdirSync(dir, { recursive: true })
    const badFile = join(dir, "bad.json")
    writeFileSync(badFile, "{broken")
    const result = spawnSync(
      process.execPath,
      ["-e", `import { listDaemons } from "./packages/terminfo.dev/src/serve.ts"; listDaemons()`],
      {
        cwd: packageRoot,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(badFile)
  })

  it("reports failure to remove its own registration on shutdown", async () => {
    const { filename } = await startTestDaemon()
    const stderr: Buffer[] = []
    child!.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk))
    rmSync(filename)
    mkdirSync(filename)
    child!.kill("SIGTERM")
    const exitCode = await new Promise<number | null>((resolve) => child!.once("exit", resolve))
    expect(exitCode).toBe(1)
    expect(Buffer.concat(stderr).toString()).toContain(filename)
  }, 5000)
})

/**
 * Run one inline collector script against the hosted-Darwin capture environment. The capture
 * directory is what makes a run `darwinHosted`, so a script can drop it to collect the same
 * terminal with NO capture adapter at all and compare the two runs row for row.
 */
function runHostedDarwinFixture(script: string) {
  home = mkdtempSync(join(tmpdir(), "terminfo-serve-calibration-"))
  return spawnSync(process.execPath, ["-e", script], {
    cwd: packageRoot,
    env: {
      ...process.env,
      HOME: home,
      TERMINFO_CAPTURE_DIRECTORY: join(home, "captures"),
      TERMINFO_DISPOSABLE_RECEIPT: "hardware-receipt-fixture",
      TERMINFO_RUNTIME_PROVENANCE: "",
      TERMINFO_CLIPBOARD_FIXTURE_RECEIPT: "",
    },
    encoding: "utf8",
    timeout: 10_000,
  })
}

describe("private finite daemon startup", () => {
  it("reports the same named capture refusal for the first and later probes when Darwin calibration fails", () => {
    home = mkdtempSync(join(tmpdir(), "terminfo-serve-calibration-"))
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
        import { mock } from "bun:test"
        import assert from "node:assert/strict"
        Object.defineProperty(process, "platform", { value: "darwin" })
        const tty = await import("./packages/terminfo.dev/src/tty.ts")
        const owned = await import("./packages/terminfo.dev/src/owned-terminal.ts")
        const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
        let calibrationCalls = 0, unexpectedCaptures = 0
        const geometry = { status: "measured", rows: 24, cols: 80 }
        mock.module("./packages/terminfo.dev/src/detect.ts", () => ({
          detectTerminal: () => ({ name: "ghostty", version: "1.3.1", os: "macos", osVersion: "fixture" })
        }))
        // Hardware admission is covered by owned-terminal tests; keep the real collector/batch.
        mock.module("./packages/terminfo.dev/src/owned-terminal.ts", () => ({ ...owned,
          ownedTerminalVerifiedFor: () => true,
          createOwnedTerminal: async () => ({ geometryAtGrant: geometry, geometrySource: "fixture",
            hostedAppPid: 42, summary: "owned fixture", readGeometry: async () => geometry, dispose: async () => {} })
        }))
        mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({ ...receipt,
          readDisposableReceipt: () => undefined
        }))
        mock.module("./packages/terminfo.dev/src/tty.ts", () => ({ ...tty,
          withRawMode: async callback => callback(), drainStdin: async () => {},
          queryWithSentinelOutcome: async (sequence, pattern) => {
            const raw = sequence.includes("[18t") ? "\\x1b[8;24;80t"
              : sequence.includes("[16t") ? "\\x1b[6;17;8t"
              : sequence.includes("[14t") ? "\\x1b[4;408;640t"
              : "\\x1bP>|ghostty 1.3.1\\x1b\\\\"
            return { raw, rawBase64: Buffer.from(raw).toString("base64"), match: pattern.exec(raw), reason: "reply" }
          }
        }))
        mock.module("./packages/terminfo.dev/src/darwin-capture.ts", () => ({
          createDarwinCapture: async () => ({
            capture: async () => { unexpectedCaptures++; throw new Error("capture must retain the calibration refusal") },
            captureRaw: async () => { unexpectedCaptures++; throw new Error("capture must retain the calibration refusal") }
          })
        }))
        mock.module("./packages/terminfo.dev/src/capture-calibration.ts", () => ({
          calibrateCaptureOrigin: async () => {
            calibrationCalls++
            const error = new Error("Capture calibration fixture: non-solid difference cannot supply an origin")
            error.name = "CaptureCalibrationRefused"
            throw error
          }
        }))
        const unified = await import("./packages/terminfo.dev/src/probes/unified.ts")
        globalThis.__TERMINFO_BUNDLED_SUITE__ = {
          manifest: { probeHash: "a".repeat(12), probes: { app: unified.ALL_PROBES.map(p => p.id).sort() } },
          collectorRevision: "b".repeat(40)
        }
        const { collectProbeRun } = await import("./packages/terminfo.dev/src/serve.ts")
        const ids = ["extensions.truecolor", "erase.line.all"]
        const run = await collectProbeRun({ ids })
        assert.deepEqual(run.observations.map(o => o.featureId), ids)
        assert.ok(run.observations.every(o => o.outcome === "inconclusive"))
        assert.ok(run.observations.every(o => /Capture calibration fixture: non-solid difference/.test(o.note ?? "")))
        assert.deepEqual(run.ungradedDiagnostics, {})
        assert.equal(calibrationCalls, 1)
        assert.equal(unexpectedCaptures, 0)
      `,
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          HOME: home,
          TERMINFO_CAPTURE_DIRECTORY: join(home, "captures"),
          TERMINFO_DISPOSABLE_RECEIPT: "hardware-receipt-fixture",
          TERMINFO_RUNTIME_PROVENANCE: "",
          TERMINFO_CLIPBOARD_FIXTURE_RECEIPT: "",
        },
        encoding: "utf8",
        timeout: 5000,
      },
    )
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })

  // Terminal.app answered no CSI 16 t on a github-hosted runner and its own text area did not
  // divide into whole pixels (860x120, 467x30), so 51 rows were left ungraded with one refusal
  // message and the whole run was inadmissible as suite-incomplete (28785). A terminal whose cells
  // cannot be mapped is a run WITHOUT a capture adapter: every probe then takes its own no-capture
  // branch, the suite is complete, and the run records why it could not calibrate.
  it("attempts raster calibration when hosted Darwin window replies do not supply cells", () => {
    const result = runHostedDarwinFixture(`
      import { mock } from "bun:test"
      import assert from "node:assert/strict"
      Object.defineProperty(process, "platform", { value: "darwin" })
      const tty = await import("./packages/terminfo.dev/src/tty.ts")
      const owned = await import("./packages/terminfo.dev/src/owned-terminal.ts")
      const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
      const unified = await import("./packages/terminfo.dev/src/probes/unified.ts")
      const geometry = { status: "measured", rows: 30, cols: 120, at: "2026-10-15T00:00:00.000Z", source: "fixture", stdout: "30 120\\n", stderr: "" }
      const silent = { match: null, reason: "timeout", raw: "", rawBase64: "" }
      let frames = 0, calibrations = 0
      mock.module("./packages/terminfo.dev/src/detect.ts", () => ({
        detectTerminal: () => ({ name: "terminal-app", version: "2.15", os: "macos", osVersion: "26.6.2" })
      }))
      mock.module("./packages/terminfo.dev/src/owned-terminal.ts", () => ({ ...owned,
        ownedTerminalVerifiedFor: () => true,
        createOwnedTerminal: async () => ({ geometryAtGrant: geometry, geometrySource: "fixture", hostedAppPid: 5705,
          summary: "{}", readGeometry: async () => geometry, dispose: async () => {} })
      }))
      mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({ ...receipt, readDisposableReceipt: () => undefined }))
      mock.module("./packages/terminfo.dev/src/tty.ts", () => ({ ...tty,
        withRawMode: async (cb) => cb(), drainStdin: async () => {},
        query: async () => null, queryWithSentinel: async () => null, queryOutcome: async () => silent,
        queryCursorPosition: async () => null, measureRenderedWidth: async () => null,
        measureUtf8Decoding: async () => "silent", queryMode: async () => null, readResponse: async () => null,
        queryWithSentinelOutcome: async (sequence, pattern) => {
          const reply = sequence === "\\x1b[14t" ? "\\x1b[4;467;860t"
            : sequence === "\\x1b[18t" ? "\\x1b[8;30;120t"
            : "\\x1b[?1;2c"
          return { raw: reply, rawBase64: Buffer.from(reply).toString("base64"), match: pattern.exec(reply), reason: pattern.test(reply) ? "reply" : "sentinel" }
        }
      }))
      mock.module("./packages/terminfo.dev/src/darwin-capture.ts", () => ({ createDarwinCapture: async () => ({
        capture: async () => { frames++; throw new Error("no frame may be requested for a refused calibration") },
        captureRaw: async () => { frames++; throw new Error("no frame may be requested for a refused calibration") }
      }) }))
      mock.module("./packages/terminfo.dev/src/capture-calibration.ts", () => ({ calibrateCaptureOrigin: async () => {
        calibrations++
        throw Object.assign(new Error("Capture calibration nonuniform columns: native fixture has unequal cell edges"), { name: "CaptureCalibrationRefused" })
      } }))
      globalThis.__TERMINFO_BUNDLED_SUITE__ = { manifest: { probeHash: "a".repeat(12),
        probes: { app: unified.ALL_PROBES.map((p) => p.id).sort() } }, collectorRevision: "b".repeat(40) }
      const { collectProbeRun } = await import("./packages/terminfo.dev/src/serve.ts")
      const refused = await collectProbeRun({})
      delete process.env.TERMINFO_CAPTURE_DIRECTORY
      const bare = await collectProbeRun({})
      // Row for row, a refused calibration IS a run with no capture adapter: every row that would
      // have asked for a frame takes the branch it would have taken with no capture at all. Only
      // the NOTE differs, and it must, because a refused run says why (@cto, 28785 REVISE must 1).
      const withoutNote = (run) => run.observations.map(({ note, ...rest }) => rest)
      assert.deepEqual(withoutNote(refused), withoutNote(bare))
      const noAdapter = (run) => run.observations.filter((o) => /no owned capture adapter is installed in this run/.test(o.note ?? ""))
      const named = refused.observations.filter((o) => /cell-to-pixel geometry was refused/.test(o.note ?? ""))
      assert.equal(named.length, noAdapter(bare).length)
      assert.equal(noAdapter(refused).length, 0)
      assert.ok(named.every((o) => /nonuniform columns/.test(o.note)))
      assert.equal(refused.suiteComplete, true)
      assert.equal(bare.suiteComplete, true)
      assert.deepEqual(refused.ungradedDiagnostics, {})
      assert.deepEqual(bare.ungradedDiagnostics, {})
      // No probe ever saw a capture adapter, and no origin was calibrated for one.
      assert.equal(frames, 0)
      assert.equal(calibrations, 1)
      // A run with NO capture adapter records no calibration at all, so a reader can tell that apart
      // from a terminal that refused to be calibrated.
      assert.equal(bare.rawReplies["collector.captureCalibration"], undefined)
      const fact = JSON.parse(refused.rawReplies["collector.captureCalibration"])
      assert.equal(fact.outcome, "refused")
      assert.equal(fact.basis, undefined)
      assert.equal(fact.geometry, undefined)
      assert.deepEqual(fact.queries.map((q) => [q.sequence, q.reason, q.raw]), [
        ["\\x1b[16t", "sentinel", "\\x1b[?1;2c"],
        ["\\x1b[14t", "reply", "\\x1b[4;467;860t"],
        ["\\x1b[18t", "reply", "\\x1b[8;30;120t"]
      ])
      assert.match(fact.refusal, /Capture calibration nonuniform columns/)
    `)
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })

  // alacritty answers no CSI 16 t and reports the same text area twice (798x598 over 133x46), which
  // divides into a 6x13 cell — the derived basis the pre-flight must accept. Its rows must decide
  // exactly as they do when the terminal reports the same cell size itself, and the run records
  // WHICH basis the geometry rests on.
  it("installs the capture on a derived alacritty cell size, deciding the same rows as a 16 t report", () => {
    const result = runHostedDarwinFixture(`
      import { mock } from "bun:test"
      import assert from "node:assert/strict"
      Object.defineProperty(process, "platform", { value: "darwin" })
      const tty = await import("./packages/terminfo.dev/src/tty.ts")
      const owned = await import("./packages/terminfo.dev/src/owned-terminal.ts")
      const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
      const unified = await import("./packages/terminfo.dev/src/probes/unified.ts")
      const geometry = { status: "measured", rows: 46, cols: 133, at: "2026-10-15T00:00:00.000Z", source: "fixture", stdout: "46 133\\n", stderr: "" }
      const silent = { match: null, reason: "timeout", raw: "", rawBase64: "" }
      let reportedCellSize = null, frames = 0, calibrations = 0, calibrationFailure
      mock.module("./packages/terminfo.dev/src/detect.ts", () => ({
        detectTerminal: () => ({ name: "alacritty", version: "0.17.0", os: "macos", osVersion: "26.6.2" })
      }))
      mock.module("./packages/terminfo.dev/src/owned-terminal.ts", () => ({ ...owned,
        ownedTerminalVerifiedFor: () => true,
        createOwnedTerminal: async () => ({ geometryAtGrant: geometry, geometrySource: "fixture", hostedAppPid: 42,
          summary: "{}", readGeometry: async () => geometry, dispose: async () => {} })
      }))
      mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({ ...receipt, readDisposableReceipt: () => undefined }))
      mock.module("./packages/terminfo.dev/src/tty.ts", () => ({ ...tty,
        withRawMode: async (cb) => cb(), drainStdin: async () => {},
        query: async () => null, queryWithSentinel: async () => null, queryOutcome: async () => silent,
        queryCursorPosition: async () => null, measureRenderedWidth: async () => null,
        measureUtf8Decoding: async () => "silent", queryMode: async () => null, readResponse: async () => null,
        queryWithSentinelOutcome: async (sequence, pattern) => {
          const reply = sequence === "\\x1b[16t" ? (reportedCellSize ?? "\\x1b[?6c")
            : sequence === "\\x1b[14t" ? "\\x1b[4;598;798t"
            : sequence === "\\x1b[18t" ? "\\x1b[8;46;133t"
            : "\\x1bP>|alacritty 0.17.0\\x1b\\\\"
          return { raw: reply, rawBase64: Buffer.from(reply).toString("base64"), match: pattern.exec(reply), reason: pattern.test(reply) ? "reply" : "sentinel" }
        }
      }))
      mock.module("./packages/terminfo.dev/src/darwin-capture.ts", () => ({ createDarwinCapture: async () => ({
        capture: async (checkpoint) => {
          frames++
          // A fixture frame: byte-stable across two reads of one static frame, and painted exactly
          // when the sentinel glyph is asked for, so the oracle's paint witness proves out.
          const painted = checkpoint.label.includes("paint witness")
          return { frame: { role: checkpoint.role, ref: "sha256:" + (painted ? "d" : "a").repeat(64), capturedAt: 1,
            label: checkpoint.label, regionDigest: "sha256:" + (painted ? "e" : "b").repeat(64),
            pixelsDigest: "sha256:" + "c".repeat(64) }, trace: { captureCommand: "fixture" } }
        },
        captureRaw: async (checkpoint) => {
          frames++
          return { result: { frame: { role: checkpoint.role, ref: "sha256:" + "f".repeat(64), capturedAt: 1,
            label: checkpoint.label, regionDigest: "sha256:" + "b".repeat(64), pixelsDigest: "sha256:" + "c".repeat(64) },
            trace: { captureCommand: "fixture" } }, decoded: { width: 1, height: 1, rgba: Buffer.alloc(4) } }
        }
      }) }))
      mock.module("./packages/terminfo.dev/src/capture-calibration.ts", () => ({ calibrateCaptureOrigin: async ({ pixelGeometry }) => {
        calibrations++
        if (calibrationFailure) throw calibrationFailure
        assert.deepEqual(pixelGeometry, { cellWidth: 6, cellHeight: 13, textWidth: 798, textHeight: 598 })
        return { origin: { x: 0, y: 0 }, pixelGeometry: { cellWidth: 6, cellHeight: 13, textWidth: 798, textHeight: 598 }, basis: "fixture complete raster" }
      } }))
      globalThis.__TERMINFO_BUNDLED_SUITE__ = { manifest: { probeHash: "a".repeat(12),
        probes: { app: unified.ALL_PROBES.map((p) => p.id).sort() } }, collectorRevision: "b".repeat(40) }
      const { collectProbeRun } = await import("./packages/terminfo.dev/src/serve.ts")
      const derived = await collectProbeRun({})
      reportedCellSize = "\\x1b[6;13;6t"
      const reported = await collectProbeRun({})
      const originalTimeout = new Error("solid grid paint witness timeout")
      calibrationFailure = Object.assign(new Error("Capture calibration restore failed", { cause: originalTimeout }), { name: "CaptureRestoreFailed" })
      await assert.rejects(collectProbeRun({}), error => error === calibrationFailure)
      calibrationFailure = new Error("Original capture adapter I/O failure", { cause: originalTimeout })
      await assert.rejects(collectProbeRun({}), error => error === calibrationFailure)
      calibrationFailure = Object.assign(new Error("Capture calibration paint not observed: solid grid paint witness timeout", { cause: originalTimeout }), { name: "CaptureCalibrationRefused" })
      const unseen = await collectProbeRun({})
      assert.equal(unseen.suiteComplete, true)
      assert.deepEqual(unseen.ungradedDiagnostics, {})
      assert.equal(JSON.parse(unseen.rawReplies["collector.captureCalibration"]).outcome, "refused")
      assert.match(JSON.parse(unseen.rawReplies["collector.captureCalibration"]).refusal, /paint not observed/)
      assert.deepEqual(JSON.parse(unseen.rawReplies["collector.captureCalibration"]).causes, [
        { name: "CaptureCalibrationRefused", message: calibrationFailure.message },
        { name: "Error", message: originalTimeout.message },
      ])
      assert.ok(!unseen.observations.some(o => o.evidence === "pixels"))
      calibrationFailure = undefined
      delete process.env.TERMINFO_CAPTURE_DIRECTORY
      reportedCellSize = null
      const bare = await collectProbeRun({})
      const cell = { cellWidth: 6, cellHeight: 13, textWidth: 798, textHeight: 598 }
      const derivedFact = JSON.parse(derived.rawReplies["collector.captureCalibration"])
      assert.equal(derivedFact.outcome, "installed")
      assert.equal(derivedFact.basis, "measured by complete raster calibration")
      assert.deepEqual(derivedFact.geometry, cell)
      const reportedFact = JSON.parse(reported.rawReplies["collector.captureCalibration"])
      assert.equal(reportedFact.basis, "measured by complete raster calibration")
      assert.deepEqual(reportedFact.geometry, cell)
      assert.equal(bare.rawReplies["collector.captureCalibration"], undefined)
      // The derived basis still calibrates, once per run, and its probes reach pixels.
      assert.equal(calibrations, 5)
      assert.ok(frames > 0)
      const pixels = (run) => run.observations.filter((o) => o.evidence === "pixels")
      assert.ok(pixels(derived).length > 0)
      assert.deepEqual(pixels(derived), pixels(reported))
      assert.deepEqual(pixels(bare), [])
      assert.equal(derived.suiteComplete, true)
      assert.equal(reported.suiteComplete, true)
      assert.deepEqual(derived.ungradedDiagnostics, {})
      assert.deepEqual(reported.ungradedDiagnostics, {})
    `)
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })

  // @cto, 28785 REVISE round 2 must 2: pin EVERY classification site of queryPixelGeometry with
  // one table. A timeout - nothing answered at all, DA1 included - is the one transient cause, and
  // the run aborts by name carrying the replies it read. A sentinel is DA1 answered and then
  // silence through the grace window: the terminal's own measured negative, which completes as a
  // refusal that names itself in the row note. Both DA1-only shapes complete; both timeout shapes
  // abort. (Sites: region-readback.ts 358, 375, 398, 405, 415, 421.)
  it("classifies every geometry refusal by cause, and aborts only on a timeout", () => {
    const result = runHostedDarwinFixture(`
      import { mock } from "bun:test"
      import assert from "node:assert/strict"
      Object.defineProperty(process, "platform", { value: "darwin" })
      const tty = await import("./packages/terminfo.dev/src/tty.ts")
      const owned = await import("./packages/terminfo.dev/src/owned-terminal.ts")
      const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
      const unified = await import("./packages/terminfo.dev/src/probes/unified.ts")
      const geometry = { status: "measured", rows: 30, cols: 120, at: "2026-10-15T00:00:00.000Z", source: "fixture", stdout: "30 120\\n", stderr: "" }
      const shapes = [
        { name: "358 14 t sentinel after a 16 t reply", six: "reply:\\x1b[6;13;6t", fourteen: "sentinel", eighteen: null,
          expect: "refused", cause: /answered CSI 14 t \\(text area in pixels\\) with sentinel/ },
        { name: "375 a pixel report that did not parse as positive numbers", six: "reply:\\x1b[6;0;6t", fourteen: "reply:\\x1b[4;598;798t", eighteen: null,
          expect: "refused", cause: /did not parse as positive numbers/ },
        { name: "398 DA1 only: 16 t and 14 t both sentinel", six: "sentinel", fourteen: "sentinel", eighteen: null,
          expect: "refused", cause: /CSI 16 t \\(cell size in pixels\\) with sentinel and CSI 14 t \\(text area in pixels\\) with sentinel/ },
        { name: "398 a timeout is the one transient cause", six: "timeout", fourteen: "timeout", eighteen: null,
          expect: "aborts", cause: /with timeout and CSI 14 t \\(text area in pixels\\) with timeout/ },
        { name: "405 DA1 only through the derived path: 18 t sentinel", six: "sentinel", fourteen: "reply:\\x1b[4;467;860t", eighteen: "sentinel",
          expect: "refused", cause: /CSI 18 t \\(text area in characters\\) with sentinel/ },
        { name: "405 the derived path 18 t timeout aborts too", six: "sentinel", fourteen: "reply:\\x1b[4;467;860t", eighteen: "timeout",
          expect: "aborts", cause: /CSI 18 t \\(text area in characters\\) with timeout/ },
        { name: "415 a text area that did not parse as positive numbers", six: "sentinel", fourteen: "reply:\\x1b[4;0;0t", eighteen: "reply:\\x1b[8;30;120t",
          expect: "refused", cause: /text area that did not parse as positive numbers/ },
        { name: "421 the area does not divide into whole pixels (Terminal.app)", six: "sentinel", fourteen: "reply:\\x1b[4;467;860t", eighteen: "reply:\\x1b[8;30;120t",
          expect: "refused", cause: /does not divide into a whole-pixel cell size/ }
      ]
      let mode = shapes[0], frames = 0, calibrations = 0
      mock.module("./packages/terminfo.dev/src/detect.ts", () => ({
        detectTerminal: () => ({ name: "terminal-app", version: "2.15", os: "macos", osVersion: "26.6.2" })
      }))
      mock.module("./packages/terminfo.dev/src/owned-terminal.ts", () => ({ ...owned,
        ownedTerminalVerifiedFor: () => true,
        createOwnedTerminal: async () => ({ geometryAtGrant: geometry, geometrySource: "fixture", hostedAppPid: 5705,
          summary: "{}", readGeometry: async () => geometry, dispose: async () => {} })
      }))
      mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({ ...receipt, readDisposableReceipt: () => undefined }))
      mock.module("./packages/terminfo.dev/src/tty.ts", () => ({ ...tty,
        withRawMode: async (cb) => cb(), drainStdin: async () => {},
        query: async () => null, queryWithSentinel: async () => null,
        queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
        queryCursorPosition: async () => null, measureRenderedWidth: async () => null,
        measureUtf8Decoding: async () => "silent", queryMode: async () => null, readResponse: async () => null,
        queryWithSentinelOutcome: async (sequence, pattern) => {
          // The collector's OWN geometry corroboration asks CSI 18 t before the pre-flight, with a
          // pattern that insists on a non-zero first digit: answer it as the measured grid, always,
          // so it is never confused with the derived geometry path's own 18 t question below.
          if (pattern.source.includes("[1-9][0-9]*")) {
            const raw = "\\x1b[8;30;120t"
            return { match: pattern.exec(raw), reason: "reply", raw, rawBase64: "Z" }
          }
          // XTVERSION (and anything else this fixture does not model) is a separate query: it is
          // answered with DA1's own reply here, which the identity guard reads as "sentinel", never
          // as one of the three geometry replies below.
          if (sequence !== "\\x1b[16t" && sequence !== "\\x1b[14t" && sequence !== "\\x1b[18t") {
            return { match: null, reason: "sentinel", raw: "\\x1b[?1;2c", rawBase64: "Z" }
          }
          const spec = sequence === "\\x1b[16t" ? mode.six : sequence === "\\x1b[14t" ? mode.fourteen : mode.eighteen
          assert.notEqual(spec, null, mode.name + " must never ask " + sequence)
          if (spec === "timeout") return { match: null, reason: "timeout", raw: "", rawBase64: "" }
          if (spec === "sentinel") return { match: null, reason: "sentinel", raw: "\\x1b[?1;2c", rawBase64: "Z" }
          const raw = spec.slice("reply:".length)
          return { match: pattern.exec(raw), reason: "reply", raw, rawBase64: "Z" }
        }
      }))
      mock.module("./packages/terminfo.dev/src/darwin-capture.ts", () => ({ createDarwinCapture: async () => ({
        capture: async () => { frames++; throw new Error("no frame may be requested for a refused geometry") },
        captureRaw: async () => { frames++; throw new Error("no frame may be requested for a refused geometry") }
      }) }))
      mock.module("./packages/terminfo.dev/src/capture-calibration.ts", () => ({ calibrateCaptureOrigin: async () => {
        calibrations++
        throw Object.assign(new Error("Capture calibration nonuniform columns: measured unequal cell edges"), { name: "CaptureCalibrationRefused" })
      } }))
      globalThis.__TERMINFO_BUNDLED_SUITE__ = { manifest: { probeHash: "a".repeat(12),
        probes: { app: unified.ALL_PROBES.map((p) => p.id).sort() } }, collectorRevision: "b".repeat(40) }
      const { collectProbeRun } = await import("./packages/terminfo.dev/src/serve.ts")
      const measured = []
      for (const shape of shapes) {
        mode = shape
        let thrown = null
        let run = null
        try {
          run = await collectProbeRun({})
        } catch (error) {
          thrown = error
        }
        if (shape.expect === "refused") {
          assert.equal(thrown, null, shape.name + " must complete, not throw: " + String(thrown === null ? "" : thrown.message))
          const fact = JSON.parse(run.rawReplies["collector.captureCalibration"])
          const named = run.observations.filter((o) => /cell-to-pixel geometry was refused/.test(o.note ?? ""))
          measured.push({ name: shape.name, kind: "refused", outcome: fact.outcome, refusal: fact.refusal,
            complete: run.suiteComplete, ungraded: Object.keys(run.ungradedDiagnostics ?? {}).length,
            named: named.length, firstNamed: named.length > 0 ? named[0].note : "" })
        } else {
          measured.push({ name: shape.name, kind: thrown === null ? "completed" : "threw",
            error: thrown === null ? null : thrown.name, message: String(thrown === null ? "" : thrown.message) })
        }
      }
      assert.deepEqual(measured.map((m) => m.name), shapes.map((s) => s.name))
      for (const index of shapes.keys()) {
        const shape = shapes[index]
        const row = measured[index]
        if (shape.expect === "refused") {
          assert.equal(row.kind, "refused", shape.name)
          assert.equal(row.outcome, "refused", shape.name)
          assert.match(row.refusal, /Capture calibration nonuniform columns/, shape.name)
          assert.equal(row.complete, true, shape.name)
          assert.equal(row.ungraded, 0, shape.name)
          assert.ok(row.named > 0, shape.name + " must name the refusal in a row note")
          assert.match(row.firstNamed, /Capture calibration nonuniform columns/, shape.name)
        } else {
          assert.equal(row.kind, "threw", shape.name + " must abort the run")
          assert.equal(row.error, "TerminalGeometryUnmeasurable", shape.name)
          assert.match(row.message, shape.cause, shape.name)
          assert.match(row.message, /REPEAT THE RUN/, shape.name)
          assert.match(row.message, /Replies read: /, shape.name)
        }
      }
      // No geometry was ever installed, in any shape: nothing captured and nothing calibrated.
      assert.equal(frames, 0)
      assert.equal(calibrations, shapes.filter(s => s.expect === "refused").length)
    `)
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })

  it("measures owned subset identity independently, retains feature replies and disposes on refusal", () => {
    home = mkdtempSync(join(tmpdir(), "terminfo-serve-identity-"))
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      import { mock } from "bun:test"
      import assert from "node:assert/strict"
      import { parseRunProvenance } from "@terminfo/run-parser"
      import { parseAppLaunchReceipt } from "./packages/run-parser/src/app-launch.ts"
      const unified = await import("./packages/terminfo.dev/src/probes/unified.ts")
      const tty = await import("./packages/terminfo.dev/src/tty.ts")
      const owned = await import("./packages/terminfo.dev/src/owned-terminal.ts")
      let raw = "\\x1bP>|kitty(0.49.2)\\x1b\\\\\\x1b[?62;52;c", disposed = 0, calls = []
      let launch
      let terminal={name:"kitty",version:"",os:"linux",osVersion:"fixture"}
      globalThis.__TERMINFO_BUNDLED_SUITE__ = {
        manifest: { probeHash: "a".repeat(12), probes: { app: unified.ALL_PROBES.map(p => p.id).sort() } },
        collectorRevision: "b".repeat(40)
      }
      mock.module("./packages/terminfo.dev/src/detect.ts", () => ({ detectTerminal: () => terminal }))
      mock.module("./packages/terminfo.dev/src/owned-terminal.ts", () => ({...owned, createOwnedTerminal: async () => ({
        geometryAtGrant:{status:"measured",rows:24,cols:80},summary:"owned fixture",dispose:async()=>{disposed++}
      })}))
      mock.module("./packages/terminfo.dev/src/tty.ts", () => ({...tty,
        withRawMode:async callback=>callback(),drainStdin:async()=>{},
        queryWithSentinelOutcome:async(sequence,pattern)=>{
          calls.push(sequence)
          const reply=sequence === "\\x1b[18t" ? "\\x1b[8;24;80t" : raw
          return {raw:reply,rawBase64:Buffer.from(reply).toString("base64"),match:pattern.exec(reply),reason:pattern.test(reply)?"reply":"sentinel"}
        }
      }))
      mock.module("./packages/terminfo.dev/src/probes/unified.ts", () => ({...unified,runProbeBatch:async options=>({
        rawReplies:options.ids.includes("device.xtversion")?{"device.xtversion":"feature-owned reply"}:{},
        observations:options.ids.map(featureId=>({featureId})), assertions:[],screenshotRefs:[],ungradedDiagnostics:{},suiteComplete:false,
        ...(launch && { appLaunch: launch })
      })}))
      const {collectProbeRun}=await import("./packages/terminfo.dev/src/serve.ts")
      const ids=unified.ALL_PROBES.filter(p=>p.id!=="device.xtversion").slice(0,10).map(p=>p.id)
      // 28216: the collector COPIES the apparatus-measured launch block into origin.appLaunch, and a
      // batch that carries none leaves the origin without one.
      launch={bundlePath:"/Applications/iTerm.app",cfBundleShortVersionString:"3.6.11",cfBundleVersion:"3.6.11",
        executablePath:"/Applications/iTerm.app/Contents/MacOS/iTerm2",executableSha256:"a".repeat(64),
        sourceArtifact:{path:"/Library/Caches/Homebrew/downloads/iterm2.zip",sha256:"b".repeat(64)}}
      const run=await collectProbeRun({ids,terminalAppOwner:{}})
      assert.deepEqual(run.origin,{kind:"collector",appLaunch:launch})
      assert.equal(run.target.version,"0.49.2")
      assert.deepEqual(run.observations.map(o=>o.featureId),ids)
      assert.equal(run.suiteComplete,false)
      assert.equal(run.rawReplies["device.xtversion"],undefined)
      assert.equal(run.rawReplies["collector.xtversion"],raw)
      assert.deepEqual(calls,["\\x1b[18t","\\x1b[>0q"])
      const query=JSON.parse(run.rawReplies["collector.xtversionQuery"])
      assert.equal(query.sequence,"\\x1b[>0q")
      assert.equal(query.outbound,"\\x1b[>0q\\x1b[c")
      assert.equal(query.rawBase64,Buffer.from(raw).toString("base64"))
      const provenance={executable:{path:"/fixture/kitty",sha256:"c".repeat(64),version:"kitty 0.49.2"},
        sourceArtifact:{url:"https://example.invalid/kitty.txz",sha256:"d".repeat(64)},
        runtime:{imageId:"sha256:"+"e".repeat(64),imageTarSha256:"f".repeat(64),arch:"amd64",nixLockRevision:"1".repeat(40),sourceRevision:"b".repeat(40),cleanTree:true,suiteHash:"a".repeat(12)},
        fixture:{definition:"fixture",config:"fixture",font:"fixture",geometry:"80x24",display:"fixture",gl:"fixture"}}
      assert.equal(parseRunProvenance(provenance,run.target,{probeHash:run.probeHash,sourceRevision:run.sourceRevision},"fixture").executable.version,"kitty 0.49.2")
      const feature=await collectProbeRun({ids:["device.xtversion"],terminalAppOwner:{}})
      assert.equal(feature.rawReplies["device.xtversion"],"feature-owned reply")
      assert.equal(feature.rawReplies["collector.xtversion"],raw)
      launch=undefined
      const unlaunched=await collectProbeRun({ids:["device.xtversion"],terminalAppOwner:{}})
      assert.deepEqual(unlaunched.origin,{kind:"collector"})
      launch={bundlePath:"/Applications/iTerm.app",cfBundleShortVersionString:"3.6.11",cfBundleVersion:"3.6.11",
        executablePath:"/Applications/iTerm.app/Contents/MacOS/iTerm2",executableSha256:"a".repeat(64),
        sourceArtifact:{path:"/Library/Caches/Homebrew/downloads/iterm2.zip",sha256:"b".repeat(64)}}
      for(const invalid of ["\\x1b[?62;52;c","\\x1bP>|kitty(0.49.2)"]){
        raw=invalid
        await assert.rejects(collectProbeRun({ids,terminalAppOwner:{}}),/identity: XTVERSION preflight/)
      }
      assert.equal(disposed,5)
      calls=[]
      const nonowned=await collectProbeRun({ids})
      assert.equal(nonowned.target.version,"unknown")
      assert.equal(nonowned.rawReplies["collector.xtversion"],undefined)
      assert.deepEqual(calls,[])
      // Actual run 38303792334 reported stale detection 1.23.20211.0 despite measured executable
      // ProductVersion 1.21.240823001. Earlier macOS/receipt-copy assertions did not cover this.
      terminal={name:"windows-terminal",version:"1.23.20211.0",os:"windows",osVersion:"fixture"}
      for(const productVersion of ["1.21.240823001","1.21.240823001-build42"]){
        launch=parseAppLaunchReceipt({platform:"win32",executablePath:"C:/runner/WindowsTerminal.exe",
          productVersion,executableSha256:"c3".repeat(32),
          sourceArtifact:{kind:"portable-zip",path:"C:/runner/wt.zip",sha256:"d4".repeat(32)}},"collector","app","fixture")
        process.env.TERMINFO_TARGET_VERSION=productVersion.trim()
        const windows=await collectProbeRun({ids:["device.xtversion"]})
        assert.equal(windows.target.version,productVersion)
        assert.deepEqual(windows.origin.appLaunch,launch)
      }
      terminal={name:"alacritty",version:"",os:"windows",osVersion:"fixture"}
      launch=parseAppLaunchReceipt({platform:"win32",executablePath:"D:/a/_temp/alacritty/alacritty.exe",
        productVersion:"0.17.0",executableSha256:"c3".repeat(32),
        sourceArtifact:{kind:"portable-exe",path:"D:/a/_temp/Alacritty-v0.17.0-portable.exe",sha256:"c3".repeat(32)},
        mesaRenderer:{upstream:"https://github.com/mmozeiko/build-mesa",version:"26.2.5",
          archivePath:"D:/a/_temp/mesa.7z",archiveSha256:"d4".repeat(32),
          dlls:[{name:"opengl32.dll",path:"D:/a/_temp/alacritty/opengl32.dll",sha256:"e5".repeat(32)}]}},"collector","app","fixture")
      process.env.TERMINFO_TARGET_VERSION=""
      const winAlacritty=await collectProbeRun({ids:["device.xtversion"]})
      assert.equal(winAlacritty.target.version,"0.17.0")
      assert.deepEqual(winAlacritty.origin.appLaunch,launch)
    `,
      ],
      { cwd: packageRoot, env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 5000 },
    )
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })

  it.each([
    { arm: "windowsHosted", retained: false },
    { arm: "terminalApp", retained: false },
    { arm: "darwinHosted", retained: true },
  ])("handles $arm text retention: $retained", ({ arm, retained }) => {
    home = mkdtempSync(join(tmpdir(), "terminfo-serve-windows-skip-"))
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      import { mock } from "bun:test"
      import assert from "node:assert/strict"
      const arm = process.env.FIXTURE_ARM
      const retained = process.env.FIXTURE_RETAINED === "yes"
      Object.defineProperty(process, "platform", { value: arm === "windowsHosted" ? "win32" : "darwin" })
      const unified = await import("./packages/terminfo.dev/src/probes/unified.ts")
      const tty = await import("./packages/terminfo.dev/src/tty.ts")
      const owned = await import("./packages/terminfo.dev/src/owned-terminal.ts")
      let capture
      let captureKind = "absent"
      let reads = 0
      globalThis.__TERMINFO_BUNDLED_SUITE__ = {
        manifest: { probeHash: "a".repeat(12), probes: { app: unified.ALL_PROBES.map(p => p.id).sort() } },
        collectorRevision: "b".repeat(40)
      }
      mock.module("./packages/terminfo.dev/src/detect.ts", () => ({
        detectTerminal: () => ({ name: "kitty", version: "", os: "windows", osVersion: "fixture" })
      }))
      mock.module("./packages/terminfo.dev/src/owned-terminal.ts", () => ({ ...owned,
        ownedTerminalVerifiedFor: () => true,
        createOwnedTerminal: async () => ({
          geometryAtGrant: { status: "measured", rows: 24, cols: 80 },
          summary: "owned fixture",
          readCells: async () => { reads += 1; return { status: "refused", reason: "no retention directory in this run" } },
          dispose: async () => {}
        })
      }))
      mock.module("./packages/terminfo.dev/src/tty.ts", () => ({ ...tty,
        withRawMode: async callback => callback(), drainStdin: async () => {},
        queryWithSentinelOutcome: async (sequence, pattern) => {
          const raw = "\\x1bP>|kitty(0.49.2)\\x1b\\\\\\x1b[?62;52;c"
          return { raw, rawBase64: Buffer.from(raw).toString("base64"), match: pattern.exec(raw), reason: pattern.test(raw) ? "reply" : "sentinel" }
        }
      }))
      mock.module("./packages/terminfo.dev/src/probes/unified.ts", () => ({ ...unified,
        runProbeBatch: async options => {
          capture = options.capture
          captureKind = options.captureKind ?? "absent"
          if (retained) {
            assert.equal(typeof options.prepareCapture, "function", "macOS text needs once-per-run preparation")
            await options.prepareCapture({
              context: { rows: 4, cols: 12, queryMode: async () => "unknown", write: () => { throw new Error("Paint before known mode state") } },
              featureId: "collector.captureCalibration",
              recordCapture: () => { throw new Error("Capture before known mode state") }
            })
          }
          return {
            rawReplies: {},
            observations: options.ids.map(featureId => ({ featureId, outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" })),
            assertions: [], screenshotRefs: [], ungradedDiagnostics: {}, suiteComplete: false
          }
        }
      }))
      const { collectProbeRun } = await import("./packages/terminfo.dev/src/serve.ts")
      const run = arm === "terminalApp"
        ? await collectProbeRun({ ids: ["device.xtversion"], terminalAppOwner: {} })
        : await collectProbeRun({ ids: ["device.xtversion"] })
      assert.equal(typeof capture, retained ? "function" : "undefined")
      assert.equal(captureKind, retained ? "text-cells" : "absent")
      assert.equal(reads, 0)
      assert.deepEqual(run.textSnapshotRefs ?? [], [])
      assert.equal(run.observations.filter(observation => observation.evidence === "text").length, 0)
      if (retained) {
        assert.equal(run.textQualification.shapes.length, 5)
        assert.ok(run.textQualification.shapes.every(shape => typeof shape.reason === "string" && !shape.frames))
      } else assert.equal(run.textQualification, undefined)
    `,
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          HOME: home,
          FIXTURE_ARM: arm,
          FIXTURE_RETAINED: retained ? "yes" : "no",
          TERMINFO_CAPTURE_DIRECTORY: retained ? join(home, "capture") : "",
          TERMINFO_DISPOSABLE_RECEIPT: arm !== "terminalApp" ? "hardware-receipt-fixture" : "",
          TERMINFO_RUNTIME_PROVENANCE: "",
          TERMINFO_CLIPBOARD_FIXTURE_RECEIPT: "",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    )
    const lines = result.stderr.split("\n").filter(Boolean)
    expect(result.status, result.stderr).toBe(0)
    expect(lines).toHaveLength(retained ? 0 : 1)
    if (!retained) {
      expect(lines[0]).toMatch(new RegExp(`^${arm}: this arm can read cells from the terminal's own text`, "u"))
      expect(lines[0]).toMatch(/no TERMINFO_CAPTURE_DIRECTORY to retain a snapshot in/u)
      expect(lines[0]).toMatch(/no-capture branch$/u)
    }
  })

  it.each(["capture", "pending-write", "write-error", "refusal"])(
    "a hosted Windows capture with a retention directory takes the %s branch without Linux provenance",
    (expectation) => {
      home = mkdtempSync(join(tmpdir(), "terminfo-serve-hosted-capture-"))
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `
      import { mock } from "bun:test"
      import assert from "node:assert/strict"
      import { readdirSync, readFileSync } from "node:fs"
      import { join } from "node:path"
      import { Writable } from "node:stream"
      const expectation = process.env.FIXTURE_EXPECT
      const hosted = expectation !== "refusal"
      let reads = 0
      let text = "stale"
      let finishWrite
      const out = new Writable({
        write(chunk, encoding, done) {
          if (chunk.toString() === "queued-clear") {
            finishWrite = error => { if (!error) text = "hello"; done(error) }
          } else done()
        }
      })
      Object.defineProperty(process, "platform", { value: "win32" })
      const unified = await import("./packages/terminfo.dev/src/probes/unified.ts")
      const tty = await import("./packages/terminfo.dev/src/tty.ts")
      const owned = await import("./packages/terminfo.dev/src/owned-terminal.ts")
      let capture
      let captureKind = "absent"
      let captured = false
      globalThis.__TERMINFO_BUNDLED_SUITE__ = {
        manifest: { probeHash: "a".repeat(12), probes: { app: unified.ALL_PROBES.map(p => p.id).sort() } },
        collectorRevision: "b".repeat(40)
      }
      mock.module("./packages/terminfo.dev/src/detect.ts", () => ({
        detectTerminal: () => ({ name: "windows-terminal", version: "", os: "windows", osVersion: "fixture" })
      }))
      mock.module("./packages/terminfo.dev/src/owned-terminal.ts", () => ({ ...owned,
        ownedTerminalVerifiedFor: () => true,
        createOwnedTerminal: async () => ({
          geometryAtGrant: { status: "measured", rows: 24, cols: 80 },
          summary: "owned fixture",
          readCells: async () => { reads += 1; return ({
            status: "read",
            grid: { cols: 80, rows: 24, text: [text], attributes: [[0, 0, 0, 0, 0]] },
            bufferOwner: { image: "OpenConsole.exe", pid: 1, ppid: 2, executablePath: "C:\\\\Windows\\\\System32\\\\OpenConsole.exe", executableSha256: "sha256:" + "a".repeat(64) },
            standIns: []
          }) },
          dispose: async () => {}
        })
      }))
      mock.module("./packages/terminfo.dev/src/tty.ts", () => ({ ...tty,
        withRawMode: async callback => callback(), drainStdin: async () => {},
        queryWithSentinelOutcome: async (sequence, pattern) => {
          const raw = "\\x1b[8;24;80t"
          return { raw, rawBase64: Buffer.from(raw).toString("base64"), match: pattern.exec(raw), reason: pattern.test(raw) ? "reply" : "sentinel" }
        }
      }))
      mock.module("./packages/terminfo.dev/src/probes/unified.ts", () => ({ ...unified,
        runProbeBatch: async options => {
          capture = options.capture
          captureKind = options.captureKind ?? "absent"
          if (options.capture) {
            if (expectation === "pending-write" || expectation === "write-error") {
              // Real Writable queues the adapter's completion behind this unfinished chunk.
              options.out.write("queued-clear")
              const pending = options.capture({ role: "witness", label: "fixture" })
              pending.catch(() => {}) // The original promise is asserted below, including its error.
              await Promise.resolve()
              assert.equal(reads, 0, "text readback ran before the selected output completed")
              assert.equal(readdirSync(process.env.TERMINFO_CAPTURE_DIRECTORY).length, 0)
              if (expectation === "write-error") {
                const failure = new Error("selected output completion failed")
                const errorSeen = new Promise(resolve => out.once("error", resolve))
                finishWrite(failure)
                await assert.rejects(pending, error => error === failure)
                assert.equal(reads, 0)
                assert.equal(readdirSync(process.env.TERMINFO_CAPTURE_DIRECTORY).length, 0)
                assert.equal(await errorSeen, failure)
              } else {
                finishWrite()
                await pending
                captured = true
              }
            } else {
              text = "hello"
              await options.capture({ role: "witness", label: "fixture" })
              captured = true
            }
          }
          return {
            rawReplies: {},
            observations: options.ids.map(featureId => ({ featureId, outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" })),
            assertions: [], screenshotRefs: [], ungradedDiagnostics: {}, suiteComplete: false
          }
        }
      }))
      const { collectProbeRun } = await import("./packages/terminfo.dev/src/serve.ts")
      if (!hosted) {
        await assert.rejects(
          collectProbeRun({ ids: ["device.xtversion"], out }),
          /Controlled Linux collection requires runtime provenance/u,
        )
      } else {
        await collectProbeRun({ ids: ["device.xtversion"], out })
        assert.equal(captureKind, "text-cells")
        assert.equal(typeof capture, "function")
        assert.equal(captured, expectation !== "write-error")
        const frames = readdirSync(process.env.TERMINFO_CAPTURE_DIRECTORY).filter(name => name.endsWith(".txt"))
        assert.equal(frames.length, expectation === "write-error" ? 0 : 1)
        if (expectation !== "write-error") {
          assert.equal(reads, 1)
          assert.match(readFileSync(join(process.env.TERMINFO_CAPTURE_DIRECTORY, frames[0]), "utf8"), /hello/u)
        }
      }
      `,
        ],
        {
          cwd: packageRoot,
          env: {
            ...process.env,
            HOME: home,
            FIXTURE_EXPECT: expectation,
            TERMINFO_CAPTURE_DIRECTORY: join(home, "capture"),
            TERMINFO_DISPOSABLE_RECEIPT: expectation !== "refusal" ? "hardware-receipt-fixture" : "",
            TERMINFO_RUNTIME_PROVENANCE: "",
            TERMINFO_CLIPBOARD_FIXTURE_RECEIPT: "",
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).toBe("")
    },
  )

  it("hosted Windows Alacritty requires detected terminal to match receipt appId and sets target.version from win32 appLaunch.productVersion", () => {
    home = mkdtempSync(join(tmpdir(), "terminfo-serve-hosted-alacritty-"))
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      import { mock } from "bun:test"
      import assert from "node:assert/strict"
      Object.defineProperty(process, "platform", { value: "win32" })
      const unified = await import("./packages/terminfo.dev/src/probes/unified.ts")
      const tty = await import("./packages/terminfo.dev/src/tty.ts")
      const owned = await import("./packages/terminfo.dev/src/owned-terminal.ts")
      let detectedName = "alacritty"
      globalThis.__TERMINFO_BUNDLED_SUITE__ = {
        manifest: { probeHash: "a".repeat(12), probes: { app: unified.ALL_PROBES.map(p => p.id).sort() } },
        collectorRevision: "b".repeat(40)
      }
      mock.module("./packages/terminfo.dev/src/detect.ts", () => ({
        detectTerminal: () => ({ name: detectedName, version: "", os: "windows", osVersion: "fixture" })
      }))
      mock.module("./packages/terminfo.dev/src/owned-terminal.ts", () => ({ ...owned,
        ownedTerminalVerifiedFor: () => true,
        createOwnedTerminal: async () => ({
          geometryAtGrant: { status: "measured", rows: 24, cols: 80 },
          hostedWindowsAppId: "alacritty",
          summary: "owned alacritty fixture",
          readCells: async () => ({
            status: "read",
            grid: { cols: 80, rows: 24, text: ["hello"], attributes: [[0, 0, 0, 0, 0]] },
            bufferOwner: { image: "conhost.exe", pid: 7216, ppid: 4684, executablePath: "C:\\\\Windows\\\\System32\\\\conhost.exe", executableSha256: "sha256:" + "b".repeat(64) }
          }),
          dispose: async () => {}
        })
      }))
      mock.module("./packages/terminfo.dev/src/tty.ts", () => ({ ...tty,
        withRawMode: async callback => callback(), drainStdin: async () => {},
        queryWithSentinelOutcome: async (sequence, pattern) => {
          const raw = sequence.includes("[18t") ? "\\x1b[8;24;80t" : ""
          return { raw, rawBase64: Buffer.from(raw).toString("base64"), match: pattern.exec(raw), reason: pattern.test(raw) ? "reply" : "sentinel" }
        }
      }))
      mock.module("./packages/terminfo.dev/src/probes/unified.ts", () => ({ ...unified,
        runProbeBatch: async options => ({
          rawReplies: {},
          appLaunch: {
            platform: "win32",
            executablePath: "D:\\\\a\\\\_temp\\\\alacritty\\\\alacritty.exe",
            productVersion: "0.17.0",
            executableSha256: "5ad70ddc5c2a2bfe84084a2c4c73558e9360914f035a902d7a69277be7249f1f",
            sourceArtifact: {
              kind: "portable-exe",
              path: "D:\\\\a\\\\_temp\\\\measurement-artifacts\\\\Alacritty-v0.17.0-portable.exe",
              sha256: "5ad70ddc5c2a2bfe84084a2c4c73558e9360914f035a902d7a69277be7249f1f"
            }
          },
          observations: options.ids.map(featureId => ({ featureId, outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" })),
          assertions: [], screenshotRefs: [], ungradedDiagnostics: {}, suiteComplete: false
        })
      }))
      const { collectProbeRun } = await import("./packages/terminfo.dev/src/serve.ts")
      const run = await collectProbeRun({ ids: ["device.xtversion"] })
      assert.equal(run.target.id, "alacritty")
      assert.equal(run.target.version, "0.17.0")
      detectedName = "windows-terminal"
      await assert.rejects(
        collectProbeRun({ ids: ["device.xtversion"] }),
        /Hosted Windows terminal detected "windows-terminal" while the receipt names alacritty/u,
      )
      `,
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          HOME: home,
          TERMINFO_CAPTURE_DIRECTORY: join(home, "capture"),
          TERMINFO_DISPOSABLE_RECEIPT: "hardware-receipt-fixture",
          TERMINFO_RUNTIME_PROVENANCE: "",
          TERMINFO_CLIPBOARD_FIXTURE_RECEIPT: "",
          TERMINFO_TARGET_VERSION: "",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe("")
  })

  it.each([undefined, '["cursor.hide","reset.decaln"]'])(
    "forwards startup selection %s once and preserves producer completeness",
    async (selection) => {
      const { registration } = await startTestDaemon(
        `
          import { mock } from "bun:test"
          const unified = await import("./packages/terminfo.dev/src/probes/unified.ts")
          const tty = await import("./packages/terminfo.dev/src/tty.ts")
          globalThis.__TERMINFO_BUNDLED_SUITE__ = {
            manifest: { probeHash: "a".repeat(12), probes: { app: unified.ALL_PROBES.map(p => p.id).sort() } },
            collectorRevision: "b".repeat(40)
          }
          mock.module("./packages/terminfo.dev/src/tty.ts", () => ({
            ...tty, withRawMode: async callback => callback(), drainStdin: async () => {}
          }))
          mock.module("./packages/terminfo.dev/src/probes/unified.ts", () => ({
            ...unified, runProbeBatch: async options => ({
              rawReplies: { selected: options.ids ?? null }, observations: (options.ids ?? []).map(featureId => ({ featureId })),
              assertions: [], screenshotRefs: [], ungradedDiagnostics: {}, suiteComplete: false
            })
          }))
          const { startDaemon } = await import("./packages/terminfo.dev/src/serve.ts")
          await startDaemon()
          process.env.TERMINFO_PROBE_IDS = '["not-a-probe"]'
        `,
        { TERMINFO_PROBE_IDS: selection },
      )
      const response = await fetch(`http://127.0.0.1:${registration.port}/probe`, {
        headers: { Authorization: `Bearer ${registration.token}` },
      })
      expect(response.status).toBe(200)
      const run = (await response.json()) as {
        rawReplies: { selected: string[] | null }
        observations: { featureId: string }[]
        suiteComplete: boolean
      }
      expect(run.rawReplies.selected).toEqual(selection ? JSON.parse(selection) : null)
      expect(run.observations.map((observation: { featureId: string }) => observation.featureId)).toEqual(
        selection ? JSON.parse(selection) : [],
      )
      expect(run.suiteComplete).toBe(false)
    },
  )

  it.each(["", "null", "[]", '["cursor.hide","cursor.hide"]', '["not-a-probe"]', '["cursor.hide",3]'])(
    "refuses malformed or inapplicable private IDs %s before listening",
    (value) => {
      home = mkdtempSync(join(tmpdir(), "terminfo-serve-private-"))
      const result = spawnSync(
        process.execPath,
        ["-e", 'import { startDaemon } from "./packages/terminfo.dev/src/serve.ts"; startDaemon()'],
        {
          cwd: packageRoot,
          env: { ...process.env, HOME: home, TERMINFO_PROBE_IDS: value },
          encoding: "utf8",
          timeout: 1500,
        },
      )
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("TERMINFO_PROBE_IDS")
    },
  )
})
