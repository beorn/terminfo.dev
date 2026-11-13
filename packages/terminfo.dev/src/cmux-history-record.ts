/**
 * The cmux history arm's evidence, as the persisted run records it (@dev/1 peer read 2026-11-13).
 *
 * The arm keeps its proof on the owner, but a record that never carries it loses which surface it
 * acquired and the read that happened. The record is built through the same path-free identity as
 * every other owned history read (@cto 70be39c7): the executable by basename, never the host path, and
 * the grant proof stays out of the record entirely — the grant's outcome is recorded as a status.
 */
import type { OwnedTerminal } from "./owned-terminal.ts"
import { ownedHistoryReceipt } from "./owned-history-receipt.ts"

export type CmuxHistoryEvidence = Record<"collector.cmuxHistory", string>

export function cmuxHistoryEvidence(history: OwnedTerminal["cmuxHistory"]): CmuxHistoryEvidence | undefined {
  if (history === undefined) return undefined
  const identity = ownedHistoryReceipt({
    surface: "cmux",
    pane: history.surface ?? undefined,
    executable: history.executable,
  })
  // A record that cannot be reduced to the path-free identity is not published: the run fails loudly
  // instead of writing a host path into the corpus (@cto 70be39c7).
  if (identity.status === "refused") throw new Error(identity.reason)
  return {
    "collector.cmuxHistory": JSON.stringify({
      ...(JSON.parse(identity.receipt) as Record<string, unknown>),
      grant: history.grant,
      lastRead: history.lastRead,
    }),
  }
}
