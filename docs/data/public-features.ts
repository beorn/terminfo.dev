/**
 * The public feature catalogue (@cpo/term f16a5a52 Q2): every catalogue id except the nine environment positions
 * (`device.env-*`), which no public page lists or renders. Each public reader of the catalogue lists features
 * through here: the matrix data (probes.data.ts), the sidebar and nav (.vitepress/config.ts), the tag pages
 * (load-probes.ts), the analysis text (scripts/generate-analysis.ts) and the feature-name links
 * (linkify-content.ts). It decides what a page lists, never what is counted: every fold still reads each run's full
 * recorded catalogue. The partition is probe-defs' one environment list (environment-groups.ts).
 */
import { scoredFeatureIds } from "../../packages/probe-defs/src/environment-groups.ts"

/** The catalogue's ids a public page may list, in catalogue order. */
export function publicFeatureIds(catalog: Readonly<Record<string, unknown>>): string[] {
  return scoredFeatureIds(Object.keys(catalog))
}

/** The catalogue's entries a public page may list: the entries of publicFeatureIds, in catalogue order. */
export function publicFeatures<T>(catalog: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(publicFeatureIds(catalog).map((id) => [id, catalog[id] as T]))
}
