/**
 * SillyNovel — server plugin
 *
 * Mounted by SillyTavern at /api/plugins/sillynovel (requires
 * `enableServerPlugins: true` in config.yaml).
 *
 * This file registers routes and nothing else. Path resolution, containment,
 * symlink rejection, atomic writes, and locking live in lib/ so the parts that
 * carry security invariants stay small and reviewable.
 *
 * ⚠️ SECURITY (see AGENTS.md — not negotiable):
 *  - Filesystem paths come only from the authenticated `request.user.directories`,
 *    via lib/paths.js. Never reconstructed from a session handle.
 *  - No route accepts a filesystem path. Server-minted UUIDs only.
 *  - Error bodies never contain a path.
 *
 * NOTE: plugin changes require a CONTAINER RESTART (Node loads plugins at boot):
 *   container stop sillynovel && container start sillynovel
 */

import { BlockerError, RequestError, resolveStorageRoot } from './lib/paths.js';
import {
    MAX_CHAPTER_BYTES,
    createChapter,
    createProject,
    getProject,
    listProjects,
    parseIfMatch,
    readChapter,
    readNotes,
    readProfile,
    writeChapter,
    writeNotes,
    writeProfile,
} from './lib/store.js';

export const info = {
    id: 'sillynovel',
    name: 'SillyNovel',
    description: 'Project and chapter storage for the SillyNovel Writing Workspace.',
};

/** Body cap for JSON payloads, above the chapter cap to allow for JSON overhead. */
const MAX_BODY_BYTES = MAX_CHAPTER_BYTES + 64 * 1024;

/**
 * Read a JSON body with our own byte cap.
 *
 * Works whether or not ST applied a body parser ahead of plugin routes, and
 * enforcing the cap here means it holds regardless of upstream middleware.
 * The cap is on BYTES, not characters — a character-count cap lets a payload of
 * multi-byte characters through at several times the intended size.
 */
async function readJsonBody(request) {
    if (request.body && typeof request.body === 'object') {
        if (Buffer.byteLength(JSON.stringify(request.body), 'utf8') > MAX_BODY_BYTES) {
            throw new RequestError(413, 'payload too large');
        }
        return request.body;
    }

    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new RequestError(413, 'payload too large'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });

        request.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new RequestError(400, 'invalid JSON'));
            }
        });

        request.on('error', reject);
    });
}

/**
 * Wrap a handler with storage-root resolution and error mapping.
 *
 * Responses carry a code, never a path or a stack. A BlockerError means ST's
 * middleware did not populate the authenticated directories — the documented
 * blocker condition, logged loudly because it invalidates the storage design
 * rather than being a per-request failure.
 */
function route(handler) {
    return async (request, response) => {
        try {
            const root = await resolveStorageRoot(request);
            await handler(request, response, root);
        } catch (error) {
            if (error instanceof BlockerError) {
                console.error(`[${info.id}] BLOCKER: ${error.message}`);
                response.status(500).json({ error: 'storage unavailable', blocker: true });
                return;
            }
            if (error instanceof RequestError) {
                response.status(error.status).json({ error: error.code });
                return;
            }
            console.error(`[${info.id}] unhandled error:`, error?.code ?? error?.message ?? error);
            response.status(500).json({ error: 'internal error' });
        }
    };
}

/**
 * @param {import('express').Router} router mounted at /api/plugins/sillynovel
 */
export async function init(router) {
    router.get('/health', (_request, response) => {
        response.json({ ok: true, plugin: info.id, version: '0.4.0' });
    });

    router.get('/projects', route(async (_request, response, root) => {
        response.json({ projects: await listProjects(root) });
    }));

    router.post('/projects', route(async (request, response, root) => {
        const body = await readJsonBody(request);
        response.status(201).json(await createProject(root, body?.title));
    }));

    router.get('/projects/:projectId', route(async (request, response, root) => {
        response.json(await getProject(root, request.params.projectId));
    }));

    router.post('/projects/:projectId/chapters', route(async (request, response, root) => {
        const body = await readJsonBody(request);
        const chapter = await createChapter(root, request.params.projectId, body?.title);
        response.status(201).set('ETag', `"${chapter.etag}"`).json(chapter);
    }));

    router.get('/projects/:projectId/chapters/:chapterId', route(async (request, response, root) => {
        const chapter = await readChapter(root, request.params.projectId, request.params.chapterId);
        response.set('ETag', `"${chapter.etag}"`).json(chapter);
    }));

    // Compare-and-swap. If-Match is required: without it, last-write-wins would
    // be reachable simply by omitting a header.
    router.put('/projects/:projectId/chapters/:chapterId', route(async (request, response, root) => {
        const expected = parseIfMatch(request.get('If-Match'));
        const body = await readJsonBody(request);
        const result = await writeChapter(
            root,
            request.params.projectId,
            request.params.chapterId,
            body?.content,
            expected,
        );
        response.set('ETag', `"${result.etag}"`).json(result);
    }));

    // Per-chapter notes (Phase 3). The chapter's compare-and-swap discipline;
    // an absent note reads as '' with the digest of '', and the chapter itself
    // must exist.
    router.get('/projects/:projectId/chapters/:chapterId/notes', route(async (request, response, root) => {
        const result = await readNotes(root, request.params.projectId, request.params.chapterId);
        response.set('ETag', `"${result.etag}"`).json(result);
    }));

    router.put('/projects/:projectId/chapters/:chapterId/notes', route(async (request, response, root) => {
        const expected = parseIfMatch(request.get('If-Match'));
        const body = await readJsonBody(request);
        const result = await writeNotes(
            root,
            request.params.projectId,
            request.params.chapterId,
            body?.content,
            expected,
        );
        response.set('ETag', `"${result.etag}"`).json(result);
    }));

    // The Writing Profile (Phase 3). Same compare-and-swap discipline as a
    // chapter: If-Match required on PUT, the digest is of the file's own bytes,
    // and an absent file reads as the canonical default rather than 404.
    router.get('/projects/:projectId/profile', route(async (request, response, root) => {
        const result = await readProfile(root, request.params.projectId);
        response.set('ETag', `"${result.etag}"`).json(result);
    }));

    router.put('/projects/:projectId/profile', route(async (request, response, root) => {
        const expected = parseIfMatch(request.get('If-Match'));
        const body = await readJsonBody(request);
        const result = await writeProfile(root, request.params.projectId, body?.profile, expected);
        response.set('ETag', `"${result.etag}"`).json(result);
    }));

    console.log(`[${info.id}] server plugin loaded — storage routes active`);
}

export async function exit() {
    console.log(`[${info.id}] server plugin unloaded`);
}

export default { info, init, exit };
