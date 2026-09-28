export type { ProbeDefinition, ProbeResult, TermlessContext, TermContext, TerminalQueryOutcome } from "./types.ts"
export { OBSERVATION_OUTCOMES, OBSERVATION_REASONS, OBSERVATION_EVIDENCE } from "./types.ts"
export type {
  ObservationOutcome,
  ObservationReason,
  ObservationEvidence,
  Observation,
  ObservationFrame,
  ProbeTarget,
  ProbeSuiteManifest,
  RunOrigin,
  AppLaunchReceipt,
  AppSourceArtifact,
  ProbeAssertion,
  UngradedDiagnostic,
  HeadlessRuntimeIdentity,
  ProbeRun,
  RunProvenance,
  Interpretation,
} from "./types.ts"
export {
  sgrProbe,
  cursorProbe,
  modeProbe,
  behavioralModeProbe,
  responseProbe,
  capabilityProbe,
  widthProbe,
  isBlank,
  probe,
} from "./helpers.ts"

import { sgrProbes } from "./sgr.ts"
import { cursorProbes } from "./cursor.ts"
import { textProbes } from "./text.ts"
import { eraseProbes } from "./erase.ts"
import { editingProbes } from "./editing.ts"
import { modesProbes } from "./modes.ts"
import { deviceProbes } from "./device.ts"
import { extensionsProbes } from "./extensions.ts"
import { inputProbes } from "./input.ts"
import { resetProbes } from "./reset.ts"
import { scrollbackProbes } from "./scrollback.ts"
import { charsetsProbes } from "./charsets.ts"
import { unicodeProbes } from "./unicode.ts"

export const ALL_PROBES = [
  // Extensions first; live OSC 52 probes refuse to touch an unowned clipboard.
  ...extensionsProbes,
  ...sgrProbes,
  ...cursorProbes,
  ...textProbes,
  ...eraseProbes,
  ...editingProbes,
  ...modesProbes,
  ...deviceProbes,
  ...inputProbes,
  ...resetProbes,
  ...scrollbackProbes,
  ...charsetsProbes,
  ...unicodeProbes,
]

export {
  sgrProbes,
  cursorProbes,
  textProbes,
  eraseProbes,
  editingProbes,
  modesProbes,
  deviceProbes,
  extensionsProbes,
  inputProbes,
  resetProbes,
  scrollbackProbes,
  charsetsProbes,
  unicodeProbes,
}
