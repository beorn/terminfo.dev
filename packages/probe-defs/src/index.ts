export type {
  ProbeDefinition,
  ProbeResult,
  NoSemanticObservable,
  TermlessContext,
  TermContext,
  TerminalQueryOutcome,
  ClipboardFixture,
} from "./types.ts"
export {
  OBSERVATION_OUTCOMES,
  OBSERVATION_REASONS,
  OBSERVATION_EVIDENCE,
  NON_MEASURING_EVIDENCE,
  isNonMeasuringEvidence,
} from "./types.ts"
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
  NotTestedCoverage,
  HeadlessRuntimeIdentity,
  ProbeRun,
  RunProvenance,
  Interpretation,
} from "./types.ts"
export {
  sgrProbe,
  cursorProbe,
  decrpmModeProbe,
  responseProbe,
  capabilityProbe,
  widthProbe,
  isBlank,
  readHyperlinkMetadata,
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

const clipboardProbes = extensionsProbes.filter((probe) => probe.id.startsWith("extensions.osc52-"))

export const ALL_PROBES = [
  // Clipboard probes run after all pixel checkpoints, including when an owned fixture is installed.
  ...extensionsProbes.filter((probe) => !probe.id.startsWith("extensions.osc52-")),
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
  ...clipboardProbes,
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
