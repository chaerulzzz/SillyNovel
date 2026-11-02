/**
 * SillyNovel — path resolution and containment.
 *
 * Every filesystem path in this plugin originates here. Nothing else resolves,
 * joins, or validates a path.
 *
 * ⚠️ SECURITY (AGENTS.md rules 7-9, docs/ARCHITECTURE.md §9). These are not
 * stylistic preferences — each one is a Phase 1.5 finding:
 *
 *  - `request.user.directories.root` is NOT guaranteed absolute. In this
 *    deployment it is `data/<handle>`, relative, because config.yaml sets
 *    `dataRoot: ./data`. Assuming absoluteness was a real bug found mid-spike.
 *    Resolve, then canonicalize, then contain against the canonical root.
 *  - Symlinks must be rejected on the directory AND every leaf, on read AND
 *    replace, checked independently. This means every ANCESTOR level too —
 *    `sillynovel/`, `projects/`, each project directory, each `chapters/` —
 *    not just the storage root and the final file. `fs.mkdir(path, {recursive:
 *    true})` does NOT throw when `path` already exists as a symlink to a
 *    directory; it treats that as success. Never use it here. Build paths
 *    level by level with `checkRealDirectory`/`ensureRealDirectory` instead.
 *  - No caller ever passes a path. Identifiers only, UUIDv4 only.
 *
 * ⚠️ MEASURED: on this deployment's virtiofs mount, a directory swapped for a
 * symlink can still `lstat` as the OLD (pre-swap) state for up to ~1 second
 * after the swap — confirmed even from a fresh process outside this Node
 * server (`container exec`), so it is mount-level attribute caching, not
 * anything in this file or in Node. This WIDENS the "one trusted OS-level
 * filesystem actor" TOCTOU acceptance already recorded in
 * docs/ARCHITECTURE.md §9 from a microsecond-scale check-then-use race to a
 * roughly one-second window — material for the Phase 9/10 re-review gates.
 * No userspace fix exists for a virtualization-layer cache; this is recorded,
 * not "fixed". Manually verifying any of the checks in this file must include
 * a delay of at least 2s after the swap, or the check will appear to fail
 * when it is actually just reading stale cached metadata.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Root of our storage inside the authenticated user's own directory. */
const STORAGE_DIR = 'sillynovel';

/**
 * Strict RFC 4122 v4. A string matching this cannot contain a path separator,
 * a dot-segment, a null byte, or anything else that survives into a filename —
 * which is what makes traversal untestable-by-construction rather than
 * defended-against-after-the-fact.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Thrown when ST's middleware did not populate the authenticated directories. */
export class BlockerError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BlockerError';
        this.status = 500;
        this.blocker = true;
    }
}

/** Thrown for anything the client got wrong. Never carries a path. */
export class RequestError extends Error {
    constructor(status, code) {
        super(code);
        this.name = 'RequestError';
        this.status = status;
        this.code = code;
    }
}

export function isUuid(value) {
    return typeof value === 'string' && UUID_V4.test(value);
}

/**
 * Canonical, symlink-free root of this user's SillyNovel storage.
 *
 * The directory is created if absent — non-recursively beyond the user's own
 * root, which ST owns and guarantees.
 *
 * @param {import('express').Request} request
 * @returns {Promise<string>} absolute, canonical path
 */
export async function resolveStorageRoot(request) {
    const directories = request?.user?.directories;

    if (!directories || typeof directories !== 'object') {
        throw new BlockerError('request.user.directories is not populated');
    }

    const userRoot = directories.root;

    if (typeof userRoot !== 'string' || userRoot.length === 0) {
        throw new BlockerError('request.user.directories.root is missing');
    }

    // resolve() first: this value may be relative to the server's cwd.
    // realpath() second: canonicalize before anything is compared against it.
    const canonicalUserRoot = await fs.realpath(path.resolve(userRoot));
    const storageRoot = path.join(canonicalUserRoot, STORAGE_DIR);

    // NOT fs.mkdir(storageRoot, {recursive: true}). Recursive mkdir does not
    // throw when the target already exists as a symlink to a directory — it
    // silently treats that as success. realpath() below would then canonicalize
    // straight through the symlink, and containment would still pass, because
    // the symlink's target can legitimately sit under canonicalUserRoot too.
    // Every request would then operate wherever that symlink points, silently.
    const exists = await checkRealDirectory(storageRoot);
    if (!exists) {
        await fs.mkdir(storageRoot);
    }

    // Canonicalize our own root too — if it is a symlink, every containment
    // check below would be comparing against the wrong tree.
    const canonicalStorageRoot = await fs.realpath(storageRoot);

    if (!isContained(canonicalStorageRoot, canonicalUserRoot)) {
        throw new BlockerError('storage root escaped the user directory');
    }

    return canonicalStorageRoot;
}

/**
 * True when `target` is `parent` itself or lies beneath it.
 *
 * Compares with a trailing separator so `/a/bc` is not treated as being inside
 * `/a/b` — the classic prefix-confusion bug.
 */
export function isContained(target, parent) {
    if (target === parent) {
        return true;
    }
    const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
    return target.startsWith(prefix);
}

/**
 * Build a contained path from validated identifier segments.
 *
 * Every segment must be a UUIDv4 or a fixed literal from this module's own
 * callers — never anything derived from a request body or query string.
 *
 * @param {string} root canonical storage root
 * @param {string[]} segments
 * @returns {string}
 */
export function containedPath(root, segments) {
    const resolved = path.resolve(root, ...segments);

    if (!isContained(resolved, root)) {
        throw new RequestError(400, 'invalid identifier');
    }

    return resolved;
}

/**
 * Assert a path is a plain directory — not a symlink to one.
 *
 * `lstat` does not follow the final component, which is the whole point:
 * `stat` would happily report a symlinked directory as a directory.
 *
 * Read-only, per-resource use: throws if the directory is missing OR wrong.
 * "Missing" and "symlink-tampered" collapse to the same 404 deliberately — a
 * client must not be able to tell the difference, or the error becomes an
 * oracle for probing what exists.
 */
export async function assertRealDirectory(target) {
    const stats = await fs.lstat(target).catch(() => null);

    if (!stats) {
        throw new RequestError(404, 'not found');
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new RequestError(404, 'not found');
    }
}

/**
 * Verify a FOUNDATIONAL directory — one shared by every resource this user
 * has, not scoped to a single project or chapter. Missing is normal (nothing
 * has been created yet); existing-as-something-else is a structural anomaly
 * affecting this user's entire account, not one resource, so it is a
 * BlockerError rather than a 404.
 *
 * Used for the storage root and the projects/ container. NOT used for a
 * specific project or chapters/ directory — those are per-resource and use
 * `assertRealDirectory` / `ensureRealDirectory` instead.
 *
 * @returns {Promise<boolean>} whether the directory currently exists
 */
export async function checkRealDirectory(target) {
    const stats = await fs.lstat(target).catch(() => null);

    if (stats && (stats.isSymbolicLink() || !stats.isDirectory())) {
        throw new BlockerError('a foundational storage directory is not a plain directory');
    }

    return Boolean(stats);
}

/**
 * Ensure a PER-RESOURCE directory exists as a plain directory, creating it
 * (non-recursively) if absent.
 *
 * Deliberately never `{recursive: true}`: that mode silently tolerates an
 * existing symlink-to-directory, which is exactly the gap this function
 * exists to close. Callers build a path level by level — each level checked
 * or created only after its own parent has already been verified real, so no
 * unverified component is ever trusted.
 */
export async function ensureRealDirectory(target) {
    const stats = await fs.lstat(target).catch(() => null);

    if (!stats) {
        try {
            await fs.mkdir(target);
            return;
        } catch (error) {
            // Two writers racing to create the same per-resource directory —
            // e.g. two chapters' first notes saves in one project — both see it
            // absent and both mkdir. The loser must not fail the request: it
            // re-checks what now exists with the same test as the found path.
            if (error?.code !== 'EEXIST') {
                throw error;
            }
        }
    }

    const found = stats ?? await fs.lstat(target).catch(() => null);

    if (!found || found.isSymbolicLink() || !found.isDirectory()) {
        throw new RequestError(404, 'not found');
    }
}

/**
 * Probe a PER-RESOURCE directory on a READ path.
 *
 * Absent is a legitimate answer here ("nothing stored yet"), so it returns
 * false rather than throwing; a symlink or a non-directory is 404 like any
 * tampered resource; a real directory is true. Never creates — a read must not
 * write — which is why neither ensureRealDirectory (creates) nor
 * assertRealDirectory (404 on absent) fits.
 *
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function probeRealDirectory(target) {
    const stats = await fs.lstat(target).catch(() => null);

    if (!stats) {
        return false;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new RequestError(404, 'not found');
    }
    return true;
}

/**
 * Assert a path is a plain file — not a symlink to one.
 *
 * Called before every read, before every replace, and (from Phase 5) before
 * every delete. Guarding one operation and not the others leaves the rest open.
 */
export async function assertRealFile(target) {
    const stats = await fs.lstat(target).catch(() => null);

    if (!stats) {
        throw new RequestError(404, 'not found');
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new RequestError(404, 'not found');
    }
}

export { STORAGE_DIR };
