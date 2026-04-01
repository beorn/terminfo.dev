/**
 * probes types -- terminal capability probing via vitest.
 */

export type SupportLevel = "yes" | "no" | "partial" | "unknown"

export interface ProbeResult {
  support: SupportLevel
  notes?: string
}

export interface BackendInfo {
  name: string
  version: string
  engine: string
}

export interface probesFeature {
  id: string
  name: string
  category: string
  spec?: string
  results: Record<string, ProbeResult>
}

export interface probesDatabase {
  generated: string
  termlessVersion: string
  backends: Record<string, BackendInfo>
  features: probesFeature[]
}

/**
 * Throw this in a probes probe to indicate partial support.
 * The reporter interprets it as "partial" rather than "no".
 *
 * @example
 * ```typescript
 * if (cell.underline && cell.underline !== "curly") {
 *   throw new PartialSupport("underline yes, curly variant no")
 * }
 * ```
 */
export class PartialSupport extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PartialSupport"
  }
}
