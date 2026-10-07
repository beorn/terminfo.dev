#!/usr/bin/env node
/** 27910: the one hosted receipt producer. Runs with Node's type stripping before checkout,
 * importing only the parser and Node built-ins. Later workflows add OS sources to the same owner. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { HOSTED_IDENTITY_SOURCES, parseDisposableReceipt } from "../packages/terminfo.dev/src/disposable-receipt.ts"

function required(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Hosted receipt requires environment ${key}; no value was provided`)
  return value
}

function decimal(key: string): string {
  const value = required(key)
  if (/[^0-9]/.test(value)) throw new Error(`Hosted receipt ${key} must contain decimal digits`)
  return value
}

function sampleIdentity(): Record<string, string> {
  const os = required("RUNNER_OS")
  if (os !== "macOS") {
    throw new Error(`Hosted receipt has no producer for RUNNER_OS=${JSON.stringify(os)}; only macOS is ratified here`)
  }
  return Object.fromEntries(
    Object.entries(HOSTED_IDENTITY_SOURCES.macOS.sources).map(([field, source]) => {
      const result = spawnSync(source.command, source.args, { encoding: "utf8" })
      if (result.error || result.status !== 0) {
        throw new Error(
          `Hosted receipt ${field}: ${source.command} failed with exit ${result.status}, signal ${result.signal}; cannot measure ${source.source}`,
        )
      }
      const value = new RegExp(source.pattern).exec(result.stdout)?.[1]
      if (!value) {
        throw new Error(
          `Hosted receipt ${field}: ${source.command} returned no ${source.source}; no identity is substituted`,
        )
      }
      const hash = createHash("sha256").update(value).digest("hex")
      process.stderr.write(
        `${field}: ${source.command} ${source.args.join(" ")} · ${source.scope} · ${Buffer.byteLength(value)} bytes · sha256:${hash}\n`,
      )
      return [field, hash]
    }),
  )
}

async function context() {
  const repository = required("GITHUB_REPOSITORY")
  const githubRunId = decimal("GITHUB_RUN_ID")
  const githubRunAttempt = decimal("GITHUB_RUN_ATTEMPT")
  const name = required("RUNNER_NAME")
  const endpoint = `${required("GITHUB_API_URL")}/repos/${repository}/actions/runs/${githubRunId}/attempts/${githubRunAttempt}/jobs`
  const token = required("GH_TOKEN")
  const matches: number[] = []
  for (let page = 1; ; page++) {
    const url = `${endpoint}?per_page=100&page=${page}`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(
        `Hosted receipt jobs API ${url} returned HTTP ${response.status}; no numeric job id can be measured`,
      )
    }
    const body = (await response.json()) as { jobs?: unknown }
    if (!Array.isArray(body.jobs)) throw new Error(`Hosted receipt jobs API ${url} returned no jobs array`)
    for (const job of body.jobs as Array<{ runner_name?: unknown; id?: unknown }>) {
      if (job.runner_name !== name) continue
      if (typeof job.id !== "number" || !Number.isSafeInteger(job.id) || job.id < 0) {
        throw new Error(
          `Hosted receipt jobs API ${url}: matching RUNNER_NAME has no safe numeric id; GITHUB_JOB is a YAML key`,
        )
      }
      matches.push(job.id)
    }
    if (body.jobs.length < 100) break
  }
  if (matches.length !== 1) {
    throw new Error(
      `Hosted receipt requires exactly one jobs-API RUNNER_NAME match for ${JSON.stringify(name)} at ${endpoint}; found ${matches.length}`,
    )
  }
  return {
    job: {
      repository,
      workflow: required("GITHUB_WORKFLOW"),
      workflowRef: required("GITHUB_WORKFLOW_REF"),
      githubRunId,
      githubRunAttempt,
      job: required("GITHUB_JOB"),
      jobId: String(matches[0]),
    },
    runner: {
      environment: required("RUNNER_ENVIRONMENT"),
      name,
      os: required("RUNNER_OS"),
      arch: required("RUNNER_ARCH"),
      imageOS: required("ImageOS"),
      imageVersion: required("ImageVersion"),
      trackingId: required("RUNNER_TRACKING_ID"),
    },
  }
}

async function main(): Promise<void> {
  const [mode, startPath, receiptPath, extra] = process.argv.slice(2)
  if ((mode !== "start" && mode !== "emit") || !startPath || (mode === "emit" ? !receiptPath : receiptPath) || extra) {
    throw new Error(
      "Usage: hosted-runner-receipt.ts start <absolute-start.json> | emit <absolute-start.json> <absolute-host-measured.json>",
    )
  }
  if (!isAbsolute(startPath) || (receiptPath && !isAbsolute(receiptPath))) {
    throw new Error("Hosted receipt output paths must be absolute")
  }
  if (required("RUNNER_ENVIRONMENT") !== "github-hosted") {
    throw new Error("Hosted receipt requires RUNNER_ENVIRONMENT=github-hosted; never assumed")
  }
  // Sampling precedes API lookup/setup. No raw source value leaves this function.
  const identity = sampleIdentity()
  const current = await context()
  if (mode === "start") {
    mkdirSync(dirname(startPath), { recursive: true })
    writeFileSync(startPath, JSON.stringify({ phase: "job-start", ...current, identity }) + "\n", {
      flag: "wx",
      mode: 0o600,
    })
    return
  }
  let first: Awaited<ReturnType<typeof context>> & { phase: string; identity: Record<string, string> }
  try {
    first = JSON.parse(readFileSync(startPath, "utf8")) as typeof first
  } catch (cause) {
    throw new Error(
      `Hosted receipt cannot read job-start sample ${startPath}; sample in the first job step before collecting`,
      { cause },
    )
  }
  if (
    !first ||
    first.phase !== "job-start" ||
    JSON.stringify(first.job) !== JSON.stringify(current.job) ||
    JSON.stringify(first.runner) !== JSON.stringify(current.runner)
  ) {
    throw new Error(
      `Hosted receipt job-start sample ${startPath} does not describe this job/runner; refuse the handoff`,
    )
  }
  const runId = createHash("sha256")
    .update(
      [
        "github-hosted-runner",
        current.job.repository,
        current.job.githubRunId,
        current.job.githubRunAttempt,
        current.job.jobId,
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 32)
  const bytes =
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "github-hosted-runner",
        runId,
        collectedAt: new Date().toISOString(),
        ...current,
        vm: { identityAtJobStart: first.identity, identityAtCollection: identity },
      },
      null,
      2,
    ) + "\n"
  if (!receiptPath) throw new Error("Hosted receipt emit requires its explicit receipt path")
  mkdirSync(dirname(receiptPath), { recursive: true })
  writeFileSync(receiptPath, bytes, { flag: "wx", mode: 0o444 })
  // Write THEN parse the exact persisted bytes. Shell callers must stop on any parser failure.
  parseDisposableReceipt(readFileSync(receiptPath, "utf8"))
}

await main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
  process.exitCode = 1
})
