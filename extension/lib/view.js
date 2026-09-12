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

import { ApiErrorKind } from './api.js';
import {
    addChapter,
    clearOversizeHalt,
    getHalt,
    getWorkspace,
    openChapter,
    resolveWorkspace,
    saveChapter,
} from './session.js';

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
/**
 * Idle debounce before a server save. ARCHITECTURE.md:461 gives ~2-5 s as a
 * benchmark target rather than a frozen requirement — measure at realistic
 * chapter sizes before treating this number as settled.
 */
const SAVE_DEBOUNCE_MS = 2000;

/**
 * Said when a 412 halts saving. It has to tell the author their words are not
 * stored anywhere yet, because until checkpoint 7's local recovery copy exists,
 * closing or reloading loses them.
 */
const CONFLICT_MESSAGE =
    'This chapter changed somewhere else, so your text will not be saved. Copy it out of the editor before closing or reloading — it is not stored anywhere yet.';

const SAVE_STATUS = {
    'read-only': 'Read-only',
    idle: 'No unsaved changes',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    saved: 'Saved',
    conflict: CONFLICT_MESSAGE,
    error: 'Could not save',
};

/** Pending idle-save timer, or null. */
let saveTimer = null;

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

/** @param {HTMLElement} panel */
function editorOf(panel) {
    return panel.querySelector('.sillynovel-editor');
}

/**
 * Does the editor hold bytes the server does not?
 * @param {HTMLElement} panel
 */
function isDirty(panel) {
    const workspace = getWorkspace();
    const editor = editorOf(panel);

    return Boolean(workspace && editor) && editor.value !== workspace.content;
}

function cancelScheduledSave() {
    if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
}

/** @param {HTMLElement} panel */
function scheduleSave(panel) {
    cancelScheduledSave();
    saveTimer = setTimeout(() => { void autoSave(panel); }, SAVE_DEBOUNCE_MS);
}

/**
 * What to do once a save has settled, either way.
 *
 * ⚠️ This has to be STATE-aware, not merely content-aware. After a 412 the
 * editor still differs from the stored content, so a purely dirty-based check
 * would fire again immediately: PUT -> 412 -> settle -> PUT, forever, which is
 * the opposite of "autosave halts". And re-saving inline rather than re-arming
 * the debounce turns a transient 5xx into a tight retry loop with no pacing.
 *
 * @param {HTMLElement} panel
 */
function settleSave(panel) {
    if (!panel.isConnected) {
        cancelScheduledSave();
        return;
    }

    if (getHalt() !== null) {
        return;
    }

    if (isDirty(panel)) {
        scheduleSave(panel);
    }
}

/**
 * Put the halted status back on screen.
 *
 * runAction() writes a progress message ("Opening chapter…") into the same
 * region before it calls anything, so a navigation attempt on a halted chapter
 * would otherwise bury the very warning that explains why it was refused.
 *
 * @param {HTMLElement} panel
 * @returns {boolean} whether a halt was in force
 */
function renderHaltStatus(panel) {
    const halt = getHalt();

    if (halt === 'conflict') {
        setSaveStatus(panel, 'conflict');
        return true;
    }

    if (halt === 'oversize') {
        setSaveStatus(panel, 'error', 'This chapter is too large to save. Shorten it and saving will resume.');
        return true;
    }

    return false;
}

/**
 * @param {HTMLElement} panel
 * @param {unknown} error
 */
function renderSaveFailure(panel, error) {
    if (error?.kind === ApiErrorKind.CONFLICT) {
        setSaveStatus(panel, 'conflict');
        return;
    }

    setSaveStatus(panel, 'error', error?.message ?? SAVE_STATUS.error);
}

/**
 * One save attempt. Never throws — the status region is the report.
 *
 * Three outcomes, not two: "still dirty" has to be distinguishable from
 * "failed", because saveChapter coalesces onto an in-flight PUT that may have
 * carried older text. Collapsing them would make a navigation flush abort on a
 * perfectly healthy coalesced save.
 *
 * @param {HTMLElement} panel
 * @returns {Promise<'clean'|'dirty'|'failed'>}
 */
async function autoSave(panel) {
    cancelScheduledSave();

    if (renderHaltStatus(panel)) {
        return 'failed';
    }

    if (!isDirty(panel)) {
        // Nothing to send. Settle the status rather than leaving whatever the
        // trigger left behind — "Unsaved changes" with nothing unsaved is a lie.
        setSaveStatus(panel, 'idle');
        return 'clean';
    }

    setSaveStatus(panel, 'saving');

    try {
        await saveChapter(editorOf(panel).value);

        if (!panel.isConnected) {
            return 'failed';
        }

        if (isDirty(panel)) {
            return 'dirty';
        }

        setSaveStatus(panel, 'saved');
        return 'clean';
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] save failed`, error);

        if (panel.isConnected) {
            renderSaveFailure(panel, error);
        }

        return 'failed';
    } finally {
        settleSave(panel);
    }
}

/**
 * Flush before leaving the chapter — ARCHITECTURE.md:461 counts internal
 * navigation as a save trigger, and both openChapter and addChapter overwrite
 * the open chapter's content.
 *
 * Bounded rather than single-shot: saveChapter coalesces onto an in-flight PUT,
 * which may have carried older text, so one pass is not always enough.
 *
 * @param {HTMLElement} panel
 * @returns {Promise<boolean>} false means do NOT navigate
 */
async function flushBeforeNavigation(panel) {
    // Already halted: nothing will save, so say so again rather than leaving
    // whatever progress message the caller just wrote.
    if (getHalt() !== null) {
        renderHaltStatus(panel);
        return false;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const outcome = await autoSave(panel);

        if (outcome === 'clean') {
            return true;
        }

        // A real failure aborts immediately rather than being retried here —
        // pacing belongs to settleSave()'s debounce, not to a navigation click.
        if (outcome === 'failed' || !panel.isConnected) {
            return false;
        }
    }

    return !isDirty(panel);
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
        // A flush abort is not a new failure: flushBeforeNavigation has already
        // left the real reason on screen, and overwriting it with a navigation
        // message would bury the conflict warning.
        if (!(error instanceof FlushAborted)) {
            console.error(`[${EXTENSION_NAME}] workspace action failed`, error);

            if (panel.isConnected) {
                setActionError(panel, error?.message ?? 'That did not work.', retry);
            }
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

/**
 * Raised when a navigation flush could not save. It aborts the action without
 * being reported again — flushBeforeNavigation has already put the real reason
 * (conflict, or the save error) in the status region.
 */
class FlushAborted extends Error {}

/**
 * Save before leaving, then run the navigation.
 *
 * ⚠️ The flush is SHARED state — one chapter's unsaved text — so a click on A
 * followed by a click on B awaits the same save. If it fails, A's handler must
 * swallow it rather than cancel B: aborting on a stale click would cancel the
 * author's later, correct intent. runAction already treats a null result as
 * "superseded", so the stale path simply returns null.
 *
 * @param {HTMLElement} panel
 * @param {() => Promise<object|null>} navigate
 */
function flushThenNavigate(panel, navigate) {
    return async () => {
        if (!(await flushBeforeNavigation(panel))) {
            throw new FlushAborted('navigation aborted: unsaved changes could not be saved');
        }

        return navigate();
    };
}

function selectChapter(panel, chapterId) {
    const entry = panel.querySelector(`.sillynovel-chapter-entry[data-chapter-id="${chapterId}"]`);

    return runAction(panel, {
        entry,
        message: 'Opening chapter…',
        run: flushThenNavigate(panel, () => openChapter(chapterId)),
        retry: () => selectChapter(panel, chapterId),
    });
}

/**
 * "New chapter" navigates too: addChapter() ends by opening the chapter it
 * created, which overwrites the open chapter's content. It needs the same flush
 * as selectChapter, or clicking it while dirty drops the unsaved text.
 */
function createChapter(panel) {
    return runAction(panel, {
        entry: panel.querySelector('.sillynovel-new-chapter'),
        message: 'Creating chapter…',
        run: flushThenNavigate(panel, () => addChapter()),
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

    cancelScheduledSave();
    setSaveStatus(panel, getHalt() === null ? 'idle' : 'conflict');
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
 * Attach the editor's save triggers. Called once per mount.
 *
 * ARCHITECTURE.md:461: idle debounce, blur, visibilitychange, and internal
 * navigation. Ctrl/Cmd-S is ours — writers press it whatever the app does.
 *
 * @param {HTMLElement} panel
 */
function wireEditor(panel) {
    const editor = editorOf(panel);

    if (!editor) {
        return;
    }

    editor.addEventListener('input', () => {
        // Shortening the text is the only thing that can fix a 413, so editing
        // is exactly when saving should resume.
        clearOversizeHalt();

        // A conflict is sticky against every trigger. Showing "dirty" here would
        // tell the author their words are about to be saved when they are not.
        if (getHalt() !== null) {
            return;
        }

        // Dirtiness is a comparison, not a consequence of typing: editing back to
        // the saved text must not keep claiming there is something to save.
        if (!isDirty(panel)) {
            cancelScheduledSave();
            setSaveStatus(panel, 'idle');
            return;
        }

        setSaveStatus(panel, 'dirty');
        scheduleSave(panel);
    });

    editor.addEventListener('blur', () => {
        void autoSave(panel);
    });

    panel.addEventListener('keydown', (event) => {
        const shortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';

        if (shortcut) {
            event.preventDefault();
            void autoSave(panel);
        }
    });
}

/**
 * Save when the tab is hidden.
 *
 * Registered ONCE at module scope and resolved against the live panel, rather
 * than per mount: a listener added to `document` on every open would accumulate
 * across open/close cycles, since closePanel only removes the panel node.
 */
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') {
        return;
    }

    const panel = document.getElementById('sillynovel-panel');

    if (panel) {
        void autoSave(panel);
    }
});

/**
 * Best-effort save as the panel closes.
 *
 * Teardown is synchronous, so this cannot be awaited — the PUT is issued and
 * the panel goes away. The result is discarded by session.js's generation guard,
 * which is fine: what matters is that the bytes reach the server.
 * ARCHITECTURE.md:465-467 already declines to promise zero loss here, and
 * checkpoint 7's local recovery copy is the durable answer.
 */
export function flushOnClose() {
    const panel = document.getElementById('sillynovel-panel');

    cancelScheduledSave();

    if (!panel || getHalt() !== null || !isDirty(panel)) {
        return;
    }

    void saveChapter(editorOf(panel).value).catch(() => {
        // Nothing left to tell: the panel is going away.
    });
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
        wireEditor(panel);

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
