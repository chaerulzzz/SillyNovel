/**
 * SillyNovel — project and chapter storage.
 *
 * Layout (docs/ARCHITECTURE.md §9):
 *
 *   <canonical user root>/sillynovel/projects/<uuid>/
 *   ├── project.json          schemaVersion, id, title, revision, chapters[]
 *   └── chapters/<uuid>.md    pure prose, nothing else
 *
 * ONE FILE PER CHAPTER. The revision IS a SHA-256 digest of the chapter's
 * bytes, computed on read — so prose and revision cannot disagree, because
 * there is no second file to disagree with.
 */

import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

import { atomicWrite } from './atomic.js';
import { withLock } from './locks.js';
import {
    BlockerError,
    RequestError,
    assertRealDirectory,
    assertRealFile,
    checkRealDirectory,
    containedPath,
    ensureRealDirectory,
    isUuid,
} from './paths.js';

export const SCHEMA_VERSION = 1;

/** Generous for a single chapter (~170k words) and still bounded. */
export const MAX_CHAPTER_BYTES = 1024 * 1024;

const DEFAULT_PROJECT_TITLE = 'Untitled project';
const DEFAULT_CHAPTER_TITLE = 'Untitled chapter';
const MAX_TITLE_LENGTH = 200;

/** SHA-256 hex of a UTF-8 string. This is the revision. */
export function hashContent(contents) {
    return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/**
 * Parse an `If-Match` header, strictly.
 *
 * Rejects `*`, weak validators (`W/"..."`), multiple comma-separated values,
 * and anything that is not a single quoted 64-character hex digest. A lenient
 * parser here would turn a typo into a silent overwrite.
 *
 * @returns {string} the bare hex digest
 */
export function parseIfMatch(header) {
    if (typeof header !== 'string') {
        throw new RequestError(428, 'if-match required');
    }

    const value = header.trim();

    if (value.length === 0) {
        throw new RequestError(428, 'if-match required');
    }
    if (value === '*' || value.includes(',') || value.startsWith('W/')) {
        throw new RequestError(400, 'invalid if-match');
    }

    const match = /^"([0-9a-f]{64})"$/.exec(value);

    if (!match) {
        throw new RequestError(400, 'invalid if-match');
    }

    return match[1];
}

function sanitizeTitle(value, fallback) {
    if (typeof value !== 'string') {
        return fallback;
    }
    const trimmed = value.trim().slice(0, MAX_TITLE_LENGTH);
    return trimmed.length > 0 ? trimmed : fallback;
}

const projectsDir = (root) => containedPath(root, ['projects']);
const projectDir = (root, projectId) => containedPath(root, ['projects', projectId]);
const chaptersDir = (root, projectId) => containedPath(root, ['projects', projectId, 'chapters']);
const chapterFile = (root, projectId, chapterId) =>
    containedPath(root, ['projects', projectId, 'chapters', `${chapterId}.md`]);

function requireUuid(value) {
    if (!isUuid(value)) {
        throw new RequestError(400, 'invalid identifier');
    }
    return value;
}

async function readJson(target) {
    await assertRealFile(target);
    const raw = await fs.readFile(target, 'utf8');
    try {
        return JSON.parse(raw);
    } catch {
        throw new RequestError(500, 'corrupt metadata');
    }
}

/**
 * Chapter ids that actually have a prose file on disk.
 * The filesystem is authoritative for chapter *existence*.
 *
 * ⚠️ Verifies `chapters/` itself before enumerating it. `readdir` alone
 * follows a symlinked directory transparently — this backs reconciliation, so
 * a tampered `chapters/` is treated as "no chapters found" rather than as a
 * license to enumerate whatever the symlink points at. This is a read: it
 * must never throw, and it must never trust an unverified directory.
 */
async function chapterIdsOnDisk(root, projectId) {
    const directory = chaptersDir(root, projectId);
    const stats = await fs.lstat(directory).catch(() => null);

    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
        return [];
    }

    const entries = await fs.readdir(directory).catch(() => []);

    return entries
        .filter((name) => name.endsWith('.md'))
        .map((name) => name.slice(0, -'.md'.length))
        .filter(isUuid);
}

/**
 * Reconcile stored metadata against the filesystem.
 *
 * 🔒 IN MEMORY ONLY. This is called from GET handlers, and a GET must never
 * rewrite project.json — reads are not CSRF-protected, and a read with a write
 * side effect is both a surprise and a fresh race. Repairs are persisted only
 * during chapter creation, under the project lock.
 *
 * - entry with no file  -> omitted (prose is gone; the entry is noise)
 * - file with no entry  -> adopted, appended (prose is never invisible)
 */
function reconcileChapters(storedChapters, idsOnDisk) {
    const stored = Array.isArray(storedChapters) ? storedChapters : [];
    const onDisk = new Set(idsOnDisk);
    const seen = new Set();
    const chapters = [];

    for (const entry of stored) {
        const id = entry?.id;
        if (!isUuid(id) || !onDisk.has(id) || seen.has(id)) {
            continue;
        }
        seen.add(id);
        chapters.push({ id, title: sanitizeTitle(entry?.title, DEFAULT_CHAPTER_TITLE) });
    }

    for (const id of idsOnDisk) {
        if (!seen.has(id)) {
            chapters.push({ id, title: DEFAULT_CHAPTER_TITLE, adopted: true });
        }
    }

    return chapters;
}

/**
 * Load a project's metadata, reconciled. Returns null when unreadable.
 *
 * Verifies `projects/` itself before trusting the specific project directory
 * beneath it — `assertRealDirectory` on the project dir alone lstats only the
 * final component, so it would not by itself catch `projects/` having been
 * replaced with a symlink further up the chain.
 */
async function loadProject(root, projectId) {
    const projectsExist = await checkRealDirectory(projectsDir(root));
    if (!projectsExist) {
        return null;
    }

    const directory = projectDir(root, projectId);

    try {
        await assertRealDirectory(directory);
    } catch {
        return null;
    }

    const metadata = await readJson(containedPath(root, ['projects', projectId, 'project.json']))
        .catch(() => null);

    // A project directory without readable metadata is treated as an incomplete
    // create and is not listed. No prose exists at that point, so nothing is at
    // risk.
    if (!metadata) {
        return null;
    }

    const idsOnDisk = await chapterIdsOnDisk(root, projectId);

    return {
        raw: metadata,
        project: {
            id: projectId,
            title: sanitizeTitle(metadata.title, DEFAULT_PROJECT_TITLE),
            schemaVersion: metadata.schemaVersion ?? SCHEMA_VERSION,
            chapters: reconcileChapters(metadata.chapters, idsOnDisk),
        },
    };
}

/**
 * Verify the full ancestor chain for a chapter, in order: `projects/` -> the
 * project's own directory -> its `chapters/` directory.
 *
 * The storage root (`sillynovel/`) is already verified once per request by
 * `resolveStorageRoot()` before any handler runs — this covers everything
 * below that. `lstat` on `chaptersDir` alone only protects its own final path
 * component; path resolution follows a symlinked ANCESTOR transparently on
 * the way there, so checking `chaptersDir` in isolation does not catch
 * `projects/` or this project's own directory having been swapped. Call this
 * immediately before every chapter read, write, and creation — not once and
 * reused, since an ancestor can be swapped at any point during a request
 * sequence, and each operation needs its own guarantee that it is touching
 * what it thinks it is touching.
 *
 * Severity matches what the rest of this module already does: `projects/` is
 * foundational (shared by every project this user has), so a tampered
 * `projects/` is a BlockerError via `checkRealDirectory`, not a per-resource
 * 404 — but simply absent collapses to 404 here, same as any other missing
 * resource. The project directory and `chapters/` are per-resource: missing
 * and tampered deliberately collapse to the same 404 via `assertRealDirectory`,
 * so a client cannot use the distinction to probe what exists.
 */
async function assertChapterAncestryReal(root, projectId) {
    const projectsExist = await checkRealDirectory(projectsDir(root));
    if (!projectsExist) {
        throw new RequestError(404, 'not found');
    }
    await assertRealDirectory(projectDir(root, projectId));
    await assertRealDirectory(chaptersDir(root, projectId));
}

export async function listProjects(root) {
    const directory = projectsDir(root);
    const exists = await checkRealDirectory(directory);

    if (!exists) {
        return [];
    }

    const entries = (await fs.readdir(directory).catch(() => [])).filter(isUuid);
    const projects = [];

    for (const id of entries) {
        const loaded = await loadProject(root, id);
        if (loaded) {
            projects.push({
                id: loaded.project.id,
                title: loaded.project.title,
                chapterCount: loaded.project.chapters.length,
            });
        }
    }

    return projects;
}

export async function getProject(root, projectId) {
    requireUuid(projectId);
    const loaded = await loadProject(root, projectId);

    if (!loaded) {
        throw new RequestError(404, 'not found');
    }

    return loaded.project;
}

export async function createProject(root, title) {
    const id = randomUUID();

    // Level by level, never recursive: each mkdir/lstat below trusts only a
    // parent it (or an earlier call in this same chain) has already verified.
    const projectsExist = await checkRealDirectory(projectsDir(root));
    if (!projectsExist) {
        await fs.mkdir(projectsDir(root));
    }
    await ensureRealDirectory(projectDir(root, id));
    await ensureRealDirectory(chaptersDir(root, id));

    const metadata = {
        schemaVersion: SCHEMA_VERSION,
        id,
        title: sanitizeTitle(title, DEFAULT_PROJECT_TITLE),
        revision: 1,
        chapters: [],
        createdAt: new Date().toISOString(),
    };

    await atomicWrite(containedPath(root, ['projects', id, 'project.json']),
        JSON.stringify(metadata, null, 2));

    return { id, title: metadata.title, chapters: [] };
}

/**
 * Create a chapter.
 *
 * ⚠️ WRITE ORDER IS A SAFETY PROPERTY, NOT AN IMPLEMENTATION DETAIL.
 * The prose file is created FIRST, then project.json is updated. A crash in the
 * window then leaves an orphan prose file — which the reconciler adopts — rather
 * than a metadata entry whose prose was never written. Never reorder these.
 */
export async function createChapter(root, projectId, title) {
    requireUuid(projectId);

    return withLock(`project:${projectId}`, async () => {
        const loaded = await loadProject(root, projectId);

        if (!loaded) {
            throw new RequestError(404, 'not found');
        }

        // Re-verifies projects/ and this project's own directory a second time
        // — loadProject just checked both, under this same lock — but routing
        // every chapter-leaf operation through one shared check is worth a
        // couple of extra lstat calls: it means no call site can drift to
        // trusting a narrower subset of the chain than the others do.
        await assertChapterAncestryReal(root, projectId);

        const chapterId = randomUUID();

        // 1. Prose first.
        await atomicWrite(chapterFile(root, projectId, chapterId), '');

        // 2. Then metadata — including any reconciliation repairs, which this
        //    CSRF-protected mutation is the sanctioned place to persist.
        const chapters = [
            ...loaded.project.chapters.map(({ id, title: t }) => ({ id, title: t })),
            { id: chapterId, title: sanitizeTitle(title, DEFAULT_CHAPTER_TITLE) },
        ];

        const metadata = {
            ...loaded.raw,
            schemaVersion: SCHEMA_VERSION,
            id: projectId,
            chapters,
            revision: (Number(loaded.raw.revision) || 0) + 1,
            updatedAt: new Date().toISOString(),
        };

        await atomicWrite(containedPath(root, ['projects', projectId, 'project.json']),
            JSON.stringify(metadata, null, 2));

        return { id: chapterId, title: chapters.at(-1).title, content: '', etag: hashContent('') };
    });
}

export async function readChapter(root, projectId, chapterId) {
    requireUuid(projectId);
    requireUuid(chapterId);

    await assertChapterAncestryReal(root, projectId);

    const target = chapterFile(root, projectId, chapterId);
    await assertRealFile(target);

    const content = await fs.readFile(target, 'utf8');

    return { id: chapterId, content, etag: hashContent(content) };
}

/**
 * Replace a chapter's prose, as a compare-and-swap.
 *
 * The whole read -> compare -> write sequence runs under the chapter's lock.
 * Without it, two writers holding the same ETag both pass the comparison, both
 * write, and both are told they succeeded — silently losing one of them.
 */
export async function writeChapter(root, projectId, chapterId, content, expectedEtag) {
    requireUuid(projectId);
    requireUuid(chapterId);

    if (typeof content !== 'string') {
        throw new RequestError(400, 'content must be a string');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_CHAPTER_BYTES) {
        throw new RequestError(413, 'chapter too large');
    }

    return withLock(`chapter:${projectId}:${chapterId}`, async () => {
        await assertChapterAncestryReal(root, projectId);

        const target = chapterFile(root, projectId, chapterId);
        await assertRealFile(target);

        const current = await fs.readFile(target, 'utf8');
        const currentEtag = hashContent(current);

        if (currentEtag !== expectedEtag) {
            throw new RequestError(412, 'revision mismatch');
        }

        await atomicWrite(target, content);

        // Identical bytes yield an identical digest. That is correct — nothing
        // changed — so callers must not expect a revision to always advance.
        return { id: chapterId, etag: hashContent(content) };
    });
}
