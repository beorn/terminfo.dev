/**
 * @failure A stored App notification observation is dropped or relabeled between run parsing
 *   and the production site/API projection.
 * @level l2
 * @consumer Stored notification runs in the site data build and API.
 * @reach fs-read vendor/terminfo.dev/packages/run-parser/src/fixtures/notification.capture.json
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { parseRun, parseSuiteManifest } from "./index.ts"
import { projectResults } from "../../../docs/data/selected-results.ts"
import { publicResults } from "../../../docs/data/public-results.ts"

test("stored App notification survives canonical parsing and the site data projection", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/notification.capture.json", import.meta.url), "utf8"),
  ) as {
    suite: unknown
    run: unknown
  }
  const suite = parseSuiteManifest("notification-suite.json", JSON.stringify(fixture.suite))
  const catalog = suite.catalogIds
  if (!catalog) throw new Error("Notification compatibility fixture has no frozen catalogue")
  const raw = JSON.stringify(fixture.run)
  const parsed = parseRun("notification.capture.json", raw, catalog, new Map([[suite.probeHash, suite]]))
  expect(parsed.results?.[0]).toMatchObject({ status: "supported", assertionType: "notification" })
  const projection = projectResults([parsed], catalog, { currentProbeHash: suite.probeHash }, [])
  const published = publicResults(projection, new Map())
  const version = published.projection.history["term:kitty"]?.[0]
  expect(version?.results[0]).toMatchObject({ status: "supported", assertionType: "notification" })
  expect(published.projection.contexts["term:kitty"]?.featureResults["extensions.notifications"]).toMatchObject({
    status: "supported",
    assertionType: "notification",
    strength: 5,
  })
  expect(JSON.parse(raw)).toEqual(fixture.run)
})
