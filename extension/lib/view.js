/**
 * SillyNovel — the workspace body: five regions and the actions that drive them
 * (Phase 2, checkpoint 5).
 *
 * Split out of panel.js so that module stays about shell lifecycle — mount,
 * maximize, close, focus — rather than growing a nav rail and an editor.
 *
 * This checkpoint is structural. The editor is read-only until checkpoint 6
 * brings the save machine, the suggestion pane is empty until 8, and the
 * Inspector shows labels but no content until 9.
 */

import { addChapter, getWorkspace, openChapter, resolveWorkspace } from './session.js';

const EXTENSION_NAME = 'sillynovel-writing';

/**
 * The prompt blocks from ARCHITECTURE.md §3.
 *
 * The LABELS are fixed — separating established state from writing instruction
 * is the whole point of §3 — but the ORDER is explicitly a tunable, so this
 * scaffold must not be read as pinning it.
 */
const PROMPT_BLOCKS = [
    'WRITING PROFILE',
    'ESTABLISHED STORY STATE',
    'LORE',
    'EARLIER CHAPTERS',
    'MANUSCRIPT',
    'CURRENT WRITING INSTRUCTION',
    'OUTPUT CONTRACT',
];

/**
 * Every save state, not just the one reachable today, so checkpoint 6 fills a
 * defined region instead of inventing one. Only `read-only` occurs here.
 */
const SAVE_STATUS = {
    'read-only': 'Read-only — editing and saving arrive in checkpoint 6',
    idle: 'No unsaved changes',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    saved: 'Saved',
    conflict: 'This chapter changed somewhere else',
    error: 'Could not save',
};

/**
 * Swap the body between loading, ready and error.
 *
 * Visibility is set here rather than trusted to the template's `hidden`
 * attributes: that markup passes through DOMPurify on the way in.
 *
 * ⚠️ This is a FULL-SCREEN REPLACE and belongs only to the initial open. Using
 * it for a chapter switch would blank the chapter the author is reading before
 * the request has even failed. In-workspace actions use runAction() instead.
 *
 * @param {HTMLElement} panel
 * @param {'loading'|'ready'|'error'} state
 */
function setWorkspaceState(panel, state) {
    const regions = {
        loading: panel.querySelector('.sillynovel-workspace-loading'),
        ready: panel.querySelector('.sillynovel-workspace-ready'),
        error: panel.querySelector('.sillynovel-workspace-error'),
    };

    for (const [name, element] of Object.entries(regions)) {
        if (element) {
            element.hidden = name !== state;
        }
    }
}

/**
 * @param {HTMLElement} panel
 * @param {string} state a SAVE_STATUS key, or a transient action state
 * @param {string} [text] overrides the canned message
 */
function setSaveStatus(panel, state, text) {
    const element = panel.querySelector('.sillynovel-save-status');

    if (!element) {
        return;
    }

    element.dataset.state = state;
    // replaceChildren, not textContent: it also clears any retry button an
    // earlier failure left behind.
    element.replaceChildren(document.createTextNode(text ?? SAVE_STATUS[state] ?? ''));
}

/**
 * Report a failed action inline, leaving the open chapter on screen.
 *
 * @param {HTMLElement} panel
 * @param {string} message
 * @param {() => void} [retry] re-runs the failed action, not a full re-resolve
 */
function setActionError(panel, message, retry) {
    const element = panel.querySelector('.sillynovel-save-status');

    if (!element) {
        return;
    }

    element.dataset.state = 'error';
    element.replaceChildren(document.createTextNode(message));

    if (retry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sillynovel-inline-retry';
        button.textContent = 'Retry';
        button.addEventListener('click', retry);
        element.append(' ', button);
    }
}

/**
 * Run an in-workspace action without tearing the ready region down.
 *
 * @param {HTMLElement} panel
 * @param {{entry: HTMLElement, message: string, run: () => Promise<object|null>, retry: () => void}} options
 */
async function runAction(panel, { entry, message, run, retry }) {
    if (entry) {
        entry.classList.add('sillynovel-busy');
        entry.disabled = true;
    }

    setSaveStatus(panel, 'busy', message);

    try {
        const workspace = await run();

        if (!panel.isConnected) {
            return;
        }

        // null means a later click superseded this one, so this result must not
        // decide which chapter is open. Repaint from the CURRENT state instead
        // of skipping: a superseded action can still have changed something the
        // view shows — addChapter refreshes the chapter list even when its own
        // final open loses — and skipping would leave the new chapter missing
        // from the nav until the next full resolve.
        const paint = workspace ?? getWorkspace();

        if (paint) {
            renderWorkspaceContent(panel, paint);
        }
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] workspace action failed`, error);

        if (panel.isConnected) {
            setActionError(panel, error?.message ?? 'That did not work.', retry);
        }
    } finally {
        // Per element, and only if it is still mounted: a stale response for one
        // chapter must not clear the busy indicator on another, and a re-render
        // may have replaced this element entirely.
        if (entry && entry.isConnected) {
            entry.classList.remove('sillynovel-busy');
            entry.disabled = false;
        }
    }
}

function selectChapter(panel, chapterId) {
    const entry = panel.querySelector(`.sillynovel-chapter-entry[data-chapter-id="${chapterId}"]`);

    return runAction(panel, {
        entry,
        message: 'Opening chapter…',
        run: () => openChapter(chapterId),
        retry: () => selectChapter(panel, chapterId),
    });
}

function createChapter(panel) {
    return runAction(panel, {
        entry: panel.querySelector('.sillynovel-new-chapter'),
        message: 'Creating chapter…',
        run: () => addChapter(),
        retry: () => createChapter(panel),
    });
}

/**
 * @param {HTMLElement} panel
 * @param {object} workspace
 */
function renderNav(panel, workspace) {
    const list = panel.querySelector('.sillynovel-chapter-list');

    if (!list) {
        return;
    }

    const chapters = Array.isArray(workspace.project.chapters) ? workspace.project.chapters : [];

    list.replaceChildren(...chapters.map((chapter) => {
        const item = document.createElement('li');
        const button = document.createElement('button');

        button.type = 'button';
        button.className = 'sillynovel-chapter-entry';
        button.dataset.chapterId = chapter.id;
        button.textContent = chapter.title;

        if (chapter.id === workspace.chapter.id) {
            button.setAttribute('aria-current', 'true');
        }

        button.addEventListener('click', () => selectChapter(panel, chapter.id));
        item.append(button);

        return item;
    }));
}

/**
 * Paint the open workspace into the ready region.
 *
 * @param {HTMLElement} panel
 * @param {object} workspace
 */
function renderWorkspaceContent(panel, workspace) {
    const setText = (selector, text) => {
        const element = panel.querySelector(selector);
        if (element) {
            element.textContent = text;
        }
    };

    setText('.sillynovel-project-title', workspace.project.title);
    setText('.sillynovel-chapter-title', workspace.chapter.title);

    const editor = panel.querySelector('.sillynovel-editor');
    if (editor) {
        editor.value = workspace.content;
    }

    renderNav(panel, workspace);
    setSaveStatus(panel, 'read-only');
}

/** Fill the Inspector with §3's labels and wire its disclosure. */
function renderInspector(panel) {
    const list = panel.querySelector('.sillynovel-inspector-blocks');
    const toggle = panel.querySelector('.sillynovel-inspector-toggle');
    const body = panel.querySelector('.sillynovel-inspector-body');

    if (list) {
        list.replaceChildren(...PROMPT_BLOCKS.map((name) => {
            const item = document.createElement('li');
            item.textContent = `[${name}]`;
            return item;
        }));
    }

    if (toggle && body) {
        // Set explicitly rather than relying on the template's `hidden`
        // surviving DOMPurify, so "collapsed by default" is our guarantee.
        body.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');

        toggle.onclick = () => {
            const expanded = toggle.getAttribute('aria-expanded') === 'true';
            toggle.setAttribute('aria-expanded', String(!expanded));
            body.hidden = expanded;
        };
    }
}

/**
 * Resolve the workspace and show it.
 *
 * Never throws: a failure must leave the panel usable, showing why and offering
 * a retry, rather than propagating into whatever mounted it.
 *
 * @param {HTMLElement} panel
 * @returns {Promise<void>}
 */
export async function renderWorkspace(panel) {
    setWorkspaceState(panel, 'loading');

    try {
        const workspace = await resolveWorkspace();

        // The panel may have been closed while resolution was in flight.
        if (!panel.isConnected) {
            return;
        }

        renderInspector(panel);

        const newChapter = panel.querySelector('.sillynovel-new-chapter');
        if (newChapter) {
            newChapter.onclick = () => createChapter(panel);
        }

        renderWorkspaceContent(panel, workspace);
        setWorkspaceState(panel, 'ready');
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] could not open the workspace`, error);

        if (!panel.isConnected) {
            return;
        }

        const message = panel.querySelector('.sillynovel-error-message');
        if (message) {
            // Plugin error bodies never contain a path (plugin/index.js), so
            // these messages are safe to show as-is.
            message.textContent = error?.message ?? 'SillyNovel could not open the workspace.';
        }

        const retry = panel.querySelector('.sillynovel-retry');
        if (retry) {
            retry.onclick = () => renderWorkspace(panel);
        }

        setWorkspaceState(panel, 'error');
    }
}
