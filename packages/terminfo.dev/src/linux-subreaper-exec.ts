/**
 * Become a child subreaper, then exec the given command in this same process (#38759).
 *
 * Zellij's client starts its server by double-forking it into a daemon, so the server would be re-parented outside
 * the outer terminal and the collector's ancestry would no longer reach the Kitty process that owns it. The Linux mux
 * shell re-execs itself through this helper first: PR_SET_CHILD_SUBREAPER survives execve, so the shell (same PID,
 * same start ticks) adopts the daemonized server and the ancestry stays collector -> server -> outer shell -> Kitty.
 * Runs under the image's Bun beside the runner and imports only bun:ffi, so its committed source is the frozen input.
 */
import { dlopen, FFIType, ptr } from "bun:ffi"

const PR_SET_CHILD_SUBREAPER = 36
const argv = process.argv.slice(2)
if (argv.length === 0) {
  process.stderr.write("usage: linux-subreaper-exec <command> [args...]\n")
  process.exit(2)
}
const libc = dlopen("libc.so.6", {
  prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  execvp: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
})
if (libc.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n) !== 0) {
  process.stderr.write("linux-subreaper-exec: prctl(PR_SET_CHILD_SUBREAPER) failed\n")
  process.exit(2)
}
const strings = argv.map((arg) => Buffer.from(`${arg}\0`))
const table = new BigUint64Array(strings.length + 1)
for (const [index, bytes] of strings.entries()) table[index] = BigInt(ptr(bytes))
libc.symbols.execvp(ptr(strings[0]!), ptr(table))
process.stderr.write(`linux-subreaper-exec: execvp ${argv[0]} failed\n`)
process.exit(127)
