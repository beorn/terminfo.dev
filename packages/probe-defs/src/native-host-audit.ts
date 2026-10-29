import type {
  CallbackHostRecipeCause,
  HostInputName,
  HostRecipeName,
  LibProbeSource,
  ProbeCallbackResult,
} from "./types.ts"

/** Source citation for each host-owned recipe one audited native artifact leaves unanswered. */
type NativeHostSourceCitations = Readonly<Record<Exclude<HostRecipeName, "color-request">, string>>

/**
 * Independent source audits of exact unchanged native artifacts, keyed by loaded-binary sha256 — never a digest copied
 * from runtime. A host gains causes only through its own audit here; no host inherits another's citations.
 */
const NATIVE_HOST_AUDITS: ReadonlyMap<string, NativeHostSourceCitations> = new Map([
  [
    // Alacritty: alacritty_terminal 0.26.0 behind the Termless native addon.
    "e6e16113863355b77d0aa3b359bd40c7066fb144e005fbc324fecfa3f4869bea",
    {
      "text-area-size":
        "alacritty_terminal 0.26.0 term/mod.rs:2259-2265 requests embedder pixels; Termless packages/alacritty/native/src/lib.rs EventProxy::send ignores TextAreaSizeRequest; this harness supplies no pixel geometry",
      "clipboard-load":
        "alacritty_terminal 0.26.0 Config default clipboard policy OnlyCopy; Termless packages/alacritty/native/src/lib.rs EventProxy::send has no ClipboardLoad handler; this harness supplies no clipboard read permission",
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
      : { recipe, cause: { kind: "source-audited", missing, artifactSha256, sourceCitation: citations[recipe] } }
  return { ...result, hostRecipeCauses: [...(result.hostRecipeCauses ?? []), claim] }
}
