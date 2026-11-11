/**
 * @failure Desktop notification silence is graded without the owned control, default profile,
 *   exact terminal bus, unfocused write, or outer-terminal proof; parse loss is hidden.
 * @level l1
 * @consumer OSC9 and OSC777 App callbacks with independent desktop delivery readback.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import type { NotificationFixture, TermProbeSource } from "./types.ts"

type Fault = "none" | "disabled" | "bus-unknown" | "profile-unknown" | "focused" | "unparsed" | "mux-no-outer"

function source(fault: Fault) {
  const writes: string[] = []
  const entries: Array<{ id: number; appName: string; summary: string; body: string }> = []
  const fixture: NotificationFixture = {
    control: { nonce: "independent-control", id: 1 },
    recordPath: "owned-notifications.jsonl",
    deadlineMs: 10,
    terminalBus: { state: fault === "bus-unknown" ? "unknown" : "same", reason: "measured terminal process env" },
    profile: {
      state: fault === "profile-unknown" ? "unknown" : "default",
      reason: "qualified default notification config",
    },
    cursor: () => entries.length,
    readSince: (cursor) => ({
      entries: entries.slice(cursor),
      problems: fault === "unparsed" ? ["unparsed frame"] : [],
    }),
  }
  const ctx = {
    kind: "live",
    mux: fault === "mux-no-outer" ? "screen" : undefined,
    write(text: string) {
      writes.push(text)
      if (
        fault !== "disabled" &&
        fault !== "bus-unknown" &&
        fault !== "profile-unknown" &&
        fault !== "focused" &&
        fault !== "mux-no-outer"
      ) {
        const nonce = text.match(/terminfo-notify-[a-zA-Z0-9-]+/)?.[0]
        if (!nonce) return
        entries.push({ id: 2, appName: "target", summary: nonce, body: nonce })
      }
    },
    withNotificationObserver: (work: (observer: NotificationFixture) => unknown) => work(fixture),
    input: {
      injectKey: async () => undefined,
      injectClick: async () => undefined,
      async focusRoundTrip(work?: (readFocus: () => Promise<string>) => Promise<void>) {
        await work?.(async () => (fault === "focused" ? "42" : "543"))
        return { ownedWindowId: "42", rootWindowId: "543", focusedWindowIds: ["42", "543", "42"] }
      },
    },
  } as unknown as TermProbeSource
  return { ctx, writes }
}

for (const id of ["extensions.notifications", "extensions.osc777-notify"]) {
  test(`${id} decides real nonce delivery and only qualified unfocused silence`, async () => {
    const callback = extensionsProbes.find((probe) => probe.id === id)?.term
    if (!callback) throw new Error(`Missing App callback ${id}`)
    for (const fault of [
      "none",
      "disabled",
      "bus-unknown",
      "profile-unknown",
      "focused",
      "unparsed",
      "mux-no-outer",
    ] as const) {
      const { ctx, writes } = source(fault)
      const result = await callback(ctx)
      if (fault === "focused") {
        expect(result.tests).toMatchObject([{ status: "probe-invalid" }])
        expect(result.observation).toBeUndefined()
        continue
      }
      expect(result.observation?.outcome, fault).toBe(
        fault === "none" ? "supported" : fault === "disabled" ? "unsupported" : "inconclusive",
      )
      expect(writes, fault).toHaveLength(1)
      expect(result.observation?.assertionType).toBe("notification")
      if (fault !== "none" && fault !== "disabled") expect(result.assertions ?? []).toHaveLength(0)
    }
  })
}
