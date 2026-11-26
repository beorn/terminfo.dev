/**
 * @failure A mux with no reviewed title reader is sent another mux's flags, and every title probe reads invalid instead
 *   of To do: run 9032abd0 (#38759) sent Zellij 0.46.0 Screen's `-S <session> -Q title` on three rows.
 * @level l1
 * @consumer createLinuxClipboardAdapter's readTitle, which the title probes call through the run context
 * @reach none
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { fdSocketInodes, muxTitleCommand } from "./linux-clipboard.ts"

const target = (mux: "tmux" | "screen" | "herdr" | "zellij") => ({
  mux,
  executable: { path: `/nix/store/x-${mux}/bin/${mux}` },
  socketPath: `/home/runner/terminfo-run-sockets/${mux}.sock`,
  session: "terminfo-run",
})

describe("the command that reads a mux pane's title (#38759)", () => {
  it("is tmux's display-message on its own socket", () => {
    expect(muxTitleCommand(target("tmux"))).toEqual({
      file: "/nix/store/x-tmux/bin/tmux",
      args: [
        "-S",
        "/home/runner/terminfo-run-sockets/tmux.sock",
        "display-message",
        "-p",
        "-t",
        "terminfo-run",
        "#{pane_title}",
      ],
    })
  })

  it("is Screen's -Q title in its socket directory", () => {
    expect(muxTitleCommand(target("screen"))).toEqual({
      file: "/nix/store/x-screen/bin/screen",
      args: ["-S", "terminfo-run", "-Q", "title"],
      env: { SCREENDIR: "/home/runner/terminfo-run-sockets" },
    })
  })

  it("is none for herdr and Zellij, which have no reviewed title reader", () => {
    expect(muxTitleCommand(target("herdr"))).toBeUndefined()
    expect(muxTitleCommand(target("zellij"))).toBeUndefined()
  })
})

describe("the socket inodes a mux process holds (#38759)", () => {
  const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
  const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
  const links: Record<string, string | Error> = {
    "/proc/7/fd/0": "/dev/pts/3",
    "/proc/7/fd/3": "socket:[4242]",
    "/proc/7/fd/9": enoent,
    "/proc/7/fd/11": "socket:[4343]",
  }
  const io = (overrides: Record<string, string | Error> = {}) => ({
    readdir: () => Object.keys({ ...links, ...overrides }).map((path) => path.slice("/proc/7/fd/".length)),
    readlink: (path: string) => {
      const link = { ...links, ...overrides }[path]
      if (link instanceof Error) throw link
      if (link === undefined) throw new Error(`fixture has no ${path}`)
      return link
    },
  })

  it("skips a descriptor that closed between the listing and its readlink (run ea7fd487: 181 rows invalid)", () => {
    expect([...fdSocketInodes(7, "Zellij", io())].sort()).toEqual(["4242", "4343"])
  })

  it("still refuses a descriptor it cannot read for any other reason", () => {
    expect(() => fdSocketInodes(7, "Zellij", io({ "/proc/7/fd/3": eacces }))).toThrow(
      "Owned mux Zellij fd link /proc/7/fd/3 cannot be read",
    )
  })
})
