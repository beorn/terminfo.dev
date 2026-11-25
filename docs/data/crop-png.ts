/**
 * Pure-TypeScript PNG cropper for public screen-result thumbnails (#38269).
 *
 * Decodes 8-bit RGB, RGBA, grayscale, grayscale+alpha, and 1/2/4/8-bit indexed-palette PNGs
 * directly from content/artifacts/ without spawning ImageMagick, clamps every crop strictly inside
 * the calibrated terminal cell grid so no window title bar, chrome, or desktop can ever be emitted,
 * and encodes a compact non-interlaced RGBA PNG with its SHA-256 digest.
 */
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync, inflateSync } from "node:zlib"

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface CellGridCrop {
  readonly origin: { readonly x: number; readonly y: number }
  readonly cell: { readonly width: number; readonly height: number }
  readonly grid: { readonly columns: number; readonly rows: number }
}

export interface DecodedPng {
  readonly width: number
  readonly height: number
  readonly rgba: Uint8Array
}

export interface CroppedPng {
  readonly png: Buffer
  readonly width: number
  readonly height: number
  readonly sha256: string
  readonly rect: Rect
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(chunks: readonly Uint8Array[]): number {
  let c = 0xffffffff
  for (const buf of chunks) {
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const typeBuf = Buffer.from(type, "latin1")
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(body.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32([typeBuf, body]), 0)
  return Buffer.concat([lenBuf, typeBuf, body, crcBuf])
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Decode any standard non-interlaced PNG (color types 0, 2, 3, 4, 6; bit depths 1/2/4/8 for indexed, 8 for others). */
export function decodePngBytes(png: Uint8Array, label = "png"): DecodedPng {
  if (png.length < 8 || !Buffer.from(png.subarray(0, 8)).equals(PNG_SIG)) {
    throw new Error(`${label}: not a valid PNG`)
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let plte: Uint8Array | undefined
  let trns: Uint8Array | undefined
  const idat: Uint8Array[] = []
  const view = Buffer.from(png.buffer, png.byteOffset, png.byteLength)

  while (offset + 8 <= png.length) {
    const length = view.readUInt32BE(offset)
    const type = view.toString("latin1", offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      width = view.readUInt32BE(offset + 8)
      height = view.readUInt32BE(offset + 12)
      bitDepth = body[8]!
      colorType = body[9]!
      interlace = body[12]!
    } else if (type === "PLTE") {
      plte = body
    } else if (type === "tRNS") {
      trns = body
    } else if (type === "IDAT") {
      idat.push(body)
    } else if (type === "IEND") {
      break
    }
    offset += 12 + length
  }

  if (width <= 0 || height <= 0) throw new Error(`${label}: invalid PNG dimensions ${width}x${height}`)
  if (interlace !== 0) throw new Error(`${label}: interlaced PNGs are not supported`)

  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const channels = channelsByType[colorType]
  if (channels === undefined) throw new Error(`${label}: unsupported PNG color type ${colorType}`)
  if (colorType === 3) {
    if (![1, 2, 4, 8].includes(bitDepth)) throw new Error(`${label}: unsupported indexed bit depth ${bitDepth}`)
    if (!plte) throw new Error(`${label}: indexed PNG missing PLTE`)
  } else if (colorType === 0) {
    if (![1, 2, 4, 8, 16].includes(bitDepth)) {
      throw new Error(`${label}: unsupported PNG bit depth ${bitDepth} for color type ${colorType}`)
    }
  } else if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`${label}: unsupported PNG bit depth ${bitDepth} for color type ${colorType}`)
  }

  const raw = inflateSync(Buffer.concat(idat))
  const bitsPerPixel = channels * bitDepth
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const scanlines = new Uint8Array(height * stride)

  for (let y = 0; y < height; y++) {
    const srcRow = y * (stride + 1)
    const filter = raw[srcRow]!
    const dstRow = y * stride
    if (filter === 0) {
      scanlines.set(raw.subarray(srcRow + 1, srcRow + 1 + stride), dstRow)
    } else if (filter === 1) {
      for (let x = 0; x < bpp; x++) scanlines[dstRow + x] = raw[srcRow + 1 + x]!
      for (let x = bpp; x < stride; x++) {
        scanlines[dstRow + x] = (raw[srcRow + 1 + x]! + scanlines[dstRow + x - bpp]!) & 0xff
      }
    } else if (filter === 2) {
      if (y === 0) {
        scanlines.set(raw.subarray(srcRow + 1, srcRow + 1 + stride), dstRow)
      } else {
        const prevRow = dstRow - stride
        for (let x = 0; x < stride; x++) {
          scanlines[dstRow + x] = (raw[srcRow + 1 + x]! + scanlines[prevRow + x]!) & 0xff
        }
      }
    } else if (filter === 3) {
      const prevRow = dstRow - stride
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? scanlines[dstRow + x - bpp]! : 0
        const b = y > 0 ? scanlines[prevRow + x]! : 0
        scanlines[dstRow + x] = (raw[srcRow + 1 + x]! + ((a + b) >> 1)) & 0xff
      }
    } else if (filter === 4) {
      const prevRow = dstRow - stride
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? scanlines[dstRow + x - bpp]! : 0
        const b = y > 0 ? scanlines[prevRow + x]! : 0
        const c = x >= bpp && y > 0 ? scanlines[prevRow + x - bpp]! : 0
        scanlines[dstRow + x] = (raw[srcRow + 1 + x]! + paethPredictor(a, b, c)) & 0xff
      }
    } else {
      throw new Error(`${label}: unsupported PNG filter ${filter}`)
    }
  }

  if (colorType === 6 && bitDepth === 8) {
    return { width, height, rgba: scanlines }
  }
  if (colorType === 2 && bitDepth === 8) {
    const rgba = new Uint8Array(width * height * 4)
    const pixels = width * height
    for (let p = 0, s = 0, d = 0; p < pixels; p++, s += 3, d += 4) {
      rgba[d] = scanlines[s]!
      rgba[d + 1] = scanlines[s + 1]!
      rgba[d + 2] = scanlines[s + 2]!
      rgba[d + 3] = 255
    }
    return { width, height, rgba }
  }

  const rgba = new Uint8Array(width * height * 4)
  const sampleShift = bitDepth === 16 ? 2 : 1
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4
      if (colorType === 6) {
        const src = rowStart + x * 4 * sampleShift
        rgba[dst] = scanlines[src]!
        rgba[dst + 1] = scanlines[src + sampleShift]!
        rgba[dst + 2] = scanlines[src + 2 * sampleShift]!
        rgba[dst + 3] = scanlines[src + 3 * sampleShift]!
      } else if (colorType === 2) {
        const src = rowStart + x * 3 * sampleShift
        rgba[dst] = scanlines[src]!
        rgba[dst + 1] = scanlines[src + sampleShift]!
        rgba[dst + 2] = scanlines[src + 2 * sampleShift]!
        rgba[dst + 3] = 255
      } else if (colorType === 0) {
        let g: number
        if (bitDepth === 8) {
          g = scanlines[rowStart + x]!
        } else if (bitDepth === 16) {
          g = scanlines[rowStart + x * 2]!
        } else {
          const pixelsPerByte = 8 / bitDepth
          const byte = scanlines[rowStart + Math.floor(x / pixelsPerByte)]!
          const shift = 8 - bitDepth * ((x % pixelsPerByte) + 1)
          const rawVal = (byte >>> shift) & ((1 << bitDepth) - 1)
          g = Math.round((rawVal * 255) / ((1 << bitDepth) - 1))
        }
        rgba[dst] = g
        rgba[dst + 1] = g
        rgba[dst + 2] = g
        rgba[dst + 3] = 255
      } else if (colorType === 4) {
        const src = rowStart + x * 2 * sampleShift
        const g = scanlines[src]!
        rgba[dst] = g
        rgba[dst + 1] = g
        rgba[dst + 2] = g
        rgba[dst + 3] = scanlines[src + sampleShift]!
      } else {
        // Indexed palette (colorType === 3)
        let idx: number
        if (bitDepth === 8) {
          idx = scanlines[rowStart + x]!
        } else {
          const pixelsPerByte = 8 / bitDepth
          const byte = scanlines[rowStart + Math.floor(x / pixelsPerByte)]!
          const shift = 8 - bitDepth * ((x % pixelsPerByte) + 1)
          idx = (byte >>> shift) & ((1 << bitDepth) - 1)
        }
        const p = idx * 3
        rgba[dst] = plte![p] ?? 0
        rgba[dst + 1] = plte![p + 1] ?? 0
        rgba[dst + 2] = plte![p + 2] ?? 0
        rgba[dst + 3] = trns && idx < trns.length ? trns[idx]! : 255
      }
    }
  }
  return { width, height, rgba }
}

/** Encode an 8-bit RGBA image as a non-interlaced PNG with None filtering and fast deflate. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.allocUnsafe(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const dstRow = y * (stride + 1)
    const srcRow = y * stride
    raw[dstRow] = 0 // None filter (fast memcpy, compresses cleanly on flat terminal crops)
    raw.set(rgba.subarray(srcRow, srcRow + stride), dstRow + 1)
  }
  const compressed = deflateSync(raw, { level: 3 })
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

export interface CachedCroppedPng {
  readonly sha256: string
  readonly width: number
  readonly height: number
  readonly blobPath: string
}

const CROP_CACHE_VERSION = "png-rgba-f0-z3-v2"
const CROP_CACHE_BASE = process.env.TERMINFO_CROP_CACHE_DIR ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")
const CROP_CACHE_ROOT = join(CROP_CACHE_BASE || tmpdir(), `terminfo-crop-cache-${CROP_CACHE_VERSION}`)
const CROP_META_DIR = join(CROP_CACHE_ROOT, "meta")
const CROP_BLOB_DIR = join(CROP_CACHE_ROOT, "blobs")
let cropCacheDirsReady = false

function ensureCropCacheDirs(): void {
  if (cropCacheDirsReady) return
  mkdirSync(CROP_META_DIR, { recursive: true })
  mkdirSync(CROP_BLOB_DIR, { recursive: true })
  cropCacheDirsReady = true
}

function atomicWrite(targetPath: string, content: string | Buffer): void {
  const tmpPath = `${targetPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  writeFileSync(tmpPath, content)
  renameSync(tmpPath, targetPath)
}

/**
 * Deterministic content-addressed disk cache for cropped terminal PNGs.
 * Keyed by source artifact SHA-256 + crop parameters + codec version so repeated site/API/test passes
 * never re-decode thousands of screenshots or retain raw PNG Buffers in heap memory.
 */
export function cachedCropPng(cacheSpec: string, compute: () => CroppedPng): CachedCroppedPng {
  ensureCropCacheDirs()
  const key = createHash("sha256").update(`${CROP_CACHE_VERSION}\0${cacheSpec}`).digest("hex")
  const metaPath = join(CROP_META_DIR, `${key}.json`)
  if (existsSync(metaPath)) {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as {
      sha256?: unknown
      width?: unknown
      height?: unknown
    }
    if (
      typeof parsed.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(parsed.sha256) &&
      typeof parsed.width === "number" &&
      typeof parsed.height === "number"
    ) {
      const blobPath = join(CROP_BLOB_DIR, `${parsed.sha256}.png`)
      if (existsSync(blobPath)) {
        return { sha256: parsed.sha256, width: parsed.width, height: parsed.height, blobPath }
      }
    }
  }
  const cropped = compute()
  const blobPath = join(CROP_BLOB_DIR, `${cropped.sha256}.png`)
  if (!existsSync(blobPath)) {
    atomicWrite(blobPath, cropped.png)
  }
  atomicWrite(metaPath, JSON.stringify({ sha256: cropped.sha256, width: cropped.width, height: cropped.height }))
  return { sha256: cropped.sha256, width: cropped.width, height: cropped.height, blobPath }
}

/** Compute the exact calibrated terminal cell grid rectangle, clamped strictly inside the image. */
export function terminalGridRect(cellCrop: CellGridCrop, imageWidth: number, imageHeight: number): Rect {
  const x = Math.max(0, Math.min(imageWidth, Math.round(cellCrop.origin.x)))
  const y = Math.max(0, Math.min(imageHeight, Math.round(cellCrop.origin.y)))
  const right = Math.max(
    x,
    Math.min(imageWidth, Math.round(cellCrop.origin.x + cellCrop.grid.columns * cellCrop.cell.width)),
  )
  const bottom = Math.max(
    y,
    Math.min(imageHeight, Math.round(cellCrop.origin.y + cellCrop.grid.rows * cellCrop.cell.height)),
  )
  return { x, y, width: right - x, height: bottom - y }
}

/** Clamp a rectangle strictly inside `bounds` (the calibrated terminal cell grid, never window chrome or desktop). */
export function clampRectToBounds(rect: Rect, bounds: Rect): Rect {
  const x = Math.max(bounds.x, Math.min(bounds.x + bounds.width, Math.round(rect.x)))
  const y = Math.max(bounds.y, Math.min(bounds.y + bounds.height, Math.round(rect.y)))
  const right = Math.max(x, Math.min(bounds.x + bounds.width, Math.round(rect.x + rect.width)))
  const bottom = Math.max(y, Math.min(bounds.y + bounds.height, Math.round(rect.y + rect.height)))
  return { x, y, width: right - x, height: bottom - y }
}

/** Crop `decoded` to `rect` and encode as a compact RGBA PNG. Throws loudly if the rectangle is empty. */
export function cropDecodedPng(decoded: DecodedPng, rect: Rect, label = "crop"): CroppedPng {
  const clamped = clampRectToBounds(rect, { x: 0, y: 0, width: decoded.width, height: decoded.height })
  if (clamped.width <= 0 || clamped.height <= 0) {
    throw new Error(`${label}: empty crop rectangle ${JSON.stringify(rect)} in ${decoded.width}x${decoded.height}`)
  }
  const out = new Uint8Array(clamped.width * clamped.height * 4)
  for (let row = 0; row < clamped.height; row++) {
    const srcOffset = ((clamped.y + row) * decoded.width + clamped.x) * 4
    const dstOffset = row * clamped.width * 4
    out.set(decoded.rgba.subarray(srcOffset, srcOffset + clamped.width * 4), dstOffset)
  }
  const png = encodeRgbaPng(clamped.width, clamped.height, out)
  const sha256 = createHash("sha256").update(png).digest("hex")
  return { png, width: clamped.width, height: clamped.height, sha256, rect: clamped }
}

/**
 * Crop the read cells from a decoded capture, adding `padPx` breathing room clamped STRICTLY inside
 * the calibrated terminal cell grid so no window title bar, tab bar, or desktop pixel can leak.
 */
export function cropReadCellsFromDecoded(
  decoded: DecodedPng,
  regionRectangle: Rect,
  cellCrop: CellGridCrop,
  padPx = 0,
  label = "read-cells",
): CroppedPng {
  const grid = terminalGridRect(cellCrop, decoded.width, decoded.height)
  if (grid.width <= 0 || grid.height <= 0) {
    throw new Error(`${label}: calibrated terminal grid is empty in ${decoded.width}x${decoded.height}`)
  }
  const padded: Rect = {
    x: regionRectangle.x - padPx,
    y: regionRectangle.y - padPx,
    width: regionRectangle.width + padPx * 2,
    height: regionRectangle.height + padPx * 2,
  }
  return cropDecodedPng(decoded, clampRectToBounds(padded, grid), label)
}

/** Crop the whole terminal cell grid (never window title bar, chrome, or desktop) for the "Full screenshot" view. */
export function cropTerminalGridFromDecoded(
  decoded: DecodedPng,
  cellCrop: CellGridCrop,
  label = "terminal-grid",
): CroppedPng {
  const grid = terminalGridRect(cellCrop, decoded.width, decoded.height)
  return cropDecodedPng(decoded, grid, label)
}

/** Describe a pixel rectangle in 1-based terminal cell coordinates, e.g. "row 3, column 3" or "rows 3–4, columns 3–33". */
export function describeCellRegion(regionRectangle: Rect, cellCrop: CellGridCrop): string {
  const startRow = Math.max(1, Math.round((regionRectangle.y - cellCrop.origin.y) / cellCrop.cell.height) + 1)
  const startCol = Math.max(1, Math.round((regionRectangle.x - cellCrop.origin.x) / cellCrop.cell.width) + 1)
  const rowSpan = Math.max(1, Math.round(regionRectangle.height / cellCrop.cell.height))
  const colSpan = Math.max(1, Math.round(regionRectangle.width / cellCrop.cell.width))
  const rowPart = rowSpan === 1 ? `row ${startRow}` : `rows ${startRow}–${startRow + rowSpan - 1}`
  const colPart = colSpan === 1 ? `column ${startCol}` : `from column ${startCol}`
  return `${rowPart}, ${colPart}`
}
