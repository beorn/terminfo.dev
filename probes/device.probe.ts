import { describeBackends, feed, test, expect } from "./setup.ts"

describeBackends("device", (b) => {
  test("device.primary-da", () => {
    // DA1: CSI c or CSI 0 c — request primary device attributes
    // Backend should generate a response: CSI ? ... c
    let response = ""
    const prevHandler = b.onResponse
    b.onResponse = (data) => {
      response += new TextDecoder().decode(data)
    }
    feed(b, "\x1b[c")
    b.onResponse = prevHandler
    // Response should contain CSI ? followed by attributes and ending with c
    expect(response).toContain("?")
    expect(response.endsWith("c")).toBe(true)
  })

  test("device.status-report", () => {
    // DSR 5: CSI 5 n — request device status report
    // Backend should respond: CSI 0 n (terminal OK)
    let response = ""
    const prevHandler = b.onResponse
    b.onResponse = (data) => {
      response += new TextDecoder().decode(data)
    }
    feed(b, "\x1b[5n")
    b.onResponse = prevHandler
    // Response should be CSI 0 n (device OK)
    expect(response).toContain("0n")
  })

  test("device.secondary-da", () => {
    // DA2: CSI > c — request secondary device attributes
    feed(b, "\x1b[>c")
  })

  test("device.tertiary-da", () => {
    // DA3: CSI = c
    feed(b, "\x1b[=c")
  })

  test("device.decrqss", () => {
    // DECRQSS: DCS $ q Pt ST
    feed(b, "\x1bP$q\"p\x1b\\")
  })

  test("device.xtgettcap", () => {
    // XTGETTCAP: DCS + q Pt ST
    feed(b, "\x1bP+q544e\x1b\\")
  })

  test("device.decrpm", () => {
    // DECRPM request: CSI ? Ps $ p
    feed(b, "\x1b[?1$p")
  })
})
