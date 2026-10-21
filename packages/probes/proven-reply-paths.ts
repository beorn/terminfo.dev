/**
 * F1 (27832) on headless engines (#30554, @cto verdict 67840412): the backends that deliver every
 * engine reply to `onResponse` synchronously, inside `feed` or the `getCursor` drain, with no
 * background writer, no dropped reply class and no adapter-made DA1 answer. Each row was audited
 * against the Termless source at 23207f1, and its DA1 answer was measured through feedCapture on
 * Terminfo 70b6bfde (census: /hh/var/@dev2/da-census/). Only a backend named here, at exactly these
 * versions, gets the sentinel member. The ghostty WASM engine, alacritty, wezterm, vt100-rust,
 * ghostty-native and kitty are absent on purpose: none of them delivers every reply inside the capture.
 *
 * This table is the proof's one home until #30549 makes the adapters' own declarations honest; the
 * change that moves the proof into the adapters deletes it.
 */
export interface ReplyPathProof {
  readonly adapterVersion: string
  readonly engineVersion: string
  /** Where every engine reply reaches onResponse, at Termless 23207f1. */
  readonly replySink: string
  /** The DA1 answer the backend gives through feedCapture: the proof's positive control. */
  readonly da1Answer: string
}

export const PROVEN_REPLY_PATHS: Readonly<Record<string, ReplyPathProof>> = {
  xtermjs: {
    adapterVersion: "0.10.2",
    engineVersion: "6.0.0",
    replySink:
      "term.onData -> onResponse (packages/xtermjs/src/backend.ts:194-196), fed through _writeBuffer.writeSync (:141-146, :250-251)",
    da1Answer: "\x1b[?1;2c",
  },
  vt100: {
    adapterVersion: "0.10.2",
    engineVersion: "0.7.1",
    replySink: "the engine's onResponse forwarder (packages/vt100/src/backend.ts:53-55), inside s.process (:94)",
    da1Answer: "\x1b[?1;2c",
  },
  vt220: {
    adapterVersion: "0.10.2",
    engineVersion: "0.7.1",
    replySink: "the engine's onResponse forwarder (packages/vt220/src/backend.ts:50-52)",
    da1Answer: "\x1b[?62;1;2;6;7;8;9c",
  },
  vterm: {
    adapterVersion: "0.10.2",
    engineVersion: "0.7.1",
    replySink: "the engine's onResponse forwarder (packages/vterm/src/backend.ts:75-78)",
    da1Answer: "\x1b[?62;4c",
  },
  libvterm: {
    adapterVersion: "0.10.2",
    engineVersion: "0.3.3",
    replySink: "the vterm_output_read drain inside feed (packages/libvterm/src/backend.ts:269-274)",
    da1Answer: "\x1b[?1;2c",
  },
}

/**
 * Whether one headless run gets the sentinel member, and why. The collector keeps it in the run as
 * `collector.replyPath`, so a pass review can tell a cell that stayed inconclusive because its
 * engine's version drifted from a cell whose engine was never proven.
 */
export type ReplyPathDecision =
  | { member: true; backend: string; proof: ReplyPathProof }
  | { member: false; backend: string; adapterVersion: string; engineVersion: string; reason: string }

/**
 * A proven backend at versions its row does not name gets no member, and says so on stderr as well as
 * in the run: an engine bump flips that engine's sentinel cells back to inconclusive, and the flip
 * must never be silent (@cto 67840412).
 */
export function replyPathDecision(
  backend: string,
  identity: { adapterVersion: string; engineVersion: string },
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): ReplyPathDecision {
  const { adapterVersion, engineVersion } = identity
  const proof = PROVEN_REPLY_PATHS[backend]
  if (!proof) {
    return { member: false, backend, adapterVersion, engineVersion, reason: `${backend} has no proven reply path` }
  }
  if (proof.adapterVersion === adapterVersion && proof.engineVersion === engineVersion) {
    return { member: true, backend, proof }
  }
  const reason =
    `version drift: ${backend} runs adapter ${adapterVersion} with engine ${engineVersion}, but its reply-path ` +
    `proof names adapter ${proof.adapterVersion} with engine ${proof.engineVersion}; the sentinel member is ` +
    "withheld, so its silent queries stay inconclusive until the proof is audited again"
  warn(`headless ${reason}`)
  return { member: false, backend, adapterVersion, engineVersion, reason }
}
