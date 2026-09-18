/**
 * SillyNovel — the local recovery store (Phase 2, checkpoint 7).
 *
 * A copy of the chapter being edited, held in the browser so that the couple of
 * seconds of typing the server has not seen yet survives a crash, a closed tab,
 * or a save that could not go through.
 *
 * ARCHITECTURE.md §9 "Durability": raw string, no diffing, ~500 ms debounce —
 * and an explicit refusal to promise zero-character loss under a sudden
 * browser-process crash. The goal is RECOVERABLE, not lossless.
 *
 * ⚠️ THE INVARIANT THIS MODULE EXISTS TO KEEP:
 *   a record is either ABSENT, or AT LEAST AS NEW as the editor.
 * Everything that reads a record — the rebase after a save, the wording of the
 * recovery offer, the prune — is wrong the moment that stops holding. The one
 * thing that can break it is the write suspension while an offer is pending,
 * which is why syncRecord() below is load-bearing rather than best-effort.
 *
 * Scoping is by UUID: project and chapter ids are server-minted and live under
 * each user's own directory, so a record can only ever be matched by the user
 * who owns that chapter.
 *
 * ⚠️ Accepted residual: IndexedDB is per-origin, so on a SHARED BROWSER PROFILE
 * another SillyTavern user's devtools could read a draft left behind. Same
 * single-trusted-operator assumption ARCHITECTURE.md §9 already makes for the
 * TOCTOU window. Mitigated by deleting records as soon as the server has the
 * text, and by pruning anything older than MAX_AGE_MS.
 */

const DB_NAME = 'sillynovel-recovery';
const DB_VERSION = 1;
const STORE = 'drafts';

/** Records older than this are dropped on open. Bounded, not precious. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const EXTENSION_NAME = 'sillynovel-writing';

/**
 * Set once the store has proved it cannot be maintained. From then on we raise
 * no offers from it: a store we cannot write to is one whose records we cannot
 * trust to be at least as new as the editor.
 */
let untrusted = false;

/** Cached open request, so we do not reopen per keystroke. @type {Promise<IDBDatabase|null>|null} */
let dbPromise = null;

/** Log the first failure only; after that the store is simply unavailable. */
let warned = false;

function warnOnce(error) {
    if (!warned) {
        warned = true;
        console.warn(`[${EXTENSION_NAME}] local recovery unavailable; the editor is unaffected`, error);
    }
}

/** @returns {Promise<IDBDatabase|null>} null when the store cannot be used */
function openDb() {
    if (dbPromise) {
        return dbPromise;
    }

    dbPromise = new Promise((resolve) => {
        let request;

        try {
            request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (error) {
            warnOnce(error);
            resolve(null);
            return;
        }

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'key' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { warnOnce(request.error); resolve(null); };
        request.onblocked = () => { warnOnce('open blocked'); resolve(null); };
    });

    return dbPromise;
}

const keyFor = (projectId, chapterId) => `${projectId}:${chapterId}`;

/**
 * Run one transaction and resolve when it commits.
 *
 * @param {'readonly'|'readwrite'} mode
 * @param {(store: IDBObjectStore) => any} work
 * @returns {Promise<any>} the work's result, or null on any failure
 */
async function withStore(mode, work) {
    const db = await openDb();

    if (!db) {
        return null;
    }

    return new Promise((resolve) => {
        let result = null;

        try {
            const transaction = db.transaction(STORE, mode);
            const store = transaction.objectStore(STORE);

            result = work(store);

            // Resolve on COMMIT, not on the request callback: for readwrite work
            // the caller needs to know the change is durable, not merely queued.
            transaction.oncomplete = () => resolve(result && typeof result.result !== 'undefined' ? result.result : result);
            transaction.onerror = () => { warnOnce(transaction.error); resolve(null); };
            transaction.onabort = () => { warnOnce(transaction.error); resolve(null); };
        } catch (error) {
            warnOnce(error);
            resolve(null);
        }
    });
}

/** @returns {boolean} whether offers may be raised from this store at all */
export function isTrusted() {
    return !untrusted;
}

/**
 * @returns {Promise<{key: string, projectId: string, chapterId: string, content: string, baseEtag: string, updatedAt: number}|null>}
 */
export function readRecord(projectId, chapterId) {
    if (untrusted) {
        return Promise.resolve(null);
    }

    return withStore('readonly', (store) => store.get(keyFor(projectId, chapterId)));
}

/** The ~500 ms draft write. Best-effort by design. */
export function writeRecord(projectId, chapterId, content, baseEtag) {
    if (untrusted) {
        return Promise.resolve(null);
    }

    return withStore('readwrite', (store) => store.put({
        key: keyFor(projectId, chapterId),
        projectId,
        chapterId,
        content,
        baseEtag,
        updatedAt: Date.now(),
    }));
}

export function deleteRecord(projectId, chapterId) {
    return withStore('readwrite', (store) => store.delete(keyFor(projectId, chapterId)));
}

/**
 * Bring the record back in step with the editor, then report whether the
 * invariant now holds.
 *
 * ⚠️ LOAD-BEARING, unlike everything else here. A silent no-op leaves a record
 * that is BEHIND the editor, which settleAfterSave() will then misread as a
 * newer continuation and rebase — producing a record that claims to be newer
 * than text it does not contain. Two crashes later the author is offered a
 * revert. So a failed write escalates: delete instead, and if that also fails,
 * stop trusting the store for the rest of the session.
 *
 * @returns {Promise<boolean>} whether the invariant is intact
 */
export async function syncRecord(projectId, chapterId, content, baseEtag) {
    const written = await withStore('readwrite', (store) => store.put({
        key: keyFor(projectId, chapterId),
        projectId,
        chapterId,
        content,
        baseEtag,
        updatedAt: Date.now(),
    }));

    if (written !== null) {
        return true;
    }

    // Absent satisfies the invariant just as well as up-to-date does.
    const deleted = await deleteRecord(projectId, chapterId);

    if (deleted !== null) {
        return true;
    }

    untrusted = true;
    warnOnce('recovery store could not be maintained; offers disabled for this session');

    return false;
}

/**
 * Resolve the record after a save landed, in ONE transaction.
 *
 * Read-then-write across two transactions can interleave with the ~500 ms draft
 * write and delete the newer draft this rule exists to protect.
 *
 * - stored content EQUALS what was saved -> delete; the server has it
 * - stored content DIFFERS -> it is a continuation typed during the PUT, so
 *   keep it, but rebase baseEtag onto the revision the save produced, or the
 *   next open reads the author's own save as somebody else's edit. updatedAt is
 *   refreshed too, or a long continuation ages toward the prune while live.
 */
export function settleAfterSave(projectId, chapterId, savedContent, newEtag) {
    return withStore('readwrite', (store) => {
        const key = keyFor(projectId, chapterId);
        const request = store.get(key);

        request.onsuccess = () => {
            const record = request.result;

            if (!record) {
                return;
            }

            if (record.content === savedContent) {
                store.delete(key);
                return;
            }

            store.put({ ...record, baseEtag: newEtag, updatedAt: Date.now() });
        };

        return null;
    });
}

/** Drop anything older than MAX_AGE_MS. Prose should not accumulate forever. */
export function pruneOldRecords() {
    const cutoff = Date.now() - MAX_AGE_MS;

    return withStore('readwrite', (store) => {
        const request = store.openCursor();

        request.onsuccess = () => {
            const cursor = request.result;

            if (!cursor) {
                return;
            }

            if (typeof cursor.value?.updatedAt === 'number' && cursor.value.updatedAt < cutoff) {
                cursor.delete();
            }

            cursor.continue();
        };

        return null;
    });
}
