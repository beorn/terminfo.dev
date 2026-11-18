// 34753: the Node proof child imports our TypeScript sources directly. Node's ESM resolver requires a
// file extension, while this repo is authored with bundler-style extensionless specifiers (and the
// vendored silvery sources do the same), so the child registers this hook to finish the lookup the
// way the Bun/tsconfig resolution already does. It only runs in the child; nothing ships.
import { register } from "node:module"

register(new URL("./node-ts-resolve-hooks.mjs", import.meta.url))
