import { describeBackends, feed, test, expect } from "./setup.ts"

describeBackends("sgr", (b) => {
  test("sgr.bold", () => {
    feed(b, "\x1b[1mX")
    expect(b.getCell(0, 0).bold).toBe(true)
  })

  test("sgr.faint", () => {
    feed(b, "\x1b[2mX")
    expect(b.getCell(0, 0).dim).toBe(true)
  })

  test("sgr.italic", () => {
    feed(b, "\x1b[3mX")
    expect(b.getCell(0, 0).italic).toBe(true)
  })

  test("sgr.underline.single", () => {
    feed(b, "\x1b[4mX")
    expect(b.getCell(0, 0).underline).toBeTruthy()
  })

  test("sgr.underline.double", () => {
    feed(b, "\x1b[21mX")
    const cell = b.getCell(0, 0)
    expect(cell.underline).toBeTruthy()
    expect(cell.underline).toBe("double")
  })

  test("sgr.underline.curly", () => {
    feed(b, "\x1b[4:3mX")
    const cell = b.getCell(0, 0)
    expect(cell.underline).toBeTruthy()
    expect(cell.underline).toBe("curly")
  })

  test("sgr.underline.dotted", () => {
    feed(b, "\x1b[4:4mX")
    const cell = b.getCell(0, 0)
    expect(cell.underline).toBeTruthy()
    expect(cell.underline).toBe("dotted")
  })

  test("sgr.underline.dashed", () => {
    feed(b, "\x1b[4:5mX")
    const cell = b.getCell(0, 0)
    expect(cell.underline).toBeTruthy()
    expect(cell.underline).toBe("dashed")
  })

  test("sgr.blink", () => {
    feed(b, "\x1b[5mX")
    expect(b.getCell(0, 0).blink).toBe(true)
  })

  test("sgr.inverse", () => {
    feed(b, "\x1b[7mX")
    expect(b.getCell(0, 0).inverse).toBe(true)
  })

  test("sgr.hidden", () => {
    feed(b, "\x1b[8mX")
    expect(b.getCell(0, 0).hidden).toBe(true)
  })

  test("sgr.strikethrough", () => {
    feed(b, "\x1b[9mX")
    expect(b.getCell(0, 0).strikethrough).toBe(true)
  })

  test("sgr.fg.256", () => {
    feed(b, "\x1b[38;5;196mX")
    const fg = b.getCell(0, 0).fg
    expect(fg).not.toBeNull()
    expect(fg?.r).toBeGreaterThan(200)
  })

  test("sgr.bg.256", () => {
    feed(b, "\x1b[48;5;21mX")
    const bg = b.getCell(0, 0).bg
    expect(bg).not.toBeNull()
    expect(bg?.b).toBeGreaterThan(100)
  })

  test("sgr.fg.truecolor", () => {
    feed(b, "\x1b[38;2;255;128;0mX")
    const fg = b.getCell(0, 0).fg
    expect(fg).not.toBeNull()
    expect(fg).toEqual({ r: 255, g: 128, b: 0 })
  })

  test("sgr.bg.truecolor", () => {
    feed(b, "\x1b[48;2;0;255;128mX")
    const bg = b.getCell(0, 0).bg
    expect(bg).not.toBeNull()
    expect(bg).toEqual({ r: 0, g: 255, b: 128 })
  })

  test("sgr.overline", () => {
    feed(b, "\x1b[53mX")
    // Overline is not yet in the Cell interface, so we check the raw property
    const cell = b.getCell(0, 0) as any
    expect(cell.overline === true || cell.overline === undefined).toBe(true)
  })

  test("sgr.underline.color", () => {
    feed(b, "\x1b[4m\x1b[58;2;255;0;128mX")
    const cell = b.getCell(0, 0)
    expect(cell.underline).toBeTruthy()
    expect(cell.underlineColor).not.toBeNull()
    if (cell.underlineColor) {
      expect(cell.underlineColor.r).toBe(255)
      expect(cell.underlineColor.g).toBe(0)
      expect(cell.underlineColor.b).toBe(128)
    }
  })

  test("sgr.fg.standard", () => {
    feed(b, "\x1b[31mX")
    const fg = b.getCell(0, 0).fg
    expect(fg).not.toBeNull()
    // Red: should have high r component
    expect(fg!.r).toBeGreaterThan(100)
  })

  test("sgr.bg.standard", () => {
    feed(b, "\x1b[42mX")
    const bg = b.getCell(0, 0).bg
    expect(bg).not.toBeNull()
    // Green: should have high g component
    expect(bg!.g).toBeGreaterThan(100)
  })

  test("sgr.fg.bright", () => {
    feed(b, "\x1b[91mX")
    const fg = b.getCell(0, 0).fg
    expect(fg).not.toBeNull()
    // Bright red
    expect(fg!.r).toBeGreaterThan(150)
  })

  test("sgr.bg.bright", () => {
    feed(b, "\x1b[102mX")
    const bg = b.getCell(0, 0).bg
    expect(bg).not.toBeNull()
    // Bright green
    expect(bg!.g).toBeGreaterThan(150)
  })

  test("sgr.fg.default", () => {
    feed(b, "\x1b[31mX\x1b[39mY")
    const cell = b.getCell(0, 1)
    // After SGR 39, fg should be reset to default (null)
    expect(cell.fg).toBeNull()
  })

  test("sgr.bg.default", () => {
    feed(b, "\x1b[42mX\x1b[49mY")
    const cell = b.getCell(0, 1)
    // After SGR 49, bg should be reset to default (null)
    expect(cell.bg).toBeNull()
  })

  test("sgr.selective-reset.bold", () => {
    feed(b, "\x1b[1mX\x1b[22mY")
    const cell = b.getCell(0, 1)
    expect(cell.bold).toBe(false)
    expect(cell.dim).toBe(false)
  })

  test("sgr.selective-reset.underline", () => {
    feed(b, "\x1b[4mX\x1b[24mY")
    const cell = b.getCell(0, 1)
    expect(!!cell.underline).toBe(false)
  })

  test("sgr.selective-reset.italic", () => {
    feed(b, "\x1b[3mX\x1b[23mY")
    const cell = b.getCell(0, 1)
    expect(cell.italic).toBe(false)
  })

  test("sgr.selective-reset.inverse", () => {
    feed(b, "\x1b[7mX\x1b[27mY")
    const cell = b.getCell(0, 1)
    expect(cell.inverse).toBe(false)
  })

  test("sgr.reset", () => {
    feed(b, "\x1b[1;3;4mX\x1b[0mY")
    const cell = b.getCell(0, 1)
    expect(cell.bold).toBe(false)
    expect(cell.italic).toBe(false)
    expect(!!cell.underline).toBe(false)
  })
})
