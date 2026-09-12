/**
 * SillyNovel — which project and chapter are open, how that is decided on first
 * run, and how the author moves between chapters (Phase 2, checkpoints 4-5).
 *
 * This module owns the resolution algorithm, chapter navigation, and the small
 * amount of state that survives them. It renders nothing; view.js does that.
 *
 * RULES (see AGENTS.md):
 *  - extension_settings holds UI preferences ONLY (ARCHITECTURE.md §9). Which
 *    project and chapter were last open is such a preference. Prose never is.
 */

import * as api from './api.js';

const SETTINGS_KEY = 'sillynovel';

/**
 * The open workspace, or null. Cleared on panel close so that every open
 * re-resolves against the server rather than trusting a stale snapshot.
 *
 * `project` is kept WHOLE, exactly as getProject returned it, because it already
 * carries the `chapters` array the nav rail renders. Copying that list into a
 * second field here would give it two owners, and they would drift the moment
 * addChapter() refreshed one of them.
 *
 * @type {{project: {id: string, title: string, chapters: Array<{id: string, title: string}>}, chapter: {id: string, title: string}, content: string, etag: string}|null}
 */
let current = null;

/**
 * The in-flight resolution, or null.
 *
 * ⚠️ Single-flight is a CORRECTNESS property here, not an optimisation. Two
 * resolutions racing between the project listing and the create step would both
 * observe an empty list and both create a project. panel.js's own guard covers a
 * double *open*; this covers everything else that can call in.
 * @type {Promise<object>|null}
 */
let resolveInFlight = null;

/**
 * The in-flight chapter creation, or null.
 *
 * ⚠️ Single-flight is a CORRECTNESS property, not an optimisation: a double
 * click would be two POSTs and two server-minted chapters, and there is no
 * DELETE route until Phase 5 to remove the extra one.
 * @type {Promise<object|null>|null}
 */
let addInFlight = null;

/**
 * The id of a chapter that EXISTS ON THE SERVER but is not yet reflected in
 * `current.project.chapters`, or null.
 *
 * Creation is two requests — create, then re-read the project — and a failure
 * between them must not be replayed as a fresh start, or the retry mints a
 * second chapter. Same principle as resolve() refusing to read a failed listing
 * as "no projects".
 *
 * ⚠️ Its lifetime is exactly that invariant. It is cleared whenever the project
 * listing becomes fresh again — after a successful refresh, after resolve(), and
 * in resetWorkspace(). Letting it outlive the workspace would be its own bug: a
 * failed refresh followed by a panel close would leave the id set, and the next
 * "New chapter" click would skip the create and reopen that old chapter instead.
 * @type {string|null}
 */
let pendingChapterId = null;

/**
 * Monotonic navigation token. Taken when the AUTHOR ACTS — at the click — not
 * when a request starts, so "last click wins" means the most recent intent
 * rather than whichever response happens to land last.
 */
let openToken = 0;

/**
 * The extension's settings bag.
 *
 * Lives here rather than in panel.js because this module owns the persisted
 * workspace state; panel.js imports it for its own panel-mode preference so the
 * bag is created in exactly one place.
 *
 * @returns {object} mutable settings object under extension_settings.sillynovel
 */
export function getSettings() {
    const all = SillyTavern.getContext().extensionSettings;

    if (!all[SETTINGS_KEY] || typeof all[SETTINGS_KEY] !== 'object') {
        all[SETTINGS_KEY] = {};
    }

    return all[SETTINGS_KEY];
}

/**
 * @param {{chapters?: Array<{id: string, title: string}>}} project
 * @param {object} settings
 * @returns {{id: string, title: string}|null} null when the project has none
 */
function pickChapter(project, settings) {
    const chapters = Array.isArray(project?.chapters) ? project.chapters : [];

    if (chapters.length === 0) {
        return null;
    }

    return chapters.find((chapter) => chapter.id === settings.lastChapterId) ?? chapters[0];
}

function remember(projectId, chapterId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    settings.lastProjectId = projectId;
    settings.lastChapterId = chapterId;

    context.saveSettingsDebounced();
}

/**
 * Resolve which project and chapter to open, creating them on a true first run.
 *
 * @returns {Promise<object>} the open workspace
 */
async function resolve() {
    // Confirm the plugin is actually mounted BEFORE anything below can create
    // data. A missing plugin then reports itself as such instead of surfacing
    // as a confusing failure partway through a create sequence.
    await api.health();

    const projects = await api.listProjects();
    const settings = getSettings();

    // ⚠️ Reaching this line means the listing SUCCEEDED. A failed read throws
    // above and never arrives here — which is the point. Treating an error as
    // "no projects" would mint a duplicate project on every network blip, and
    // with no DELETE route until Phase 5 there is no way to clean that up.
    let project;

    if (projects.length > 0) {
        const remembered = projects.find((entry) => entry.id === settings.lastProjectId);
        project = await api.getProject((remembered ?? projects[0]).id);
    } else {
        // createProject returns {id, title, chapters: []}, so a fresh project
        // falls straight into the chapterless branch below and gets its first
        // chapter from the same code path that repairs an existing one.
        project = await api.createProject();
    }

    let chapter = pickChapter(project, settings);

    if (!chapter) {
        // Two requests, deliberately not one transaction: a failure between
        // creating a project and creating its first chapter leaves a chapterless
        // project, and this branch is what recovers from that on the next open.
        // Same principle as store.js:createChapter writing prose before
        // metadata — choose the crash window whose residue is recoverable.
        const created = await api.createChapter(project.id);
        chapter = { id: created.id, title: created.title };

        // The listing we fetched predates this create, and the nav rail renders
        // from project.chapters — leaving it stale shows an empty chapter list
        // for the chapter that is actually open. Patch it locally rather than
        // spending another round trip in the first-run path: the server just
        // told us the id and title it minted.
        project.chapters = [...(Array.isArray(project.chapters) ? project.chapters : []), chapter];
    }

    const loaded = await api.getChapter(project.id, chapter.id);

    current = {
        project,
        chapter: { id: chapter.id, title: chapter.title },
        content: loaded.content,
        etag: loaded.etag,
    };

    // The listing is now the server's own, so nothing can still be missing from it.
    pendingChapterId = null;

    remember(project.id, chapter.id);

    return current;
}

/**
 * Resolve the workspace, reusing an in-flight call rather than starting a second.
 * @returns {Promise<object>}
 */
export function resolveWorkspace() {
    if (resolveInFlight) {
        return resolveInFlight;
    }

    resolveInFlight = resolve().finally(() => {
        resolveInFlight = null;
    });

    return resolveInFlight;
}

/**
 * Open a chapter of the currently open project.
 *
 * Concurrency is LAST-CLICK-WINS, not single-flight: a nav rail implies that the
 * most recent click is the one the author meant, and a plain single-flight guard
 * would silently drop a click on a *different* chapter. The token is compared
 * after the await, so a superseded response is discarded rather than written
 * into `current` — and a superseded REJECTION is swallowed too, so a slow
 * failure cannot raise an error about a chapter the author already left.
 *
 * @param {string} chapterId
 * @param {number} [token] reserved by the caller at click time; defaults to a
 *   fresh one, which is what a direct nav click wants
 * @returns {Promise<object|null>} the workspace, or null if superseded
 */
export async function openChapter(chapterId, token = ++openToken) {
    if (!current) {
        return null;
    }

    const projectId = current.project.id;
    let loaded;

    try {
        loaded = await api.getChapter(projectId, chapterId);
    } catch (error) {
        if (token !== openToken) {
            return null;
        }
        throw error;
    }

    // Superseded by a later click, or the workspace went away underneath us.
    if (token !== openToken || !current || current.project.id !== projectId) {
        return null;
    }

    // getChapter returns {id, content, etag} and no title, so the title comes
    // from the project's own listing.
    const entry = (current.project.chapters ?? []).find((chapter) => chapter.id === chapterId);

    current.chapter = { id: chapterId, title: entry?.title ?? 'Untitled chapter' };
    current.content = loaded.content;
    current.etag = loaded.etag;

    remember(projectId, chapterId);

    return current;
}

/**
 * Create the next chapter, refresh the listing, and open it.
 *
 * @param {number} token reserved at click time
 * @returns {Promise<object|null>}
 */
async function add(token) {
    if (!current) {
        return null;
    }

    const projectId = current.project.id;
    let chapterId = pendingChapterId;

    if (!chapterId) {
        const nextNumber = (current.project.chapters?.length ?? 0) + 1;
        const created = await api.createChapter(projectId, `Chapter ${nextNumber}`);

        // If the workspace went away mid-create, do NOT record the id: it would
        // outlive the state it describes. The chapter exists and the next
        // resolve() will list it, which is all the id was for.
        if (!current || current.project.id !== projectId) {
            return null;
        }

        chapterId = created.id;
        pendingChapterId = chapterId;
    }

    const project = await api.getProject(projectId);

    if (!current || current.project.id !== projectId) {
        return null;
    }

    current.project = project;

    // ⚠️ pendingChapterId is NOT cleared here, even though the listing is now
    // fresh. The action is not finished until the chapter is open, and if this
    // final read fails the retry must resume at the open rather than create a
    // second chapter. Clearing on a successful refresh alone reintroduces
    // exactly the duplicate this id exists to prevent.
    const opened = await openChapter(chapterId, token);

    // Reached only when the open succeeded or was superseded; both mean the
    // chapter is on the server and in the listing, so the gap is closed.
    pendingChapterId = null;

    return opened;
}

/**
 * Add a chapter to the open project.
 *
 * Single-flight, because a duplicate here cannot be undone before Phase 5 adds
 * deletion. The token is reserved HERE, at the click, so that if the author
 * navigates elsewhere while this is in flight the nav click is the later intent
 * and wins: the chapter is still created and listed, it just does not yank the
 * author off the chapter they chose.
 *
 * @returns {Promise<object|null>}
 */
export function addChapter() {
    if (addInFlight) {
        return addInFlight;
    }

    const token = ++openToken;

    addInFlight = add(token).finally(() => {
        addInFlight = null;
    });

    return addInFlight;
}

/** @returns {object|null} the open workspace, without touching the network */
export function getWorkspace() {
    return current;
}

/**
 * Forget what is open. Called when the panel closes.
 *
 * pendingChapterId goes with it: it describes a gap in `current.project`, and
 * without `current` there is no gap to describe. Any chapter it referred to
 * still exists on the server and will simply be listed by the next resolve().
 *
 * ⚠️ Closing is an author action, so it takes a token like any other and wins
 * over anything already in flight. Without this, an add() still running at
 * close time would finish against the REOPENED workspace and yank the author
 * onto a chapter they never asked for. The old action's project refresh stays
 * harmless — it is the server's own listing — but its final open cannot land.
 */
export function resetWorkspace() {
    current = null;
    pendingChapterId = null;
    openToken += 1;
}
