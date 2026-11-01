import type {
  CallbackHostRecipeCause,
  HostInputName,
  HostRecipeName,
  LibProbeSource,
  ProbeCallbackResult,
} from "./types.ts"

/**
 * Why one audited native artifact leaves each host-owned recipe unanswered: "source-audited" cites the declared host
 * input the harness does not supply; "unimplemented" cites the source that has no reply path for the query at all.
 */
type NativeHostAudit = { kind: "source-audited" | "unimplemented"; citation: string }
/** An artifact lists only the recipes it leaves unanswered; a recipe without a row keeps its measured result. */
type NativeHostSourceCitations = Readonly<Partial<Record<Exclude<HostRecipeName, "color-request">, NativeHostAudit>>>

/**
 * Independent source audits of exact unchanged native artifacts, keyed by loaded-binary sha256 — never a digest copied
 * from runtime. A host gains causes only through its own audit here; no host inherits another's citations.
 */
export const NATIVE_HOST_AUDITS: ReadonlyMap<string, NativeHostSourceCitations> = new Map([
  // Termless be67d1c7 absolute-row rebuild: Config, EventProxy and the reply path were independently re-audited.
  [
    "8232209bd7273d68eb0bc9a71c5acf94fd8ebd96612604ff901c09c4d6cb8344",
    {
      "clipboard-load": {
        kind: "source-audited",
        citation:
          "alacritty_terminal 0.26.0 term/mod.rs:356-380 defaults OSC52 to OnlyCopy; Termless be67d1c7 packages/alacritty/native/src/lib.rs:311-319 changes only scrolling_history from Config::default, and EventProxy::send_event:48-89 has no ClipboardLoad handler; this harness supplies no clipboard read permission",
      },
    },
  ],
  // S6 native mode-readback rebuilds: their independent two-checkout receipts bind these source audits.
  [
    "dc3b24de6e91416f66b1953ce101991ef7e78602ce1b5d357f65832c9b96b326",
    {
      "clipboard-load": {
        kind: "unimplemented",
        citation:
          "vt100 0.16.2 src/perform.rs:212-221 dispatches OSC 52 '?' to paste_from_clipboard; termless 27297cf2 packages/vt100-rust/native/src/lib.rs:50-53 records only paste_selector and writes no reply bytes",
      },
      "text-area-size": {
        kind: "unimplemented",
        citation:
          "vt100 0.16.2 src/perform.rs:132-156 handles only CSI 8 t, forwarding CSI 14 t to the empty src/callbacks.rs:55-63 unhandled_csi; termless 27297cf2 packages/vt100-rust/native/src/lib.rs:21-54 installs no override or reply writer",
      },
    },
  ],
  // Retained-row rebuild: ResponseHandler/ReadonlyHandler and host inputs remain as audited at this source.
  [
    "e58288d0b62448bf746ad77e58a4e9523c1baabb080d6fc6723f76caf29d2bb0",
    {
      "clipboard-load": {
        kind: "unimplemented",
        citation:
          "termless c75b0674 packages/ghostty-native/native/src/main.zig:38-83 ResponseHandler writes only mode, DSR 5/6 and kitty keyboard replies, forwarding clipboard_contents to ghostty 332b2aef src/terminal/stream_readonly.zig:176-196 where it is ignored without a writer",
      },
      "text-area-size": {
        kind: "unimplemented",
        citation:
          "termless c75b0674 packages/ghostty-native/native/src/main.zig:38-83 ResponseHandler forwards size_report to ghostty 332b2aef src/terminal/stream_readonly.zig:176-196 where it is ignored; the wrapper supplies no reply path for CSI 14 t",
      },
    },
  ],
  [
    "d6e23fe62d56de795c6fa783a6c5025fc5b1238e739839de8b4b3737eca0c43e",
    {
      "clipboard-load": {
        kind: "unimplemented",
        citation:
          "termless 723acd11 packages/ghostty-native/native/src/main.zig:38-83 ResponseHandler writes only mode, DSR 5/6 and kitty keyboard replies, forwarding clipboard_contents to ghostty 332b2aef src/terminal/stream_readonly.zig:176-196 where it is ignored without a writer",
      },
      "text-area-size": {
        kind: "unimplemented",
        citation:
          "termless 723acd11 packages/ghostty-native/native/src/main.zig:38-83 ResponseHandler forwards size_report to ghostty 332b2aef src/terminal/stream_readonly.zig:176-196 where it is ignored; the wrapper supplies no reply path for CSI 14 t",
      },
    },
  ],
  // Rebuilt for term.colors() indexed/named cell color resolution (31735, 31774); reply and host-input routes unchanged.
  [
    "32d76284e5a3c7673fafbbc83a16717fa0a1c1811c7d659d982176a53ceb1aa9",
    {
      "clipboard-load": {
        kind: "source-audited",
        citation:
          "alacritty_terminal 0.26.0 Config default clipboard policy OnlyCopy; Termless packages/alacritty/native/src/lib.rs EventProxy::send has no ClipboardLoad handler; this harness supplies no clipboard read permission",
      },
    },
  ],
  // Rebuilt at Termless 5afcc676 for owned URI and underlineColor readback (31385); reply and host-input routes unchanged.
  [
    "d280c3fd2129f42db0d7154d6e66f5582a67fa1faf1e82ab463b6b8286f126d0",
    {
      "clipboard-load": {
        kind: "source-audited",
        citation:
          "alacritty_terminal 0.26.0 Config default clipboard policy OnlyCopy; Termless packages/alacritty/native/src/lib.rs EventProxy::send has no ClipboardLoad handler; this harness supplies no clipboard read permission",
      },
    },
  ],
  [
    "6722b331de7489c14cb599d939e5d2314f054220728f83c5c29f454e70273e47",
    {
      "clipboard-load": {
        kind: "unimplemented",
        citation:
          "tattoy-wezterm-term 0.1.0-fork.5 terminalstate/performer.rs:788 drops OperatingSystemCommand::QuerySelection; terminal.rs:13-19 Clipboard has only set_contents, so no build of this engine answers an OSC 52 read",
      },
    },
  ],

  [
    "0f56a805793d7d829daa617f1323aacff0d73fe868747b0d077c6af315e2aab8",
    {
      "clipboard-load": {
        kind: "unimplemented",
        citation:
          "tattoy-wezterm-term 0.1.0-fork.5 terminalstate/performer.rs:788 drops OperatingSystemCommand::QuerySelection; terminal.rs:13-19 Clipboard has only set_contents, so no build of this engine answers an OSC 52 read",
      },
    },
  ],
  [
    // Alacritty: alacritty_terminal 0.26.0 behind the Termless native addon.
    "e6e16113863355b77d0aa3b359bd40c7066fb144e005fbc324fecfa3f4869bea",
    {
      // The harness declares pixel geometry (31551); the wrapper never hands it to the engine's request.
      "text-area-size": {
        kind: "unimplemented",
        citation:
          "alacritty_terminal 0.26.0 term/mod.rs:2259-2265 asks the embedder for pixels with Event::TextAreaSizeRequest; Termless packages/alacritty/native/src/lib.rs:47-75 EventProxy::send_event drops that event (no arm, `_ => {}`), so no build of this wrapper answers CSI 14 t",
      },
      "clipboard-load": {
        kind: "source-audited",
        citation:
          "alacritty_terminal 0.26.0 Config default clipboard policy OnlyCopy; Termless packages/alacritty/native/src/lib.rs EventProxy::send has no ClipboardLoad handler; this harness supplies no clipboard read permission",
      },
    },
  ],
  [
    // The same engine rebuilt at Termless 22476678, whose wrapper answers CSI 14 t from the declared pixel geometry
    // through the engine's own formatter (31628), so that reply is never empty and needs no row.
    "5d818656c9d58c8c68bec9f7bca1a55cc65ccf9fc078f9a3da0b872a28bf547a",
    {
      "clipboard-load": {
        kind: "source-audited",
        citation:
          "alacritty_terminal 0.26.0 Config default clipboard policy OnlyCopy; Termless packages/alacritty/native/src/lib.rs EventProxy::send has no ClipboardLoad handler; this harness supplies no clipboard read permission",
      },
    },
  ],
  [
    // The same engine rebuilt at Termless 0400d94a for cell underline_color forwarding (31379); EventProxy is unchanged.
    "11c87e7e7f23e6f224e9dc8c3296b0a91f5453a42038e5ad049aafa864f9bd50",
    {
      "clipboard-load": {
        kind: "source-audited",
        citation:
          "alacritty_terminal 0.26.0 Config default clipboard policy OnlyCopy; Termless packages/alacritty/native/src/lib.rs EventProxy::send has no ClipboardLoad handler; this harness supplies no clipboard read permission",
      },
    },
  ],
  [
    // WezTerm: tattoy-wezterm-term 0.1.0-fork.5 behind the Termless native addon. It answers CSI 14 t from the pixels
    // the wrapper gives it (terminalstate/mod.rs:2047-2054), so that reply is never empty and needs no row.
    "84da518e3f298a0ed75f186db6e39d87e99b8f0c8508dd7252ec0cafee77fe12",
    {
      "clipboard-load": {
        kind: "unimplemented",
        citation:
          "tattoy-wezterm-term 0.1.0-fork.5 terminalstate/performer.rs:788 drops OperatingSystemCommand::QuerySelection; terminal.rs:13-19 Clipboard has only set_contents, so no build of this engine answers an OSC 52 read",
      },
    },
  ],
  [
    // The same engine rebuilt at Termless 71cac2c3, whose wrapper gives it the declared pixel geometry (31551).
    "78c05a7155ffb48b351de181cce13a5d996c3472f545f674dc34177fe27bae01",
    {
      "clipboard-load": {
        kind: "unimplemented",
        citation:
          "tattoy-wezterm-term 0.1.0-fork.5 terminalstate/performer.rs:788 drops OperatingSystemCommand::QuerySelection; terminal.rs:13-19 Clipboard has only set_contents, so no build of this engine answers an OSC 52 read",
      },
    },
  ],
])

/** Explain an actually empty host-owned query without changing the criterion or protocol bytes. */
export function nativeHostRecipeResult(
  ctx: LibProbeSource,
  result: ProbeCallbackResult,
  recipe: HostRecipeName,
  missing: HostInputName,
  query: string,
  empty: boolean,
): ProbeCallbackResult {
  if (!empty || ctx.runtimeIdentity?.kind !== "native") return result
  const artifactSha256 = ctx.runtimeIdentity.loadedBinary.sha256
  const citations = NATIVE_HOST_AUDITS.get(artifactSha256)
  if (citations === undefined) return result
  let claim: CallbackHostRecipeCause
  if (recipe === "color-request") claim = { recipe, cause: { kind: "observed", missing, query } }
  else {
    const audit = citations[recipe]
    if (audit === undefined) return result
    claim = { recipe, cause: { kind: audit.kind, missing, artifactSha256, sourceCitation: audit.citation } }
  }
  return { ...result, hostRecipeCauses: [...(result.hostRecipeCauses ?? []), claim] }
}
