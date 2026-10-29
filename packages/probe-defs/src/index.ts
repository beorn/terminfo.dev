export type {
  HostInputName,
  HostRecipeName,
  HostRecipeExpectation,
  CallbackHostRecipeCause,
  RetainedHostRecipeCause,
  ProbeDefinition,
  ProbeCallbackResult,
  MeasuredProbeCallbackResult,
  ExecutionOnlyProbeCallbackResult,
  ProbeSourceKind,
  NoSemanticObservable,
  LibProbeSource,
  TermProbeSource,
  TerminalQueryOutcome,
  ClipboardFixture,
  InputFixture,
  Utf8Decoding,
  Utf8DecodingReading,
  CaptureCells,
  CapturePixelGeometry,
  CaptureRectangle,
  CaptureRequest,
} from "./types.ts"
export { OBSERVATION_OUTCOMES, OBSERVATION_REASONS, ASSERTION_TYPES, HOST_INPUT_NAMES, frameDigests } from "./types.ts"
export type {
  ObservationOutcome,
  ObservationReason,
  AssertionType,
  Observation,
  ConsoleBufferOwner,
  ObservationFrame,
  TextCellsObservationFrame,
  TextQualification,
  TextQualificationShape,
  TextQualificationSpec,
  ProbeSubject,
  ProbeSuiteManifest,
  RunOrigin,
  AppLaunchReceipt,
  WindowsMesaRendererReceipt,
  WindowsMesaRendererDllReceipt,
  AppSourceArtifact,
  DerivedSourceTreeArtifact,
  ProbeAssertion,
  UngradedDiagnostic,
  NotTestedCoverage,
  HeadlessRuntimeIdentity,
  ProbeRun,
  HistoricalProbeRun,
  CapturedRunDraft,
  OuterAppProof,
  MuxAttachmentProof,
  LinuxMuxAttachmentProof,
  DarwinMuxAttachmentProof,
  RunProvenance,
  Interpretation,
} from "./types.ts"
export {
  SOURCE_NEGATIVE_REVIEW,
  REPLY_PATH_AUDIT_REVIEW,
  HARNESS_INCOMPLETE_TEST,
  sgrProbe,
  cursorProbe,
  decrpmModeProbe,
  decrpmPs,
  decrpmReading,
  decrpmReplyPattern,
  decrpmResult,
  decrpmStatus,
  headlessDecrpmArm,
  queryDecrpm,
  isBlank,
  readHyperlinkMetadata,
  readSentinelReply,
  probe,
  sentinelAnswer,
  sentinelGraceMs,
  utf8DecodingRefusal,
  type SentinelRead,
} from "./helpers.ts"
export {
  beginCaptureLifecycle,
  endCaptureLifecycle,
  captureRegionReadbackDecision,
  captureRegionVerdict,
  collectorRegionRead,
  queryPixelGeometry,
  DEFAULT_TIMEOUT_MS,
  type CellRegion,
  type PixelGeometrySource,
  type PixelGeometry,
  type PixelGeometryQuerySource,
  type PixelGeometryRefusal,
  type RegionCapture,
  type RegionRead,
  type RegionReadback,
} from "./region-readback.ts"

// The kind tables, so a real-backend test (packages/probes) can run every kind row's parser arm
// against a terminal that actually implements the sequences (@cto 28450 must-fix 1, 2026-10-12).
// The list is COMPLETE, and `region-readback-xterm.test.ts` fails when a table declared under src/
// is not exported here: a family this list drops is invisible to that test, which is how must-fix 1's
// protection skipped four charsets rows (@cto 28450 census check, 2026-10-12).
export { regionReadbackProbes, type RegionReadbackRow } from "./region-readback-kind.ts"
export { charsetReadbackRows } from "./charsets.ts"
export { editingReadbackRows } from "./editing.ts"
export { eraseReadbackRows } from "./erase.ts"
export { modesReadbackRows } from "./modes.ts"
export { textReadbackRows } from "./text.ts"
export { scrollbackReadbackRows } from "./scrollback.ts"

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

export { splitDecidableBasis } from "./decidable-basis.ts"
export type { DecidableBasis } from "./decidable-basis.ts"
export { ENVIRONMENT_GROUP_IDS, gradedFeatureIds, isEnvironmentGroup } from "./environment-groups.ts"
export type { EnvironmentGroupId } from "./environment-groups.ts"

export { APP_UNOBSERVABLE_ROWS, appUnobservableIds, splitAppObservable } from "./app-unobservable.ts"
export type { AppObservableSplit, AppUnobservableRow } from "./app-unobservable.ts"

export { TEXT_QUALIFICATION_SPEC, TEXT_QUALIFICATION_SHAPES, textQualificationFixtures } from "./text-qualification.ts"

export { PROBE_STATUSES } from "./types.ts"
export type {
  ProbeStatus,
  ProbeAttempt,
  ProbeResult,
  ProbeTestResult,
  ProbeTestInput,
  RunDraft,
  CurrentProbeRun,
  CaptureDecision,
  HistoricalInterpretation,
} from "./types.ts"
export { initializeRunDraft, finalizeProbeResult, sealRunDraft } from "./helpers.ts"

export { recordExecutedProbe, recordCollectionFailure } from "./helpers.ts"

export { assessTextQualification, type TextQualificationAssessment } from "./text-qualification.ts"
