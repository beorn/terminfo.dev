export { evidenceRuntimeIdentity } from "./runtime-identity.ts"
export { sourceAnswerKey, parseSourceAnswerKey } from "./source-answers.ts"
export type { SourceAnswerSubject } from "./source-answers.ts"
export type {
  HostInputName,
  HostRecipeName,
  HostRecipeExpectation,
  CallbackHostRecipeCause,
  RetainedHostRecipeCause,
  ProbeDefinition,
  ProbeCallbackResult,
  PixelCellCrop,
  MeasuredProbeCallbackResult,
  ExecutionOnlyProbeCallbackResult,
  ProbeSourceKind,
  NoSemanticObservable,
  LibMouseEvent,
  LibKeyEvent,
  LibProbeSource,
  ModeState,
  TermProbeSource,
  TerminalScrollbackReading,
  TerminalScrollbackReset,
  TermFeaturesReading,
  AppSemanticReading,
  RenderedWidthResult,
  TerminalQueryOutcome,
  ClipboardFixture,
  PasteRoute,
  InputFixture,
  Utf8Decoding,
  Utf8DecodingReading,
  CaptureCells,
  CapturePixelGeometry,
  CaptureRectangle,
  CaptureRequest,
  CaptureLocated,
  CalibrationSentinel,
} from "./types.ts"
export {
  OBSERVATION_OUTCOMES,
  OBSERVATION_REASONS,
  ASSERTION_TYPES,
  HOST_INPUT_NAMES,
  SILENCE_RULES,
  frameDigests,
  type SilenceDeclaration,
  type SilenceRule,
} from "./types.ts"
export type {
  ObservationOutcome,
  ObservationReason,
  AssertionType,
  Observation,
  ConsoleBufferOwner,
  ObservationFrame,
  TextCellsObservationFrame,
  TextQualification,
  TextQualificationOwnership,
  TextQualificationShape,
  TextQualificationSpec,
  TextSnapshotDiagnostic,
  ProbeSubject,
  ProbeSuiteManifest,
  RunOrigin,
  AppLaunchReceipt,
  WindowsMesaRendererReceipt,
  WindowsMesaRendererDllReceipt,
  AppSourceArtifact,
  DerivedSourceTreeArtifact,
  ProbeAssertion,
  ProbeWitness,
  ColourSiblingSeparationWitness,
  ColourNoAttributeWitness,
  UngradedDiagnostic,
  NotTestedCoverage,
  HeadlessRuntimeIdentity,
  Run,
  HistoricalRun,
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
  SEMANTIC_PROMPT_SOURCE_REVIEW,
  REPLY_PATH_AUDIT_REVIEW,
  HARNESS_INCOMPLETE_TEST,
  HEADLESS_OBSERVABLE_REVIEW,
  UNTESTABLE_ONLY_REVIEW_BRANCHES,
  DECLARED_UNTESTABLE_TEST,
  FENCED_SILENCE,
  declaredUntestableResult,
  fencedSilenceResult,
  fencedSilenceStatus,
  isDeclaredUntestable,
  isFencedSilence,
  SOURCE_ONLY_NEGATIVE_REVIEW_BRANCHES,
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
  sweepCellWidth,
  cellWidthTransition,
  type CellWidthSweep,
  type CellWidthTransitionReads,
  isBlank,
  readHyperlinkMetadata,
  readSentinelReply,
  probe,
  sentinelAnswer,
  sentinelGraceMs,
  utf8DecodingRefusal,
  withReplyFailureEvidence,
  type SentinelRead,
} from "./helpers.ts"
export {
  beginCaptureLifecycle,
  endCaptureLifecycle,
  captureRegionReadbackDecision,
  captureRegionCallbackResult,
  collectorRegionRead,
  queryPixelGeometry,
  DEFAULT_TIMEOUT_MS,
  originFromSentinel,
  witnessCellFor,
  witnessCellsFor,
  sentinelBlockRefusal,
  cropPositionRefusal,
  gridMoveExemption,
  CELL_EDGE_TOLERANCE_PX,
  SENTINEL_BOX_SLACK_PX,
  sentinelBoxDeficit,
  sentinelFillClause,
  type GridMove,
  type ComparedCrop,
  type CellRegion,
  type PixelGeometrySource,
  type PixelGeometry,
  type PixelGeometryQuerySource,
  type PixelGeometryRefusal,
  type RegionCapture,
  type RegionRead,
  type RegionReadback,
} from "./region-readback.ts"
export {
  assertCalibratedCaptureGeometry,
  CALIBRATION_SOLID_PAINT,
  type CalibratedGeometrySource,
} from "./calibrated-capture-geometry.ts"

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
export { scrollbackReadbackRows, ScrollbackReadingUnavailable } from "./scrollback.ts"

import { sgrProbes } from "./sgr.ts"
import { cursorProbes } from "./cursor.ts"
import { textProbes } from "./text.ts"
import { eraseProbes } from "./erase.ts"
import { editingProbes } from "./editing.ts"
import { modesProbes } from "./modes.ts"
import { deviceProbes } from "./device.ts"
import { extensionsProbes, withD2LibraryObservation } from "./extensions.ts"
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
].map(withD2LibraryObservation)

/** Resolve execution inputs without changing the full catalogue or suite membership. */
export function resolveProbeIds(
  ids: readonly string[],
):
  | { result: "resolved" | "empty"; probes: import("./types.ts").ProbeDefinition[] }
  | { result: "invalid"; unknownIds: string[]; duplicateIds: string[] } {
  const known = new Set(ALL_PROBES.map((probe) => probe.id))
  const seen = new Set<string>()
  const unknownIds = new Set<string>()
  const duplicateIds = new Set<string>()
  for (const id of ids) {
    if (!known.has(id)) unknownIds.add(id)
    if (seen.has(id)) duplicateIds.add(id)
    seen.add(id)
  }
  if (unknownIds.size || duplicateIds.size) {
    return { result: "invalid", unknownIds: [...unknownIds], duplicateIds: [...duplicateIds] }
  }
  return { result: ids.length ? "resolved" : "empty", probes: ALL_PROBES.filter((probe) => seen.has(probe.id)) }
}

export { collectorIds } from "./helpers.ts"
export { finalizeVisualResult, fontLigatureMuxCoverage, MUX_FONT_LIGATURE_NO_OBSERVABLE } from "./sgr.ts"
export {
  colourSiblingSeparation,
  type ColourSiblingDecision,
  type OuterColourControl,
  type OuterColourRecord,
} from "./sgr-colour-capture.ts"

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

export {
  MUX_OUTER_DECRQ_UNREADABLE,
  MUX_OUTER_DECRQ_UNREADABLE_BRANCH,
  MUX_OUTER_NO_RECORD,
  MUX_OUTER_ROWS,
  MUX_OUTER_ROW_CONTROL_WRITE,
  MUX_TITLE_CONTROL_WRITE,
  muxOuterNoControlDefault,
  muxOuterRowGrade,
  muxTitleControlNonce,
  muxTitleControlWrite,
  withMuxOuterRows,
  withMuxOuterUnreadableRow,
  type MuxOuterRow,
} from "./mux-outer-rows.ts"

export { splitDecidableBasis } from "./decidable-basis.ts"
export type { DecidableBasis } from "./decidable-basis.ts"
export { ENVIRONMENT_GROUP_IDS, scoredFeatureIds, isEnvironmentGroup } from "./environment-groups.ts"
export type { EnvironmentGroupId } from "./environment-groups.ts"

export { TEXT_QUALIFICATION_SPEC, TEXT_QUALIFICATION_SHAPES, textQualificationFixtures } from "./text-qualification.ts"

export { PROBE_STATUSES, FEATURE_RESULT_STATUSES, HARNESS_OUTCOMES, isHarnessOutcome } from "./types.ts"
export type {
  ProbeStatus,
  FeatureResultStatus,
  ProbeAttempt,
  CollectorSelection,
  CollectorAttempt,
  ProbeResult,
  HarnessOutcome,
  ProbeTestResult,
  ProbeTestInput,
  RunDraft,
  CurrentRun,
  HistoricalInterpretation,
} from "./types.ts"
export { initializeRunDraft, finalizeProbeResult } from "./helpers.ts"

export {
  recordExecutedProbe,
  recordCollectionFailure,
  readCollectorSelection,
  readCollectorAttempt,
  recordCollectorSelection,
  recordCollectorAttempt,
  collectorAttemptDigest,
} from "./helpers.ts"

export {
  assessTextQualification,
  admitsTextObservation,
  textQualificationRecipeFor,
  textQualificationRecipeMatchesSubject,
  TEXT_QUALIFICATION_RECIPES,
  TEXT_QUALIFICATION_OWNERSHIP_CELL,
  type TextQualificationRecipe,
  type TextQualificationAssessment,
} from "./text-qualification.ts"
