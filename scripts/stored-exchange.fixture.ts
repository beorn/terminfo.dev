/**
 * #37341: a decided live result stores the exchange its evidence sentence is worded from (docs/data/evidence-messages.ts),
 * and the trace build refuses a decided result with no stored record. A fixture result whose test is not about evidence
 * stores this exchange: one query the terminal did not answer, though it answered the device check sent after it (its
 * read window holds that DA1 reply, as the run parser requires of a query_reply record). It carries no matched reply,
 * because a reply must fit a shape its feature declares (REPLY_SHAPES), and synthetic feature ids declare none.
 */
export const UNANSWERED_QUERY = JSON.stringify({
  queries: [{ sequence: "\u001b[5n\u001b[c", reason: "sentinel", sentinel: { graceMs: 250 }, raw: "\u001b[?62c" }],
})
