/**
 * SillyNovel — which project and chapter are open, and how that is decided on
 * first run (Phase 2, checkpoint 4).
 *
 * This module owns the resolution algorithm and the small amount of state that
 * survives it. It does not render anything; panel.js does that.
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
 * @type {{project: {id: string, title: string}, chapter: {id: string, title: string}, content: string, etag: string}|null}
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
    }

    const loaded = await api.getChapter(project.id, chapter.id);

    current = {
        project: { id: project.id, title: project.title },
        chapter: { id: chapter.id, title: chapter.title },
        content: loaded.content,
        etag: loaded.etag,
    };

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

/** @returns {object|null} the open workspace, without touching the network */
export function getWorkspace() {
    return current;
}

/** Forget what is open. Called when the panel closes. */
export function resetWorkspace() {
    current = null;
}
