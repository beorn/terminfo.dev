/** Replay artifacts have one private home; callers cannot select measured-content destinations. */
import { homedir } from "node:os"
import { join } from "node:path"

export const ERASE_REPLAY_ROOT = join(homedir(), ".terminfo-dev", "replays")
