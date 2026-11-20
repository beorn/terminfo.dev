/**
 * @failure  The editors' SGR 59 underline reset grades as a third frame again, or the band reader grades a glyph row.
 * @level    l1
 * @consumer sgr.underline-color-reset on VS Code and Cursor Mac (#37240 cell 2, @cto 5dd1c2ee / 872c53eb)
 * @testonly none
 */
// #37240 cell 2 (@cto 5dd1c2ee): the underline band reader, graded on the frames the VS Code and Cursor
// Mac runs retained (content/artifacts), cropped at each run's own recorded region rectangle.
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import {
  underlineBandAttempts,
  underlineBandVerdict,
  type CaptureRenderingAxes,
  type ObservationFrame,
} from "@terminfo/probe-defs"
import { renderingAxes } from "./capture-core.ts"
import { decodeRetainedPng } from "./testing/retained-png.ts"

const ID = "sgr.underline-color-reset"
const SETUP = "#ff0080"
const CONTENT = new URL("../../../content/", import.meta.url)
const RUNS = {
  vscode: "com.microsoft.VSCode-1.142.0-macos-a935213655e690277486921ef3587667.json",
  cursor: "cursor-3.30.14-macos-56d65f1b58680a65c094c1b6d172a166.json",
}
type Role = "seed" | "after" | "expected" | "ignored"
const SUFFIX: Record<Role, string> = {
  seed: "pre-edit seed",
  after: "post-sequence target",
  expected: "expected frame",
  ignored: "ignored-attribute frame",
}

interface RetainedFrame {
  label: string
  ref: string
  regionRectangle: { x: number; y: number; width: number; height: number }
}

/** The four graded frames of one retained run, each cropped at its own rectangle and measured. */
function retained(run: keyof typeof RUNS) {
  const record = JSON.parse(readFileSync(new URL(`probes-apps/${RUNS[run]}`, CONTENT), "utf8")) as {
    results: { featureId: string; frames: RetainedFrame[] }[]
  }
  const frames = record.results.find((result) => result.featureId === ID)!.frames
  const axes = {} as Record<Role, CaptureRenderingAxes>
  let width = 0
  for (const role of Object.keys(SUFFIX) as Role[]) {
    const frame = frames.find((entry) => entry.label === `${ID}: ${SUFFIX[role]}`)!
    const image = decodeRetainedPng(new URL(`artifacts/${frame.ref.slice("sha256:".length)}.png`, CONTENT))
    const { x, y, width: w, height: h } = frame.regionRectangle
    const crop = Buffer.alloc(w * h * 4)
    for (let row = 0; row < h; row++) {
      crop.set(
        image.rgba.subarray(((y + row) * image.width + x) * 4, ((y + row) * image.width + x + w) * 4),
        row * w * 4,
      )
    }
    axes[role] = renderingAxes(crop)
    width = w
  }
  return { width, ...axes }
}

const grade = (frames: ReturnType<typeof retained>, swap: Partial<Record<Role, Role>> = {}) => {
  const pick = (role: Role) => frames[swap[role] ?? role]
  return underlineBandVerdict(ID, SETUP, frames.width, pick("seed"), pick("after"), pick("expected"), pick("ignored"))
}

test("VS Code a9352136: SGR 59 resets the underline to white, not the dark theme foreground", () => {
  const verdict = grade(retained("vscode"))
  expect(verdict).toMatchObject({
    kind: "wrong-colour",
    rows: [13],
    afterColour: "#ffffff",
    expectedColour: "#cccccc",
    seedColour: "#ff0080",
  })
  expect(verdict?.note).toContain("resets to #ffffff, not the theme foreground #cccccc")
  // The glyph rows the band reader leaves ungraded are named, with their pixel counts (@cto 872c53eb).
  expect(verdict?.note).toContain(
    "ungraded glyph rows where seed and ignored differ on some pixels: row 2: 2 px, row 4: 2 px, row 5: 2 px",
  )
})

test("Cursor 56d65f1b: SGR 59 resets the underline to white, not the light theme foreground", () => {
  expect(grade(retained("cursor"))).toMatchObject({
    kind: "wrong-colour",
    rows: [13],
    afterColour: "#ffffff",
    expectedColour: "#141414",
    seedColour: "#ff0080",
  })
})

test("a post-sequence band equal to the expected frame's is Supported, though the glyph rows differ", () => {
  const frames = retained("vscode")
  expect(grade(frames, { after: "expected" })).toMatchObject({ kind: "supported", afterColour: "#cccccc" })
})

test("a post-sequence band still in the setup colour is no effect", () => {
  expect(grade(retained("vscode"), { after: "seed" })).toMatchObject({ kind: "no-effect", afterColour: "#ff0080" })
})

test("a glyph row that differs on every pixel is not an underline: third frame", () => {
  const frames = retained("vscode")
  // Synthetic: the ignored frame's glyph row 5 repainted whole, so seed and ignored differ on every
  // pixel of rows 5 and 13 — two rows that are not one contiguous band at the cell's bottom edge.
  const rgb = Uint8Array.from(frames.ignored.rgb!)
  rgb.fill(7, 5 * frames.width * 3, 6 * frames.width * 3)
  const ignored = Object.defineProperty({ ...frames.ignored }, "rgb", { value: rgb }) as CaptureRenderingAxes
  const verdict = underlineBandVerdict(ID, SETUP, frames.width, frames.seed, frames.after, frames.expected, ignored)
  expect(verdict?.kind).toBe("third-frame")
  expect(verdict?.note).toContain("not 1-2 contiguous rows at the cell's bottom edge")
})

test("a seed band that is not the setup colour is not the setup's underline: third frame", () => {
  const verdict = underlineBandVerdict(
    ID,
    "#00ff00",
    retained("vscode").width,
    ...((["seed", "after", "expected", "ignored"] as Role[]).map((role) => retained("vscode")[role]) as [
      CaptureRenderingAxes,
      CaptureRenderingAxes,
      CaptureRenderingAxes,
      CaptureRenderingAxes,
    ]),
  )
  expect(verdict?.kind).toBe("third-frame")
})

test("an expected band equal to the seed's cannot separate a reset from no effect", () => {
  expect(grade(retained("vscode"), { expected: "seed" })?.kind).toBe("inconclusive")
})

test("a frame read back from a record carries no RGB, and the band reader declines", () => {
  const frames = retained("vscode")
  const { rgb: _rgb, ...stored } = { ...frames.after, rgb: undefined }
  expect(
    underlineBandVerdict(ID, SETUP, frames.width, frames.seed, stored, frames.expected, frames.ignored),
  ).toBeUndefined()
})

test("attempts must agree on the band verdict and colour", () => {
  const frames = retained("vscode")
  const round = (after: CaptureRenderingAxes): ObservationFrame[] =>
    (Object.keys(SUFFIX) as Role[]).map(
      (role) =>
        ({
          kind: "screenshot",
          label: `${ID}: ${SUFFIX[role]}`,
          ref: "sha256:" + "0".repeat(64),
          regionRectangle: { x: 0, y: 0, width: frames.width, height: frames.width },
          rendering: role === "after" ? after : frames[role],
        }) as unknown as ObservationFrame,
    )
  expect(underlineBandAttempts(ID, [...round(frames.after), ...round(frames.after)])).toBeUndefined()
  expect(underlineBandAttempts(ID, [...round(frames.after), ...round(frames.expected)])).toMatchObject({
    disagreement: expect.stringContaining("attempt 1: wrong-colour #ffffff; attempt 2: supported #cccccc"),
  })
})
