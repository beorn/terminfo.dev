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
type NativeHostSourceCitations = Readonly<Record<Exclude<HostRecipeName, "color-request">, NativeHostAudit>>

/**
 * Independent source audits of exact unchanged native artifacts, keyed by loaded-binary sha256 — never a digest copied
 * from runtime. A host gains causes only through its own audit here; no host inherits another's citations.
 */
const NATIVE_HOST_AUDITS: ReadonlyMap<string, NativeHostSourceCitations> = new Map([
  [
    // Alacritty: alacritty_terminal 0.26.0 behind the Termless native addon.
    "e6e16113863355b77d0aa3b359bd40c7066fb144e005fbc324fecfa3f4869bea",
    {
      "text-area-size": {
        kind: "source-audited",
        citation:
          "alacritty_terminal 0.26.0 term/mod.rs:2259-2265 requests embedder pixels; Termless packages/alacritty/native/src/lib.rs EventProxy::send ignores TextAreaSizeRequest; this harness supplies no pixel geometry",
      },
      "clipboard-load": {
        kind: "source-audited",
        citation:
          "alacritty_terminal 0.26.0 Config default clipboard policy OnlyCopy; Termless packages/alacritty/native/src/lib.rs EventProxy::send has no ClipboardLoad handler; this harness supplies no clipboard read permission",
      },
    },
  ],
  [
    // WezTerm: tattoy-wezterm-term 0.1.0-fork.5 behind the Termless native addon.
    "84da518e3f298a0ed75f186db6e39d87e99b8f0c8508dd7252ec0cafee77fe12",
    {
      "text-area-size": {
        kind: "source-audited",
        citation:
          "tattoy-wezterm-term 0.1.0-fork.5 terminalstate/mod.rs:2047-2054 answers CSI 14 t from the embedder's pixel size; Termless packages/wezterm/native/src/lib.rs:148-149 and :231-232 pass pixel_width and pixel_height 0; this harness supplies no pixel geometry",
      },
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
  const claim: CallbackHostRecipeCause =
    recipe === "color-request"
      ? { recipe, cause: { kind: "observed", missing, query } }
      : {
          recipe,
          cause: {
            kind: citations[recipe].kind,
            missing,
            artifactSha256,
            sourceCitation: citations[recipe].citation,
          },
        }
  return { ...result, hostRecipeCauses: [...(result.hostRecipeCauses ?? []), claim] }
}
