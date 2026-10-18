/**
 * @failure Editing capture fixtures advertised a cell-readback claim the application collector
 *   cannot make: they returned only a cursor-position measurement, with no pre-edit control or
 *   post-edit target a reviewer could judge. A missing capture branch must not silently change
 *   the cursor-only fallback, and an undersized terminal must refuse before writing.
 * @level l1
 * @consumer App probe pixel frames for editing operations.
 * @testonly none
 */
import { expect, test } from "vitest"
import { editingProbes, editingReadbackRows } from "./editing.ts"
import type { ObservationFrame, ProbeDefinition, TermContext } from "./types.ts"

const CAPTURE_IDS = [
  "editing.insert-chars",
  "editing.delete-chars",
  "editing.insert-lines",
  "editing.delete-lines",
  "editing.repeat-char",
  "editing.decfra",
  "editing.decera",
  "editing.decsera",
  "editing.deccra",
  "editing.deccara",
  "editing.decrara",
  "editing.sl",
  "editing.sr",
  "editing.decic",
  "editing.decdc",
] as const

function captureContext(rows: number, cols: number, withCapture = true) {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context: TermContext = {
    rows,
    cols,
    write: (sequence) => writes.push(sequence),
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  if (withCapture) {
    context.capture = async ({ role, label }) => {
      const frame = {
        role,
        label,
        capturedAt: frames.length + 1,
        ref: `sha256:${String(frames.length + 1).repeat(64)}`,
        pixelsDigest: `sha256:${String(frames.length + 1).repeat(64)}`,
      }
      frames.push(frame)
      return frame
    }
  }
  return { context, writes, frames }
}

function find(id: string): ProbeDefinition {
  const definition = editingProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`missing editing term callback for ${id}`)
  return definition
}

/**
 * 28450 slice C moved every editing capture row onto the region verdict, so the ungraded
 * pre-edit-control/post-edit-target pixel pair is no longer reachable for any of them. The decision
 * itself is asserted per id by `testing/region-readback-contract.test.ts`; what stays unique to this
 * file is the guard behaviour, asserted below.
 */
test("every editing capture row asks the terminal's pixel report before painting", async () => {
  for (const id of CAPTURE_IDS) {
    const { context, writes, frames } = captureContext(24, 80)
    const result = await find(id).term!(context)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "query",
    })
    expect(String(result.observation?.note), id).toContain("CSI 16 t")
    expect(frames, id).toEqual([])
    expect(writes, id).toEqual([])
  }
})

/**
 * A window whose cells are readable: CSI 16 t and CSI 14 t answer the terminal's own pixel report,
 * the witness cell shows the last glyph written, and the compared cells never move — so the row
 * reaches the decision and its spec, without claiming any capability.
 */
function readbackCaptureContext(rows: number, cols: number, witness = { row: 3, col: 1 }) {
  const writes: string[] = []
  const requests: Array<{ region: { top: number; left: number; bottom: number; right: number }; label: string }> = []
  const frames: ObservationFrame[] = []
  let reads = 0
  const sentinel = `${witness.row},${witness.col},${witness.row},${witness.col}`
  const key = (region: { top: number; left: number; bottom: number; right: number }) =>
    `${region.top},${region.left},${region.bottom},${region.right}`
  const context: TermContext = {
    rows,
    cols,
    write: (sequence) => writes.push(sequence),
    queryCursorPosition: async () => ({ row: 2, col: 1 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    async queryWithSentinelOutcome(sequence) {
      if (sequence === "\x1b[16t") {
        return { match: ["\x1b[6;16;8t", "16", "8"], reason: "reply", raw: "", rawBase64: "" }
      }
      if (sequence === "\x1b[14t") {
        return { match: ["\x1b[4;384;640t", "384", "640"], reason: "reply", raw: "", rawBase64: "" }
      }
      return { match: null, reason: "timeout", raw: "", rawBase64: "" }
    },
    queryMode: async () => null,
  }
  context.capture = async (request) => {
    reads += 1
    const region = request.cells!
    requests.push({ region, label: request.label })
    const frame: ObservationFrame = {
      role: request.role,
      label: request.label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
    }
    frames.push(frame)
    const witnessWrite = writes.filter((entry) => /^\x1b\[\d+;\d+H.$/.test(entry)).at(-1)
    const content = key(region) === sentinel ? (witnessWrite?.slice(-1) ?? "") : "unmoving"
    return { ...frame, regionDigest: `sha256:${key(region)}|${content}`, pixelsDigest: `sha256:frame|${content}` }
  }
  return { context, writes, requests, frames }
}

test("the readback-governed row hands the decision its own region and the terminal's pixel report", async () => {
  const { context, requests } = readbackCaptureContext(24, 80)
  const result = await find("editing.delete-chars").term!(context)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(String(result.observation?.note)).toContain("seed frame and the expected frame read the same cells")
  const compared = requests.filter(({ region }) => region.right !== region.left || region.bottom !== region.top)
  expect(compared.map(({ region }) => region)).toEqual([
    { top: 1, left: 1, bottom: 1, right: 8 },
    { top: 1, left: 1, bottom: 1, right: 8 },
    { top: 1, left: 1, bottom: 1, right: 8 },
  ])
  expect(compared.map(({ label }) => label)).toEqual([
    "editing.delete-chars: pre-edit seed",
    "editing.delete-chars: post-sequence target",
    "editing.delete-chars: expected frame",
  ])
})

test("the readback-governed row refuses by name when the terminal cannot report its pixel geometry", async () => {
  const { context, frames } = captureContext(24, 80)
  const result = await find("editing.delete-chars").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    // Shape B of 28582: the pixel-report queries were already written, so this is not the
    // zero-byte "none" refusal — it is a query that came back unusable.
    evidence: "query",
  })
  expect(String(result.observation?.note)).toContain("CSI 16 t")
  expect(frames).toEqual([])
})

test("an undersized terminal refuses an editing capture before writing", async () => {
  for (const id of CAPTURE_IDS) {
    const { context, writes, frames } = captureContext(1, 1)
    const result = await find(id).term!(context)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(writes, id).toEqual([])
    expect(frames, id).toEqual([])
  }
})

test("a seed at the very edge refuses so it cannot wrap or scroll the captured region", async () => {
  // insert-chars compares one nine-column row with its witness on row 3, so the kind DERIVES a floor of
  // 3 rows by 9 + the family's two-column margin = 11 columns.
  const tight = captureContext(1, 8)
  expect((await find("editing.insert-chars").term!(tight.context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(tight.writes).toEqual([])
  const margins = captureContext(2, 11)
  const refused = await find("editing.insert-chars").term!(margins.context)
  expect(refused.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(margins.writes).toEqual([])
  expect(margins.frames).toEqual([])
  // One column short of the derived floor still refuses: the margin is what stops the seed wrapping.
  const narrow = captureContext(3, 10)
  expect((await find("editing.insert-chars").term!(narrow.context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(narrow.writes).toEqual([])
  expect(narrow.frames).toEqual([])
  // Exactly the derived floor opens the guards: the row moves on to the pixel report, no paint yet.
  const fit = captureContext(3, 11)
  expect((await find("editing.insert-chars").term!(fit.context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "query",
  })
  expect(fit.frames).toEqual([])
})

test("the capture set covers the cell-edit probes and leaves non-cell probes untouched", () => {
  const captured = editingProbes.filter((probe) => probe.id in Object.fromEntries(CAPTURE_IDS.map((id) => [id, true])))
  expect(captured.map((probe) => probe.id).sort()).toEqual([...CAPTURE_IDS].sort())
  expect(captured).toHaveLength(15)
})

/**
 * 28450 slice C deleted the cursor-only fallback for the thirteen converted rows: a run with no owned
 * capture can only answer "inconclusive", so the row refuses BY NAME and writes nothing rather than
 * keeping an ungraded CPR fixture alive (@cto A2). `editing.decsace` and `editing.decrqcra` keep their
 * own callbacks; the two attribute-rectangle rows converted to the kind with decsace, so their extent
 * refusals are the kind's own (`editing-geometry.test.ts`).
 */
test("without a capture adapter a converted row refuses by name and writes nothing", async () => {
  const { context, writes, frames } = captureContext(24, 80, false)
  const result = await find("editing.insert-chars").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(String(result.observation?.note)).toContain("no owned capture adapter")
  expect(writes).toEqual([])
  expect(frames).toEqual([])
})

/**
 * A capture adapter that MODELS DECSACE and DECCARA instead of handing every capture its own
 * digest: the digest is a function of the cells the writes actually left on screen. A double that
 * invents a distinct digest per capture cannot fail on the arm's writes — a mutant that sets the
 * wrong extent, omits DECCARA, or grades the seed still earns three different digests and passes
 * (@cto round-2 B2, which reproduced exactly those three mutants at 7a364cac).
 *
 * The ref is deliberately CONSTANT: a frame pair compared by retained artifact would read "same
 * frame" here, so an arm that regressed to `ref` cannot pass this double.
 */
function decsaceCaptureContext() {
  const DECSACE_SEED_PAINT = "\x1b[0m\x1b[2J\x1b[H\x1b[1;1Habcdefgh\x1b[2;1Hijklmnop"
  const DECSACE_CARA = "\x1b[1;2;2;3;7$r"
  const rows = 2
  const cols = 8
  const blank = () =>
    Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ char: " ", inverse: false })))
  let screen = blank()
  let cursor = { row: 0, col: 0 }
  let decsace = 0
  const frameWrites: string[] = []
  const writes: string[] = []
  let sinceCapture = ""

  const invert = (top: number, left: number, bottom: number, right: number) => {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const inRectangle = row >= top && row <= bottom && col >= left && col <= right
        const afterStart = row > top || (row === top && col >= left)
        const beforeEnd = row < bottom || (row === bottom && col <= right)
        const inStream = afterStart && beforeEnd
        const cell = screen[row]?.[col]
        if (cell !== undefined && (decsace === 2 ? inRectangle : inStream)) cell.inverse = true
      }
    }
  }

  const apply = (sequence: string) => {
    writes.push(sequence)
    sinceCapture += sequence
    let index = 0
    while (index < sequence.length) {
      const character = sequence[index]
      if (character !== "\x1b") {
        const cell = screen[cursor.row]?.[cursor.col]
        if (cell !== undefined) cell.char = character ?? ""
        cursor.col += 1
        index += 1
        continue
      }
      // A CSI is params, then INTERMEDIATE bytes (0x20-0x2F: `*` for DECSACE, `$` for DECCARA),
      // then the final byte. Matching only `$` as an intermediate swallowed `2*x`.
      const match = /^\x1b\[([0-9;?]*)([ -/]*)([@-~])/.exec(sequence.slice(index))
      if (!match) {
        index += 1
        continue
      }
      const params = match[1] ?? ""
      const intermediate = match[2] ?? ""
      const final = match[3] ?? ""
      const numbers = params
        .split(";")
        .filter((entry) => entry !== "")
        .map(Number)
      if (final === "H") {
        cursor = { row: (numbers[0] ?? 1) - 1, col: (numbers[1] ?? 1) - 1 }
      } else if (final === "J") {
        screen = blank()
      } else if (final === "x" && intermediate === "*") {
        decsace = numbers[0] ?? 0
      } else if (final === "r" && intermediate === "$") {
        invert((numbers[0] ?? 1) - 1, (numbers[1] ?? 1) - 1, (numbers[2] ?? 1) - 1, (numbers[3] ?? 1) - 1)
      }
      index += match[0].length
    }
  }

  const digest = () =>
    `sha256:${screen.map((line) => line.map((cell) => `${cell.inverse ? "#" : "."}${cell.char}`).join("")).join("|")}`

  const context: TermContext = {
    rows: 24,
    cols: 80,
    write: apply,
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  context.capture = async ({ role, label }) => {
    const frame: ObservationFrame = {
      role,
      label,
      capturedAt: frameWrites.length + 1,
      ref: `sha256:${"r".repeat(64)}`,
      pixelsDigest: digest(),
    }
    frameWrites.push(sinceCapture)
    sinceCapture = ""
    return frame
  }
  return { context, frameWrites, writes, seed: DECSACE_SEED_PAINT, cara: DECSACE_CARA }
}

/**
 * decsace converted with the attribute-cell kind (@cto 2026-10-18): on an adapter that reports
 * frames it measures BOTH extents. The stream frame is the control, so the arm is supported only
 * when DECSACE 2 and DECSACE 0 leave screens that differ from the seed AND from each other.
 */
test("editing.decsace grades the frames its own writes produced", async () => {
  const { context, frameWrites, writes, seed, cara } = decsaceCaptureContext()
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "pixels" })
  // The bytes each capture was taken after, in order: the seed, the second read of that same static
  // frame, DECSACE 2 + DECCARA, then DECSACE 0 + DECCARA. A swapped or missing write changes this.
  expect(frameWrites).toEqual([`\x1b[0m\x1b[?25l${seed}`, "", `${seed}\x1b[2*x${cara}`, `${seed}\x1b[0*x${cara}`])
  // The observation cites the three DECIDED frames; the stability read is the second write bucket
  // above and exists as evidence in the arm's own sequence, not as a frame to grade.
  const frames = (result.observation?.frames ?? []) as ObservationFrame[]
  expect(frames.map((frame) => frame.label)).toEqual([
    "editing.decsace: seed before DECSACE",
    "editing.decsace: DECSACE 2 rectangle frame",
    "editing.decsace: DECSACE 0 stream frame",
  ])
  const observed = JSON.parse(String(result.assertions?.[0]?.observed)) as Record<string, string>
  expect(observed.kind).toBe("whole")
  expect(observed.seed).not.toBe(observed.rectangle)
  expect(observed.seed).not.toBe(observed.stream)
  expect(observed.rectangle).not.toBe(observed.stream)
  // The shared lifecycle closes as well as opens: DECTCEM restored and the screen reset on the way
  // out, so the next probe on this terminal does not inherit a hidden cursor (@dev/review2 R3 B1).
  expect(writes).toContain("\x1b[?25h")
  expect(writes.at(-1)).toBe("\x1b[0m\x1b[2J\x1b[H")
})

test("editing.decsace restores the cursor when a capture throws", async () => {
  const { context, writes } = decsaceCaptureContext()
  context.capture = async () => {
    throw new Error("capture failed")
  }
  await expect(find("editing.decsace").term!(context)).rejects.toThrow(/capture failed/)
  expect(writes).toContain("\x1b[?25h")
  expect(writes.at(-1)).toBe("\x1b[0m\x1b[2J\x1b[H")
})

/**
 * A text-only double is the macOS case: its digest cannot see an attribute, so both extents read the
 * same frame. That must be inconclusive BY NAME — never a pass (nothing was separated) and never a
 * negative (the attribute may well have been applied).
 */
test("editing.decsace reads equal extents inconclusive by name, never supported", async () => {
  const { context, frames } = captureContext(24, 80)
  context.capture = async ({ role, label }) => {
    const frame = {
      role,
      label,
      capturedAt: 1,
      ref: `sha256:${"a".repeat(64)}`,
      pixelsDigest: `sha256:${"a".repeat(64)}`,
    }
    frames.push(frame)
    return frame
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
  })
  expect(String(result.observation?.note)).toContain("Both DECSACE extent modes left the same frame")
  expect(result.assertions).toBeUndefined()
  expect(frames).toHaveLength(4)
})

/**
 * P2 from review2 source audit 97414a37: `ref` is the RETAINED ARTIFACT, and the shared type says
 * encoded container chunks can differ between identical images. Comparing refs alone therefore lets
 * unchanged pixels read as a measured extent difference. The arm must compare the frame kind measured
 * digest (pixelsDigest for pixels, cellDigest for text cells) and name the gap when one is absent.
 */
test("editing.decsace compares measured digests, not retained artifact refs", async () => {
  const { context } = captureContext(24, 80)
  let reads = 0
  context.capture = async ({ role, label }) => {
    reads += 1
    // Three DIFFERENT artifact refs over ONE measured screen: the encoded bytes differ, the
    // measurement does not.
    return {
      role,
      label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
      pixelsDigest: `sha256:${"f".repeat(64)}`,
    }
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
  })
  expect(String(result.observation?.note)).toContain("same frame")
  expect(result.assertions).toBeUndefined()
})

test("editing.decsace names an adapter that reports no measured digest", async () => {
  const { context } = captureContext(24, 80)
  let reads = 0
  context.capture = async ({ role, label }) => {
    reads += 1
    return { role, label, capturedAt: reads, ref: `sha256:${String(reads).repeat(64)}` }
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("do not all report one measured digest kind")
  expect(result.assertions).toBeUndefined()
})

/**
 * @cto round-2 B1a: a per-frame `whole ?? cells` can compare one frame's whole-window digest with
 * another frame's region digest — those never match, so the mismatch reads as a measured extent
 * difference. One kind must be present on ALL three frames, or the row is inconclusive.
 */
test("editing.decsace refuses frames whose measured digests are of different kinds", async () => {
  const { context } = captureContext(24, 80)
  let reads = 0
  context.capture = async ({ role, label }) => {
    reads += 1
    const frame: ObservationFrame = {
      role,
      label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
      ...(reads === 4 ? { regionDigest: `sha256:${"c".repeat(64)}` } : { pixelsDigest: `sha256:${"p".repeat(64)}` }),
    }
    return frame
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("one measured digest kind")
  expect(result.assertions).toBeUndefined()
})

/**
 * @cto round-2 B1b: the cursor is hidden and two captures of one static frame must agree, exactly as
 * the capture-region oracle requires (region-readback.ts). A frame that moved between two reads of
 * the same static screen cannot decide anything.
 */
test("editing.decsace refuses a capture that is not byte-stable", async () => {
  const { context } = captureContext(24, 80)
  let reads = 0
  context.capture = async ({ role, label }) => {
    reads += 1
    return {
      role,
      label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
      pixelsDigest: `sha256:${String(reads).repeat(64)}`,
    }
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("not byte-stable")
  expect(result.assertions).toBeUndefined()
})

/**
 * @cto round-2 B2 mutant 2: a frame that did not move from the seed has measured no change at all,
 * so an ignored DECCARA cannot be separated from a digest that cannot see attributes.
 */
test("editing.decsace refuses a target frame that did not move from the seed", async () => {
  const { context } = captureContext(24, 80)
  let reads = 0
  context.capture = async ({ role, label }) => {
    reads += 1
    const digest = reads <= 2 ? "seed" : reads === 3 ? "rect" : "seed"
    return { role, label, capturedAt: reads, ref: `sha256:${digest}`, pixelsDigest: `sha256:${digest}` }
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("stream frame did not differ from the seed")
  expect(result.assertions).toBeUndefined()
})

/**
 * The two converted attribute rows on a TEXT-ONLY adapter: the seed and the expected frame read the
 * same cells because only attributes changed, so the region oracle refuses by name. This is the macOS
 * census row (@cto 2026-10-18 condition 3) in executable form.
 */
test("an attribute row on a text-only adapter is inconclusive by name", async () => {
  for (const id of ["editing.deccara", "editing.decrara"]) {
    const row = editingReadbackRows.find((entry) => entry.id === id)
    if (!row?.sentinel) throw new Error(`missing sentinel for ${id}`)
    const { context } = readbackCaptureContext(24, 80, { row: row.sentinel.row, col: row.sentinel.col ?? 1 })
    const result = await find(id).term!(context)
    expect(result.observation, id).toMatchObject({ outcome: "inconclusive", evidence: "pixels" })
    expect(String(result.observation?.note), id).toContain("seed frame and the expected frame read the same cells")
    expect(result.assertions, id).toBeUndefined()
  }
})

/**
 * @cto round-2 R4 and @dev/review2 round-3 R4: the expected frame must be pinned PER ROW and per
 * CELL, not by finding `\x1b[7m` anywhere in the writes — the DECRARA seed already carries `7m`, so
 * a global search proved nothing about the expected phase, and DECRARA's claim is the opposite one:
 * its expected cells must CLEAR inverse.
 *
 * The check is semantic: render every write into its screen cells (CUP + SGR), then require a write
 * whose cells equal the row's own `after` grid in BOTH the character and the inverse flag. A
 * missing painting leaves every cell non-inverse; an always-inverse painting turns DECRARA's
 * flanks on. Either way no write matches, per row.
 */
/**
 * The screen each write leaves, in order. SGR state PERSISTS across writes, exactly as a terminal
 * keeps it: an expected frame that never resets would inherit the seed's reverse video, which is the
 * very failure DECRARA's after grid exists to catch.
 */
function paintedScreens(writes: readonly string[]): Array<Map<string, { char: string; inverse: boolean }>> {
  let row = 1
  let col = 1
  let inverse = false
  return writes.map((write) => {
    const cells = new Map<string, { char: string; inverse: boolean }>()
    let index = 0
    while (index < write.length) {
      if (write[index] !== "\x1b") {
        cells.set(`${row},${col}`, { char: write[index] ?? "", inverse })
        col += 1
        index += 1
        continue
      }
      const match = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(write.slice(index))
      if (!match) {
        index += 1
        continue
      }
      const params = (match[1] ?? "")
        .split(";")
        .filter((entry) => entry !== "")
        .map(Number)
      if (match[2] === "H") {
        row = params[0] ?? 1
        col = params[1] ?? 1
      } else if (match[2] === "m") {
        for (const code of params.length === 0 ? [0] : params) {
          if (code === 0) inverse = false
          else if (code === 7) inverse = true
        }
      }
      index += match[0].length
    }
    return new Map(cells)
  })
}

test("each attribute row's expected frame carries its own cells and inverse flags", async () => {
  const failures: string[] = []
  for (const id of ["editing.deccara", "editing.decrara"]) {
    const row = editingReadbackRows.find((entry) => entry.id === id)
    if (!row?.sentinel) throw new Error(`missing sentinel for ${id}`)
    const { context, writes } = readbackCaptureContext(24, 80, {
      row: row.sentinel.row,
      col: row.sentinel.col ?? 1,
    })
    await find(id).term!(context)
    const top = row.region?.top ?? 1
    const left = row.region?.left ?? 1
    const screens = paintedScreens(writes)
    const matched = writes.findIndex((_write, index) => {
      const painted = screens[index]
      if (painted === undefined) return false
      return row.after.every((cells, cellRow) =>
        cells.every((cell, cellCol) => {
          if (typeof cell === "string") return true
          const got = painted.get(`${top + cellRow},${left + cellCol}`)
          return got?.char === cell.char && got.inverse === (cell.attributes.inverse === true)
        }),
      )
    })
    // DECRARA's claim is the CLEAR: its expected frame must contain no reverse video at all, while
    // DECCARA's must set it. A frame that merely inherits the seed's state is not the same frame.
    const expectedWrite = matched === -1 ? "" : (writes[matched] ?? "")
    const paintedAsClaimed = matched !== -1
    const clearsAsClaimed = id === "editing.deccara" || !expectedWrite.includes("\x1b[7m")
    const setsAsClaimed = id !== "editing.deccara" || expectedWrite.includes("\x1b[7m")
    if (!paintedAsClaimed || !clearsAsClaimed || !setsAsClaimed) {
      failures.push(
        `${id} (matched=${String(paintedAsClaimed)}, clears=${String(clearsAsClaimed)}, sets=${String(setsAsClaimed)})`,
      )
    }
  }
  expect(failures).toEqual([])
})
