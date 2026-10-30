/** Isolate the fixed production replay home without exposing an output path on its runner. */
import { inject, vi } from "vitest"

declare module "vitest" {
  interface ProvidedContext {
    eraseTestHome: string
  }
}

vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => inject("eraseTestHome"),
}))
