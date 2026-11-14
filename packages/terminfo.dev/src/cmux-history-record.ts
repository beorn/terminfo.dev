/**
 * The cmux history arm's evidence, as the persisted run records it (@dev/1 peer read 2026-11-13).
 *
 * The arm keeps its proof on the owner, but a record that never carries it loses the grant receipt,
 * the surface it acquired and the last read. Serializing here evaluates the live `lastRead` getter,
 * so a record built after the probes carries the read that happened rather than the grant.
 */
import type { OwnedTerminal } from "./owned-terminal.ts"

export type CmuxHistoryEvidence = Record<"collector.cmuxHistory", string>

export function cmuxHistoryEvidence(history: OwnedTerminal["cmuxHistory"]): CmuxHistoryEvidence | undefined {
  return history === undefined
    ? undefined
    : {
        "collector.cmuxHistory": JSON.stringify({
          ...history,
          nativeEditorFields: {
            status: "inapplicable",
            reason:
              "cmux has no VSCode Terminal API for name, processId or shellIntegration.cwd; native evidence is its owned surface and raw read-screen response",
          },
        }),
      }
}
