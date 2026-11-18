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

  // 34904: strings are skipped by searching for each quote; a quote counts as the end only after an even run of
  // backslashes. A wrong end would desynchronise the walk and miss the duplicate that follows it.
  it("ends strings correctly after escaped quotes and escaped backslashes, and still finds a later duplicate", () => {
    const before = String.raw`{"a":"x\\","b":"q\"\\\"","k\"":1,"rows":["\\",{"c":"\\\\"}],`
    expect(() => parseJsonStrict("run.json", String.raw`${before}"k\"":2}`)).toThrow('run.json: duplicate key k"')
    expect(() => parseJsonStrict("run.json", `${before}"a":3}`)).toThrow("run.json: duplicate key a")
    const entries: string[] = []
    parseJsonStrict("run.json", String.raw`["a\\",{"b":"\"}"},"c"]`, (index, entry) =>
      entries.push(`${String(index)}=${entry}`),
    )
    expect(entries).toEqual([String.raw`0="a\\"`, String.raw`1={"b":"\"}"}`, `2="c"`])
  })
})
