/**
 * @failure Live and headless read the F1 DA1 sentinel with different rules, so one collector calls a reply what the other calls a measured negative, or a grader takes a DA1-shaped reply for the sentinel's answer and publishes a negative over it.
 * @level l1
 * @consumer The live collector's onData (terminfo.dev tty.ts), the headless sentinel member (#30554, @cto verdict 452bc032 condition 3) and every grader's sentinel negative (#30559, @cto verdict 86260f80).
 * @reach Calls the shared classification and negative functions directly on whole buffers.
 * @testonly none
 */
import { expect, test } from "vitest"
import { readSentinelReply, sentinelNegativeResult } from "./helpers.ts"

const CPR = /\x1b\[(\d+);(\d+)R/
const DA1 = "\x1b[?1;2c"

test.each([
  { name: "nothing yet", buffer: "", kind: "pending", match: null },
  { name: "a reply with no DA1 answer yet", buffer: "\x1b[3;7R", kind: "pending", match: ["\x1b[3;7R", "3", "7"] },
  { name: "a reply ahead of the DA1 answer", buffer: `\x1b[3;7R${DA1}`, kind: "reply", match: ["\x1b[3;7R", "3", "7"] },
  { name: "the DA1 answer alone", buffer: DA1, kind: "answered", match: null },
  { name: "a reply after the DA1 answer", buffer: `${DA1}\x1b[3;7R`, kind: "answered", match: ["\x1b[3;7R", "3", "7"] },
  { name: "bytes after the DA1 answer that are no reply", buffer: `${DA1}\x1b[3;`, kind: "answered", match: null },
  {
    name: "unmatched bytes, then DA1",
    buffer: `\x1b]11;rgb:0000/0000/0000\x1b\\${DA1}`,
    kind: "unmatched",
    match: null,
  },
  { name: "a partial frame, then DA1", buffer: `\x1b[3;${DA1}`, kind: "unmatched", match: null },
  {
    name: "unmatched bytes, DA1, then a reply",
    buffer: `x${DA1}\x1b[3;7R`,
    kind: "unmatched",
    match: ["\x1b[3;7R", "3", "7"],
  },
  {
    name: "a reply split across two captures",
    buffer: ["\x1b[3;", `7R${DA1}`].join(""),
    kind: "reply",
    match: ["\x1b[3;7R", "3", "7"],
  },
  { name: "a DA2 answer, which is not DA1", buffer: "\x1b[>1;10;0c", kind: "pending", match: null },
  { name: "a parameterless DA1 answer, as live reads it", buffer: "\x1b[?c", kind: "pending", match: null },
  // #30559 (@cto 86260f80 rule 1): the sentinel's answer is the LAST DA1-shaped answer in the read, and every byte
  // before it is the query's reply, a DA1-shaped reply included.
  { name: "a DA1-shaped reply, then the DA1 answer", buffer: `${DA1}${DA1}`, kind: "unmatched", match: null },
  {
    name: "a reply between a DA1-shaped reply and the DA1 answer",
    buffer: `${DA1}\x1b[3;7R${DA1}`,
    kind: "reply",
    match: ["\x1b[3;7R", "3", "7"],
  },
  {
    name: "a DA1-shaped reply, the DA1 answer, then a reply",
    buffer: `${DA1}${DA1}\x1b[3;7R`,
    kind: "unmatched",
    match: ["\x1b[3;7R", "3", "7"],
  },
])("$name", ({ buffer, kind, match }) => {
  expect(readSentinelReply(buffer, CPR)).toEqual({ kind, match })
})

test("a reply frame found before the DA1 answer wins even when a second frame follows it", () => {
  expect(readSentinelReply(`\x1b[1;1R${DA1}\x1b[2;2R`, CPR)).toEqual({ kind: "reply", match: ["\x1b[1;1R", "1", "1"] })
})

test("a query whose reply is DA1-shaped reads that reply ahead of the DA1 answer", () => {
  expect(readSentinelReply(`\x1b[?62;4c${DA1}`, /\x1b\[\?([0-9;]+)c/)).toEqual({
    kind: "reply",
    match: ["\x1b[?62;4c", "62;4"],
  })
})

const FACTS = { atMs: 9, graceMs: 250 }

// #30559 (@cto 86260f80 rule 3): a read is silence only when nothing precedes the sentinel's own answer, the LAST
// DA1-shaped answer. Whitespace after it is tolerated, as before; nothing before it is.
test.each([
  { name: "the DA1 answer alone", raw: DA1, facts: FACTS, note: "negative by sentinel" },
  { name: "whitespace after the DA1 answer", raw: `${DA1}\r\n`, facts: FACTS, note: "negative by sentinel" },
  { name: "a DA1-shaped reply before the DA1 answer", raw: `${DA1}${DA1}`, facts: FACTS, note: null },
  { name: "whitespace before the DA1 answer", raw: ` ${DA1}`, facts: FACTS, note: null },
  { name: "bytes before the DA1 answer", raw: `x${DA1}`, facts: FACTS, note: null },
  { name: "a partial frame after the DA1 answer", raw: `${DA1}\x1b[3;`, facts: FACTS, note: null },
  { name: "no DA1 answer in the read", raw: "", facts: FACTS, note: null },
  { name: "no measured sentinel facts", raw: DA1, facts: undefined, note: null },
])("sentinel negative: $name", ({ raw, facts, note }) => {
  expect(sentinelNegativeResult(raw, facts, "complete reply")?.observation?.note ?? null).toBe(note)
})
