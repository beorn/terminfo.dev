/**
 * The cmux history arm's evidence, as the persisted run records it (@dev/1 peer read 2026-11-13).
 *
 * The arm keeps its proof on the owner, but a record that never carries it loses which surface it
 * acquired and the read that happened. The record is built through the same path-free identity as
 * every other owned history read (@cto 70be39c7): the executable by basename, never the host path.
 * Nothing the cmux CLI printed is published: the grant is a status plus its refusal code, and the last
 * read is reduced to counts, because both receipts carry the pane transcript (@cto REVISE 2026-11-13).
 */
import type { OwnedTerminal } from "./owned-terminal.ts"
import { ownedHistoryReceipt } from "./owned-history-receipt.ts"

const pathFree = /^[^\\/]*$/u

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
  const record = JSON.stringify({
    ...(JSON.parse(identity.receipt) as Record<string, unknown>),
    grant: history.grant,
    ...(history.grantRefusal === null ? {} : { grantRefusal: history.grantRefusal }),
    lastRead: history.lastRead,
  })
  // The fields above are each reduced by construction; this is the fence on the whole record, so a value
  // nobody anticipated cannot carry a path into the corpus (@cto REVISE 2026-11-13).
  if (!pathFree.test(record)) {
    throw new Error("the cmux history record still carries a host path separator, so it is not publishable")
  }
  return { "collector.cmuxHistory": record }
}
