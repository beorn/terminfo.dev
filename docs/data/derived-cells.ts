/**
 * Unsupported, derived (#33019, @cto 2300c1b4 / 1192f8b5 / 6588ac5f / ed184562): a child feature reads Unsupported
 * when its declared parent is DECIDED Unsupported, with its own direct witness, in the same context. The pairs are
 * data; the reader names no feature. Stored rows stay exactly as measured, and the parent is read live on every
 * projection, so a parent that is reopened or re-measured takes the child with it.
 */
import type { SelectedContextCell } from "./selected-results.ts"

export interface DerivedPair {
  readonly child: string
  readonly parent: string
  /** The parent as a reader knows it, for the cell's sentence. */
  readonly parentName: string
  /** Why the child needs the parent, completing "because …". */
  readonly needs: string
}

/** Every declared pair. Any pair beyond these goes to @cto first (33019 condition 5). */
export const DERIVED_UNSUPPORTED: readonly DerivedPair[] = [
  {
    child: "extensions.kitty-graphics.display",
    parent: "extensions.kitty-graphics.transmit",
    parentName: "Kitty graphics transmit",
    needs: "an image must be transmitted before it can be displayed",
  },
  {
    child: "extensions.kitty-graphics.animation",
    parent: "extensions.kitty-graphics.transmit",
    parentName: "Kitty graphics transmit",
    needs: "an animation's frames are transmitted images",
  },
  {
    child: "extensions.kitty-graphics.unicode-placeholders",
    parent: "extensions.kitty-graphics.transmit",
    parentName: "Kitty graphics transmit",
    needs: "a placeholder shows a transmitted image",
  },
  {
    child: "sgr.underline-color-reset",
    parent: "sgr.underline.color",
    parentName: "underline colour (SGR 58)",
    needs: "a terminal that cannot colour an underline has nothing to reset",
  },
  {
    child: "extensions.osc117-reset-highlight-bg",
    parent: "extensions.osc17-highlight-bg",
    parentName: "highlight background colour (OSC 17)",
    needs: "there is no highlight background colour to reset",
  },
  {
    child: "extensions.osc119-reset-highlight-fg",
    parent: "extensions.osc19-highlight-fg",
    parentName: "highlight foreground colour (OSC 19)",
    needs: "there is no highlight foreground colour to reset",
  },
]

/** One cell a parts row reads, as a reader knows it. */
export interface DerivedPart {
  readonly feature: string
  readonly name: string
}

/** A part as its context selected it: its own run, status and recorded reason. */
export interface PartReading extends DerivedPart {
  readonly runId: string
  readonly status: string
  readonly reason: string | null
}

/** A parts row's verdict: the status, its words, and the parts that decide it (the first is the cited entry). */
export interface PartsGrade {
  readonly status: "supported" | "unsupported" | "untestable" | "probe-todo"
  readonly words: string
  readonly decidedBy: readonly number[]
}

/**
 * A cell graded only from other cells of the same context by its table (#38772, @cto 8cccf709), never by its own
 * probe. The pairs above are the one-part case: their part is the parent and their table is "refused by its own effect
 * witness entails Unsupported"; they keep their literal shape so their outputs stay byte-identical.
 */
export interface DerivedParts {
  readonly child: string
  readonly parts: readonly DerivedPart[]
  readonly grade: (parts: readonly PartReading[], kind: string) => PartsGrade
}

export type DerivedRow = DerivedPair | DerivedParts

const DECIDED_PART = new Set(["supported", "unsupported", "untestable"])

/**
 * The setting a read row names when it read only under a non-default setting, from the fixed phrases our collectors
 * record: an app profile's "allow: <setting>", or a library's "read under harness-supplied <setting>". Anything else
 * reads as defaults.
 */
export function readSetting(reason: string | null): { setting: string; by: "app" | "embedder" } | null {
  if (!reason) return null
  const app = /(?:^|; )allow: ([^;]+)/.exec(reason)?.[1]
  if (app) return { setting: app.trim(), by: "app" }
  const embedder = /read under harness-supplied ([^;]+)/.exec(reason)?.[1]
  if (embedder) return { setting: embedder.trim(), by: "embedder" }
  return null
}

/**
 * OSC 52's umbrella from its write and read rows (@cpo/term f281df2f, 5483ec82). A half that is not decided leaves it
 * To do; a half that is Untestable makes it Untestable; a refused write is Unsupported. With the write working, a read
 * refused at defaults is Unsupported; a read that needs a setting is Unsupported on an app (judged at shipped defaults)
 * and Supported on a library (judged with its embedder's setting enabled); a read at defaults is Supported.
 */
export function gradeOsc52Clipboard(parts: readonly PartReading[], kind: string): PartsGrade {
  const [write, read] = parts
  if (!write || !read) throw new Error("The OSC 52 umbrella reads exactly two parts: write, then read")
  const open = parts.filter((part) => !DECIDED_PART.has(part.status))
  if (open.length > 0) {
    return {
      status: "probe-todo",
      words: `needs both halves measured: ${open.map((part) => part.name).join(" and ")} ${open.length > 1 ? "are" : "is"} not decided`,
      decidedBy: [],
    }
  }
  const untestable = parts.find((part) => part.status === "untestable")
  if (untestable) {
    return {
      status: "untestable",
      words: `${untestable.name} is untestable here`,
      decidedBy: [parts.indexOf(untestable)],
    }
  }
  if (write.status === "unsupported") {
    return { status: "unsupported", words: `copy does not work (${write.name})`, decidedBy: [0] }
  }
  if (read.status === "unsupported") {
    return {
      status: "unsupported",
      words: `copy works (${write.name}); reading does not answer at default settings, see ${read.name}`,
      decidedBy: [1],
    }
  }
  const setting = readSetting(read.reason)
  if (setting && kind === "lib") {
    return {
      status: "supported",
      words: `copy and paste-back both work; reading needs the embedding app's setting (${setting.setting})`,
      decidedBy: [0, 1],
    }
  }
  if (setting) {
    return {
      status: "unsupported",
      words: `copy works (${write.name}); reading is off by default (${setting.setting}), see ${read.name}`,
      decidedBy: [1],
    }
  }
  return {
    status: "supported",
    words: `copy and paste-back both work at default settings (${write.name} and ${read.name})`,
    decidedBy: [0, 1],
  }
}

/** Every parts row. Any row beyond these goes to @cto first, as the pairs do. */
export const DERIVED_FROM_PARTS: readonly DerivedParts[] = [
  {
    child: "extensions.osc52-clipboard",
    parts: [
      { feature: "extensions.osc52-write", name: "OSC 52 write" },
      { feature: "extensions.osc52-read", name: "OSC 52 read" },
    ],
    grade: gradeOsc52Clipboard,
  },
]

/** Every derived row the projection reads by default: the one-part pairs, then the parts rows. */
export const DERIVED_ROWS: readonly DerivedRow[] = [...DERIVED_UNSUPPORTED, ...DERIVED_FROM_PARTS]

/** Set only on a cell graded from parts: each part as read, the verdict's words, and the cell's own stored reading. */
export interface DerivedPartsMarker {
  readonly parts: readonly PartReading[]
  /** The part whose entry the card cites (the first that decided it); absent when no part decided it. */
  readonly cites?: string
  readonly words: string
  readonly ownStatus: string
  readonly ownReason: string | null
}

/** A derived cell's marker: from one refused parent, or from parts. */
export type DerivedMarker = DerivedParentMarker | DerivedPartsMarker

/** Set only on a derived cell: the parent it was read from, and the child's own stored reading kept beside it. */
export interface DerivedParentMarker {
  readonly parent: string
  readonly parentName: string
  readonly parentRunId: string
  readonly parentReason: string | null
  readonly needs: string
  /** The child's own reading before derivation, so the move is visible and reversible. */
  readonly ownStatus: string
  /** The child's own stored refusal or reason, kept as a note (@cto ed184562 answer 3). */
  readonly ownReason: string | null
}

const cellStatus = (cell: SelectedContextCell) => cell.featureResult?.status ?? cell.result.status

/**
 * A parent entails only when it is decided Unsupported by its own direct witness, never by derivation, and that
 * witness read the effect (#38772, @cto b1a8ecea and 7ffb81e4): the effect decides, the reply never does. A
 * query_reply witness is a reply or its absence, never the effect: a fenced silence shows the terminal does not answer
 * the query, not that it lacks the feature, and a state reply that omits an attribute (Ghostty 1.3.1's DECRQSS
 * answering 0;4m with no SGR 58) shows only what the reply can carry. Neither entails anything about the child, which
 * keeps its own reading.
 */
function entailingParent(cell: SelectedContextCell | undefined): cell is SelectedContextCell {
  return (
    cell !== undefined &&
    cell.derived === undefined &&
    cellStatus(cell) === "unsupported" &&
    cell.result.status === "unsupported" &&
    cell.result.assertionType !== undefined &&
    cell.result.assertionType !== "query_reply"
  )
}

/**
 * Derive the declared children of one context in place; returns the child ids it derived. A child already decided
 * Unsupported stays direct. A child reading Supported under an entailing parent throws: the table or a measurement
 * is wrong, and that comes to @cto. A conflicting or reopened child is left as it reads.
 */
export function applyDerived(
  contextKey: string,
  cells: Record<string, SelectedContextCell>,
  rows: readonly DerivedRow[],
): string[] {
  const derived: string[] = []
  for (const row of rows) {
    if ("parts" in row) {
      if (applyParts(cells, row)) derived.push(row.child)
      continue
    }
    const pair = row
    const parent = cells[pair.parent]
    const child = cells[pair.child]
    if (!child || !entailingParent(parent)) continue
    const status = cellStatus(child)
    if (status === "supported") {
      throw new Error(
        `Derived pair ${pair.parent} -> ${pair.child} in ${contextKey}: the child reads Supported while the parent reads Unsupported with its own witness (run ${parent.run.runId}); the pair table or a measurement is wrong, bring it to @cto (#33019)`,
      )
    }
    if (status === "unsupported" || status === "probe-conflict" || child.reopened || !child.featureResult) continue
    cells[pair.child] = {
      ...child,
      featureResult: { ...child.featureResult, status: "unsupported", strength: null },
      derived: {
        parent: pair.parent,
        parentName: pair.parentName,
        parentRunId: parent.run.runId,
        parentReason: parent.result.reason ?? null,
        needs: pair.needs,
        ownStatus: status,
        ownReason: child.result.reason ?? null,
      },
    }
    derived.push(pair.child)
  }
  return derived
}

type PartSubject = {
  readonly version: unknown
  readonly os: unknown
  readonly osVersion?: unknown
  readonly config?: unknown
}

/**
 * Whether the parts were measured on the same app version, OS and profile (@cpo/term 5483ec82). A part that names the
 * setting it was read under (readSetting) was measured on its own profile by design: the grade judges that setting,
 * so its config may differ. Any other config difference, or a missing part, is not comparable.
 */
export function partsComparable(
  subjects: readonly (PartSubject | undefined)[],
  readings: readonly PartReading[],
): boolean {
  const first = subjects[0]
  if (!first) return false
  return subjects.every(
    (subject, index) =>
      subject !== undefined &&
      subject.version === first.version &&
      subject.os === first.os &&
      subject.osVersion === first.osVersion &&
      (subject.config === first.config || readSetting(readings[index]?.reason ?? null) !== null),
  )
}

/**
 * Grade one parts row in place; true when it graded the child. Every part must be present and measured on the same app
 * version, OS and profile as the others, or the child reads To do (@cpo/term 5483ec82). The child's own probe never
 * decides it; its stored reading stays beside the grade.
 */
function applyParts(cells: Record<string, SelectedContextCell>, row: DerivedParts): boolean {
  const child = cells[row.child]
  if (!child?.featureResult) return false
  const present = row.parts.map((part) => cells[part.feature])
  const readings: PartReading[] = row.parts.map((part, index) => {
    const cell = present[index]
    return {
      ...part,
      runId: cell?.run.runId ?? "",
      status: cell ? cellStatus(cell) : "probe-todo",
      reason: cell?.result.reason ?? null,
    }
  })
  const same = partsComparable(
    present.map((cell) => cell?.run.subject),
    readings,
  )
  const grade: PartsGrade = same
    ? row.grade(readings, child.run.subject.kind)
    : {
        status: "probe-todo",
        words: "needs both halves measured on the same app version, OS and profile",
        decidedBy: [],
      }
  const first = grade.decidedBy[0]
  const cited = first === undefined ? undefined : row.parts[first]
  cells[row.child] = {
    ...child,
    featureResult: { ...child.featureResult, status: grade.status, strength: null },
    derived: {
      parts: readings,
      ...(cited && { cites: cited.feature }),
      words: grade.words,
      ownStatus: cellStatus(child),
      ownReason: child.result.reason ?? null,
    },
  }
  return true
}

/** The words a derived cell shows wherever it is displayed. */
export function publicDerivedReason(marker: DerivedMarker): string {
  if ("parts" in marker) {
    return `Graded from ${marker.parts.map((part) => part.name).join(" and ")} in this context: ${marker.words}.`
  }
  const witness = marker.parentReason ? ` (${marker.parentReason})` : ""
  return `Unsupported, derived: ${marker.parentName} was refused in run ${marker.parentRunId}${witness}; ${marker.needs}.`
}
