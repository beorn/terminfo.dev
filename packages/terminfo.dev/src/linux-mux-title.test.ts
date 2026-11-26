/**
 * @failure A mux with no reviewed title reader is sent another mux's flags, and every title probe reads invalid instead
 *   of To do: run 9032abd0 (#38759) sent Zellij 0.46.0 Screen's `-S <session> -Q title` on three rows.
 * @level l1
 * @consumer createLinuxClipboardAdapter's readTitle, which the title probes call through the run context
 * @reach none
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { muxTitleCommand } from "./linux-clipboard.ts"

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
