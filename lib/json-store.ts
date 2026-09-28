import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { serverDataJsonPath, type ServerDataFile } from "@/lib/server-data-paths";

/**
 * Serialized, crash-safe access to the JSON sidecar stores.
 *
 * Each store used to hand-roll its own `readFile` -> `JSON.parse` -> mutate ->
 * `writeFile` pair with no coordination, so two concurrent read-modify-write
 * cycles on the same file raced and the second `writeFile` silently discarded
 * the first. `lib/signal-store.ts` had this fixed inline by #361; the remaining
 * JSON stores share the same shape and route their mutations through here.
 *
 * Three guarantees:
 *
 * 1. `withFileLock` chains work per absolute file path, so a read-modify-write
 *    cycle runs to completion before the next one starts. `updateJsonFile` puts
 *    the read AND the write inside that chain, which is what removes the lost
 *    update.
 * 2. `writeJsonFileAtomic` writes a sibling temp file then `rename`s it over the
 *    target, so a reader never observes a half-written file and a crash
 *    mid-write cannot truncate the store to invalid JSON.
 * 3. A JSON parse failure throws instead of degrading to `{}`. Returning `{}`
 *    on a parse error meant the next write silently overwrote every existing
 *    record. A missing file still resolves to the caller's fallback.
 *
 * SCOPE LIMIT — the lock is per-process. It removes the single-instance race,
 * which is the dominant failure mode, but it does NOT make the sidecars safe
 * across processes or serverless instances: on Vercel each instance resolves
 * its own `os.tmpdir()` copy of the data root, so two instances hold divergent
 * state and whichever writes last wins. Cross-instance consistency needs a
 * shared datastore or an advisory lock on a shared volume. See
 * `serverDataRoot()` in lib/server-data-paths.ts and docs/TECHNICAL.md 5.4.
 *
 * LOCKS ARE NOT REENTRANT. A `mutate` callback must never call back into a
 * locking store function for the same file, or it will deadlock waiting on its
 * own chain. Apply nested changes to the in-flight `store` object directly and
 * fire notifications after the callback returns.
 */

const fileQueues = new Map<string, Promise<unknown>>();

/**
 * Runs `task` with exclusive access to `filePath` within this process. Pairing
 * this with the raw read/write helpers is almost never what you want — use
 * `updateJsonFile` / `updateStore` so the read and the write share one critical
 * section.
 */
export function withFileLock<T>(
  filePath: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = fileQueues.get(filePath) ?? Promise.resolve();
  const next = previous.then(task, task);
  fileQueues.set(
    filePath,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/**
 * Unlocked read. A missing file yields `fallback`; a corrupt file throws rather
 * than silently reporting empty. Safe for read-only consumers.
 */
export async function readJsonFile<T>(
  filePath: string,
  fallback: T,
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return fallback;
    throw error;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Corrupt JSON store at ${filePath}: ${String(error)}`);
  }
}

/**
 * Unlocked atomic write. Prefer `updateJsonFile` / `updateStore` — this only
 * guarantees the write is not torn, not that it will not clobber a concurrent
 * writer.
 */
export async function writeJsonFileAtomic(
  filePath: string,
  data: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Locked read-modify-write: reads, applies `mutate`, and atomically writes while
 * holding the file's lock, then returns whatever `mutate` returned. This is the
 * only correct way to mutate a store.
 *
 * `read` adapts the parsed JSON into the store's shape. Use it for files with a
 * legacy or defensive on-disk format that needs normalizing before mutation.
 */
export async function updateJsonFile<T, R>(
  filePath: string,
  opts: {
    read?: (raw: unknown) => T;
    mutate: (store: T) => R | Promise<R>;
  },
): Promise<R> {
  return withFileLock(filePath, async () => {
    const raw = await readJsonFile<unknown>(filePath, undefined);
    // A missing file starts from an empty store, matching the
    // `catch { return {} }` readers this replaces.
    const store = opts.read ? opts.read(raw) : ((raw ?? {}) as T);
    const result = await opts.mutate(store);
    await writeJsonFileAtomic(filePath, store);
    return result;
  });
}

/** Locked read-modify-write for a registered sidecar file. */
export function updateStore<T extends object, R = void>(
  key: ServerDataFile,
  mutate: (store: T) => R | Promise<R>,
): Promise<R> {
  return updateJsonFile<T, R>(serverDataJsonPath(key), { mutate });
}

/**
 * Locked read-modify-write for a registered sidecar file whose on-disk shape
 * needs normalizing before mutation.
 */
export function updateStoreWithReader<T, R>(
  key: ServerDataFile,
  read: (raw: unknown) => T,
  mutate: (store: T) => R | Promise<R>,
): Promise<R> {
  return updateJsonFile<T, R>(serverDataJsonPath(key), { read, mutate });
}

/** Unlocked read of a registered sidecar file. Safe for read-only consumers. */
export function readStore<T extends object>(
  key: ServerDataFile,
  fallback: () => T,
): Promise<T> {
  return readJsonFile<T>(serverDataJsonPath(key), fallback());
}
