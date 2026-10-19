/**
 * @failure Ambiguous duplicate JSON keys silently select evidence, or valid JSON whitespace is refused.
 * @level l0
 * @consumer Admission, site data loaders and every parseRun consumer.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { parseJsonStrict } from "./index.ts"

describe("strict JSON evidence", () => {
  it("accepts every JSON whitespace character around nested values", () => {
    for (const whitespace of [" ", "\t", "\r", "\n"]) {
      const source = `${whitespace}{${whitespace}"rows"${whitespace}:${whitespace}[${whitespace}true,${whitespace}{"label":"a b"}${whitespace}]${whitespace}}${whitespace}`
      expect(parseJsonStrict("run.json", source)).toEqual({ rows: [true, { label: "a b" }] })
    }
  })

  it("refuses decoded duplicate keys inside whitespace-separated nested objects", () => {
    const source = '{\n"rows": [\t{\r"id": 1,\n"\\u0069d": 2\t}\n]\r}'
    expect(() => parseJsonStrict("run.json", source)).toThrow("run.json: duplicate key id")
  })
})
