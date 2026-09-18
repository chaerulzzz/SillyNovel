/**
 * SillyNovel — atomic file replacement.
 *
 * The exact sequence proven against Apple Container's virtiofs mount in Phase
 * 1.5 (docs/PROGRESS.md, tests/phase-1.5/RESULTS.md):
 *
 *   exclusive same-directory temp create (wx) -> write -> fsync -> close
 *   -> rename, with the temp unlinked in a finally on every path
 *
 * PROVEN: no truncation; atomic replacement visibility to concurrent readers
 * (20/20 rounds clean); temp cleanup on forced failure; survives container
 * stop/start; no zero-byte stubs.
 *
 * PARENT-DIRECTORY FSYNC — decided by measurement in Phase 2. Benchmarked
 * inside the container against the real virtiofs mount, 60 iterations at a
 * 40KB chapter:
 *
 *   without parent fsync   p50=0.58ms  p95=1.61ms
 *   with parent fsync      p50=0.58ms  p95=0.97ms
 *
 * It is supported and costs nothing measurable at this scale, so we do it. A
 * rename is not durable until the directory entry is synced, and this is the
 * conventional step for that.
 *
 * ⚠️ STILL NOT PROVEN: actual survival of an abrupt HOST crash or power loss.
 * That the call succeeds is not proof the guarantee survives the virtualization
 * layer end to end, and only real power-loss testing would show it. We now
 * perform the conventional durability step; we do not claim the outcome.
 */

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * Replace `target` with `contents`, atomically.
 *
 * The temp file is created in the same directory so the rename stays within one
 * filesystem — a rename across mounts is not atomic and would silently degrade
 * into copy-then-delete.
 *
 * @param {string} target absolute, already contained and validated
 * @param {string} contents
 */
export async function atomicWrite(target, contents) {
    const directory = path.dirname(target);
    const temporary = path.join(directory, `.tmp-${randomUUID()}`);

    let handle = null;

    try {
        // 'wx' fails if the path exists. A UUID collision should be impossible;
        // if it somehow happens we want an error, not a silent overwrite.
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;

        await fs.rename(temporary, target);

        // The rename is not durable until the directory entry itself is synced.
        // Best-effort: a filesystem that refuses this should not fail the write,
        // which already succeeded.
        const directoryHandle = await fs.open(directory, 'r').catch(() => null);
        if (directoryHandle) {
            try {
                await directoryHandle.sync();
            } catch (error) {
                // The write itself already succeeded — this never fails the
                // request. But swallowing every error identically means a
                // filesystem that genuinely doesn't support this looks
                // indistinguishable from a real I/O problem. We measured this
                // as supported on the pinned virtiofs deployment (see header),
                // so any failure here in production is unexpected and worth
                // knowing about, not something to guess an allowlist for.
                console.warn(`[sillynovel] parent-directory fsync failed for ${path.basename(directory)}:`, error?.code ?? error);
            } finally {
                await directoryHandle.close().catch(() => {});
            }
        }
    } finally {
        if (handle) {
            await handle.close().catch(() => {});
        }
        // Unlink unconditionally. After a successful rename the temp name no
        // longer exists and this is a harmless ENOENT; after any failure it is
        // the only thing preventing an orphan.
        await fs.rm(temporary, { force: true }).catch(() => {});
    }
}
