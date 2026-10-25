import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"

const sourceA = {
  rootRevision: "9138dddfb34ef35bf2edada3d5eb45f8c20659e2",
  terminfoRevision: "dcf4d96bf8d3a211766080d75ded42b0a1de6f97",
  termlessRevision: "b0f7f91591211a401665345bd2d4dee5c856b411",
  suiteHash: "9c012ae23f95",
  collectorSha256: "1c2e0a8d55365c9964efc03332ae1d069775cc7b86072f45217201d34750b78e",
  recorderSha256: "4c8caf5c000ffffdfd267e8424a7095515e16fafcc9a29593c40571fcbde0ca0",
  driverSha256: "c56ec0c9bd571d2b24e9662abef9c24edb41a3b5cc4005afcfe0a31d2948918f",
  lockSha256: "d575df3405287ba6772558a09704dfd5e5ef385a19804d3204609daeb66bebfb",
  bunVersion: "1.4.4",
}

/** @testonly Private retained-corpus experiment; production readers and publication remain out of scope. */
export function readStoredTrace(
  path: string,
  recorder: { dialect: "a" | "b"; IncompleteReplay: new (message: string) => Error },
) {
  const document = JSON.parse(readFileSync(path, "utf8")) as {
    source?: unknown
    runId?: unknown
    log: { version?: unknown; calls: unknown[] }
  }
  if (document.log?.version !== 1) {
    throw new recorder.IncompleteReplay(`unknown trace version ${JSON.stringify(document.log?.version) ?? "undefined"}`)
  }
  const metadataPath = join(dirname(dirname(path)), recorder.dialect === "a" ? "identity.json" : "v3-run.draft.json")
  if (!existsSync(metadataPath)) throw new recorder.IncompleteReplay(`unknown trace provenance: ${path}`)
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
    source?: unknown
    runId?: unknown
    sourceRevision?: unknown
    provenance?: { runtime?: { suiteHash?: unknown } }
  } | null
  const known =
    recorder.dialect === "a"
      ? isDeepStrictEqual(metadata?.source, sourceA) && isDeepStrictEqual(document.source, metadata?.source)
      : document.runId === metadata?.runId &&
        metadata?.runId === "30923c364282861c1f2b18685aaa8e70" &&
        metadata?.sourceRevision === "e40331968fde4c1a2e5d38657adfb97200011a9d" &&
        metadata?.provenance?.runtime?.suiteHash === "71bf77a55ea3"
  if (!known) throw new recorder.IncompleteReplay(`unknown trace provenance: ${path}`)
  return { document, serialized: `${JSON.stringify(document, null, recorder.dialect === "a" ? undefined : 2)}\n` }
}
