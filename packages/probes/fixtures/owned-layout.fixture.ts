import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Whether this checkout sits in the owned layout, with the vterm sibling and the owned Termless beside it.
 * Standalone component CI checks out terminfo.dev alone and resolves the published @termless packages instead.
 * Moved unchanged from collect-headless.test.ts so both test homes read one fact (#32053, @dev/fixer 578f3a78).
 */
export const OWNED_LAYOUT = existsSync(fileURLToPath(new URL("../../../../vterm", import.meta.url)))
