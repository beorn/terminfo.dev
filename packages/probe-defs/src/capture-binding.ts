/**
 * #30932 S1 (@cto PROCEED 2026-11-17 12:20): which capture installation one recorded row was handed.
 *
 * A row's call log already carries the geometry its callback read. What it cannot say is which
 * installation that geometry came from: the run's first calibration, or a renewal after a row wrote
 * RIS. This record is that association, stored beside the call log under `<featureId>.captureBinding`.
 * It is evidence, never an override: a reader checks it against the recorded installation and the
 * recorded callback context, and a mismatch is an incomplete replay rather than a substituted value.
 *
 * Its own format and version are separate from the viprobe call-log format (still version 1) and the
 * run schema (still 4); a run without it stays readable by every reader that ignores it.
 */
import type { TermProbeSource } from "./types.ts"

export const CAPTURE_BINDING_FORMAT = "terminfo.capture-binding"
export const CAPTURE_BINDING_VERSION = 1
/** The raw-reply key suffix: `<featureId>.captureBinding`, beside `<featureId>.callLog`. */
export const CAPTURE_BINDING_SUFFIX = ".captureBinding"

type InstalledGeometry = NonNullable<TermProbeSource["captureGeometry"]>

export type CaptureBinding =
  | {
      format: typeof CAPTURE_BINDING_FORMAT
      version: typeof CAPTURE_BINDING_VERSION
      /** The raw-reply id of the installation's own paint log: `collector.captureCalibration` or `…renewal.N`. */
      calibrationId: string
      /** The row's position in the run's selected order: a reader places it between installations. */
      rowIndex: number
      outcome: "installed"
      /** Exactly the context the callback was handed, measured raster geometry and sentinel included. */
      captureGeometry: InstalledGeometry
    }
  | {
      format: typeof CAPTURE_BINDING_FORMAT
      version: typeof CAPTURE_BINDING_VERSION
      calibrationId: string
      rowIndex: number
      outcome: "refused"
      refusal: string
    }

/** The association for a row handed `source`, or undefined when no installation reached it. */
export function captureBinding(
  calibrationId: string,
  rowIndex: number,
  source: Pick<TermProbeSource, "captureGeometry" | "captureGeometryRefusal">,
): CaptureBinding | undefined {
  const base = { format: CAPTURE_BINDING_FORMAT, version: CAPTURE_BINDING_VERSION, calibrationId, rowIndex } as const
  if (source.captureGeometry) {
    // Plain recorded data: a JSON copy keeps the binding independent of the live context object.
    const captureGeometry = JSON.parse(JSON.stringify(source.captureGeometry)) as InstalledGeometry
    return { ...base, outcome: "installed", captureGeometry }
  }
  if (source.captureGeometryRefusal !== undefined) {
    return { ...base, outcome: "refused", refusal: source.captureGeometryRefusal }
  }
  return undefined
}

/** Why a stored association cannot be used; the reader turns it into a named incomplete replay. */
export class CaptureBindingMalformed extends Error {
  constructor(readonly field: string) {
    super(`capture binding malformed: ${field}`)
    this.name = "CaptureBindingMalformed"
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/** Validates one parsed association. Every field is checked by name; nothing is defaulted. */
export function parseCaptureBinding(value: unknown): CaptureBinding {
  if (!object(value)) throw new CaptureBindingMalformed("record")
  if (value.format !== CAPTURE_BINDING_FORMAT) throw new CaptureBindingMalformed("format")
  if (value.version !== CAPTURE_BINDING_VERSION) throw new CaptureBindingMalformed("version")
  const { calibrationId } = value
  if (
    typeof calibrationId !== "string" ||
    !/^collector\.captureCalibration(\.renewal\.[1-9][0-9]*)?$/.test(calibrationId)
  ) {
    throw new CaptureBindingMalformed("calibrationId")
  }
  if (!Number.isSafeInteger(value.rowIndex) || (value.rowIndex as number) < 0) {
    throw new CaptureBindingMalformed("rowIndex")
  }
  if (value.outcome === "refused") {
    if (Object.keys(value).sort().join(",") !== "calibrationId,format,outcome,refusal,rowIndex,version") {
      throw new CaptureBindingMalformed("fields")
    }
    if (typeof value.refusal !== "string" || !value.refusal) throw new CaptureBindingMalformed("refusal")
    return value as CaptureBinding
  }
  if (value.outcome !== "installed") throw new CaptureBindingMalformed("outcome")
  if (Object.keys(value).sort().join(",") !== "calibrationId,captureGeometry,format,outcome,rowIndex,version") {
    throw new CaptureBindingMalformed("fields")
  }
  const installed = value.captureGeometry
  if (!object(installed) || installed.source !== "measured by complete raster calibration") {
    throw new CaptureBindingMalformed("captureGeometry.source")
  }
  const geometry = installed.geometry
  if (
    !object(geometry) ||
    !positive(geometry.cellWidth) ||
    !positive(geometry.cellHeight) ||
    !positive(geometry.textWidth) ||
    !positive(geometry.textHeight)
  ) {
    throw new CaptureBindingMalformed("captureGeometry.geometry")
  }
  return value as CaptureBinding
}
