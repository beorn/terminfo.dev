import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { command } from "./capture-core.ts"
import {
  NOTIFICATIONS_NAME,
  NOTIFY_RECEIPT_SCHEMA,
  parseNotifyRecord,
  type NotifyEntry,
  type NotifyRecorderReceipt,
} from "./linux-notify-recorder.ts"

/** Owned App-run readback; the probe decides the criterion from these observations. */
export interface NotificationObserver {
  readonly receipt: NotifyRecorderReceipt
  readonly control: { readonly nonce: string; readonly id: number }
  cursor(): number
  readSince(cursor: number): { readonly entries: readonly NotifyEntry[]; readonly problems: readonly string[] }
}

/** Qualify the launch receipt with a Notify sent by the independent libdbus client. */
export async function createNotificationObserver(options: {
  readonly receiptPath: string
  readonly address: string
}): Promise<NotificationObserver> {
  const rawReceipt = readFileSync(options.receiptPath, "utf8")
  const value: unknown = JSON.parse(rawReceipt)
  if (typeof value !== "object" || value === null) {
    throw new Error(`notification fixture ${options.receiptPath}: receipt is not an object`)
  }
  const receipt = value as Record<string, unknown>
  if (
    receipt.schema !== NOTIFY_RECEIPT_SCHEMA ||
    receipt.name !== NOTIFICATIONS_NAME ||
    receipt.owned !== true ||
    receipt.address !== options.address ||
    typeof receipt.pid !== "number" ||
    !Number.isSafeInteger(receipt.pid) ||
    receipt.pid <= 1 ||
    typeof receipt.uniqueName !== "string" ||
    !/^:\d+\.\d+$/.test(receipt.uniqueName) ||
    typeof receipt.recordPath !== "string" ||
    receipt.recordPath.length === 0 ||
    typeof receipt.startedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.startedAt))
  ) {
    throw new Error(
      `notification fixture ${options.receiptPath}: receipt does not identify the owned recorder on ${options.address}`,
    )
  }
  const recordPath = receipt.recordPath
  let previousRecord = ""
  const read = () => {
    if (readFileSync(options.receiptPath, "utf8") !== rawReceipt) {
      throw new Error(`notification fixture ${options.receiptPath}: recorder receipt changed during observation`)
    }
    const text = readFileSync(recordPath, "utf8")
    if (!text.startsWith(previousRecord)) {
      throw new Error(`notification fixture ${recordPath}: record was replaced or truncated during observation`)
    }
    const rows = parseNotifyRecord(text, recordPath)
    previousRecord = text
    return rows
  }
  const beforeControl = read().length
  const nonce = `terminfo-notify-control-${randomBytes(12).toString("hex")}`
  const reply = (
    await command(
      "dbus-send",
      [
        `--bus=${options.address}`,
        "--print-reply",
        "--reply-timeout=2000",
        `--dest=${NOTIFICATIONS_NAME}`,
        "/org/freedesktop/Notifications",
        `${NOTIFICATIONS_NAME}.Notify`,
        "string:terminfo-control",
        "uint32:0",
        "string:",
        `string:${nonce}`,
        `string:${nonce}`,
        "array:string:",
        "dict:string:variant:",
        "int32:-1",
      ],
      undefined,
      Date.now() + 5000,
    )
  ).toString("utf8")
  const id = /^\s*uint32 (\d+)\s*$/m.exec(reply)?.[1]
  const observed = read()
    .slice(beforeControl)
    .find(
      (entry): entry is NotifyEntry =>
        entry.kind === "notify" && entry.summary === nonce && entry.body === nonce && entry.id === Number(id),
    )
  if (id === undefined || observed === undefined) {
    throw new Error(
      `notification fixture ${recordPath}: independent control Notify was not recorded with its returned id`,
    )
  }
  return {
    receipt: receipt as unknown as NotifyRecorderReceipt,
    control: { nonce, id: observed.id },
    cursor: () => read().length,
    readSince(cursor) {
      const rows = read()
      return {
        entries: rows.slice(cursor).filter((entry): entry is NotifyEntry => entry.kind === "notify"),
        problems: rows.flatMap((entry) => (entry.kind === "unparsed" || entry.kind === "fatal" ? [entry.reason] : [])),
      }
    },
  }
}
