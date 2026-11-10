import { expect, test } from "vitest"
import { clipboardConfigAgrees } from "./serve.ts"

test("a hosted run with no provenance does not refuse a null clipboard config", () => {
  expect(() => clipboardConfigAgrees(undefined, { config: null })).not.toThrow()
})

test("a provenance config that differs from the clipboard still refuses", () => {
  expect(() => clipboardConfigAgrees({ fixture: { config: "other" } }, { config: null })).toThrow(
    /differs from runtime provenance/,
  )
})

test("matching null configs agree", () => {
  expect(() => clipboardConfigAgrees({ fixture: { config: null } }, { config: null })).not.toThrow()
})
