import { readFileSync } from "node:fs"
import { inflateSync } from "node:zlib"
import type { CapturedFrame } from "../capture-core.ts"

/**
 * Decode one retained 8-bit RGBA, non-interlaced PNG (the collector's own frame format) without
 * magick, so a test can grade the exact pixels a run retained.
 */
export function decodeRetainedPng(path: URL | string): CapturedFrame {
  const png = readFileSync(path)
  let offset = 8
  let width = 0
  let height = 0
  const data: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString("latin1", offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) {
        throw new Error(`${String(path)} is not 8-bit RGBA non-interlaced`)
      }
    }
    if (type === "IDAT") data.push(body)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * 4
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[y * stride + x - 4]! : 0
      const up = y > 0 ? rgba[(y - 1) * stride + x]! : 0
      const corner = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4]! : 0
      const estimate = left + up - corner
      const [dl, du, dc] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)]
      const paeth = dl <= du && dl <= dc ? left : du <= dc ? up : corner
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter]!
      rgba[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + predictor) & 255
    }
  }
  return { width, height, rgba }
}
