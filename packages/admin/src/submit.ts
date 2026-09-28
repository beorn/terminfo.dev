/** Submission waits for a reviewed v2 run rather than promoting legacy booleans. */

export function handleSubmit(_opts: { terminalName?: string; terminalVersion?: string }): Promise<void> {
  throw new Error(
    "Submitting a v2 partial run requires a reviewed submission path; use probe here --json to inspect raw evidence",
  )
}
