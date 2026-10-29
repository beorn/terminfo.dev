import type { LibProbeSource } from "./types.ts"

/** One audited cell: the exact query bytes, why the artifact cannot answer them, and its own source citation. */
export interface ReplyPathAudit {
  readonly query: string
  /** Only an explicitly audited family may contain a per-run query identifier. Omitted means byte-exact. */
  readonly matches?: "prefix"
  /** no-reply-path: the sequence is handled but the artifact has no writer for the reply (Untestable review).
   *  parser-rejected: the artifact's parser rejects the sequence before any handler (Unsupported, negative by source
   *  citation). */
  readonly kind: "no-reply-path" | "parser-rejected"
  readonly citation: string
}

const GHOSTTY_NATIVE_KEYBOARD_AUDIT: ReplyPathAudit = {
  query: "\x1b[?u\x1b[c",
  kind: "no-reply-path",
  citation:
    "termless 0c409349 packages/ghostty-native/native/src/main.zig:81 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
}

const GHOSTTY_NATIVE_GRAPHICS_AUDIT: ReplyPathAudit = {
  query: "\x1b_G",
  matches: "prefix",
  kind: "no-reply-path",
  citation:
    "termless 0c409349 packages/ghostty-native/native/src/main.zig:81 vtStream() -> ghostty 332b2aef Terminal.zig:260-265 ReadonlyStream; stream.zig:736-738 forwards APC; stream_readonly.zig:168-173 ignores apc_start/apc_put/apc_end; native exports main.zig:48-65 provide no image-state or reply observer",
}

const VT100_RUST_OSC52_READ_AUDIT: ReplyPathAudit = {
  query: "\x1b]52;c;?\x07",
  kind: "no-reply-path",
  citation:
    "termless 4a730304 packages/vt100-rust/native/src/lib.rs:50-52 paste_from_clipboard records the selector and writes no reply bytes. vt100 0.16.2 OSC 52 '?' calls paste_from_clipboard. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098. The f309015f rows are the previous artifact and stay unchanged.",
}

/** Native callbacks on the b9109b59 artifact. The vt100 0.16.2 crate citations stay on each row. */
const VT100_RUST_B910_LIB =
  "termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098."

const VT100_RUST_B910_KEYBOARD_AUDIT: ReplyPathAudit = {
  query: "\x1b[?u\x1b[c",
  kind: "no-reply-path",
  citation: `registry/src/index.crates.io-1949cf8c6b5b557f/vt100-0.16.2/src/perform.rs:176-183 private ?u and :157-164 plain c dispatch Callbacks::unhandled_csi, empty at src/callbacks.rs:55-63. Cargo.lock vt100 checksum054ff75fb8fa83e609e685106df4faeffdf3a735d3c74ebce97ec557d5d36fd9; vte0.15.0 checksuma5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd. ${VT100_RUST_B910_LIB}`,
}

const VT100_RUST_B910_GRAPHICS_AUDIT: ReplyPathAudit = {
  query: "\x1b_G",
  matches: "prefix",
  kind: "parser-rejected",
  citation: `registry/src/index.crates.io-1949cf8c6b5b557f/vte-0.15.0/src/lib.rs:377 ESC_ enters SosPmApcString; :182 routes payload only to anywhere (:438-451 controls only), discarding it before any vt100 callback; Perform:761-815 exposes no APC hook. Cargo.lock vte0.15.0 checksuma5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd; vt1000.16.2 checksum054ff75fb8fa83e609e685106df4faeffdf3a735d3c74ebce97ec557d5d36fd9; display's a=t prerequisite is discarded before any placement can be attempted. ${VT100_RUST_B910_LIB}`,
}

const VT100_RUST_B910_OSC21_AUDIT: ReplyPathAudit = {
  query: "\x1b]21;foreground=?\x1b\\",
  kind: "no-reply-path",
  citation: `registry/src/index.crates.io-1949cf8c6b5b557f/vt100-0.16.2/src/perform.rs:234-236 dispatches unknown OSC21 to unhandled_osc, empty at src/callbacks.rs:66. Cargo.lock vt100 checksum054ff75fb8fa83e609e685106df4faeffdf3a735d3c74ebce97ec557d5d36fd9; vte0.15.0 checksuma5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd. ${VT100_RUST_B910_LIB}`,
}

const VT100_RUST_B910_SIXEL_DA_AUDIT: ReplyPathAudit = {
  query: "\x1b[c",
  kind: "no-reply-path",
  citation: `vt100 0.16.2 src/perform.rs:157-164 csi_dispatch default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). ${VT100_RUST_B910_LIB}`,
}

const VT100_RUST_B910_SIXEL_S_AUDIT: ReplyPathAudit = {
  query: "\x1b[?2;1;0S",
  kind: "no-reply-path",
  citation: `registry/src/index.crates.io-1949cf8c6b5b557f/vt100-0.16.2/src/perform.rs:176-183 dispatches private ?S to unhandled_csi, empty at src/callbacks.rs:55-63. Cargo.lock vt100 checksum054ff75fb8fa83e609e685106df4faeffdf3a735d3c74ebce97ec557d5d36fd9; vte0.15.0 checksuma5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd. ${VT100_RUST_B910_LIB}`,
}

const VT100_RUST_B910_OSC99_AUDIT: ReplyPathAudit = {
  query: "\u001b]99;",
  matches: "prefix",
  kind: "no-reply-path",
  citation: `vte0.15.0 src/lib.rs:419-422 ends OSC on ESC and :554-587 forwards its semicolon-separated params to performer.osc_dispatch. vt1000.16.2 src/perform.rs:198-236 handles OSC0/1/2/52 only; OSC99 reaches callbacks.unhandled_osc at :234-236, whose default src/callbacks.rs:64-66 is empty. Exact cached crate SHA256 vt100054ff75fb8fa83e609e685106df4faeffdf3a735d3c74ebce97ec557d5d36fd9 and vtea5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd. Audited family is Terminfo27541ce4 extensions.ts:3267-3312 capability query ESC]99;i=<nonce>:p=?;ST. ${VT100_RUST_B910_LIB}`,
}

const VT100_OSC52_AUDIT: ReplyPathAudit = {
  query: "\x1b]52;c;?\x07",
  kind: "no-reply-path",
  citation:
    "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:210-218 OSC 52 '?' -> Callbacks::paste_from_clipboard, empty by default (src/callbacks.rs:36); termless 0c409349 packages/vt100-rust/native/src/lib.rs:10-14 implements only set_window_title",
}

const GHOSTTY_WASM_GRAPHICS_AUDIT: ReplyPathAudit = {
  query: "\x1b_G",
  matches: "prefix",
  kind: "no-reply-path",
  citation:
    "ghostty-web 0.4.0 artifact7c43302d, core5714ed07: termless vendor/ghostty-web/ghostty-wasm-api.patch:697 ResponseStream(ResponseHandler), :824-827 constructs, :867 feeds; core src/terminal/stream.zig:781-783 forwards APC; patch:589-591/:607 ignores APC handlers, exposing no image state or graphics reply; display cannot complete its a=t allocation prerequisite",
}

const VT100_RUST_KEYBOARD_AUDIT: ReplyPathAudit = {
  query: "\x1b[?u\x1b[c",
  kind: "no-reply-path",
  citation:
    "vt100-rust 0.16.2 artifactf309015f: registry/src/index.crates.io-1949cf8c6b5b557f/vt100-0.16.2/src/perform.rs:176-183 private ?u and :157-164 plain c dispatch Callbacks::unhandled_csi, empty at src/callbacks.rs:55-63; termless0400d94a packages/vt100-rust/native/src/lib.rs:10-14 implements only title storage, no reply export. Cargo.lock vt100 checksum054ff75fb8fa83e609e685106df4faeffdf3a735d3c74ebce97ec557d5d36fd9; vte0.15.0 checksuma5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd",
}

const VT100_RUST_GRAPHICS_AUDIT: ReplyPathAudit = {
  query: "\x1b_G",
  matches: "prefix",
  kind: "parser-rejected",
  citation:
    "vt100-rust 0.16.2 artifactf309015f: registry/src/index.crates.io-1949cf8c6b5b557f/vte-0.15.0/src/lib.rs:377 ESC_ enters SosPmApcString; :182 routes payload only to anywhere (:438-451 controls only), discarding it before any vt100 callback; Perform:761-815 exposes no APC hook. Cargo.lock vte0.15.0 checksuma5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd; vt1000.16.2 checksum054ff75fb8fa83e609e685106df4faeffdf3a735d3c74ebce97ec557d5d36fd9; display's a=t prerequisite is discarded before any placement can be attempted",
}

/**
 * Source audits of exact artifacts that cannot reply, keyed by loaded-artifact sha256 — never a digest copied from
 * runtime — and then by featureId. Data only: a cell enters with its own citation and is reviewed as data. An
 * unlisted (artifact, feature) pair keeps the probe's measured result.
 */
export const REPLY_PATH_AUDITS: ReadonlyMap<string, Readonly<Record<string, ReplyPathAudit>>> = new Map<
  string,
  Readonly<Record<string, ReplyPathAudit>>
>([
  // Ghostty WASM rebuilt for .window_title observation and .size_report (.csi_18_t) producer (31735, @cto 863bef67).
  // CSI 18 t now answers "\x1b[8;{rows};{cols}t" copied from ghostty 5714ed07a1012573261b7b7e3ed2add9c1504496
  // src/termio/Termio.zig:540-546 using self.terminal.rows/cols; CSI 14 t, 16 t, and 21 t remain silent.
  [
    "d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9",
    {
      "extensions.osc99-kitty-notify": {
        query: "\u001b]99;",
        matches: "prefix",
        kind: "parser-rejected",
        citation:
          "Ghostty WASM d80a8110, core 5714ed07a1012573261b7b7e3ed2add9c1504496: src/terminal/osc.zig:556-565 puts first9 in state9; :1076-1081 accepts only semicolon there, so second9 invalidates OSC99; :554 clears complete and :1708-1714 returns null. Parser.zig:270-273 emits osc_dispatch only for nonnull commands. The actual WASM write path is Termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream(ResponseHandler), nextSlice; no notification action is reached. Audited family is Terminfo27541ce4 extensions.ts:3267-3312 capability query ESC]99;i=<nonce>:p=?;ST, not desktop delivery.",
      },
      "extensions.osc0-icon-title": {
        query: "\u001b[20t",
        kind: "parser-rejected",
        citation:
          "Ghostty WASM artifact d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9, core 5714ed07a1012573261b7b7e3ed2add9c1504496; Termless vendor/ghostty-web/ghostty-wasm-api.patch constructs ResponseStream(ResponseHandler) and feeds it; size_report formats only .csi_18_t (copied from src/termio/Termio.zig:540-546) and leaves .csi_14_t/.csi_16_t/.csi_21_t silent. Core src/terminal/stream.zig:1793-1849 XTWINOPS accepts 14/16/18/21 and 22/23, but 20 reaches the unimplemented-parameter arm before any handler. Terminfo 27541ce40cea4baaaa5a34171ad059e08d295d19 packages/probe-defs/src/extensions.ts:2245-2254,2759-2770 requires BOTH icon20 and title21 exact payload replies; icon20 is necessary.",
      },
      "extensions.osc52-clipboard": {
        query: "\u001b]52;c;?\u0007",
        kind: "no-reply-path",
        citation:
          "Ghostty WASM artifact d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9, core 5714ed07a1012573261b7b7e3ed2add9c1504496; Termless vendor/ghostty-web/ghostty-wasm-api.patch constructs ResponseStream(ResponseHandler), feeds it, and ignores request_mode_unknown/clipboard_contents. Core src/terminal/osc.zig:941-975 parses OSC52 kind/data; stream.zig:2022-2026 dispatches clipboard_contents, which this WASM handler ignores without clipboard storage, host callback or reply append. Terminfo 27541ce40cea4baaaa5a34171ad059e08d295d19 packages/probe-defs/src/extensions.ts:1942-1961,2789-2793 requires exact nonce roundtrip via this read query, not write consumption.",
      },
      "extensions.osc52-read": {
        query: "\u001b]52;c;?\u0007",
        kind: "no-reply-path",
        citation:
          "Ghostty WASM artifact d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9, core 5714ed07a1012573261b7b7e3ed2add9c1504496; Termless vendor/ghostty-web/ghostty-wasm-api.patch constructs ResponseStream(ResponseHandler), feeds it, and ignores request_mode_unknown/clipboard_contents. Core src/terminal/osc.zig:941-975 parses OSC52 kind/data; stream.zig:2022-2026 dispatches clipboard_contents, which this WASM handler ignores without clipboard storage, host callback or reply append. Terminfo 27541ce40cea4baaaa5a34171ad059e08d295d19 packages/probe-defs/src/extensions.ts:1965-1988,2812-2814 seeds an isolated nonce and requires this read query to return it.",
      },
      "extensions.osc52-write": {
        query: "\u001b]52;c;?\u0007",
        kind: "no-reply-path",
        citation:
          "Ghostty WASM artifact d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9, core 5714ed07a1012573261b7b7e3ed2add9c1504496; Termless vendor/ghostty-web/ghostty-wasm-api.patch constructs ResponseStream(ResponseHandler), feeds it, and ignores request_mode_unknown/clipboard_contents. Core src/terminal/osc.zig:941-975 parses OSC52 kind/data; stream.zig:2022-2026 dispatches clipboard_contents, which this WASM handler ignores without clipboard storage, host callback or reply append. Terminfo 27541ce40cea4baaaa5a34171ad059e08d295d19 packages/probe-defs/src/extensions.ts:1942-1961,2801-2805 uses the nonce roundtrip callback; its necessary observation is this exact readback query, not standalone write success.",
      },
      "extensions.osc5522-clipboard": {
        query: "\u001b[?5522$p",
        kind: "no-reply-path",
        citation:
          "Ghostty WASM artifact d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9, core 5714ed07a1012573261b7b7e3ed2add9c1504496; Termless vendor/ghostty-web/ghostty-wasm-api.patch constructs ResponseStream(ResponseHandler), feeds it, and ignores request_mode_unknown/clipboard_contents. Terminfo 27541ce40cea4baaaa5a34171ad059e08d295d19 packages/probe-defs/src/extensions.ts:3164-3185 sends DECRQM ?5522$p only, never OSC5522. Core modes.zig:146-157,189-233 has no 5522 entry; stream.zig:1605-1613 dispatches request_mode_unknown, ignored by this WASM handler without a reply append.",
      },
      "extensions.kitty-graphics": {
        query: "\u001b_G",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 artifact d80a8110, core 5714ed07: termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream(ResponseHandler); core src/terminal/stream.zig:781-783 forwards APC; patch:586-591 ignores APC handlers, exposing no image state or graphics reply; display cannot complete its a=t allocation prerequisite",
      },
      "extensions.kitty-graphics.transmit": {
        query: "\u001b_G",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 artifact d80a8110, core 5714ed07: termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream(ResponseHandler); core src/terminal/stream.zig:781-783 forwards APC; patch:586-591 ignores APC handlers, exposing no image state or graphics reply; display cannot complete its a=t allocation prerequisite",
      },
      "extensions.kitty-graphics.display": {
        query: "\u001b_G",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 artifact d80a8110, core 5714ed07: termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream(ResponseHandler); core src/terminal/stream.zig:781-783 forwards APC; patch:586-591 ignores APC handlers, exposing no image state or graphics reply; display cannot complete its a=t allocation prerequisite",
      },
      "extensions.osc21-kitty-color": {
        query: "\u001b]21;foreground=?\u001b\\",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 artifact d80a8110, core 5714ed07: termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init -> src/terminal/stream.zig:497-501 Parser.init -> Parser.zig:230 osc_parser.init(null); osc.zig:845-851 rejects OSC21 without an allocator before any handler",
      },
      "extensions.sixel-geometry-report": {
        query: "\u001b[?2;1;0S",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 artifact d80a8110, core 5714ed07: src/terminal/parse_table.zig:324 collects '?' as a CSI intermediate, Parser.zig:312-320 retains it; stream.zig:1173-1188 handles S only without intermediates and ignores '?' before any handler; termless vendor/ghostty-web/ghostty-wasm-api.patch selects this stream",
      },
      "device.decrpm": {
        query: "\u001b[?7$p",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:594-595 no-op); ghostty 5714ed07 src/terminal/stream.zig:1583-1618 request_mode parses it",
      },
      "device.decrqss": {
        query: "\u001bP$qm\u001b\\",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM: termless vendor/ghostty-web/ghostty-wasm-api.patch Stream(ResponseHandler); ghostty 5714ed07 src/terminal/stream.zig:778-780 forwards raw DCS to the handler; patch:586-588 DCS handlers are no-ops; src/terminal/dcs.zig is not on this path",
      },
      "device.dsr-996-color-scheme": {
        query: "\u001b[?996n",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch 'Not supported in WASM context'); ghostty 5714ed07 src/terminal/stream.zig:1528-1556 device_status color_scheme parses it",
      },
      "device.primary-da": {
        query: "\u001b[c",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch device_attributes no-op); ghostty 5714ed07 src/terminal/stream.zig:1320-1338 device_attributes parses it",
      },
      "device.secondary-da": {
        query: "\u001b[>c",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch device_attributes no-op); ghostty 5714ed07 src/terminal/stream.zig:1320-1338 device_attributes parses it",
      },
      "device.tertiary-da": {
        query: "\u001b[=c",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch device_attributes no-op); ghostty 5714ed07 src/terminal/stream.zig:1320-1338 device_attributes parses it",
      },
      "device.xtgettcap": {
        query: "\u001bP+q544e\u001b\\",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM: termless vendor/ghostty-web/ghostty-wasm-api.patch Stream(ResponseHandler); ghostty 5714ed07 src/terminal/stream.zig:778-780 forwards raw DCS to the handler; patch:586-588 DCS handlers are no-ops; src/terminal/dcs.zig is not on this path",
      },
      "device.xtgetxres": {
        query: "\u001bP+Q7465726d4e616d65\u001b\\",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM drops the DCS (termless vendor/ghostty-web/ghostty-wasm-api.patch:586-588 dcs_* no-op); ghostty 5714ed07 src/terminal/dcs.zig:81-93 is not linked",
      },
      "device.xtreportcolors": {
        query: "\u001b[#R",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty 5714ed07 src/terminal/stream.zig:1977 no 'R' final: 'unimplemented CSI action'",
      },
      "device.xtversion": {
        query: "\u001b[>0q",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch xtversion no-op); ghostty 5714ed07 src/terminal/stream.zig:1676 xtversion parses it",
      },
      "device.xtwinops-14": {
        query: "\u001b[14t",
        kind: "no-reply-path",
        citation:
          "Ghostty WASM artifact d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9, core 5714ed07a1012573261b7b7e3ed2add9c1504496: ghostty 5714ed07 src/terminal/stream.zig:1797-1803 size_report csi_14_t parses it; termless vendor/ghostty-web/ghostty-wasm-api.patch size_report formats only .csi_18_t (copied from src/termio/Termio.zig:540-546) and leaves .csi_14_t silent",
      },
      "device.xtwinops-16": {
        query: "\u001b[16t",
        kind: "no-reply-path",
        citation:
          "Ghostty WASM artifact d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9, core 5714ed07a1012573261b7b7e3ed2add9c1504496: ghostty 5714ed07 src/terminal/stream.zig:1804-1810 size_report csi_16_t parses it; termless vendor/ghostty-web/ghostty-wasm-api.patch size_report formats only .csi_18_t (copied from src/termio/Termio.zig:540-546) and leaves .csi_16_t silent",
      },
      "device.xtwinops-20": {
        query: "\u001b[20t",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty 5714ed07 src/terminal/stream.zig:1844-1847 'ignoring CSI t with unimplemented parameter'",
      },
      "device.xtwinops-21": {
        query: "\u001b[21t",
        kind: "no-reply-path",
        citation:
          "Ghostty WASM artifact d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9, core 5714ed07a1012573261b7b7e3ed2add9c1504496: ghostty 5714ed07 src/terminal/stream.zig:1818-1824 size_report csi_21_t parses it; termless vendor/ghostty-web/ghostty-wasm-api.patch size_report formats only .csi_18_t (copied from src/termio/Termio.zig:540-546) and leaves .csi_21_t silent",
      },
      "editing.decrqcra": {
        query: "\u001b[1;1;1;1;1;5*y",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty 5714ed07 src/terminal/stream.zig:1977 no 'y' final: 'unimplemented CSI action'",
      },
      "extensions.osc10-fg-color": {
        query: "\u001b]10;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:604-607 rejects OSC 10 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc104-reset-palette": {
        query: "\u001b]4;0;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): seed query OSC 4: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:904-907 rejects OSC 4 with a null allocator, and OSC 104 itself is guarded the same way (osc.zig:626-629). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc11-bg-color": {
        query: "\u001b]11;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:645-648 rejects OSC 11 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc110-reset-fg": {
        query: "\u001b]10;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): seed query OSC 10: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:604-607 rejects OSC 10 with a null allocator, and OSC 110 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc111-reset-bg": {
        query: "\u001b]11;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): seed query OSC 11: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:645-648 rejects OSC 11 with a null allocator, and OSC 111 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc112-reset-cursor": {
        query: "\u001b]12;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): seed query OSC 12: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:690-693 rejects OSC 12 with a null allocator, and OSC 112 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc113-reset-pointer-fg": {
        query: "\u001b]13;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): seed query OSC 13: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:707-710 rejects OSC 13 with a null allocator, and OSC 113 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc114-reset-pointer-bg": {
        query: "\u001b]14;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): seed query OSC 14: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:730-733 rejects OSC 14 with a null allocator, and OSC 114 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc12-cursor-color": {
        query: "\u001b]12;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:690-693 rejects OSC 12 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc1337-capabilities": {
        query: "\u001b]1337;Capabilities\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty 5714ed07 src/terminal/osc.zig:723-726 @\"133\" + '7' -> invalid",
      },
      "extensions.osc1337-cellsize": {
        query: "\u001b]1337;ReportCellSize\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty 5714ed07 src/terminal/osc.zig:723-726 @\"133\" + '7' -> invalid",
      },
      "extensions.osc17-highlight-bg": {
        query: "\u001b]17;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:781-784 rejects OSC 17 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc19-highlight-fg": {
        query: "\u001b]19;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:815-818 rejects OSC 19 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc30001-color-stack-push": {
        query: "\u001b]10;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): the probe sends only the seed OSC 10 query: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:604-607 rejects OSC 10 with a null allocator. OSC 30001 itself, never sent, is outside the grammar (osc.zig:556-566 accepts no OSC number starting with 3). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc30101-color-stack-pop": {
        query: "\u001b]10;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): the probe sends only the seed OSC 10 query: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:604-607 rejects OSC 10 with a null allocator. OSC 30101 itself, never sent, is outside the grammar (osc.zig:556-566 accepts no OSC number starting with 3). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc4-palette": {
        query: "\u001b]4;0;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:904-907 rejects OSC 4 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc5-special-color": {
        query: "\u001b]5;0;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:923-926 rejects OSC 5 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc701-locale": {
        query: "\u001b]701;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty 5714ed07 src/terminal/osc.zig:979-990 @\"7\" + '0' -> invalid",
      },
      "extensions.osc702-version": {
        query: "\u001b]702;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty 5714ed07 src/terminal/osc.zig:979-990 @\"7\" + '0' -> invalid",
      },
      "extensions.osc776-cell-size": {
        query: "\u001b]776\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty 5714ed07 src/terminal/osc.zig:991-995 @\"77\" + '6' -> invalid",
      },
      "extensions.osc7770-font-size": {
        query: "\u001b]7770;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty 5714ed07 src/terminal/osc.zig:996-1002 @\"777\" + '0' -> invalid",
      },
      "extensions.osc7777-font-window-size": {
        query: "\u001b]7777;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty 5714ed07 src/terminal/osc.zig:996-1002 @\"777\" + '7' -> invalid",
      },
      "extensions.sixel-da1": {
        query: "\u001b[c",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the .window_title and .size_report (.csi_18_t) rebuild (31735): ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch device_attributes no-op); ghostty 5714ed07 src/terminal/stream.zig:1320-1338 device_attributes parses it",
      },
    },
  ],
  // Ghostty WASM URI-only rebuild (31385). Exact prior query bytes, matching and kinds retained; old rows stay unchanged.
  [
    "77b69f9f22c4126359be864fcce97afad8f84615053e21d335ba6348a8d3e1d7",
    {
      "extensions.osc99-kitty-notify": {
        query: "\u001b]99;",
        matches: "prefix",
        kind: "parser-rejected",
        citation:
          "Ghostty WASM77b69f9f, core5714ed07a1012573261b7b7e3ed2add9c1504496: src/terminal/osc.zig:556-565 puts first9 in state9; :1076-1081 accepts only semicolon there, so second9 invalidates OSC99; :554 clears complete and :1708-1714 returns null. Parser.zig:270-273 emits osc_dispatch only for nonnull commands. The actual WASM write path is Termless14912a2729d795b45579698abcdb92d4749f4ff1 vendor/ghostty-web/ghostty-wasm-api.patch:834-837 ResponseStream(ResponseHandler), :877 nextSlice; no notification action is reached. Audited family is Terminfo27541ce4 extensions.ts:3267-3312 capability query ESC]99;i=<nonce>:p=?;ST, not desktop delivery.",
      },
      "extensions.osc0-icon-title": {
        query: "\u001b[20t",
        kind: "parser-rejected",
        citation:
          "Ghostty WASM artifact 77b69f9f22c4126359be864fcce97afad8f84615053e21d335ba6348a8d3e1d7, core 5714ed07a1012573261b7b7e3ed2add9c1504496; Termless 14912a2729d795b45579698abcdb92d4749f4ff1 vendor/ghostty-web/ghostty-wasm-api.patch:834-837 constructs ResponseStream(ResponseHandler), :877 feeds it, :605-617 ignores request_mode_unknown/size_report/clipboard_contents. Core src/terminal/stream.zig:1793-1849 XTWINOPS accepts 14/16/18/21 and 22/23, but 20 reaches the unimplemented-parameter arm before any handler. Terminfo 27541ce40cea4baaaa5a34171ad059e08d295d19 packages/probe-defs/src/extensions.ts:2245-2254,2759-2770 requires BOTH icon20 and title21 exact payload replies; icon20 is necessary. Title21 separately dispatches size_report (:1819-1821), ignored by this WASM handler.",
      },
      "extensions.osc52-clipboard": {
        query: "\u001b]52;c;?\u0007",
        kind: "no-reply-path",
        citation:
          "Ghostty WASM artifact 77b69f9f22c4126359be864fcce97afad8f84615053e21d335ba6348a8d3e1d7, core 5714ed07a1012573261b7b7e3ed2add9c1504496; Termless 14912a2729d795b45579698abcdb92d4749f4ff1 vendor/ghostty-web/ghostty-wasm-api.patch:834-837 constructs ResponseStream(ResponseHandler), :877 feeds it, :605-617 ignores request_mode_unknown/size_report/clipboard_contents. Core src/terminal/osc.zig:941-975 parses OSC52 kind/data; stream.zig:2022-2026 dispatches clipboard_contents, which this WASM handler ignores without clipboard storage, host callback or reply append. Terminfo 27541ce40cea4baaaa5a34171ad059e08d295d19 packages/probe-defs/src/extensions.ts:1942-1961,2789-2793 requires exact nonce roundtrip via this read query, not write consumption.",
      },
      "extensions.osc52-read": {
        query: "\u001b]52;c;?\u0007",
        kind: "no-reply-path",
        citation:
          "Ghostty WASM artifact 77b69f9f22c4126359be864fcce97afad8f84615053e21d335ba6348a8d3e1d7, core 5714ed07a1012573261b7b7e3ed2add9c1504496; Termless 14912a2729d795b45579698abcdb92d4749f4ff1 vendor/ghostty-web/ghostty-wasm-api.patch:834-837 constructs ResponseStream(ResponseHandler), :877 feeds it, :605-617 ignores request_mode_unknown/size_report/clipboard_contents. Core src/terminal/osc.zig:941-975 parses OSC52 kind/data; stream.zig:2022-2026 dispatches clipboard_contents, which this WASM handler ignores without clipboard storage, host callback or reply append. Terminfo 27541ce40cea4baaaa5a34171ad059e08d295d19 packages/probe-defs/src/extensions.ts:1965-1988,2812-2814 seeds an isolated nonce and requires this read query to return it.",
      },
      "extensions.osc52-write": {
        query: "\u001b]52;c;?\u0007",
        kind: "no-reply-path",
        citation:
          "Ghostty WASM artifact 77b69f9f22c4126359be864fcce97afad8f84615053e21d335ba6348a8d3e1d7, core 5714ed07a1012573261b7b7e3ed2add9c1504496; Termless 14912a2729d795b45579698abcdb92d4749f4ff1 vendor/ghostty-web/ghostty-wasm-api.patch:834-837 constructs ResponseStream(ResponseHandler), :877 feeds it, :605-617 ignores request_mode_unknown/size_report/clipboard_contents. Core src/terminal/osc.zig:941-975 parses OSC52 kind/data; stream.zig:2022-2026 dispatches clipboard_contents, which this WASM handler ignores without clipboard storage, host callback or reply append. Terminfo 27541ce40cea4baaaa5a34171ad059e08d295d19 packages/probe-defs/src/extensions.ts:1942-1961,2801-2805 uses the nonce roundtrip callback; its necessary observation is this exact readback query, not standalone write success.",
      },
      "extensions.osc5522-clipboard": {
        query: "\u001b[?5522$p",
        kind: "no-reply-path",
        citation:
          "Ghostty WASM artifact 77b69f9f22c4126359be864fcce97afad8f84615053e21d335ba6348a8d3e1d7, core 5714ed07a1012573261b7b7e3ed2add9c1504496; Termless 14912a2729d795b45579698abcdb92d4749f4ff1 vendor/ghostty-web/ghostty-wasm-api.patch:834-837 constructs ResponseStream(ResponseHandler), :877 feeds it, :605-617 ignores request_mode_unknown/size_report/clipboard_contents. Terminfo 27541ce40cea4baaaa5a34171ad059e08d295d19 packages/probe-defs/src/extensions.ts:3164-3185 sends DECRQM ?5522$p only, never OSC5522. Core modes.zig:146-157,189-233 has no 5522 entry; stream.zig:1605-1613 dispatches request_mode_unknown, ignored by this WASM handler without a reply append.",
      },
      "extensions.kitty-graphics": {
        query: "\u001b_G",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 artifact7c43302d, core5714ed07: termless vendor/ghostty-web/ghostty-wasm-api.patch:697 ResponseStream(ResponseHandler), :824-827 constructs, :867 feeds; core src/terminal/stream.zig:781-783 forwards APC; patch:589-591/:607 ignores APC handlers, exposing no image state or graphics reply; display cannot complete its a=t allocation prerequisite",
      },
      "extensions.kitty-graphics.transmit": {
        query: "\u001b_G",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 artifact7c43302d, core5714ed07: termless vendor/ghostty-web/ghostty-wasm-api.patch:697 ResponseStream(ResponseHandler), :824-827 constructs, :867 feeds; core src/terminal/stream.zig:781-783 forwards APC; patch:589-591/:607 ignores APC handlers, exposing no image state or graphics reply; display cannot complete its a=t allocation prerequisite",
      },
      "extensions.kitty-graphics.display": {
        query: "\u001b_G",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 artifact7c43302d, core5714ed07: termless vendor/ghostty-web/ghostty-wasm-api.patch:697 ResponseStream(ResponseHandler), :824-827 constructs, :867 feeds; core src/terminal/stream.zig:781-783 forwards APC; patch:589-591/:607 ignores APC handlers, exposing no image state or graphics reply; display cannot complete its a=t allocation prerequisite",
      },
      "extensions.osc21-kitty-color": {
        query: "\u001b]21;foreground=?\u001b\\",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 artifact7c43302d, core5714ed07: termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init -> src/terminal/stream.zig:497-501 Parser.init -> Parser.zig:230 osc_parser.init(null); osc.zig:845-851 rejects OSC21 without an allocator before any handler",
      },
      "extensions.sixel-geometry-report": {
        query: "\u001b[?2;1;0S",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 artifact7c43302d, core5714ed07: src/terminal/parse_table.zig:324 collects '?' as a CSI intermediate, Parser.zig:312-320 retains it; stream.zig:1173-1188 handles S only without intermediates and ignores '?' before any handler; termless vendor/ghostty-web/ghostty-wasm-api.patch:827 selects this stream",
      },
      "device.decrpm": {
        query: "\u001b[?7$p",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:594-595 no-op); ghostty 5714ed07 src/terminal/stream.zig:1583-1618 request_mode parses it",
      },
      "device.decrqss": {
        query: "\u001bP$qm\u001b\\",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM: termless vendor/ghostty-web/ghostty-wasm-api.patch:697 Stream(ResponseHandler), :824/:827 construct, :867 feed; ghostty 5714ed07 src/terminal/stream.zig:778-780 forwards raw DCS to the handler; patch:586-588/:607 DCS handlers are no-ops; src/terminal/dcs.zig is not on this path",
      },
      "device.dsr-996-color-scheme": {
        query: "\u001b[?996n",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:634-636 'Not supported in WASM context'); ghostty 5714ed07 src/terminal/stream.zig:1528-1556 device_status color_scheme parses it",
      },
      "device.primary-da": {
        query: "\u001b[c",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:598 no-op); ghostty 5714ed07 src/terminal/stream.zig:1320-1338 device_attributes parses it",
      },
      "device.secondary-da": {
        query: "\u001b[>c",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:598 no-op); ghostty 5714ed07 src/terminal/stream.zig:1320-1338 device_attributes parses it",
      },
      "device.tertiary-da": {
        query: "\u001b[=c",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:598 no-op); ghostty 5714ed07 src/terminal/stream.zig:1320-1338 device_attributes parses it",
      },
      "device.xtgettcap": {
        query: "\u001bP+q544e\u001b\\",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM: termless vendor/ghostty-web/ghostty-wasm-api.patch:697 Stream(ResponseHandler), :824/:827 construct, :867 feed; ghostty 5714ed07 src/terminal/stream.zig:778-780 forwards raw DCS to the handler; patch:586-588/:607 DCS handlers are no-ops; src/terminal/dcs.zig is not on this path",
      },
      "device.xtgetxres": {
        query: "\u001bP+Q7465726d4e616d65\u001b\\",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM drops the DCS (termless vendor/ghostty-web/ghostty-wasm-api.patch:586-588 dcs_* no-op); ghostty 5714ed07 src/terminal/dcs.zig:81-93 is not linked",
      },
      "device.xtreportcolors": {
        query: "\u001b[#R",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty 5714ed07 src/terminal/stream.zig:1977 no 'R' final: 'unimplemented CSI action'",
      },
      "device.xtversion": {
        query: "\u001b[>0q",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:597 no-op); ghostty 5714ed07 src/terminal/stream.zig:1676 xtversion parses it",
      },
      "device.xtwinops-14": {
        query: "\u001b[14t",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:596 no-op); ghostty 5714ed07 src/terminal/stream.zig:1797-1803 size_report csi_14_t parses it",
      },
      "device.xtwinops-16": {
        query: "\u001b[16t",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:596 no-op); ghostty 5714ed07 src/terminal/stream.zig:1804-1810 size_report csi_16_t parses it",
      },
      "device.xtwinops-18": {
        query: "\u001b[18t",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:596 no-op); ghostty 5714ed07 src/terminal/stream.zig:1811-1817 size_report csi_18_t parses it",
      },
      "device.xtwinops-20": {
        query: "\u001b[20t",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty 5714ed07 src/terminal/stream.zig:1844-1847 'ignoring CSI t with unimplemented parameter'",
      },
      "device.xtwinops-21": {
        query: "\u001b[21t",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:596 no-op); ghostty 5714ed07 src/terminal/stream.zig:1818-1824 size_report csi_21_t parses it",
      },
      "editing.decrqcra": {
        query: "\u001b[1;1;1;1;1;5*y",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty 5714ed07 src/terminal/stream.zig:1977 no 'y' final: 'unimplemented CSI action'",
      },
      "extensions.osc10-fg-color": {
        query: "\u001b]10;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:604-607 rejects OSC 10 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc104-reset-palette": {
        query: "\u001b]4;0;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: seed query OSC 4: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:904-907 rejects OSC 4 with a null allocator, and OSC 104 itself is guarded the same way (osc.zig:626-629). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc11-bg-color": {
        query: "\u001b]11;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:645-648 rejects OSC 11 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc110-reset-fg": {
        query: "\u001b]10;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: seed query OSC 10: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:604-607 rejects OSC 10 with a null allocator, and OSC 110 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc111-reset-bg": {
        query: "\u001b]11;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: seed query OSC 11: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:645-648 rejects OSC 11 with a null allocator, and OSC 111 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc112-reset-cursor": {
        query: "\u001b]12;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: seed query OSC 12: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:690-693 rejects OSC 12 with a null allocator, and OSC 112 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc113-reset-pointer-fg": {
        query: "\u001b]13;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: seed query OSC 13: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:707-710 rejects OSC 13 with a null allocator, and OSC 113 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc114-reset-pointer-bg": {
        query: "\u001b]14;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: seed query OSC 14: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:730-733 rejects OSC 14 with a null allocator, and OSC 114 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc12-cursor-color": {
        query: "\u001b]12;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:690-693 rejects OSC 12 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc1337-capabilities": {
        query: "\u001b]1337;Capabilities\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty 5714ed07 src/terminal/osc.zig:723-726 @\"133\" + '7' -> invalid",
      },
      "extensions.osc1337-cellsize": {
        query: "\u001b]1337;ReportCellSize\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty 5714ed07 src/terminal/osc.zig:723-726 @\"133\" + '7' -> invalid",
      },
      "extensions.osc17-highlight-bg": {
        query: "\u001b]17;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:781-784 rejects OSC 17 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc19-highlight-fg": {
        query: "\u001b]19;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:815-818 rejects OSC 19 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc30001-color-stack-push": {
        query: "\u001b]10;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: the probe sends only the seed OSC 10 query: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:604-607 rejects OSC 10 with a null allocator. OSC 30001 itself, never sent, is outside the grammar (osc.zig:556-566 accepts no OSC number starting with 3). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc30101-color-stack-pop": {
        query: "\u001b]10;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: the probe sends only the seed OSC 10 query: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:604-607 rejects OSC 10 with a null allocator. OSC 30101 itself, never sent, is outside the grammar (osc.zig:556-566 accepts no OSC number starting with 3). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc4-palette": {
        query: "\u001b]4;0;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:904-907 rejects OSC 4 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc5-special-color": {
        query: "\u001b]5;0;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:923-926 rejects OSC 5 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc701-locale": {
        query: "\u001b]701;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty 5714ed07 src/terminal/osc.zig:979-990 @\"7\" + '0' -> invalid",
      },
      "extensions.osc702-version": {
        query: "\u001b]702;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty 5714ed07 src/terminal/osc.zig:979-990 @\"7\" + '0' -> invalid",
      },
      "extensions.osc776-cell-size": {
        query: "\u001b]776\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty 5714ed07 src/terminal/osc.zig:991-995 @\"77\" + '6' -> invalid",
      },
      "extensions.osc7770-font-size": {
        query: "\u001b]7770;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty 5714ed07 src/terminal/osc.zig:996-1002 @\"777\" + '0' -> invalid",
      },
      "extensions.osc7777-font-window-size": {
        query: "\u001b]7777;?\u0007",
        kind: "parser-rejected",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty 5714ed07 src/terminal/osc.zig:996-1002 @\"777\" + '7' -> invalid",
      },
      "extensions.sixel-da1": {
        query: "\u001b[c",
        kind: "no-reply-path",
        citation:
          "Query path unchanged by the URI-only export: source audit at Termless 58fc8c4759d36d4c70530f04fdef4e14f90a7a0d (core 5714ed07), including the following pinned patch locations: ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:598 no-op); ghostty 5714ed07 src/terminal/stream.zig:1320-1338 device_attributes parses it",
      },
    },
  ],
  // Ghostty native overline-only rebuild at Termless b1a7e445 (31399); receipt native tree03033e2d.
  // Cell overline projection changes no parser/reply path from the cited 5afcc676 source audit.
  // Same core 332b2aef; all applicable prior audits retained, including the three graphics prefix rows (31377).
  [
    "d70f2f8adb5dfcb6a7d75d23e11a60ba3671844b930a3f66970a709f65ee1346",
    {
      "extensions.osc99-kitty-notify": {
        query: "\u001b]99;",
        matches: "prefix",
        kind: "parser-rejected",
        citation:
          "Ghostty natived70f2f8a, core332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28: src/terminal/osc.zig:501-512 puts first9 in state9; :672-680 accepts only semicolon in that state, so second9 invalidates OSC99; :481-484 discards later bytes and :691-695 returns null. Parser.zig:270-273 emits osc_dispatch only for nonnull commands. Termless14912a2729d795b45579698abcdb92d4749f4ff1 packages/ghostty-native/native/src/main.zig:80 uses Terminal.vtStream; this core Terminal.zig:260-265 selects ReadonlyStream, but no action reaches that handler for OSC99. Audited family is Terminfo27541ce4 extensions.ts:3267-3312 capability query ESC]99;i=<nonce>:p=?;ST, not OSC9 or desktop delivery.",
      },
      "device.xtgetxres": {
        query: "\u001bP+Q7465726d4e616d65\u001b\\",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef src/terminal/Terminal.zig:264 ReadonlyStream; stream.zig:733-735 forwards dcs_hook/put/unhook to the handler; stream_readonly.zig:161-166 ignores all three (dcs.zig:80-93 is not linked)",
      },
      "extensions.osc1337-capabilities": {
        query: "\u001b]1337;Capabilities\u0007",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc/parsers/iterm2.zig:11-62 Key/map omit Capabilities; :87-90 missing key -> invalid",
      },
      "extensions.osc1337-cellsize": {
        query: "\u001b]1337;ReportCellSize\u0007",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc/parsers/iterm2.zig:177-195 known ReportCellSize key is unimplemented -> invalid",
      },
      "extensions.osc701-locale": {
        query: "\u001b]701;?\u0007",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:637-646 state7 accepts only ';' or '7'; '0' -> invalid",
      },
      "extensions.osc702-version": {
        query: "\u001b]702;?\u0007",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:637-646 state7 accepts only ';' or '7'; '0' -> invalid",
      },
      "extensions.osc776-cell-size": {
        query: "\u001b]776\u0007",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:643-646 state77 accepts only '7'; '6' -> invalid",
      },
      "extensions.osc7770-font-size": {
        query: "\u001b]7770;?\u0007",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:674-681 state777 accepts only ';'; '0' -> invalid",
      },
      "extensions.osc7777-font-window-size": {
        query: "\u001b]7777;?\u0007",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:674-681 state777 accepts only ';'; '7' -> invalid",
      },
      "cursor.position-report": {
        query: "\u001b[6n",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 device_status.zig64-66 recognizes5/6/?996; stream.zig1490-1514 dispatches device_status; readonly183 ignores",
      },
      "device.decrpm": {
        query: "\u001b[?7$p",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1550-1576 parses?7$p (mode wraparound); readonly178-179 ignores request_mode/request_mode_unknown",
      },
      "device.decrqss": {
        query: "\u001bP$qm\u001b\\",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 -> ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig:264-265 ReadonlyStream.initAlloc; stream.zig:733-735 raw DCS hook/put/unhook forwarded to readonly161-166 ignored; full dcs.zig parser not reached",
      },
      "device.dsr-996-color-scheme": {
        query: "\u001b[?996n",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 device_status.zig64-66 recognizes5/6/?996; stream.zig1490-1514 dispatches device_status; readonly183 ignores",
      },
      "device.primary-da": {
        query: "\u001b[c",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1278-1291 parses DA finalc and prefixes; readonly182 ignores device_attributes; source table cannot infer DA1 attribute4 from no reply",
      },
      "device.secondary-da": {
        query: "\u001b[>c",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1278-1291 parses DA finalc and prefixes; readonly182 ignores device_attributes; source table cannot infer DA1 attribute4 from no reply",
      },
      "device.status-report": {
        query: "\u001b[5n",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 device_status.zig64-66 recognizes5/6/?996; stream.zig1490-1514 dispatches device_status; readonly183 ignores",
      },
      "device.tertiary-da": {
        query: "\u001b[=c",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1278-1291 parses DA finalc and prefixes; readonly182 ignores device_attributes; source table cannot infer DA1 attribute4 from no reply",
      },
      "device.xtgettcap": {
        query: "\u001bP+q544e\u001b\\",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 -> ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig:264-265 ReadonlyStream.initAlloc; stream.zig:733-735 raw DCS hook/put/unhook forwarded to readonly161-166 ignored; full dcs.zig parser not reached",
      },
      "device.xtreportcolors": {
        query: "\u001b[#R",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/stream.zig CSI dispatch has no final R prong; :1938 unimplemented CSI action, before handler dispatch",
      },
      "device.xtversion": {
        query: "\u001b[>0q",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig:1636-1637 parses CSI>0q as xtversion; readonly181 ignores",
      },
      "device.xtwinops-14": {
        query: "\u001b[14t",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1755-1790 explicitly dispatches this XTWINOPS parameter as size_report; readonly180 ignores",
      },
      "device.xtwinops-16": {
        query: "\u001b[16t",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1755-1790 explicitly dispatches this XTWINOPS parameter as size_report; readonly180 ignores",
      },
      "device.xtwinops-18": {
        query: "\u001b[18t",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1755-1790 explicitly dispatches this XTWINOPS parameter as size_report; readonly180 ignores",
      },
      "device.xtwinops-20": {
        query: "\u001b[20t",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/stream.zig:1755-1820 XTWINOPS handles14/16/18/21,22/23 only;20 ->unimplemented parameter before handler. ",
      },
      "device.xtwinops-21": {
        query: "\u001b[21t",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1755-1790 explicitly dispatches this XTWINOPS parameter as size_report; readonly180 ignores",
      },
      "editing.decrqcra": {
        query: "\u001b[1;1;1;1;1;5*y",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/stream.zig CSI dispatch has no final y prong; :1938 unimplemented CSI action, before handler dispatch",
      },
      "extensions.osc10-fg-color": {
        query: "\u001b]10;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc11-bg-color": {
        query: "\u001b]11;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc12-cursor-color": {
        query: "\u001b]12;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc17-highlight-bg": {
        query: "\u001b]17;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc19-highlight-fg": {
        query: "\u001b]19;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc4-palette": {
        query: "\u001b]4;0;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc5-special-color": {
        query: "\u001b]5;0;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.sixel-da1": {
        query: "\u001b[c",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1278-1291 parses DA finalc and prefixes; readonly182 ignores device_attributes; source table cannot infer DA1 attribute4 from no reply",
      },
      "extensions.osc52-clipboard": {
        query: "\u001b]52;c;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 osc52 parses clipboard_contents, stream.zig1987-1992 dispatches clipboard_contents; readonly189 ignores; no clipboard host/readback is exposed in this native product. Criterion is exact nonce roundtrip/read query, not standalone write.",
      },
      "extensions.osc52-read": {
        query: "\u001b]52;c;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 osc52 parses clipboard_contents, stream.zig1987-1992 dispatches clipboard_contents; readonly189 ignores; no clipboard host/readback is exposed in this native product. Criterion is exact nonce roundtrip/read query, not standalone write.",
      },
      "extensions.osc52-write": {
        query: "\u001b]52;c;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 osc52 parses clipboard_contents, stream.zig1987-1992 dispatches clipboard_contents; readonly189 ignores; no clipboard host/readback is exposed in this native product. Criterion is exact nonce roundtrip/read query, not standalone write.",
      },
      "extensions.osc5522-clipboard": {
        query: "\u001b[?5522$p",
        kind: "no-reply-path",
        citation:
          "terminfo7587293850a871e062bf94aade5d52129883fb8a extensions.ts3065-3080 sends DECRQM?5522$p only; ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 modes.zig:146-159,189-234 has no5522 entry; stream.zig1567-1576 dispatches request_mode_unknown; readonly178-179 ignores. No OSC5522 command is attempted.",
      },
      "extensions.osc0-icon-title": {
        query: "\u001b[20t",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/stream.zig:1755-1820 XTWINOPS handles14/16/18/21,22/23 only;20 ->unimplemented parameter before handler. This feature requires BOTH20 and21 exact payload replies;20 is necessary;21 dispatches size_report and is separately ignored.",
      },
      "extensions.osc30001-color-stack-push": {
        query: "\u001b]30001\u001b\\",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc.zig:515-533 state3 ->30 ->300 accepts only8; OSC30001 rejects0 at state300 before a handler",
      },
      "extensions.osc30101-color-stack-pop": {
        query: "\u001b]30101\u001b\\",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc.zig:515-533 state3 ->30 accepts only0; OSC30101 rejects1 at state30 before a handler",
      },
      "extensions.kitty-graphics": {
        query: "\u001b_G",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:260-265 ReadonlyStream; stream.zig:736-738 forwards APC; stream_readonly.zig:168-173 ignores apc_start/apc_put/apc_end; native exports main.zig:48-65 provide no image-state or reply observer",
      },
      "extensions.kitty-graphics.transmit": {
        query: "\u001b_G",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:260-265 ReadonlyStream; stream.zig:736-738 forwards APC; stream_readonly.zig:168-173 ignores apc_start/apc_put/apc_end; native exports main.zig:48-65 provide no image-state or reply observer",
      },
      "extensions.kitty-graphics.display": {
        query: "\u001b_G",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:260-265 ReadonlyStream; stream.zig:736-738 forwards APC; stream_readonly.zig:168-173 ignores apc_start/apc_put/apc_end; native exports main.zig:48-65 provide no image-state or reply observer",
      },
      "extensions.kitty-keyboard": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "extensions.kitty-keyboard.disambiguate": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "extensions.kitty-keyboard.report-events": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "extensions.kitty-keyboard.report-alternate": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "extensions.kitty-keyboard.report-all-keys": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "extensions.kitty-keyboard.report-text": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "input.csi-u": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "extensions.osc21-kitty-color": {
        query: "\u001b]21;foreground=?\u001b\\",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264-265 initAlloc; stream.zig:2018-2019 dispatches kitty_color_report; stream_readonly.zig:159 calls kittyColorOperation but :362-399 ignores .query while retaining set/reset; native getDefaultColors :571 exposes RGB state, not a protocol reply",
      },
      "extensions.sixel-geometry-report": {
        query: "\u001b[?2;1;0S",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/parse_table.zig:324 collects '?' as CSI intermediate (Parser.zig:313-321); stream.zig:1128-1142 handles final S only without intermediates and ignores XTSMGRAPHICS '?' before any handler; termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 uses this stream",
      },
    },
  ],
  // Ghostty native rebuilt at Termless 5afcc676 (31385): URI/default/underline cell readback changes no readonly reply route.
  // Same core 332b2aef; all applicable prior audits retained, including the three graphics prefix rows (31377).
  [
    "8872ab0fc56429489b52cd5d3b5a293032c3ec7dbbb71545d237945c3ef525f3",
    {
      "extensions.osc99-kitty-notify": {
        query: "\u001b]99;",
        matches: "prefix",
        kind: "parser-rejected",
        citation:
          "Ghostty native8872ab0f, core332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28: src/terminal/osc.zig:501-512 puts first9 in state9; :672-680 accepts only semicolon in that state, so second9 invalidates OSC99; :481-484 discards later bytes and :691-695 returns null. Parser.zig:270-273 emits osc_dispatch only for nonnull commands. Termless14912a2729d795b45579698abcdb92d4749f4ff1 packages/ghostty-native/native/src/main.zig:80 uses Terminal.vtStream; this core Terminal.zig:260-265 selects ReadonlyStream, but no action reaches that handler for OSC99. Audited family is Terminfo27541ce4 extensions.ts:3267-3312 capability query ESC]99;i=<nonce>:p=?;ST, not OSC9 or desktop delivery.",
      },
      "device.xtgetxres": {
        query: "\u001bP+Q7465726d4e616d65\u001b\\",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef src/terminal/Terminal.zig:264 ReadonlyStream; stream.zig:733-735 forwards dcs_hook/put/unhook to the handler; stream_readonly.zig:161-166 ignores all three (dcs.zig:80-93 is not linked)",
      },
      "extensions.osc1337-capabilities": {
        query: "\u001b]1337;Capabilities\u0007",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc/parsers/iterm2.zig:11-62 Key/map omit Capabilities; :87-90 missing key -> invalid",
      },
      "extensions.osc1337-cellsize": {
        query: "\u001b]1337;ReportCellSize\u0007",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc/parsers/iterm2.zig:177-195 known ReportCellSize key is unimplemented -> invalid",
      },
      "extensions.osc701-locale": {
        query: "\u001b]701;?\u0007",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:637-646 state7 accepts only ';' or '7'; '0' -> invalid",
      },
      "extensions.osc702-version": {
        query: "\u001b]702;?\u0007",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:637-646 state7 accepts only ';' or '7'; '0' -> invalid",
      },
      "extensions.osc776-cell-size": {
        query: "\u001b]776\u0007",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:643-646 state77 accepts only '7'; '6' -> invalid",
      },
      "extensions.osc7770-font-size": {
        query: "\u001b]7770;?\u0007",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:674-681 state777 accepts only ';'; '0' -> invalid",
      },
      "extensions.osc7777-font-window-size": {
        query: "\u001b]7777;?\u0007",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:674-681 state777 accepts only ';'; '7' -> invalid",
      },
      "cursor.position-report": {
        query: "\u001b[6n",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 device_status.zig64-66 recognizes5/6/?996; stream.zig1490-1514 dispatches device_status; readonly183 ignores",
      },
      "device.decrpm": {
        query: "\u001b[?7$p",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1550-1576 parses?7$p (mode wraparound); readonly178-179 ignores request_mode/request_mode_unknown",
      },
      "device.decrqss": {
        query: "\u001bP$qm\u001b\\",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 -> ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig:264-265 ReadonlyStream.initAlloc; stream.zig:733-735 raw DCS hook/put/unhook forwarded to readonly161-166 ignored; full dcs.zig parser not reached",
      },
      "device.dsr-996-color-scheme": {
        query: "\u001b[?996n",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 device_status.zig64-66 recognizes5/6/?996; stream.zig1490-1514 dispatches device_status; readonly183 ignores",
      },
      "device.primary-da": {
        query: "\u001b[c",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1278-1291 parses DA finalc and prefixes; readonly182 ignores device_attributes; source table cannot infer DA1 attribute4 from no reply",
      },
      "device.secondary-da": {
        query: "\u001b[>c",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1278-1291 parses DA finalc and prefixes; readonly182 ignores device_attributes; source table cannot infer DA1 attribute4 from no reply",
      },
      "device.status-report": {
        query: "\u001b[5n",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 device_status.zig64-66 recognizes5/6/?996; stream.zig1490-1514 dispatches device_status; readonly183 ignores",
      },
      "device.tertiary-da": {
        query: "\u001b[=c",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1278-1291 parses DA finalc and prefixes; readonly182 ignores device_attributes; source table cannot infer DA1 attribute4 from no reply",
      },
      "device.xtgettcap": {
        query: "\u001bP+q544e\u001b\\",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 -> ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig:264-265 ReadonlyStream.initAlloc; stream.zig:733-735 raw DCS hook/put/unhook forwarded to readonly161-166 ignored; full dcs.zig parser not reached",
      },
      "device.xtreportcolors": {
        query: "\u001b[#R",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/stream.zig CSI dispatch has no final R prong; :1938 unimplemented CSI action, before handler dispatch",
      },
      "device.xtversion": {
        query: "\u001b[>0q",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig:1636-1637 parses CSI>0q as xtversion; readonly181 ignores",
      },
      "device.xtwinops-14": {
        query: "\u001b[14t",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1755-1790 explicitly dispatches this XTWINOPS parameter as size_report; readonly180 ignores",
      },
      "device.xtwinops-16": {
        query: "\u001b[16t",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1755-1790 explicitly dispatches this XTWINOPS parameter as size_report; readonly180 ignores",
      },
      "device.xtwinops-18": {
        query: "\u001b[18t",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1755-1790 explicitly dispatches this XTWINOPS parameter as size_report; readonly180 ignores",
      },
      "device.xtwinops-20": {
        query: "\u001b[20t",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/stream.zig:1755-1820 XTWINOPS handles14/16/18/21,22/23 only;20 ->unimplemented parameter before handler. ",
      },
      "device.xtwinops-21": {
        query: "\u001b[21t",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1755-1790 explicitly dispatches this XTWINOPS parameter as size_report; readonly180 ignores",
      },
      "editing.decrqcra": {
        query: "\u001b[1;1;1;1;1;5*y",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/stream.zig CSI dispatch has no final y prong; :1938 unimplemented CSI action, before handler dispatch",
      },
      "extensions.osc10-fg-color": {
        query: "\u001b]10;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc11-bg-color": {
        query: "\u001b]11;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc12-cursor-color": {
        query: "\u001b]12;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc17-highlight-bg": {
        query: "\u001b]17;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc19-highlight-fg": {
        query: "\u001b]19;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc4-palette": {
        query: "\u001b]4;0;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc5-special-color": {
        query: "\u001b]5;0;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.sixel-da1": {
        query: "\u001b[c",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1278-1291 parses DA finalc and prefixes; readonly182 ignores device_attributes; source table cannot infer DA1 attribute4 from no reply",
      },
      "extensions.osc52-clipboard": {
        query: "\u001b]52;c;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 osc52 parses clipboard_contents, stream.zig1987-1992 dispatches clipboard_contents; readonly189 ignores; no clipboard host/readback is exposed in this native product. Criterion is exact nonce roundtrip/read query, not standalone write.",
      },
      "extensions.osc52-read": {
        query: "\u001b]52;c;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 osc52 parses clipboard_contents, stream.zig1987-1992 dispatches clipboard_contents; readonly189 ignores; no clipboard host/readback is exposed in this native product. Criterion is exact nonce roundtrip/read query, not standalone write.",
      },
      "extensions.osc52-write": {
        query: "\u001b]52;c;?\u0007",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 osc52 parses clipboard_contents, stream.zig1987-1992 dispatches clipboard_contents; readonly189 ignores; no clipboard host/readback is exposed in this native product. Criterion is exact nonce roundtrip/read query, not standalone write.",
      },
      "extensions.osc5522-clipboard": {
        query: "\u001b[?5522$p",
        kind: "no-reply-path",
        citation:
          "terminfo7587293850a871e062bf94aade5d52129883fb8a extensions.ts3065-3080 sends DECRQM?5522$p only; ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 modes.zig:146-159,189-234 has no5522 entry; stream.zig1567-1576 dispatches request_mode_unknown; readonly178-179 ignores. No OSC5522 command is attempted.",
      },
      "extensions.osc0-icon-title": {
        query: "\u001b[20t",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/stream.zig:1755-1820 XTWINOPS handles14/16/18/21,22/23 only;20 ->unimplemented parameter before handler. This feature requires BOTH20 and21 exact payload replies;20 is necessary;21 dispatches size_report and is separately ignored.",
      },
      "extensions.osc30001-color-stack-push": {
        query: "\u001b]30001\u001b\\",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc.zig:515-533 state3 ->30 ->300 accepts only8; OSC30001 rejects0 at state300 before a handler",
      },
      "extensions.osc30101-color-stack-pop": {
        query: "\u001b]30101\u001b\\",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc.zig:515-533 state3 ->30 accepts only0; OSC30101 rejects1 at state30 before a handler",
      },
      "extensions.kitty-graphics": {
        query: "\u001b_G",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:260-265 ReadonlyStream; stream.zig:736-738 forwards APC; stream_readonly.zig:168-173 ignores apc_start/apc_put/apc_end; native exports main.zig:48-65 provide no image-state or reply observer",
      },
      "extensions.kitty-graphics.transmit": {
        query: "\u001b_G",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:260-265 ReadonlyStream; stream.zig:736-738 forwards APC; stream_readonly.zig:168-173 ignores apc_start/apc_put/apc_end; native exports main.zig:48-65 provide no image-state or reply observer",
      },
      "extensions.kitty-graphics.display": {
        query: "\u001b_G",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:260-265 ReadonlyStream; stream.zig:736-738 forwards APC; stream_readonly.zig:168-173 ignores apc_start/apc_put/apc_end; native exports main.zig:48-65 provide no image-state or reply observer",
      },
      "extensions.kitty-keyboard": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "extensions.kitty-keyboard.disambiguate": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "extensions.kitty-keyboard.report-events": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "extensions.kitty-keyboard.report-alternate": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "extensions.kitty-keyboard.report-all-keys": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "extensions.kitty-keyboard.report-text": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "input.csi-u": {
        query: "\u001b[?u\u001b[c",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264 ReadonlyStream; stream.zig:1828 parses kitty_keyboard_query and :1278-1292 device_attributes; stream_readonly.zig:139-143 retains keyboard flags but :176-190 ignores both queries without a writer",
      },
      "extensions.osc21-kitty-color": {
        query: "\u001b]21;foreground=?\u001b\\",
        kind: "no-reply-path",
        citation:
          "termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 vtStream() -> ghostty 332b2aef Terminal.zig:264-265 initAlloc; stream.zig:2018-2019 dispatches kitty_color_report; stream_readonly.zig:159 calls kittyColorOperation but :362-399 ignores .query while retaining set/reset; native getDefaultColors :571 exposes RGB state, not a protocol reply",
      },
      "extensions.sixel-geometry-report": {
        query: "\u001b[?2;1;0S",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/parse_table.zig:324 collects '?' as CSI intermediate (Parser.zig:313-321); stream.zig:1128-1142 handles final S only without intermediates and ignores XTSMGRAPHICS '?' before any handler; termless 5afcc676 packages/ghostty-native/native/src/main.zig:80 uses this stream",
      },
    },
  ],
  // Ghostty native 1.3.1, native tree45cbad88: independently loaded artifact in run2e689eee.
  [
    "17d155feee5df8fa30266b9a354bbe66e39484d08218de5e03dc3bb2f199a0a3",
    {
      "extensions.kitty-graphics": GHOSTTY_NATIVE_GRAPHICS_AUDIT,
      "extensions.kitty-graphics.transmit": GHOSTTY_NATIVE_GRAPHICS_AUDIT,
      "extensions.kitty-graphics.display": GHOSTTY_NATIVE_GRAPHICS_AUDIT,
      "extensions.kitty-keyboard": GHOSTTY_NATIVE_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.disambiguate": GHOSTTY_NATIVE_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.report-events": GHOSTTY_NATIVE_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.report-alternate": GHOSTTY_NATIVE_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.report-all-keys": GHOSTTY_NATIVE_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.report-text": GHOSTTY_NATIVE_KEYBOARD_AUDIT,
      "input.csi-u": GHOSTTY_NATIVE_KEYBOARD_AUDIT,
      "extensions.osc21-kitty-color": {
        query: "\x1b]21;foreground=?\x1b\\",
        kind: "no-reply-path",
        citation:
          "termless 0c409349 packages/ghostty-native/native/src/main.zig:81 vtStream() -> ghostty 332b2aef Terminal.zig:264-265 initAlloc; stream.zig:2018-2019 dispatches kitty_color_report; stream_readonly.zig:159 calls kittyColorOperation but :362-399 ignores .query while retaining set/reset; native getDefaultColors :535 exposes RGB state, not a protocol reply",
      },
      "extensions.sixel-geometry-report": {
        query: "\x1b[?2;1;0S",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/parse_table.zig:324 collects '?' as CSI intermediate (Parser.zig:313-321); stream.zig:1128-1142 handles final S only without intermediates and ignores XTSMGRAPHICS '?' before any handler; termless 0c409349 packages/ghostty-native/native/src/main.zig:81 uses this stream",
      },
    },
  ],
  // ghostty-web 0.4.0 WASM (core 5714ed07), the artifact the 31372 capture loaded
  [
    "7c43302dde147c6f7959b7bda7045ff375c71288da1af5667ffca2bf95beb2bf",
    {
      "extensions.kitty-graphics": GHOSTTY_WASM_GRAPHICS_AUDIT,
      "extensions.kitty-graphics.transmit": GHOSTTY_WASM_GRAPHICS_AUDIT,
      "extensions.kitty-graphics.display": GHOSTTY_WASM_GRAPHICS_AUDIT,
      "extensions.osc21-kitty-color": {
        query: "\x1b]21;foreground=?\x1b\\",
        kind: "parser-rejected",
        citation:
          "ghostty-web 0.4.0 artifact7c43302d, core5714ed07: termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init -> src/terminal/stream.zig:497-501 Parser.init -> Parser.zig:230 osc_parser.init(null); osc.zig:845-851 rejects OSC21 without an allocator before any handler",
      },
      "extensions.sixel-geometry-report": {
        query: "\x1b[?2;1;0S",
        kind: "parser-rejected",
        citation:
          "ghostty-web 0.4.0 artifact7c43302d, core5714ed07: src/terminal/parse_table.zig:324 collects '?' as a CSI intermediate, Parser.zig:312-320 retains it; stream.zig:1173-1188 handles S only without intermediates and ignores '?' before any handler; termless vendor/ghostty-web/ghostty-wasm-api.patch:827 selects this stream",
      },
      "device.decrpm": {
        query: "\x1b[?7$p",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:594-595 no-op); ghostty 5714ed07 src/terminal/stream.zig:1583-1618 request_mode parses it",
      },
      "device.decrqss": {
        query: "\x1bP$qm\x1b\\",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM: termless vendor/ghostty-web/ghostty-wasm-api.patch:697 Stream(ResponseHandler), :824/:827 construct, :867 feed; ghostty 5714ed07 src/terminal/stream.zig:778-780 forwards raw DCS to the handler; patch:586-588/:607 DCS handlers are no-ops; src/terminal/dcs.zig is not on this path",
      },
      "device.dsr-996-color-scheme": {
        query: "\x1b[?996n",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:634-636 'Not supported in WASM context'); ghostty 5714ed07 src/terminal/stream.zig:1528-1556 device_status color_scheme parses it",
      },
      "device.primary-da": {
        query: "\x1b[c",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:598 no-op); ghostty 5714ed07 src/terminal/stream.zig:1320-1338 device_attributes parses it",
      },
      "device.secondary-da": {
        query: "\x1b[>c",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:598 no-op); ghostty 5714ed07 src/terminal/stream.zig:1320-1338 device_attributes parses it",
      },
      "device.tertiary-da": {
        query: "\x1b[=c",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:598 no-op); ghostty 5714ed07 src/terminal/stream.zig:1320-1338 device_attributes parses it",
      },
      "device.xtgettcap": {
        query: "\x1bP+q544e\x1b\\",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM: termless vendor/ghostty-web/ghostty-wasm-api.patch:697 Stream(ResponseHandler), :824/:827 construct, :867 feed; ghostty 5714ed07 src/terminal/stream.zig:778-780 forwards raw DCS to the handler; patch:586-588/:607 DCS handlers are no-ops; src/terminal/dcs.zig is not on this path",
      },
      "device.xtgetxres": {
        query: "\x1bP+Q7465726d4e616d65\x1b\\",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM drops the DCS (termless vendor/ghostty-web/ghostty-wasm-api.patch:586-588 dcs_* no-op); ghostty 5714ed07 src/terminal/dcs.zig:81-93 is not linked",
      },
      "device.xtreportcolors": {
        query: "\x1b[#R",
        kind: "parser-rejected",
        citation: "ghostty 5714ed07 src/terminal/stream.zig:1977 no 'R' final: 'unimplemented CSI action'",
      },
      "device.xtversion": {
        query: "\x1b[>0q",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:597 no-op); ghostty 5714ed07 src/terminal/stream.zig:1676 xtversion parses it",
      },
      "device.xtwinops-14": {
        query: "\x1b[14t",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:596 no-op); ghostty 5714ed07 src/terminal/stream.zig:1797-1803 size_report csi_14_t parses it",
      },
      "device.xtwinops-16": {
        query: "\x1b[16t",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:596 no-op); ghostty 5714ed07 src/terminal/stream.zig:1804-1810 size_report csi_16_t parses it",
      },
      "device.xtwinops-18": {
        query: "\x1b[18t",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:596 no-op); ghostty 5714ed07 src/terminal/stream.zig:1811-1817 size_report csi_18_t parses it",
      },
      "device.xtwinops-20": {
        query: "\x1b[20t",
        kind: "parser-rejected",
        citation: "ghostty 5714ed07 src/terminal/stream.zig:1844-1847 'ignoring CSI t with unimplemented parameter'",
      },
      "device.xtwinops-21": {
        query: "\x1b[21t",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:596 no-op); ghostty 5714ed07 src/terminal/stream.zig:1818-1824 size_report csi_21_t parses it",
      },
      "editing.decrqcra": {
        query: "\x1b[1;1;1;1;1;5*y",
        kind: "parser-rejected",
        citation: "ghostty 5714ed07 src/terminal/stream.zig:1977 no 'y' final: 'unimplemented CSI action'",
      },
      "extensions.osc10-fg-color": {
        query: "\x1b]10;?\x07",
        kind: "parser-rejected",
        citation:
          "ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:604-607 rejects OSC 10 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc104-reset-palette": {
        query: "\x1b]4;0;?\x07",
        kind: "parser-rejected",
        citation:
          "seed query OSC 4: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:904-907 rejects OSC 4 with a null allocator, and OSC 104 itself is guarded the same way (osc.zig:626-629). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc11-bg-color": {
        query: "\x1b]11;?\x07",
        kind: "parser-rejected",
        citation:
          "ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:645-648 rejects OSC 11 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc110-reset-fg": {
        query: "\x1b]10;?\x07",
        kind: "parser-rejected",
        citation:
          "seed query OSC 10: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:604-607 rejects OSC 10 with a null allocator, and OSC 110 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc111-reset-bg": {
        query: "\x1b]11;?\x07",
        kind: "parser-rejected",
        citation:
          "seed query OSC 11: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:645-648 rejects OSC 11 with a null allocator, and OSC 111 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc112-reset-cursor": {
        query: "\x1b]12;?\x07",
        kind: "parser-rejected",
        citation:
          "seed query OSC 12: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:690-693 rejects OSC 12 with a null allocator, and OSC 112 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc113-reset-pointer-fg": {
        query: "\x1b]13;?\x07",
        kind: "parser-rejected",
        citation:
          "seed query OSC 13: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:707-710 rejects OSC 13 with a null allocator, and OSC 113 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc114-reset-pointer-bg": {
        query: "\x1b]14;?\x07",
        kind: "parser-rejected",
        citation:
          "seed query OSC 14: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:730-733 rejects OSC 14 with a null allocator, and OSC 114 itself is guarded the same way (osc.zig:657-661). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc12-cursor-color": {
        query: "\x1b]12;?\x07",
        kind: "parser-rejected",
        citation:
          "ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:690-693 rejects OSC 12 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc1337-capabilities": {
        query: "\x1b]1337;Capabilities\x07",
        kind: "parser-rejected",
        citation: "ghostty 5714ed07 src/terminal/osc.zig:723-726 @\"133\" + '7' -> invalid",
      },
      "extensions.osc1337-cellsize": {
        query: "\x1b]1337;ReportCellSize\x07",
        kind: "parser-rejected",
        citation: "ghostty 5714ed07 src/terminal/osc.zig:723-726 @\"133\" + '7' -> invalid",
      },
      "extensions.osc17-highlight-bg": {
        query: "\x1b]17;?\x07",
        kind: "parser-rejected",
        citation:
          "ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:781-784 rejects OSC 17 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc19-highlight-fg": {
        query: "\x1b]19;?\x07",
        kind: "parser-rejected",
        citation:
          "ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:815-818 rejects OSC 19 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc30001-color-stack-push": {
        query: "\x1b]10;?\x07",
        kind: "parser-rejected",
        citation:
          "the probe sends only the seed OSC 10 query: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:604-607 rejects OSC 10 with a null allocator. OSC 30001 itself, never sent, is outside the grammar (osc.zig:556-566 accepts no OSC number starting with 3). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc30101-color-stack-pop": {
        query: "\x1b]10;?\x07",
        kind: "parser-rejected",
        citation:
          "the probe sends only the seed OSC 10 query: ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:604-607 rejects OSC 10 with a null allocator. OSC 30101 itself, never sent, is outside the grammar (osc.zig:556-566 accepts no OSC number starting with 3). ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc4-palette": {
        query: "\x1b]4;0;?\x07",
        kind: "parser-rejected",
        citation:
          "ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:904-907 rejects OSC 4 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc5-special-color": {
        query: "\x1b]5;0;?\x07",
        kind: "parser-rejected",
        citation:
          "ghostty-web 0.4.0 WASM constructs its stream without an OSC allocator (termless vendor/ghostty-web/ghostty-wasm-api.patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501 → src/terminal/Parser.zig:230 osc_parser .init(null)); src/terminal/osc.zig:923-926 rejects OSC 5 with a null allocator. ghostty 5714ed07 parses this only under initAlloc (stream.zig:506-510); ghostty-web 0.4.0 constructs the stream with init, so the limit is the WASM build's, not the grammar's",
      },
      "extensions.osc701-locale": {
        query: "\x1b]701;?\x07",
        kind: "parser-rejected",
        citation: "ghostty 5714ed07 src/terminal/osc.zig:979-990 @\"7\" + '0' -> invalid",
      },
      "extensions.osc702-version": {
        query: "\x1b]702;?\x07",
        kind: "parser-rejected",
        citation: "ghostty 5714ed07 src/terminal/osc.zig:979-990 @\"7\" + '0' -> invalid",
      },
      "extensions.osc776-cell-size": {
        query: "\x1b]776\x07",
        kind: "parser-rejected",
        citation: "ghostty 5714ed07 src/terminal/osc.zig:991-995 @\"77\" + '6' -> invalid",
      },
      "extensions.osc7770-font-size": {
        query: "\x1b]7770;?\x07",
        kind: "parser-rejected",
        citation: "ghostty 5714ed07 src/terminal/osc.zig:996-1002 @\"777\" + '0' -> invalid",
      },
      "extensions.osc7777-font-window-size": {
        query: "\x1b]7777;?\x07",
        kind: "parser-rejected",
        citation: "ghostty 5714ed07 src/terminal/osc.zig:996-1002 @\"777\" + '7' -> invalid",
      },
      "extensions.sixel-da1": {
        query: "\x1b[c",
        kind: "no-reply-path",
        citation:
          "ghostty-web 0.4.0 WASM drops the reply (termless vendor/ghostty-web/ghostty-wasm-api.patch:598 no-op); ghostty 5714ed07 src/terminal/stream.zig:1320-1338 device_attributes parses it",
      },
    },
  ],
  // Ghostty native (core 332b2aef), independently hashed artifact loaded by the 31369 capture
  [
    "9a9505600721226b952ae9ac92552b42389aa6713872a9f4904528f425b7ecdf",
    {
      "device.xtgetxres": {
        query: "\x1bP+Q7465726d4e616d65\x1b\\",
        kind: "no-reply-path",
        citation:
          "termless 71cac2c3 packages/ghostty-native/native/src/main.zig:81 vtStream() -> ghostty 332b2aef src/terminal/Terminal.zig:264 ReadonlyStream; stream.zig:733-735 forwards dcs_hook/put/unhook to the handler; stream_readonly.zig:161-166 ignores all three (dcs.zig:80-93 is not linked)",
      },
      "extensions.osc1337-capabilities": {
        query: "\x1b]1337;Capabilities\x07",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc/parsers/iterm2.zig:11-62 Key/map omit Capabilities; :87-90 missing key -> invalid",
      },
      "extensions.osc1337-cellsize": {
        query: "\x1b]1337;ReportCellSize\x07",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc/parsers/iterm2.zig:177-195 known ReportCellSize key is unimplemented -> invalid",
      },
      "extensions.osc701-locale": {
        query: "\x1b]701;?\x07",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:637-646 state7 accepts only ';' or '7'; '0' -> invalid",
      },
      "extensions.osc702-version": {
        query: "\x1b]702;?\x07",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:637-646 state7 accepts only ';' or '7'; '0' -> invalid",
      },
      "extensions.osc776-cell-size": {
        query: "\x1b]776\x07",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:643-646 state77 accepts only '7'; '6' -> invalid",
      },
      "extensions.osc7770-font-size": {
        query: "\x1b]7770;?\x07",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:674-681 state777 accepts only ';'; '0' -> invalid",
      },
      "extensions.osc7777-font-window-size": {
        query: "\x1b]7777;?\x07",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:674-681 state777 accepts only ';'; '7' -> invalid",
      },
      "extensions.osc30001-color-stack-push": {
        query: "\x1b]30001\x1b\\",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc.zig:515-533 state3 ->30 ->300 accepts only8; OSC30001 rejects0 at state300 before a handler",
      },
      "extensions.osc30101-color-stack-pop": {
        query: "\x1b]30101\x1b\\",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc.zig:515-533 state3 ->30 accepts only0; OSC30101 rejects1 at state30 before a handler",
      },
    },
  ],
  // Ghostty native (core 332b2aef), independently hashed current capture artifact
  [
    "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e",
    {
      "device.xtgetxres": {
        query: "\x1bP+Q7465726d4e616d65\x1b\\",
        kind: "no-reply-path",
        citation:
          "termless 71cac2c3 packages/ghostty-native/native/src/main.zig:81 vtStream() -> ghostty 332b2aef src/terminal/Terminal.zig:264 ReadonlyStream; stream.zig:733-735 forwards dcs_hook/put/unhook to the handler; stream_readonly.zig:161-166 ignores all three (dcs.zig:80-93 is not linked)",
      },
      "extensions.osc1337-capabilities": {
        query: "\x1b]1337;Capabilities\x07",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc/parsers/iterm2.zig:11-62 Key/map omit Capabilities; :87-90 missing key -> invalid",
      },
      "extensions.osc1337-cellsize": {
        query: "\x1b]1337;ReportCellSize\x07",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc/parsers/iterm2.zig:177-195 known ReportCellSize key is unimplemented -> invalid",
      },
      "extensions.osc701-locale": {
        query: "\x1b]701;?\x07",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:637-646 state7 accepts only ';' or '7'; '0' -> invalid",
      },
      "extensions.osc702-version": {
        query: "\x1b]702;?\x07",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:637-646 state7 accepts only ';' or '7'; '0' -> invalid",
      },
      "extensions.osc776-cell-size": {
        query: "\x1b]776\x07",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:643-646 state77 accepts only '7'; '6' -> invalid",
      },
      "extensions.osc7770-font-size": {
        query: "\x1b]7770;?\x07",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:674-681 state777 accepts only ';'; '0' -> invalid",
      },
      "extensions.osc7777-font-window-size": {
        query: "\x1b]7777;?\x07",
        kind: "parser-rejected",
        citation: "ghostty 332b2aef src/terminal/osc.zig:674-681 state777 accepts only ';'; '7' -> invalid",
      },
      "cursor.position-report": {
        query: "\x1b[6n",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 device_status.zig64-66 recognizes5/6/?996; stream.zig1490-1514 dispatches device_status; readonly183 ignores",
      },
      "device.decrpm": {
        query: "\x1b[?7$p",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1550-1576 parses?7$p (mode wraparound); readonly178-179 ignores request_mode/request_mode_unknown",
      },
      "device.decrqss": {
        query: "\x1bP$qm\x1b\\",
        kind: "no-reply-path",
        citation:
          "termless 107c05a6 packages/ghostty-native/native/src/main.zig:81 -> ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig:264-265 ReadonlyStream.initAlloc; stream.zig:733-735 raw DCS hook/put/unhook forwarded to readonly161-166 ignored; full dcs.zig parser not reached",
      },
      "device.dsr-996-color-scheme": {
        query: "\x1b[?996n",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 device_status.zig64-66 recognizes5/6/?996; stream.zig1490-1514 dispatches device_status; readonly183 ignores",
      },
      "device.primary-da": {
        query: "\x1b[c",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1278-1291 parses DA finalc and prefixes; readonly182 ignores device_attributes; source table cannot infer DA1 attribute4 from no reply",
      },
      "device.secondary-da": {
        query: "\x1b[>c",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1278-1291 parses DA finalc and prefixes; readonly182 ignores device_attributes; source table cannot infer DA1 attribute4 from no reply",
      },
      "device.status-report": {
        query: "\x1b[5n",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 device_status.zig64-66 recognizes5/6/?996; stream.zig1490-1514 dispatches device_status; readonly183 ignores",
      },
      "device.tertiary-da": {
        query: "\x1b[=c",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1278-1291 parses DA finalc and prefixes; readonly182 ignores device_attributes; source table cannot infer DA1 attribute4 from no reply",
      },
      "device.xtgettcap": {
        query: "\x1bP+q544e\x1b\\",
        kind: "no-reply-path",
        citation:
          "termless 107c05a6 packages/ghostty-native/native/src/main.zig:81 -> ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig:264-265 ReadonlyStream.initAlloc; stream.zig:733-735 raw DCS hook/put/unhook forwarded to readonly161-166 ignored; full dcs.zig parser not reached",
      },
      "device.xtreportcolors": {
        query: "\x1b[#R",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/stream.zig CSI dispatch has no final R prong; :1938 unimplemented CSI action, before handler dispatch",
      },
      "device.xtversion": {
        query: "\x1b[>0q",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig:1636-1637 parses CSI>0q as xtversion; readonly181 ignores",
      },
      "device.xtwinops-14": {
        query: "\x1b[14t",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1755-1790 explicitly dispatches this XTWINOPS parameter as size_report; readonly180 ignores",
      },
      "device.xtwinops-16": {
        query: "\x1b[16t",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1755-1790 explicitly dispatches this XTWINOPS parameter as size_report; readonly180 ignores",
      },
      "device.xtwinops-18": {
        query: "\x1b[18t",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1755-1790 explicitly dispatches this XTWINOPS parameter as size_report; readonly180 ignores",
      },
      "device.xtwinops-20": {
        query: "\x1b[20t",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/stream.zig:1755-1820 XTWINOPS handles14/16/18/21,22/23 only;20 ->unimplemented parameter before handler. ",
      },
      "device.xtwinops-21": {
        query: "\x1b[21t",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1755-1790 explicitly dispatches this XTWINOPS parameter as size_report; readonly180 ignores",
      },
      "editing.decrqcra": {
        query: "\x1b[1;1;1;1;1;5*y",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/stream.zig CSI dispatch has no final y prong; :1938 unimplemented CSI action, before handler dispatch",
      },
      "extensions.osc10-fg-color": {
        query: "\x1b]10;?\x07",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc11-bg-color": {
        query: "\x1b]11;?\x07",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc12-cursor-color": {
        query: "\x1b]12;?\x07",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc17-highlight-bg": {
        query: "\x1b]17;?\x07",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc19-highlight-fg": {
        query: "\x1b]19;?\x07",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc4-palette": {
        query: "\x1b]4;0;?\x07",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.osc5-special-color": {
        query: "\x1b]5;0;?\x07",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig264-265 supplies allocator; osc/parsers/color.zig45-110,175-205,278-304 parses exact OSC4/5 or10-19 query; stream.zig color_operation -> readonly290-359; query355 ignored. Stored palette/fg/bg/cursor state does not supply a query reply; no WASM null-allocator finding transferred.",
      },
      "extensions.sixel-da1": {
        query: "\x1b[c",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 stream.zig1278-1291 parses DA finalc and prefixes; readonly182 ignores device_attributes; source table cannot infer DA1 attribute4 from no reply",
      },
      "extensions.osc52-clipboard": {
        query: "\x1b]52;c;?\x07",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 osc52 parses clipboard_contents, stream.zig1987-1992 dispatches clipboard_contents; readonly189 ignores; no clipboard host/readback is exposed in this native product. Criterion is exact nonce roundtrip/read query, not standalone write.",
      },
      "extensions.osc52-read": {
        query: "\x1b]52;c;?\x07",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 osc52 parses clipboard_contents, stream.zig1987-1992 dispatches clipboard_contents; readonly189 ignores; no clipboard host/readback is exposed in this native product. Criterion is exact nonce roundtrip/read query, not standalone write.",
      },
      "extensions.osc52-write": {
        query: "\x1b]52;c;?\x07",
        kind: "no-reply-path",
        citation:
          "ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 osc52 parses clipboard_contents, stream.zig1987-1992 dispatches clipboard_contents; readonly189 ignores; no clipboard host/readback is exposed in this native product. Criterion is exact nonce roundtrip/read query, not standalone write.",
      },
      "extensions.osc5522-clipboard": {
        query: "\x1b[?5522$p",
        kind: "no-reply-path",
        citation:
          "terminfo7587293850a871e062bf94aade5d52129883fb8a extensions.ts3065-3080 sends DECRQM?5522$p only; ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 modes.zig:146-159,189-234 has no5522 entry; stream.zig1567-1576 dispatches request_mode_unknown; readonly178-179 ignores. No OSC5522 command is attempted.",
      },
      "extensions.osc0-icon-title": {
        query: "\x1b[20t",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/stream.zig:1755-1820 XTWINOPS handles14/16/18/21,22/23 only;20 ->unimplemented parameter before handler. This feature requires BOTH20 and21 exact payload replies;20 is necessary;21 dispatches size_report and is separately ignored.",
      },
      "extensions.osc30001-color-stack-push": {
        query: "\x1b]30001\x1b\\",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc.zig:515-533 state3 ->30 ->300 accepts only8; OSC30001 rejects0 at state300 before a handler",
      },
      "extensions.osc30101-color-stack-pop": {
        query: "\x1b]30101\x1b\\",
        kind: "parser-rejected",
        citation:
          "ghostty 332b2aef src/terminal/osc.zig:515-533 state3 ->30 accepts only0; OSC30101 rejects1 at state30 before a handler",
      },
    },
  ],
  // vt100 0.16.2 Rust parser native artifact from termless 0c409349, built by its declared `nix shell .#native-tools`
  // build; two checkouts gave this sha256 (#31671). termless 83f653f moved it off a478127f, the 31371 capture's key.
  [
    "b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962",
    {
      "cursor.position-report": {
        query: "\u001b[6n",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:157-164 csi_dispatch default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.decrpm": {
        query: "\u001b[?7$p",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:207-209 collects '?'; vt100 0.16.2 src/perform.rs:176-183 '?' default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.decrqss": {
        query: "\u001bP$qm\u001b\\",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:351-354,292 dispatches DCS to Perform::hook/put/unhook, empty by default (src/lib.rs:779-789); vt100 0.16.2 src/perform.rs:33-239 overrides none. termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.dsr-996-color-scheme": {
        query: "\u001b[?996n",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:207-209 collects '?'; vt100 0.16.2 src/perform.rs:176-183 '?' default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.primary-da": {
        query: "\u001b[c",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:157-164 csi_dispatch default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.secondary-da": {
        query: "\u001b[>c",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:186-194 intermediate arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.status-report": {
        query: "\u001b[5n",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:157-164 csi_dispatch default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.tertiary-da": {
        query: "\u001b[=c",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:186-194 intermediate arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.xtgettcap": {
        query: "\u001bP+q544e\u001b\\",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:351-354,292 dispatches DCS to Perform::hook/put/unhook, empty by default (src/lib.rs:779-789); vt100 0.16.2 src/perform.rs:33-239 overrides none. termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.xtgetxres": {
        query: "\u001bP+Q7465726d4e616d65\u001b\\",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:351-354,292 dispatches DCS to Perform::hook/put/unhook, empty by default (src/lib.rs:779-789); vt100 0.16.2 src/perform.rs:33-239 overrides none. termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.xtreportcolors": {
        query: "\u001b[#R",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:186-194 intermediate arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.xtversion": {
        query: "\u001b[>0q",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:186-194 intermediate arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.xtwinops-14": {
        query: "\u001b[14t",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:132-136 handles only CSI 8 t; other ops reach :147-155 -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.xtwinops-16": {
        query: "\u001b[16t",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:132-136 handles only CSI 8 t; other ops reach :147-155 -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.xtwinops-18": {
        query: "\u001b[18t",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:132-136 handles only CSI 8 t; other ops reach :147-155 -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.xtwinops-20": {
        query: "\u001b[20t",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:132-136 handles only CSI 8 t; other ops reach :147-155 -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "device.xtwinops-21": {
        query: "\u001b[21t",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:132-136 handles only CSI 8 t; other ops reach :147-155 -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "editing.decrqcra": {
        query: "\u001b[1;1;1;1;1;5*y",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:186-194 intermediate arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc0-icon-title": {
        query: "\u001b[20t",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:132-136 handles only CSI 8 t; CSI 20 t and 21 t reach :147-155 -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63); termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc10-fg-color": {
        query: "\u001b]10;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc104-reset-palette": {
        query: "\u001b]4;0;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc11-bg-color": {
        query: "\u001b]11;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc110-reset-fg": {
        query: "\u001b]10;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc111-reset-bg": {
        query: "\u001b]11;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc112-reset-cursor": {
        query: "\u001b]12;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc113-reset-pointer-fg": {
        query: "\u001b]13;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc114-reset-pointer-bg": {
        query: "\u001b]14;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc12-cursor-color": {
        query: "\u001b]12;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc1337-capabilities": {
        query: "\u001b]1337;Capabilities\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc1337-cellsize": {
        query: "\u001b]1337;ReportCellSize\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc17-highlight-bg": {
        query: "\u001b]17;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc19-highlight-fg": {
        query: "\u001b]19;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc30001-color-stack-push": {
        query: "\u001b]10;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc30101-color-stack-pop": {
        query: "\u001b]10;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc4-palette": {
        query: "\u001b]4;0;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc5-special-color": {
        query: "\u001b]5;0;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc5522-clipboard": {
        query: "\u001b[?5522$p",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:207-209 collects '?'; vt100 0.16.2 src/perform.rs:176-183 '?' default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc701-locale": {
        query: "\u001b]701;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc702-version": {
        query: "\u001b]702;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc776-cell-size": {
        query: "\u001b]776\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc7770-font-size": {
        query: "\u001b]7770;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.osc7777-font-window-size": {
        query: "\u001b]7777;?\u0007",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66). termless 4a730304 packages/vt100-rust/native/src/lib.rs:21-53 implements only set_window_title, set_window_icon_name, copy_to_clipboard, and paste_from_clipboard; no unhandled_csi, unhandled_osc, or reply writer. Artifact b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962, sourceCommit bf1408e001e11cac31853565f78ff8dddb70e098.",
      },
      "extensions.kitty-graphics": VT100_RUST_B910_GRAPHICS_AUDIT,
      "extensions.kitty-graphics.display": VT100_RUST_B910_GRAPHICS_AUDIT,
      "extensions.kitty-graphics.transmit": VT100_RUST_B910_GRAPHICS_AUDIT,
      "extensions.kitty-keyboard": VT100_RUST_B910_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.disambiguate": VT100_RUST_B910_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.report-all-keys": VT100_RUST_B910_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.report-alternate": VT100_RUST_B910_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.report-events": VT100_RUST_B910_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.report-text": VT100_RUST_B910_KEYBOARD_AUDIT,
      "extensions.osc21-kitty-color": VT100_RUST_B910_OSC21_AUDIT,
      "extensions.osc52-clipboard": VT100_RUST_OSC52_READ_AUDIT,
      "extensions.osc52-read": VT100_RUST_OSC52_READ_AUDIT,
      "extensions.osc99-kitty-notify": VT100_RUST_B910_OSC99_AUDIT,
      "extensions.sixel-da1": VT100_RUST_B910_SIXEL_DA_AUDIT,
      "extensions.sixel-geometry-report": VT100_RUST_B910_SIXEL_S_AUDIT,
      "input.csi-u": VT100_RUST_B910_KEYBOARD_AUDIT,
    },
  ],
  [
    "f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96",
    {
      "extensions.osc99-kitty-notify": {
        query: "\u001b]99;",
        matches: "prefix",
        kind: "no-reply-path",
        citation:
          "vt100-rust0.16.2 artifactf309015f: vte0.15.0 src/lib.rs:419-422 ends OSC on ESC and :554-587 forwards its semicolon-separated params to performer.osc_dispatch. vt1000.16.2 src/perform.rs:198-236 handles OSC0/1/2/52 only; OSC99 reaches callbacks.unhandled_osc at :234-236, whose default src/callbacks.rs:64-66 is empty. Termless14912a2729d795b45579698abcdb92d4749f4ff1 packages/vt100-rust/native/src/lib.rs:10-14 implements only title storage, with no unhandled_osc override or reply writer. Exact cached crate SHA256 vt100054ff75fb8fa83e609e685106df4faeffdf3a735d3c74ebce97ec557d5d36fd9 and vtea5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd verified; archive source files match inspected cache bytes. Audited family is Terminfo27541ce4 extensions.ts:3267-3312 capability query ESC]99;i=<nonce>:p=?;ST.",
      },
      "extensions.kitty-keyboard": VT100_RUST_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.disambiguate": VT100_RUST_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.report-events": VT100_RUST_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.report-alternate": VT100_RUST_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.report-all-keys": VT100_RUST_KEYBOARD_AUDIT,
      "extensions.kitty-keyboard.report-text": VT100_RUST_KEYBOARD_AUDIT,
      "input.csi-u": VT100_RUST_KEYBOARD_AUDIT,
      "extensions.kitty-graphics": VT100_RUST_GRAPHICS_AUDIT,
      "extensions.kitty-graphics.transmit": VT100_RUST_GRAPHICS_AUDIT,
      "extensions.kitty-graphics.display": VT100_RUST_GRAPHICS_AUDIT,
      "extensions.osc21-kitty-color": {
        query: "\x1b]21;foreground=?\x1b\\",
        kind: "no-reply-path",
        citation:
          "vt100-rust 0.16.2 artifactf309015f: registry/src/index.crates.io-1949cf8c6b5b557f/vt100-0.16.2/src/perform.rs:234-236 dispatches unknown OSC21 to unhandled_osc, empty at src/callbacks.rs:65; termless0400d94a packages/vt100-rust/native/src/lib.rs:10-14 implements only title storage, no reply export. Cargo.lock vt100 checksum054ff75fb8fa83e609e685106df4faeffdf3a735d3c74ebce97ec557d5d36fd9; vte0.15.0 checksuma5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd",
      },
      "extensions.sixel-geometry-report": {
        query: "\x1b[?2;1;0S",
        kind: "no-reply-path",
        citation:
          "vt100-rust 0.16.2 artifactf309015f: registry/src/index.crates.io-1949cf8c6b5b557f/vt100-0.16.2/src/perform.rs:176-183 dispatches private ?S to unhandled_csi, empty at src/callbacks.rs:55-63; termless0400d94a packages/vt100-rust/native/src/lib.rs:10-14 implements only title storage, no reply export. Cargo.lock vt100 checksum054ff75fb8fa83e609e685106df4faeffdf3a735d3c74ebce97ec557d5d36fd9; vte0.15.0 checksuma5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd",
      },
      "cursor.position-report": {
        query: "\x1b[6n",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:157-164 csi_dispatch default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.decrpm": {
        query: "\x1b[?7$p",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:207-209 collects '?'; vt100 0.16.2 src/perform.rs:176-183 '?' default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.decrqss": {
        query: "\x1bP$qm\x1b\\",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:351-354,292 dispatches DCS to Perform::hook/put/unhook, empty by default (src/lib.rs:779-789); vt100 0.16.2 src/perform.rs:33-239 overrides none",
      },
      "device.dsr-996-color-scheme": {
        query: "\x1b[?996n",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:207-209 collects '?'; vt100 0.16.2 src/perform.rs:176-183 '?' default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.primary-da": {
        query: "\x1b[c",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:157-164 csi_dispatch default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.secondary-da": {
        query: "\x1b[>c",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:186-194 intermediate arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.status-report": {
        query: "\x1b[5n",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:157-164 csi_dispatch default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.tertiary-da": {
        query: "\x1b[=c",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:186-194 intermediate arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.xtgettcap": {
        query: "\x1bP+q544e\x1b\\",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:351-354,292 dispatches DCS to Perform::hook/put/unhook, empty by default (src/lib.rs:779-789); vt100 0.16.2 src/perform.rs:33-239 overrides none",
      },
      "device.xtgetxres": {
        query: "\x1bP+Q7465726d4e616d65\x1b\\",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:351-354,292 dispatches DCS to Perform::hook/put/unhook, empty by default (src/lib.rs:779-789); vt100 0.16.2 src/perform.rs:33-239 overrides none",
      },
      "device.xtreportcolors": {
        query: "\x1b[#R",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:186-194 intermediate arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.xtversion": {
        query: "\x1b[>0q",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:186-194 intermediate arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.xtwinops-14": {
        query: "\x1b[14t",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:132-136 handles only CSI 8 t; other ops reach :147-155 -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.xtwinops-16": {
        query: "\x1b[16t",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:132-136 handles only CSI 8 t; other ops reach :147-155 -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.xtwinops-18": {
        query: "\x1b[18t",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:132-136 handles only CSI 8 t; other ops reach :147-155 -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.xtwinops-20": {
        query: "\x1b[20t",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:132-136 handles only CSI 8 t; other ops reach :147-155 -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "device.xtwinops-21": {
        query: "\x1b[21t",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:132-136 handles only CSI 8 t; other ops reach :147-155 -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "editing.decrqcra": {
        query: "\x1b[1;1;1;1;1;5*y",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:186-194 intermediate arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "extensions.osc0-icon-title": {
        query: "\x1b[20t",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:132-136 handles only CSI 8 t; CSI 20 t and 21 t reach :147-155 -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63); termless 0c409349 packages/vt100-rust/native/src/lib.rs:10-14 implements only set_window_title",
      },
      "extensions.osc10-fg-color": {
        query: "\x1b]10;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc104-reset-palette": {
        query: "\x1b]4;0;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc11-bg-color": {
        query: "\x1b]11;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc110-reset-fg": {
        query: "\x1b]10;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc111-reset-bg": {
        query: "\x1b]11;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc112-reset-cursor": {
        query: "\x1b]12;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc113-reset-pointer-fg": {
        query: "\x1b]13;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc114-reset-pointer-bg": {
        query: "\x1b]14;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc12-cursor-color": {
        query: "\x1b]12;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc1337-capabilities": {
        query: "\x1b]1337;Capabilities\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc1337-cellsize": {
        query: "\x1b]1337;ReportCellSize\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc17-highlight-bg": {
        query: "\x1b]17;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc19-highlight-fg": {
        query: "\x1b]19;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc30001-color-stack-push": {
        query: "\x1b]10;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc30101-color-stack-pop": {
        query: "\x1b]10;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc4-palette": {
        query: "\x1b]4;0;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc5-special-color": {
        query: "\x1b]5;0;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc52-clipboard": VT100_OSC52_AUDIT,
      "extensions.osc52-read": VT100_OSC52_AUDIT,
      "extensions.osc52-write": VT100_OSC52_AUDIT,
      "extensions.osc5522-clipboard": {
        query: "\x1b[?5522$p",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:207-209 collects '?'; vt100 0.16.2 src/perform.rs:176-183 '?' default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
      "extensions.osc701-locale": {
        query: "\x1b]701;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc702-version": {
        query: "\x1b]702;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc776-cell-size": {
        query: "\x1b]776\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc7770-font-size": {
        query: "\x1b]7770;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.osc7777-font-window-size": {
        query: "\x1b]7777;?\x07",
        kind: "no-reply-path",
        citation:
          "vte 0.15.0 src/lib.rs:410-413 -> osc_dispatch; vt100 0.16.2 src/perform.rs:234-236 default arm (only OSC 0/1/2/52 at :200-233) -> Callbacks::unhandled_osc, empty by default (src/callbacks.rs:66)",
      },
      "extensions.sixel-da1": {
        query: "\x1b[c",
        kind: "no-reply-path",
        citation:
          "vt100 0.16.2 src/perform.rs:157-164 csi_dispatch default arm -> Callbacks::unhandled_csi, empty by default (src/callbacks.rs:55-63)",
      },
    },
  ],
])

/** The audited cell for this probe on the loaded artifact, if the table lists one. */
export function replyPathAuditFor(
  ctx: LibProbeSource,
  featureId: string,
): { artifactSha256: string; audit: ReplyPathAudit } | undefined {
  const identity = ctx.runtimeIdentity
  if (identity === undefined || !("loadedBinary" in identity)) return undefined
  const artifactSha256 = identity.loadedBinary.sha256
  const audit = REPLY_PATH_AUDITS.get(artifactSha256)?.[featureId]
  return audit === undefined ? undefined : { artifactSha256, audit }
}
