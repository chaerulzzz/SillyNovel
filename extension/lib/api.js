/**
 * SillyNovel — client for the server plugin's storage routes.
 *
 * Thin wrappers over the routes in plugin/index.js, mounted by SillyTavern at
 * /api/plugins/sillynovel. No domain logic, no retry policy, no state — the
 * first-run resolution and the notion of "what is open" live in session.js.
 *
 * RULES (see AGENTS.md):
 *  - Writes require CSRF, sent via ST's own getRequestHeaders(). Never
 *    hand-assemble the header.
 *  - No route accepts a filesystem path; ids are server-minted UUIDs.
 */

const PLUGIN_BASE = '/api/plugins/sillynovel';

/** The server's revision marker: a bare SHA-256 hex digest. See requireEtag(). */
const ETAG_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Failure kinds, kept distinct because the user's next action differs for each.
 * The panel picks its message from this, never from a raw status code.
 */
export const ApiErrorKind = {
    /** ST middleware did not populate request.user.directories, or an ancestor
     *  path failed its symlink check. AGENTS.md rule 7: stop and resolve. */
    BLOCKER: 'blocker',
    /** The plugin is not mounted — enableServerPlugins off, or no restart. */
    PLUGIN_ABSENT: 'plugin-absent',
    /** Session expired. */
    UNAUTHENTICATED: 'unauthenticated',
    /** The plugin answered with an error code. */
    REQUEST: 'request',
    /**
     * 412: the chapter changed somewhere else since we read it. Distinct from
     * REQUEST because PLAN.md requires a conflict WARNING rather than a generic
     * failure — the author's unsaved words are at stake, not a retryable call.
     */
    CONFLICT: 'conflict',
    /** Could not reach the server at all. */
    NETWORK: 'network',
    /** The response did not satisfy something we require in order to proceed
     *  safely — e.g. a chapter with no usable revision marker. */
    CONTRACT: 'contract',
};

export class ApiError extends Error {
    constructor(kind, message, { status = null, code = null, cause = null } = {}) {
        super(message);
        this.name = 'ApiError';
        this.kind = kind;
        this.status = status;
        this.code = code;
        this.cause = cause;
    }
}

/**
 * CSRF + content-type headers from SillyTavern.
 *
 * getRequestHeaders is also covered by the permanent compatibility canary in
 * index.js, which fails loudly at load. This check turns the same absence into
 * a typed error at call time rather than a raw TypeError.
 */
function requestHeaders() {
    const context = SillyTavern.getContext();

    if (typeof context?.getRequestHeaders !== 'function') {
        throw new ApiError(
            ApiErrorKind.CONTRACT,
            'SillyTavern did not provide getRequestHeaders(); this SillyTavern version may be incompatible.',
        );
    }

    return context.getRequestHeaders();
}

/**
 * Read a response body, distinguishing "not JSON at all" from "empty".
 *
 * A non-JSON body on a plugin path is the signature of the plugin not being
 * mounted: SillyTavern answers the unknown route itself, with HTML.
 */
async function readBody(response) {
    const text = await response.text();

    if (text.trim() === '') {
        return { json: null, wasJson: true };
    }

    try {
        return { json: JSON.parse(text), wasJson: true };
    } catch {
        return { json: null, wasJson: false };
    }
}

/**
 * @param {'GET'|'POST'|'PUT'} method
 * @param {string} path relative to PLUGIN_BASE
 * @param {object} [body]
 * @param {object} [extraHeaders] merged over the CSRF/content-type defaults
 * @returns {Promise<any>} the parsed JSON body
 */
async function request(method, path, body, extraHeaders) {
    // Outside the try: a missing helper is a contract failure, not a network one.
    const headers = { ...requestHeaders(), ...extraHeaders };

    let response;

    try {
        response = await fetch(`${PLUGIN_BASE}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch (error) {
        throw new ApiError(ApiErrorKind.NETWORK, 'Could not reach SillyTavern.', { cause: error });
    }

    const { json, wasJson } = await readBody(response);

    if (!wasJson) {
        throw new ApiError(
            ApiErrorKind.PLUGIN_ABSENT,
            'The SillyNovel server plugin did not answer. Check that enableServerPlugins is true in config.yaml, then restart the container — plugins load at boot.',
            { status: response.status },
        );
    }

    // Checked before the generic status handling: a blocker invalidates the
    // storage design rather than failing one request, and must never be
    // presented as an ordinary error.
    if (json && json.blocker === true) {
        throw new ApiError(
            ApiErrorKind.BLOCKER,
            'SillyNovel could not reach your storage directory. This is a setup problem, not a temporary one — see the server log for the BLOCKER line.',
            { status: response.status, code: json.error ?? null },
        );
    }

    // Ahead of the generic status handling: a stale revision is a distinct
    // outcome the caller has to render differently, not an error to retry.
    if (response.status === 412) {
        throw new ApiError(
            ApiErrorKind.CONFLICT,
            'This chapter was changed somewhere else since you opened it.',
            { status: 412, code: json?.error ?? null },
        );
    }

    if (response.status === 401 || response.status === 403) {
        throw new ApiError(
            ApiErrorKind.UNAUTHENTICATED,
            'Your SillyTavern session has expired. Reload the page and sign in again.',
            { status: response.status },
        );
    }

    if (!response.ok) {
        const code = json?.error ?? 'unknown error';
        throw new ApiError(ApiErrorKind.REQUEST, `SillyNovel storage returned an error: ${code}.`, {
            status: response.status,
            code,
        });
    }

    return json;
}

/**
 * Extract and validate a chapter's revision marker.
 *
 * ⚠️ The two wire forms are NOT interchangeable. The ETag *header* is the quoted
 * validator (`"<64-hex>"`); the JSON body carries the *bare* digest. We keep the
 * bare digest — it is canonical, both forms come from the same hash, and it
 * survives JSON parsing without header access. Quoting is a wire-format concern
 * and belongs in exactly one place: the PUT wrapper that arrives in checkpoint 6,
 * because parseIfMatch (plugin/lib/store.js) rejects an unquoted value with 400.
 *
 * A missing or malformed marker FAILS the read. Opening a chapter without one
 * would carry silently into checkpoint 6, where the save either gets rejected
 * 428 or — worse — looks fine while compare-and-swap protection is gone.
 */
function requireEtag(payload, what) {
    const etag = payload?.etag;

    if (typeof etag !== 'string' || !ETAG_PATTERN.test(etag)) {
        throw new ApiError(
            ApiErrorKind.CONTRACT,
            `SillyNovel storage returned ${what} without a usable revision marker, so it was not opened.`,
        );
    }

    return etag;
}

/** @returns {Promise<{ok: boolean, plugin: string, version: string}>} */
export function health() {
    return request('GET', '/health');
}

/** @returns {Promise<Array<{id: string, title: string, chapterCount: number}>>} */
export async function listProjects() {
    const payload = await request('GET', '/projects');
    return Array.isArray(payload?.projects) ? payload.projects : [];
}

/** @returns {Promise<{id: string, title: string, chapters: Array}>} */
export function createProject(title) {
    return request('POST', '/projects', { title });
}

/** @returns {Promise<{id: string, title: string, schemaVersion: number, chapters: Array}>} */
export function getProject(projectId) {
    return request('GET', `/projects/${projectId}`);
}

/** @returns {Promise<{id: string, title: string, content: string, etag: string}>} */
export async function createChapter(projectId, title) {
    const payload = await request('POST', `/projects/${projectId}/chapters`, { title });
    return { ...payload, etag: requireEtag(payload, 'a new chapter') };
}

/** @returns {Promise<{id: string, content: string, etag: string}>} */
export async function getChapter(projectId, chapterId) {
    const payload = await request('GET', `/projects/${projectId}/chapters/${chapterId}`);
    return { ...payload, etag: requireEtag(payload, 'a chapter') };
}

/**
 * Replace a chapter's prose, as a compare-and-swap.
 *
 * ⚠️ THIS IS THE ONLY PLACE THE REVISION GETS QUOTED. State holds the bare
 * digest (see requireEtag); parseIfMatch accepts only `"<64-hex>"` and answers
 * 400 for an unquoted value, 428 for a missing one. Keeping the quoting here
 * means exactly one function has to be right about it.
 *
 * The response carries {id, etag} and NO content — the new digest must replace
 * the stored one, or the next save compares against a revision the server has
 * already moved past and 412s against our own write.
 *
 * @param {string} projectId
 * @param {string} chapterId
 * @param {string} content
 * @param {string} etag bare 64-hex digest
 * @returns {Promise<{id: string, etag: string}>}
 */
export async function putChapter(projectId, chapterId, content, etag) {
    const payload = await request(
        'PUT',
        `/projects/${projectId}/chapters/${chapterId}`,
        { content },
        { 'If-Match': `"${etag}"` },
    );

    return { ...payload, etag: requireEtag(payload, 'the saved chapter') };
}
