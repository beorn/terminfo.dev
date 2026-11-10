import { expect, test } from "vitest"
import { clipboardConfigAgrees } from "./clipboard-config.ts"

test("a hosted run with no provenance does not refuse a null clipboard config", () => {
  expect(() => clipboardConfigAgrees(undefined, { config: null })).not.toThrow()
})

test("a provenance config that differs from a claimed clipboard config still refuses", () => {
  expect(() => clipboardConfigAgrees({ fixture: { config: "other" } }, { config: "receipt" })).toThrow(
    /differs from runtime provenance/,
  )
})

test("a null clipboard config makes no claim against a launcher config string", () => {
  expect(() => clipboardConfigAgrees({ fixture: { config: "--config NONE" } }, { config: null })).not.toThrow()
})

test("matching null configs agree", () => {
  expect(() => clipboardConfigAgrees({ fixture: { config: null } }, { config: null })).not.toThrow()
})
