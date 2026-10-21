/**
 * @failure Live and headless read the F1 DA1 sentinel with different rules, so one collector calls a reply what the other calls a measured negative.
 * @level l1
 * @consumer The live collector's onData (terminfo.dev tty.ts) and the headless sentinel member (#30554, @cto verdict 452bc032 condition 3).
 * @reach Calls the one shared classification function directly on whole buffers.
 * @testonly none
 */
import { expect, test } from "vitest"
import { readSentinelReply } from "./helpers.ts"

const CPR = /\x1b\[(\d+);(\d+)R/
const DA1 = "\x1b[?1;2c"

test.each([
  { name: "nothing yet", buffer: "", kind: "pending", match: null },
  { name: "a reply with no DA1 answer yet", buffer: "\x1b[3;7R", kind: "pending", match: ["\x1b[3;7R", "3", "7"] },
  { name: "a reply ahead of the DA1 answer", buffer: `\x1b[3;7R${DA1}`, kind: "reply", match: ["\x1b[3;7R", "3", "7"] },
  { name: "the DA1 answer alone", buffer: DA1, kind: "answered", match: null },
  { name: "a reply after the DA1 answer", buffer: `${DA1}\x1b[3;7R`, kind: "answered", match: ["\x1b[3;7R", "3", "7"] },
  { name: "bytes after the DA1 answer that are no reply", buffer: `${DA1}\x1b[3;`, kind: "answered", match: null },
  { name: "a reply split across two captures", buffer: ["\x1b[3;", `7R${DA1}`].join(""), kind: "reply", match: ["\x1b[3;7R", "3", "7"] },
  { name: "a DA2 answer, which is not DA1", buffer: "\x1b[>1;10;0c", kind: "pending", match: null },
  { name: "a parameterless DA1 answer, as live reads it", buffer: "\x1b[?c", kind: "pending", match: null },
])("$name", ({ buffer, kind, match }) => {
  expect(readSentinelReply(buffer, CPR)).toEqual({ kind, match })
})

test("a reply frame found before the DA1 answer wins even when a second frame follows it", () => {
  expect(readSentinelReply(`\x1b[1;1R${DA1}\x1b[2;2R`, CPR)).toEqual({ kind: "reply", match: ["\x1b[1;1R", "1", "1"] })
})
