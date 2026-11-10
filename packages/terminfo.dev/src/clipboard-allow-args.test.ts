/**
 * @failure The launcher passes one clipboard-read setting while the collector's live argv check expects
 *   another, so an allow run is refused, or a run whose terminal never got the setting is labelled allowed.
 * @level l1
 * @consumer scripts/linux-container-run.sh allow profile and createLinuxClipboardAdapter's argv re-read.
 * @testonly assertClipboardProfile: exported so each app's flag/value pairing is checked without a live display.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { assertClipboardProfile, CLIPBOARD_ALLOW_ARGS, type ClipboardApp } from "./linux-clipboard.ts"

const launcher = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/linux-container-run.sh")

/** The allow arm of the launcher's profile case, each target's array parsed by bash itself. */
function launcherAllowArgs(): Record<string, string[]> {
  const script = readFileSync(launcher, "utf8")
  const arm = /\n {4}allow\)\n([\s\S]*?)\n {6};;\n/.exec(script)?.[1]
  if (!arm) throw new Error("allow arm of the clipboard profile case not found in the launcher")
  const found: Record<string, string[]> = {}
  for (const match of arm.matchAll(/^ {8}(\w+)\) target_clipboard_args=\((.*)\) ;;$/gm)) {
    const [, id, words] = match as unknown as [string, string, string]
    // printf with no arguments still prints its format once, so an empty array is counted first.
    const out = execFileSync("bash", ["-c", `args=(${words}); echo "\${#args[@]}"; printf '%s\\0' "\${args[@]}"`], {
      encoding: "utf8",
    })
    const [count = "", rest = ""] = out.split(/\n(.*)/s)
    found[id] = Number(count) === 0 ? [] : rest.split("\0").slice(0, -1)
  }
  return found
}

test("launcher allow args equal the collector's table for every target", () => {
  expect(launcherAllowArgs()).toEqual(CLIPBOARD_ALLOW_ARGS)
})

const apps = Object.keys(CLIPBOARD_ALLOW_ARGS) as ClipboardApp[]
const argv = (app: ClipboardApp, extra: readonly string[]) => [
  `/nix/store/x/bin/${app}`,
  "--lead",
  ...extra,
  "-e",
  "bun",
  "collector.ts",
]

test.each(apps)("%s: the allow argv passes and the default argv carries no control", (app) => {
  expect(() => assertClipboardProfile(app, "allow", argv(app, CLIPBOARD_ALLOW_ARGS[app]))).not.toThrow()
  expect(() => assertClipboardProfile(app, "default", argv(app, []))).not.toThrow()
})

test.each(apps.filter((app) => CLIPBOARD_ALLOW_ARGS[app].length > 0))(
  "%s: an allow receipt without the setting, or a default run with it, is refused",
  (app) => {
    expect(() => assertClipboardProfile(app, "allow", argv(app, []))).toThrow(/differs from allow receipt/)
    expect(() => assertClipboardProfile(app, "default", argv(app, CLIPBOARD_ALLOW_ARGS[app]))).toThrow(
      /differs from default receipt/,
    )
  },
)

test("a control after the collector command is not the terminal's own", () => {
  const late = ["/bin/kitty", "bun", "collector.ts", ...CLIPBOARD_ALLOW_ARGS.kitty]
  expect(() => assertClipboardProfile("kitty", "allow", late)).toThrow(/differs from allow receipt/)
})

test("an unrelated xterm resource is not read as a clipboard control", () => {
  const extra = ["-xrm", "Xft.antialias: false", ...CLIPBOARD_ALLOW_ARGS.xterm]
  expect(() => assertClipboardProfile("xterm", "allow", argv("xterm", extra))).not.toThrow()
})

test("deny-read exists only for Kitty", () => {
  expect(() =>
    assertClipboardProfile("kitty", "deny-read", argv("kitty", ["-o", "clipboard_control=write-clipboard"])),
  ).not.toThrow()
  expect(() => assertClipboardProfile("ghostty", "deny-read", argv("ghostty", []))).toThrow(/no declared deny-read/)
})
