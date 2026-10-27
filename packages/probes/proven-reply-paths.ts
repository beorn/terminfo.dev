/**
 * F1 (27832) on headless engines (#30554, @cto verdict 67840412): the backends that deliver every
 * engine reply to `onResponse` synchronously, inside `feed` or the `getCursor` drain, with no
 * background writer, no dropped reply class and no adapter-made DA1 answer. Each row was audited
 * against the Termless source at ea1439b, after #30549 removed the adapters' made-up replies, and its
 * DA1 answer was measured through feedCapture on Terminfo 70b6bfde (census: /hh/var/@dev2/da-census/).
 * Only a backend named here, at exactly these versions, gets the sentinel member. The ghostty WASM
 * engine, alacritty, wezterm, vt100-rust, ghostty-native and kitty are absent on purpose: none of them
 * delivers every reply inside the capture.
 *
 * This table is the proof's one home until #30576 moves the proof into the adapters and deletes it.
 * A row is keyed by versions, not by the audited source, so a Termless change under an unchanged
 * version is caught only by a fresh audit (@cto 99bd165a n2).
 *
 * Re-audited 2026-10-27 at engine 0.8.0 for vt100, vt220 and vterm (vendor/vterm d7f69fe9, Termless
 * 01f98b4, Terminfo 4ec774dd): DA1 still answers through feedCapture in each engine, and the onResponse
 * call sites are unchanged from the ea1439b audit except one addition (vt100 3, vt220 4, vterm 42 -> 43,
 * the truthful Kitty ENOTSUP refusal, #31020). Evidence, /hh/var/@dev8/:
 * 30695-sentinel-reaudit-20261027.md sha256 0404f81327709e20f80805d0f5b7842a9f58486ca6510a0831583514d6a3f520 and
 * 31059-s1-onResponse-sites-20261027.md sha256 367d1900530006372d031d6864439f8c46432e6d2f13827ee59a7d327234edc3.
 */
export interface ReplyPathProof {
  readonly adapterVersion: string
  readonly engineVersion: string
  /** Where every engine reply reaches onResponse, at Termless ea1439b. */
  readonly replySink: string
  /** The DA1 answer the backend gives through feedCapture: the proof's positive control. */
  readonly da1Answer: string
}

export const PROVEN_REPLY_PATHS: Readonly<Record<string, ReplyPathProof>> = {
  xtermjs: {
    adapterVersion: "0.10.2",
    engineVersion: "6.0.0",
    replySink:
      "term.onData -> onResponse (packages/xtermjs/src/backend.ts:194-196), fed through _writeBuffer.writeSync (:141-146, :221-222)",
    da1Answer: "\x1b[?1;2c",
  },
  vt100: {
    adapterVersion: "0.10.2",
    engineVersion: "0.8.0",
    replySink:
      "the engine's onResponse forwarder (packages/vt100/src/backend.ts:53-55), inside s.process (:97, :105, :112); the adapter's 18t reply from engine state, in input order (:107)",
    da1Answer: "\x1b[?1;2c",
  },
  vt220: {
    adapterVersion: "0.10.2",
    engineVersion: "0.8.0",
    replySink:
      "the engine's onResponse forwarder (packages/vt220/src/backend.ts:50-52), inside s.process (:94, :102, :109); the adapter's 18t reply from engine state, in input order (:104)",
    da1Answer: "\x1b[?62;1;2;6;7;8;9c",
  },
  vterm: {
    adapterVersion: "0.10.2",
    engineVersion: "0.8.0",
    replySink: "the engine's onResponse forwarder (packages/vterm/src/backend.ts:73-76), inside process (:87)",
    da1Answer: "\x1b[?62;4c",
  },
  libvterm: {
    adapterVersion: "0.10.2",
    engineVersion: "0.3.3",
    replySink: "the vterm_output_read drain inside feed (packages/libvterm/src/backend.ts:249-255)",
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
