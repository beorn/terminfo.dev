import { describeBackends, feed, feedCapture, test, expect } from "./setup.ts"

describeBackends("device", (b) => {
  test("device.primary-da", () => {
    // DA1: CSI c → response CSI ? Ps ; Ps ; ... c
    const response = feedCapture(b, "\x1b[c")
    expect(response).toContain("?")
    expect(response.endsWith("c")).toBe(true)
  })

  test("device.status-report", () => {
    // DSR 5: CSI 5 n → response CSI 0 n (device OK)
    const response = feedCapture(b, "\x1b[5n")
    expect(response).toContain("0n")
  })

  test("device.secondary-da", () => {
    // DA2: CSI > c → response CSI > Pp ; Pv ; Pc c
    const response = feedCapture(b, "\x1b[>c")
    expect(response).toContain(">")
  })

  test("device.tertiary-da", () => {
    // DA3: CSI = c → response DCS ! | hex ST
    const response = feedCapture(b, "\x1b[=c")
    expect(response.length).toBeGreaterThan(0)
  })

  test("device.decrqss", () => {
    // DECRQSS: DCS $ q Pt ST → response DCS Ps $ r Pt ST
    const response = feedCapture(b, '\x1bP$q"p\x1b\\')
    expect(response.length).toBeGreaterThan(0)
  })

  test("device.xtgettcap", () => {
    // XTGETTCAP: DCS + q hex ST → response DCS 1 + r hex = value ST
    const response = feedCapture(b, "\x1bP+q544e\x1b\\") // Query "TN"
    expect(response.length).toBeGreaterThan(0)
  })

  test("device.decrpm", () => {
    // DECRPM: CSI ? Ps $ p → response CSI ? Ps ; Pm $ y
    const response = feedCapture(b, "\x1b[?1$p") // Query DECCKM
    expect(response).toContain("$y")
  })
})
