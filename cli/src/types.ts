/**
 * Shared types for the terminfo.dev CLI.
 */
import type { detectTerminal } from "./detect.ts"

export interface ProbeResults {
  terminal: ReturnType<typeof detectTerminal>
  results: Record<string, boolean>
  notes: Record<string, string>
  responses: Record<string, string>
  passed: number
  total: number
  probes: Array<{ id: string; name: string }>
}
