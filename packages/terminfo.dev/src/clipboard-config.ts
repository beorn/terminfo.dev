/** A null clipboard config is no claim. Hosted Mac provenance is a launcher string, or absent. */
export function clipboardConfigAgrees(
  provenance: { fixture: { config: string | null } } | undefined,
  clipboard: { config: string | null },
): void {
  if (!provenance || clipboard.config === null) return
  if (provenance.fixture.config !== clipboard.config) {
    throw new Error("Owned clipboard profile config differs from runtime provenance")
  }
}
