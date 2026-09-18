/**
 * SillyNovel — per-key serialization.
 *
 * WHY THIS EXISTS: `If-Match` is a compare-and-swap, and a hash comparison
 * followed by an atomic rename is not atomic *as a whole*:
 *
 *     Tab A reads ETag X          Tab B reads ETag X
 *     A compares X == X  ok       B compares X == X  ok
 *     A writes "...foo"           B writes "...bar"
 *     both told they saved        one version is silently gone
 *
 * The rename picks a winner for the bytes, but the loser is told it succeeded.
 * That is exactly the silent loss the product forbids. Holding a lock across
 * read -> compare -> write closes it.
 *
 * 📌 RECORDED ASSUMPTION: an in-memory lock is sufficient because SillyTavern
 * runs as a SINGLE Node process — verified against the pinned 1.18.0 source,
 * which contains no `cluster`, `Worker`, or `child_process.fork`. A clustered
 * or multi-process deployment invalidates this and needs an on-disk or
 * O_EXCL-based scheme instead. Treat that as a trigger to revisit, the same way
 * docs/ARCHITECTURE.md §9 records the TOCTOU acceptance.
 */

/** @type {Map<string, Promise<unknown>>} tail of each key's pending chain */
const chains = new Map();

/**
 * Run `fn` with exclusive access to `key`.
 *
 * Calls for the same key run one at a time, in arrival order. Calls for
 * different keys do not block each other.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLock(key, fn) {
    const previous = chains.get(key) ?? Promise.resolve();

    // `current` is the new tail. It is only ever *resolved* — never rejected —
    // so a failing caller cannot cascade into the next caller's turn, and
    // `await previous` below needs no catch.
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    chains.set(key, current);

    await previous;

    try {
        return await fn();
    } finally {
        release();
        // Storing `current` itself (rather than a derived promise) is what makes
        // this identity check work — otherwise the map grows without bound in a
        // long-lived process. Only the last caller in the queue clears the key.
        if (chains.get(key) === current) {
            chains.delete(key);
        }
    }
}

/** Test seam: number of keys currently held or queued. */
export function pendingKeyCount() {
    return chains.size;
}
