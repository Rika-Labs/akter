import { Effect } from "effect"

const LOCK_EX = 2

const LOCK_NB = 4

const O_RDWR = 2

/** Keeps a child process from inheriting the lock descriptor, which would outlive this process. */
const O_CLOEXEC = process.platform === "darwin" ? 0x1000000 : 0o2000000

const library = process.platform === "darwin" ? "libc.dylib" : "libc.so.6"

interface Libc {
  readonly open: (path: string) => number
  readonly lock: (fd: number) => boolean
  readonly close: (fd: number) => void
}

/** Bun reaches libc through `bun:ffi`, imported here so no other runtime ever resolves that specifier. */
const loadBun = () =>
  import("bun:ffi").then(({ dlopen, FFIType }): Libc => {
    const { symbols } = dlopen(library, {
      open: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    })

    return {
      open: (path) => symbols.open(new TextEncoder().encode(`${path}\0`), O_RDWR | O_CLOEXEC),
      lock: (fd) => symbols.flock(fd, LOCK_EX | LOCK_NB) === 0,
      close: (fd) => void symbols.close(fd),
    }
  })

/** Node has no built-in `flock`, so it calls the same three libc functions through koffi's prebuilt native binding. */
const loadNode = () =>
  import("koffi").then(({ default: koffi }): Libc => {
    const libc = koffi.load(library)
    const open = libc.func("int open(const char *path, int flags)")
    const flock = libc.func("int flock(int fd, int operation)")
    const close = libc.func("int close(int fd)")

    return {
      open: (path) => open(path, O_RDWR | O_CLOEXEC),
      lock: (fd) => flock(fd, LOCK_EX | LOCK_NB) === 0,
      close: (fd) => void close(fd),
    }
  })

let libc: Promise<Libc> | undefined

const loadLibc = () =>
  (libc ??= (process.versions.bun === undefined ? loadNode() : loadBun()).catch((cause) => {
    libc = undefined

    throw cause
  }))

/**
 * Tries to take an exclusive, non-blocking `flock` on `path` for the scope and
 * answers whether it did; a file already locked answers false and registers
 * nothing. The lock belongs to the open descriptor, so the kernel drops it when
 * the holder dies, SIGKILL included, and a second descriptor in this process is
 * refused like another process's. The file and its directory are created first;
 * the lock is on the open file, not its bytes.
 */
export const flockExclusive = (path: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      if (process.platform !== "linux" && process.platform !== "darwin")
        return yield* Effect.die(
          new Error(`A file-backed PGlite database needs flock, which ${process.platform} lacks`),
        )

      const { open, lock, close } = yield* Effect.tryPromise(loadLibc).pipe(Effect.orDie)

      yield* Effect.promise(() =>
        import("node:fs/promises").then(({ mkdir, open }) =>
          mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true })
            .then(() => open(path, "a"))
            .then((handle) => handle.close()),
        ),
      )

      const fd = open(path)

      if (fd < 0) return yield* Effect.die(new Error(`Cannot open the lock file ${path}`))

      if (lock(fd)) return { fd, close }

      close(fd)

      return undefined
    }),
    (held) => Effect.sync(() => held?.close(held.fd)),
  ).pipe(Effect.map((held) => held !== undefined))
