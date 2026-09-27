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
    acceptOffer,
    addChapter,
    clearNotesOversizeHalt,
    clearOversizeHalt,
    declineOffer,
    getHalt,
    getNotes,
    getNotesHalt,
    getPendingOffer,
    getProfile,
    getProfileHalt,
    getWorkspaceGeneration,
    isCurrentTarget,
    recordDraft,
    getWorkspace,
    openChapter,
    reloadProfile,
    resolveWorkspace,
    saveChapter,
    saveNotes,
    saveProfile,
} from './session.js';
import {
    ACTIONS,
    GenerateErrorKind,
    PROMPT_BLOCKS,
    buildPrompt,
    buildContinuePrompt,
    renderProfileText,
    cancelGeneration,
    expandForDisplay,
    getActiveGeneration,
    needsPreflight,
    runAction as runGenerationAction,
} from './generate.js';
import { validate } from './validate.js';

const EXTENSION_NAME = 'sillynovel-writing';

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

/**
 * Local recovery write delay. Much tighter than the server debounce because the
 * write never leaves the machine — ARCHITECTURE.md:460 gives ~500 ms.
 */
const DRAFT_DEBOUNCE_MS = 500;

/** Pending local-draft timer, or null. */
let draftTimer = null;

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
function cancelScheduledDraft() {
    if (draftTimer !== null) {
        clearTimeout(draftTimer);
        draftTimer = null;
    }
}

/**
 * Queue the local recovery write.
 *
 * ⚠️ Deliberately NOT gated on the save machine's halt state. A 412 or a 413
 * stops saving, and those are exactly the moments the author's words exist
 * nowhere else — removing the safety net precisely when it matters. session.js
 * suspends this itself while an offer is pending, which is the one case where
 * writing would destroy the alternative being offered.
 *
 * @param {HTMLElement} panel
 */
function scheduleDraft(panel) {
    cancelScheduledDraft();

    draftTimer = setTimeout(() => {
        draftTimer = null;

        if (panel.isConnected) {
            recordDraft(editorOf(panel)?.value ?? '');
        }
    }, DRAFT_DEBOUNCE_MS);
}

/**
 * Show or hide the recovery offer.
 *
 * The editor is left holding the DRAFT: a writing tool recovering from a crash
 * should put the author's own last words back on screen, so that ignoring the
 * banner keeps their writing rather than losing it.
 *
 * @param {HTMLElement} panel
 */
function renderRecoveryOffer(panel) {
    const banner = panel.querySelector('.sillynovel-recovery');
    const offer = getPendingOffer();

    if (!banner) {
        return;
    }

    if (!offer) {
        banner.hidden = true;
        return;
    }

    const editor = editorOf(panel);

    if (editor) {
        setEditorText(editor, getWorkspace()?.chapter.id ?? null, offer.draft);
    }

    const message = panel.querySelector('.sillynovel-recovery-message');

    if (message) {
        message.textContent = offer.kind === 'conflict'
            ? 'Unsaved writing was recovered from this browser — and this chapter was also changed somewhere else since. Both versions contain text the other does not, so nothing has been saved either way.'
            : 'Unsaved writing was recovered from this browser. It is shown below and has not been saved yet.';
    }

    banner.hidden = false;
    renderHaltStatus(panel);
}

/**
 * Take the recovered draft.
 *
 * The record is synced to what the editor actually holds BEFORE the writers
 * resume — the author may have typed while the banner was up, and the record
 * would otherwise be older than the editor, which settleAfterSave() reads as
 * newer. A failed sync escalates inside session.js/recovery.js.
 *
 * @param {HTMLElement} panel
 */
async function keepRecoveredDraft(panel) {
    await acceptOffer(editorOf(panel)?.value ?? '');

    if (!panel.isConnected) {
        return;
    }

    renderRecoveryOffer(panel);
    setSaveStatus(panel, isDirty(panel) ? 'dirty' : 'idle');

    if (isDirty(panel)) {
        scheduleSave(panel);
    }
}

/**
 * Keep the saved version. The server is untouched either way; this only
 * replaces what the editor is showing.
 *
 * @param {HTMLElement} panel
 */
async function discardRecoveredDraft(panel) {
    const workspace = getWorkspace();

    await declineOffer();

    if (!panel.isConnected) {
        return;
    }

    const editor = editorOf(panel);

    if (editor && workspace) {
        setEditorText(editor, workspace.chapter.id, workspace.content);
    }

    renderRecoveryOffer(panel);
    setSaveStatus(panel, 'idle');
}

/** @param {HTMLElement} panel */
function editorOf(panel) {
    return panel.querySelector('.sillynovel-editor');
}

/* --- the per-document saver (Phase 3 checkpoint 3) ----------------------

   Checkpoint 6 built this machine for the chapter on module-global state: one
   timer, one status element, one dirty comparison. Notes need the same machine
   for a second document, and a copy-pasted second machine is exactly where the
   halt/settle semantics would drift. So the machine is a factory, and the
   chapter is its first instance — configured to behave byte-for-byte as before,
   with the old function names kept as destructured aliases so no call site
   changed. What stays OUTSIDE the saver is chapter-only by nature: the local
   draft timer and recovery offer, the stale marks, and setActionError. */

/**
 * @param {object} config
 * @param {string} config.name for log lines
 * @param {number} config.debounceMs idle delay before a save
 * @param {(panel: HTMLElement) => string|null} config.read the textarea's text, null if absent
 * @param {() => string|null} config.saved the server-held text, null if nothing is open
 * @param {() => string|null} config.halt why saving has stopped, or null
 * @param {(text: string) => Promise<object|null>} config.save the session.js save
 * @param {(panel: HTMLElement, state: string, text?: string) => void} config.status
 * @param {Record<string, [string, string|undefined]>} config.haltStatus what to paint per halt reason
 */
function createSaver({ name, debounceMs, read, saved, halt, save, status, haltStatus }) {
    /** Pending idle-save timer, or null. Private to this document. */
    let timer = null;

    /** Does the textarea hold bytes the server does not? */
    function isDirty(panel) {
        const server = saved();
        const text = read(panel);

        return server !== null && text !== null && text !== server;
    }

    function cancel() {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function schedule(panel) {
        cancel();
        timer = setTimeout(() => { void autoSave(panel); }, debounceMs);
    }

    /**
     * What to do once a save has settled, either way.
     *
     * ⚠️ This has to be STATE-aware, not merely content-aware. After a 412 the
     * textarea still differs from the stored content, so a purely dirty-based
     * check would fire again immediately: PUT -> 412 -> settle -> PUT, forever,
     * which is the opposite of "autosave halts". And re-saving inline rather
     * than re-arming the debounce turns a transient 5xx into a tight retry loop
     * with no pacing.
     */
    function settle(panel) {
        if (!panel.isConnected) {
            cancel();
            return;
        }

        if (halt() !== null) {
            return;
        }

        if (isDirty(panel)) {
            schedule(panel);
        }
    }

    /**
     * Put the halted status back on screen.
     *
     * runAction() writes a progress message ("Opening chapter…") into the
     * chapter's region before it calls anything, so a navigation attempt on a
     * halted document would otherwise bury the very warning that explains why
     * it was refused.
     *
     * @returns {boolean} whether a halt was in force
     */
    function renderHalt(panel) {
        const reason = halt();

        if (reason === null || !(reason in haltStatus)) {
            return false;
        }

        const [state, text] = haltStatus[reason];
        status(panel, state, text);
        return true;
    }

    function renderFailure(panel, error) {
        if (error?.kind === ApiErrorKind.CONFLICT) {
            status(panel, 'conflict');
            return;
        }

        status(panel, 'error', error?.message);
    }

    /**
     * One save attempt. Never throws — the status region is the report.
     *
     * Three outcomes, not two: "still dirty" has to be distinguishable from
     * "failed", because the session save coalesces onto an in-flight PUT that
     * may have carried older text. Collapsing them would make a navigation
     * flush abort on a perfectly healthy coalesced save.
     *
     * @returns {Promise<'clean'|'dirty'|'failed'>}
     */
    async function autoSave(panel) {
        cancel();

        if (renderHalt(panel)) {
            return 'failed';
        }

        if (!isDirty(panel)) {
            // Nothing to send. Settle the status rather than leaving whatever
            // the trigger left behind — "Unsaved changes" with nothing unsaved
            // is a lie.
            status(panel, 'idle');
            return 'clean';
        }

        status(panel, 'saving');

        try {
            await save(read(panel));

            if (!panel.isConnected) {
                return 'failed';
            }

            if (isDirty(panel)) {
                return 'dirty';
            }

            status(panel, 'saved');
            return 'clean';
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] ${name} save failed`, error);

            if (panel.isConnected) {
                renderFailure(panel, error);
            }

            return 'failed';
        } finally {
            settle(panel);
        }
    }

    /**
     * Flush before leaving the chapter. Bounded rather than single-shot: the
     * session save coalesces onto an in-flight PUT, which may have carried
     * older text, so one pass is not always enough.
     *
     * @returns {Promise<boolean>} false means do NOT navigate
     */
    async function flush(panel) {
        // A pending recovery OFFER is the deliberate exception to "a halt
        // aborts navigation": the draft is durable in IndexedDB and the offer
        // reappears when the author comes back, so there is nothing to lose by
        // leaving. Chapter-only by construction — no other document has a
        // recovery store, so no other halt() can ever return 'offer'. A
        // conflict halt is different: that text exists nowhere else.
        if (halt() === 'offer') {
            return true;
        }

        // Already halted: nothing will save, so say so again rather than
        // leaving whatever progress message the caller just wrote.
        if (halt() !== null) {
            renderHalt(panel);
            return false;
        }

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const outcome = await autoSave(panel);

            if (outcome === 'clean') {
                return true;
            }

            // A real failure aborts immediately rather than being retried here
            // — pacing belongs to settle()'s debounce, not to a navigation click.
            if (outcome === 'failed' || !panel.isConnected) {
                return false;
            }
        }

        return !isDirty(panel);
    }

    /** The consequences of the text changing, once the document-specific hooks have run. */
    function handleChange(panel) {
        // A conflict is sticky against every trigger. Showing "dirty" here
        // would tell the author their words are about to be saved when they
        // are not.
        if (halt() !== null) {
            return;
        }

        // Dirtiness is a comparison, not a consequence of typing: editing back
        // to the saved text must not keep claiming there is something to save.
        if (!isDirty(panel)) {
            cancel();
            status(panel, 'idle');
            return;
        }

        status(panel, 'dirty');
        schedule(panel);
    }

    /** Best-effort save as the panel closes. Fire-and-forget by necessity. */
    function flushOnClose(panel) {
        cancel();

        if (halt() !== null || !isDirty(panel)) {
            return;
        }

        void save(read(panel)).catch(() => {
            // Nothing left to tell: the panel is going away.
        });
    }

    return { isDirty, cancel, schedule, settle, renderHalt, renderFailure, autoSave, flush, handleChange, flushOnClose };
}

/** The chapter: the first instance, configured to behave exactly as checkpoint 6 built it. */
const chapterSaver = createSaver({
    name: 'chapter',
    debounceMs: SAVE_DEBOUNCE_MS,
    read: (panel) => editorOf(panel)?.value ?? null,
    saved: () => getWorkspace()?.content ?? null,
    halt: getHalt,
    save: saveChapter,
    status: setSaveStatus,
    haltStatus: {
        offer: ['offer', 'Choose which version to keep before saving.'],
        conflict: ['conflict', undefined],
        oversize: ['error', 'This chapter is too large to save. Shorten it and saving will resume.'],
    },
});

// The checkpoint-6 names, so no call site in this file changed.
const {
    isDirty,
    cancel: cancelScheduledSave,
    schedule: scheduleSave,
    renderHalt: renderHaltStatus,
    autoSave,
} = chapterSaver;

const NOTES_CONFLICT_MESSAGE =
    'These notes changed somewhere else, so your notes will not be saved. Copy them out of this box before '
    + 'switching chapters, closing or reloading — they are not stored anywhere else.';

/** The idle line is empty on purpose: it sits under a collapsed toggle and must stay quiet. */
const NOTES_STATUS = {
    idle: '',
    dirty: 'Unsaved notes',
    saving: 'Saving notes…',
    saved: 'Notes saved',
    conflict: NOTES_CONFLICT_MESSAGE,
    error: 'Could not save notes',
};

/** @param {HTMLElement} panel */
function notesEditorOf(panel) {
    return panel.querySelector('.sillynovel-notes-editor');
}

/**
 * @param {HTMLElement} panel
 * @param {string} state
 * @param {string} [text]
 */
function setNotesStatus(panel, state, text) {
    const element = panel.querySelector('.sillynovel-notes-status');

    if (element) {
        element.dataset.state = state;
        element.textContent = text ?? NOTES_STATUS[state] ?? '';
    }
}

/**
 * Per-chapter notes: the second instance. No draft timer, no recovery offer,
 * no stale marks — notes are not in the prompt at this checkpoint, and the
 * recovery store is keyed by chapter alone, so a notes write there would
 * overwrite the chapter's record.
 */
const notesSaver = createSaver({
    name: 'notes',
    debounceMs: SAVE_DEBOUNCE_MS,
    read: (panel) => notesEditorOf(panel)?.value ?? null,
    saved: () => getNotes()?.content ?? null,
    halt: getNotesHalt,
    save: saveNotes,
    status: setNotesStatus,
    haltStatus: {
        conflict: ['conflict', undefined],
        oversize: ['error', 'These notes are too large to save. Shorten them and saving will resume.'],
    },
});

/** Every document with a saver, chapter first. */
const SAVERS = [chapterSaver, notesSaver];

/**
 * Everything that must happen when the notes text changes, from ANY cause.
 * A function, not an inline listener, so checkpoint 5's "Add to notes" can
 * call it after a programmatic write — exactly as insertSuggestion calls
 * handleEditorChange. Idempotent for the same reason.
 *
 * @param {HTMLElement} panel
 */
function handleNotesChange(panel) {
    // Shortening is the only thing that can fix a 413, so editing is exactly
    // when saving should resume.
    clearNotesOversizeHalt();
    notesSaver.handleChange(panel);
}

/**
 * Flush every document before leaving the chapter — ARCHITECTURE.md:461 counts
 * internal navigation as a save trigger, and both openChapter and addChapter
 * overwrite the open chapter's content. Every saver gets its attempt; any
 * refusal aborts.
 *
 * @param {HTMLElement} panel
 * @returns {Promise<boolean>} false means do NOT navigate
 */
async function flushBeforeNavigation(panel) {
    let ok = true;

    for (const saver of SAVERS) {
        if (!(await saver.flush(panel))) {
            ok = false;
        }
    }

    // A later saver's refusal must not leave "Opening chapter…" standing over
    // the chapter's own halt or recovery banner.
    if (!ok) {
        renderHaltStatus(panel);
    }

    return ok;
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
        setEditorText(editor, workspace.chapter.id, workspace.content);
    }

    // Notes are chapter-scoped, so unlike the profile they ARE repainted here.
    const notes = notesEditorOf(panel);
    if (notes) {
        notes.value = workspace.notes?.content ?? '';
    }

    renderNav(panel, workspace);

    cancelScheduledSave();
    cancelScheduledDraft();
    notesSaver.cancel();

    // A suggestion belongs to the chapter it came from, and a trim notice to the
    // request that caused it. The action bar is repainted from the LIVE
    // generation rather than reset, because one may still be running — started
    // in another chapter, or before a close and reopen.
    clearSuggestion(panel);
    clearInspection(panel);
    renderTrimNote(panel, null);
    // Cleared before the repaint, not after: renderActionBar only WRITES the
    // note while something is running, so a message left over from the previous
    // chapter would otherwise survive the switch.
    setActionNote(panel, 'idle', '');
    renderActionBar(panel);

    // renderRecoveryOffer overwrites the editor with the draft when one stands,
    // so it runs after the server content has been painted, not before.
    renderRecoveryOffer(panel);

    if (getHalt() === null) {
        setSaveStatus(panel, 'idle');
    } else {
        renderHaltStatus(panel);
    }

    if (!notesSaver.renderHalt(panel)) {
        setNotesStatus(panel, 'idle');
    }
}

/**
 * Everything that must happen when the editor's text changes, from ANY cause.
 *
 * ⚠️ Extracted from the `input` listener because assigning to `textarea.value`
 * from code does not fire `input`. Inserting a suggestion that way would arm
 * neither the 2 s autosave nor the ~500 ms recovery write, and would leave the
 * status claiming "No unsaved changes" over a paragraph the server has never
 * seen — the exact state checkpoint 7 exists to prevent, wearing a label that
 * says it is safe.
 *
 * ⚠️ IDEMPOTENT BY CONSTRUCTION, and relied upon as such: it cancels and
 * re-arms the two timers and recomputes dirtiness as a COMPARISON, so running
 * it twice is indistinguishable from running it once. That is what lets Insert
 * call it explicitly even on the path where the browser also fires `input`.
 *
 * @param {HTMLElement} panel
 */
function handleEditorChange(panel) {
    // The local copy is kept regardless of halt state — a halted chapter is
    // exactly the one whose words exist nowhere else.
    scheduleDraft(panel);

    // Shortening the text is the only thing that can fix a 413, so editing
    // is exactly when saving should resume.
    clearOversizeHalt();

    // Once the source moves, say so rather than presenting the old result as current.
    renderSuggestionStale(panel);

    // Same reasoning, and the same string comparison: a displayed prompt that
    // no longer matches the editor is no longer the prompt the action would send.
    renderInspectorStale(panel);

    chapterSaver.handleChange(panel);
}

/* --- writing actions and the suggestion pane ----------------------------- */

/**
 * The suggestion currently on offer, or null. VIEW state: it is what the pane
 * is painting, not what the model is doing.
 *
 * @type {{text: string, action: string, resultKind: string, chapterId: string,
 *   generation: number, source: string,
 *   selection: SelectionAnchor|null,
 *   warnings: string[]}|null}
 */
let suggestion = null;

const SUGGESTION_HISTORY_LIMIT = 10;
const suggestionHistory = new Map();

/** @param {string} chapterId @param {boolean} [create] */
function suggestionHistoryFor(chapterId, create = false) {
    let state = suggestionHistory.get(chapterId);

    if (!state && create) {
        state = { items: [], index: null };
        suggestionHistory.set(chapterId, state);
    }

    return state ?? null;
}

/* --- selection anchors ---------------------------------------------------- */

/**
 * @typedef {{start: number, end: number, text: string, chapterId: string, broken: boolean}} SelectionAnchor
 */

/**
 * Every selection a Rewrite or Expand was asked about, from the click until its
 * result leaves history. The same object is the target's `selection` and the
 * suggestion's, so breaking it here is seen everywhere at once.
 *
 * ⚠️ Comparing text at the stored offsets is NOT enough. With the passage
 * `S … S`, deleting the first S and the middle leaves the same editor text as
 * deleting the middle and the second S — only where the edit happened tells
 * the two apart. So every edit is located as it happens, and any edit that
 * starts before an anchor's end breaks it for good.
 *
 * Anchors from a failed or cancelled run stay until the panel closes: the
 * error's Retry reuses them, so they must keep tracking edits.
 *
 * @type {Set<SelectionAnchor>}
 */
const selectionAnchors = new Set();

/** Where the edit about to land starts, recorded before it lands; null once applied. */
let pendingEditStart = null;

/** The chapter whose text the editor holds, and each chapter's text when last shown. */
let editorChapterId = null;
const lastSeenText = new Map();

/**
 * Where an edit starts, read in `beforeinput` while the selection still
 * describes the range about to change. Anything that cannot be located says 0,
 * which breaks every anchor: a false refusal is recoverable, a wrong
 * replacement is not.
 *
 * @param {InputEvent} event
 * @param {HTMLTextAreaElement} editor
 */
function editStartFor(event, editor) {
    const { selectionStart: start, selectionEnd: end } = editor;
    const type = event.inputType ?? '';

    // Undo, redo and drag-and-drop change a range the selection does not describe.
    if (type.startsWith('history') || type === 'insertFromDrop' || type === 'deleteByDrag') {
        return 0;
    }

    if (start !== end || !type.startsWith('delete')) {
        return start;
    }

    // A collapsed backward delete removes text BEFORE the caret. One step back
    // is at most one grapheme; two code units covers a surrogate pair.
    if (type === 'deleteContentBackward') {
        return Math.max(0, start - 2);
    }

    // A word or line backwards can reach anywhere; forward deletes start at the caret.
    return type.endsWith('Backward') ? 0 : start;
}

/** @param {string|null} chapterId @param {number} editStart */
function breakAnchors(chapterId, editStart) {
    for (const anchor of selectionAnchors) {
        if (anchor.chapterId === chapterId && editStart < anchor.end) {
            anchor.broken = true;
        }
    }
}

/** Apply the recorded edit, if the input handler has not already done so. */
function applyPendingEdit() {
    if (pendingEditStart !== null) {
        breakAnchors(editorChapterId, pendingEditStart);
        pendingEditStart = null;
    }
}

/**
 * Replace the editor's whole text — a chapter open, a recovery draft, a
 * declined draft. Text that differs from what this chapter last showed moved
 * underneath every anchor in it.
 *
 * @param {HTMLTextAreaElement} editor
 * @param {string} chapterId
 * @param {string} text
 */
function setEditorText(editor, chapterId, text) {
    if (editorChapterId !== null) {
        lastSeenText.set(editorChapterId, editor.value);
    }

    const previous = lastSeenText.get(chapterId);

    if (previous !== undefined && previous !== text) {
        breakAnchors(chapterId, 0);
    }

    editor.value = text;
    editorChapterId = chapterId;
    pendingEditStart = null;
}

/** @param {SelectionAnchor} anchor @param {HTMLTextAreaElement} editor */
function anchorHolds(anchor, editor) {
    return !anchor.broken && editor.value.slice(anchor.start, anchor.end) === anchor.text;
}

/** The preflight awaiting a decision, or null. */
let pendingPreflight = null;

/**
 * What the Context Inspector is showing, or null.
 *
 * VIEW state, and a SNAPSHOT.
 *
 * ⚠️ Never the object buildPrompt() returned and never an array
 * runAction() sends. createRawPrompt mutates the array it is handed, in place
 * (script.js:3886), so the array displayed must never be the array sent.
 *
 * ⚠️ `source` is the manuscript string the prompt was BUILT FROM, threaded
 * in rather than re-read when the capture is stored. Re-reading would report
 * "fresh" for a prompt assembled from older text whenever the author types
 * during the tokenizer round trip — the region quietly claiming to show
 * something it is not.
 *
 * @type {{origin: 'built'|'sent', action: string, source: string, chapterId: string,
 *   generation: number, messages: Array<object>, excluded: Array<object>,
 *   figures: object|null, refusal: {message: string, kind: string}|null}|null}
 */
let inspection = null;

/**
 * True while a prompt is being measured for the Inspector.
 *
 * Mirrors `building`, but it never gates writing actions: inspecting costs no model
 * request, so it must not disable the primary action.
 */
let inspecting = false;

/**
 * True from the moment an action is accepted until prompt measurement ends.
 *
 * ⚠️ Wider than generate.js's single-flight on purpose. That guard starts at
 * the model call, but getTokenCountAsync round-trips to the server, so there is
 * a visible window where the prompt is being measured and nothing is "running"
 * yet. Without this the button stays live through it: the extra clicks cost no
 * model requests — the single-flight still collapses them — but they each start
 * another round of token counting, and a button that looks ready while the app
 * is working is the thing the action bar exists to avoid.
 */
let building = false;

/**
 * @param {HTMLElement} panel
 * @param {string} state
 * @param {string} text
 */
function setActionNote(panel, state, text) {
    const note = panel.querySelector('.sillynovel-action-note');

    if (!note) {
        return;
    }

    note.dataset.state = state;
    note.textContent = text;
}

/**
 * Paint the action bar from the LIVE generation, not from a local flag.
 *
 * ⚠️ generate.js's in-flight state deliberately outlives the panel, so this is
 * the function that keeps a reopened panel honest: a request started before the
 * close is still running and still costing money, so the bar shows it — with
 * Cancel — rather than showing an action button that would buy a second one.
 *
 * @param {HTMLElement} panel
 */
function renderActionBar(panel) {
    const actionButtons = panel.querySelectorAll('.sillynovel-action');
    const cancelButton = panel.querySelector('.sillynovel-cancel');
    const workspace = getWorkspace();
    const running = getActiveGeneration();

    for (const button of actionButtons) {
        button.hidden = running !== null;
        button.disabled = pendingPreflight !== null || building;
    }

    if (cancelButton) {
        cancelButton.hidden = running === null;
    }

    if (!running) {
        return;
    }

    const elsewhere = !workspace || workspace.chapter.id !== running.chapterId;
    const progress = ACTIONS[running.action]?.progress ?? 'Generating…';
    const progressElsewhere = `${progress.replace(/…$/, '')} in ${running.chapterTitle}…`;

    setActionNote(
        panel,
        'busy',
        elsewhere ? progressElsewhere : progress,
    );
}

/** @param {HTMLElement} panel */
function renderSuggestionStale(panel) {
    const stale = panel.querySelector('.sillynovel-suggestion-stale');

    if (!stale) {
        return;
    }

    const editor = editorOf(panel);
    let isStale = false;

    if (suggestion && suggestion.resultKind !== 'notes' && editor) {
        isStale = suggestion.selection
            ? !anchorHolds(suggestion.selection, editor)
            : editor.value !== suggestion.source;
    }

    stale.textContent = suggestion?.selection
        ? 'The selected passage changed or moved, so this replacement is no longer anchored.'
        : 'The chapter changed after this was generated, so it may no longer follow on.';
    stale.hidden = !isStale;
}

/**
 * @param {HTMLElement} panel
 * @param {string|null} state
 * @param {string} [text]
 * @param {() => void} [retry]
 */
function setSuggestionStatus(panel, state, text, retry) {
    const status = panel.querySelector('.sillynovel-suggestions-status');

    if (!status) {
        return;
    }

    if (!state) {
        status.hidden = true;
        status.replaceChildren();
        return;
    }

    status.dataset.state = state;
    // replaceChildren, not textContent: it also clears any Retry button an
    // earlier failure left behind.
    status.replaceChildren(document.createTextNode(text ?? ''));

    if (retry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sillynovel-inline-retry';
        button.textContent = 'Retry';
        button.addEventListener('click', retry);
        status.append(' ', button);
    }

    status.hidden = false;
}

/** @param {HTMLElement} panel */
function renderSuggestionHistory(panel) {
    const controls = panel.querySelector('.sillynovel-suggestion-history');
    const previous = panel.querySelector('.sillynovel-history-previous');
    const next = panel.querySelector('.sillynovel-history-next');
    const position = panel.querySelector('.sillynovel-history-position');
    const state = suggestion ? suggestionHistoryFor(suggestion.chapterId) : null;
    const index = state?.items.indexOf(suggestion) ?? -1;
    const visible = index >= 0 && state.items.length > 1;

    if (controls) {
        controls.hidden = !visible;
    }

    if (previous) {
        previous.disabled = !visible || index === 0;
    }

    if (next) {
        next.disabled = !visible || index === state.items.length - 1;
    }

    if (position) {
        position.textContent = visible ? `${index + 1} / ${state.items.length}` : '';
    }
}

/** @param {string} act @param {string} label @param {{disabled?: boolean, title?: string}} [options] */
function suggestionActionButton(act, label, { disabled = false, title = '' } = {}) {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = `sillynovel-suggestion-action sillynovel-${act}`;
    button.dataset.act = act;
    button.textContent = label;
    button.disabled = disabled;
    button.title = title;

    return button;
}

/** @param {HTMLElement} panel */
function renderSuggestion(panel) {
    const block = panel.querySelector('.sillynovel-suggestion');
    const empty = panel.querySelector('.sillynovel-suggestions-empty');
    const body = panel.querySelector('.sillynovel-suggestion-text');
    const originalBlock = panel.querySelector('.sillynovel-suggestion-original-block');
    const original = panel.querySelector('.sillynovel-suggestion-original');
    const proposedLabel = panel.querySelector('.sillynovel-suggestion-proposed-label');
    const actions = panel.querySelector('.sillynovel-suggestion-actions');
    const status = panel.querySelector('.sillynovel-suggestions-status');
    const hasSelection = Boolean(suggestion?.selection && suggestion.resultKind === 'prose');

    if (block) {
        block.hidden = suggestion === null;
    }

    if (empty) {
        empty.hidden = suggestion !== null || Boolean(status && !status.hidden);
    }

    if (body) {
        // ⚠️ textContent, never innerHTML. This is untrusted text from outside,
        // rendered inside SillyTavern's own DOM. CSS white-space: pre-wrap is
        // what preserves the paragraph breaks that markup would have carried.
        body.textContent = suggestion?.text ?? '';
    }

    if (originalBlock) {
        originalBlock.hidden = !hasSelection;
    }

    if (original) {
        original.textContent = hasSelection ? suggestion.selection.text : '';
    }

    if (proposedLabel) {
        proposedLabel.hidden = !hasSelection;
    }

    if (actions) {
        if (!suggestion) {
            actions.replaceChildren();
        } else {
            let primary;

            if (suggestion.resultKind === 'notes') {
                primary = suggestionActionButton('add-to-notes', 'Add to notes');
            } else if (suggestion.selection) {
                primary = suggestionActionButton('replace', 'Replace');
            } else {
                primary = suggestionActionButton('insert', 'Insert');
            }

            actions.replaceChildren(
                primary,
                suggestionActionButton('copy', 'Copy'),
                suggestionActionButton('discard', 'Discard'),
            );
        }
    }

    renderSuggestionHistory(panel);
    renderSuggestionStale(panel);
}

/** @param {HTMLElement} panel @param {object|null} next */
function showSuggestion(panel, next) {
    suggestion = next;
    setSuggestionStatus(panel, null);
    renderSuggestion(panel);

    if (next?.warnings?.length) {
        const retryTarget = next;
        setSuggestionStatus(
            panel,
            'warning',
            `${next.warnings.join(' ')} Review before using, or retry.`,
            () => { void startAction(panel, retryTarget.action, retryTarget.selection); },
        );
    }
}

/** @param {HTMLElement} panel @param {object} next */
function appendSuggestion(panel, next) {
    const state = suggestionHistoryFor(next.chapterId, true);

    state.items.push(next);

    if (state.items.length > SUGGESTION_HISTORY_LIMIT) {
        const evicted = state.items.shift();

        if (evicted?.selection) {
            selectionAnchors.delete(evicted.selection);
        }
    }

    state.index = state.items.length - 1;
    showSuggestion(panel, next);
}

/** @param {HTMLElement} panel @param {number} offset */
function moveSuggestionHistory(panel, offset) {
    if (!suggestion) {
        return;
    }

    const state = suggestionHistoryFor(suggestion.chapterId);
    const index = state?.items.indexOf(suggestion) ?? -1;
    const nextIndex = index + offset;

    if (!state || nextIndex < 0 || nextIndex >= state.items.length) {
        return;
    }

    state.index = nextIndex;
    showSuggestion(panel, state.items[nextIndex]);
}

/** @param {HTMLElement} panel @param {boolean} revealPrevious */
function removeCurrentSuggestion(panel, revealPrevious) {
    if (!suggestion) {
        return;
    }

    const state = suggestionHistoryFor(suggestion.chapterId);
    const index = state?.items.indexOf(suggestion) ?? -1;

    if (!state || index < 0) {
        showSuggestion(panel, null);
        return;
    }

    state.items.splice(index, 1);

    if (suggestion.selection) {
        selectionAnchors.delete(suggestion.selection);
    }

    if (state.items.length === 0) {
        suggestionHistory.delete(suggestion.chapterId);
        showSuggestion(panel, null);
        return;
    }

    if (!revealPrevious) {
        state.index = null;
        showSuggestion(panel, null);
        return;
    }

    state.index = index > 0 ? index - 1 : 0;
    showSuggestion(panel, state.items[state.index]);
}

/** Restore only the current chapter's in-memory suggestion. @param {HTMLElement} panel */
function clearSuggestion(panel) {
    pendingPreflight = null;
    hidePreflight(panel);

    const chapterId = getWorkspace()?.chapter.id;
    const state = chapterId ? suggestionHistoryFor(chapterId) : null;
    const next = state && state.index !== null ? state.items[state.index] ?? null : null;

    showSuggestion(panel, next);
}

/** @param {HTMLElement} panel */
function hidePreflight(panel) {
    const preflight = panel.querySelector('.sillynovel-preflight');

    if (preflight) {
        preflight.hidden = true;
    }
}

/**
 * @param {HTMLElement} panel
 * @param {object|null} prompt a buildPrompt() result, or null to clear
 */
function renderTrimNote(panel, prompt) {
    const note = panel.querySelector('.sillynovel-trim-note');

    if (!note) {
        return;
    }

    if (!prompt?.trimmed) {
        note.hidden = true;
        note.textContent = '';
        return;
    }

    // ARCHITECTURE.md §5: never silently drop context. Said before the request
    // goes out, so it is on screen even if the generation then fails.
    note.textContent =
        `This chapter is longer than the model's context, so it was given the last `
        + `~${prompt.sentWords} words of ${prompt.totalWords}.`;
    note.hidden = false;
}

/**
 * Show the cost preflight and wait. AGENTS.md rule 6 / ARCHITECTURE.md §7.
 *
 * Nothing has been sent at this point and nothing will be until Send is
 * pressed — a token readout after the call prevents nothing.
 *
 * @param {HTMLElement} panel
 * @param {object} prompt
 * @param {object} target
 */
function showPreflight(panel, prompt, target) {
    const preflight = panel.querySelector('.sillynovel-preflight');
    const message = panel.querySelector('.sillynovel-preflight-message');

    if (!preflight || !message) {
        // Without the region there is no way to ask, and rule 6 says ask — so
        // the send does not happen.
        setActionNote(panel, 'error', 'This request is large, and the confirmation step is missing.');
        return;
    }

    pendingPreflight = { prompt, target };

    const scope = prompt.trimmed
        ? `the last ~${prompt.sentWords} words of this chapter (of ${prompt.totalWords})`
        : `this chapter, ~${prompt.totalWords} words`;

    message.textContent = [
        'This is a large request.',
        `Action: ${ACTIONS[prompt.action]?.label ?? prompt.action}.`,
        `Scope: ${scope}.`,
        ...(prompt.selectionWords > 0
            ? [`Selected passage: ~${prompt.selectionWords} words.`]
            : []),
        `About ${prompt.inputTokens} input tokens, plus up to ${prompt.reserveTokens} for the reply`
            + (prompt.reserveSource === 'raised-by-sillynovel'
                ? ` (raised by SillyNovel from your ${prompt.authorReserveTokens}).`
                : '.'),
        ...(prompt.profileTokens > 0 ? [`Of those input tokens, the Writing Profile is ${prompt.profileTokens}.`] : []),
        ...(prompt.selectionTokens > 0 ? [`The selected passage is ${prompt.selectionTokens} tokens.`] : []),
        ...(ACTIONS[prompt.action]?.resultKind === 'notes'
            ? ['The result will be notes, not manuscript prose.']
            : []),
        'Requests: 1.',
        'The price is not known — SillyNovel cannot see your provider’s rates.',
    ].join('\n');

    preflight.hidden = false;
    setActionNote(panel, 'idle', '');
    renderActionBar(panel);
}

/**
 * Run one generation and place the result.
 *
 * @param {HTMLElement} panel
 * @param {object} prompt
 * @param {{action: string, chapterId: string, chapterTitle: string, generation: number,
 *   source: string, profileSource: string,
 *   selection: {start: number, end: number, text: string}|null}} target
 */
async function runGeneration(panel, prompt, target) {
    // ⚠️ The previous suggestion is superseded the moment a new one is asked
    // for. Leaving it on screen through the next generation leaves a live
    // Insert button over prose that is no longer the answer to the question
    // just asked — and after a cancel or a failure it would sit under a status
    // line the author would naturally read it as belonging to.
    suggestion = null;
    setSuggestionStatus(panel, null);
    renderSuggestion(panel);

    markInspectionSent(target);
    renderInspection(panel);

    // ⚠️ Started BEFORE the bar is painted, and awaited after. runAction
    // registers the generation synchronously, before its own first await, so
    // calling it first is what lets renderActionBar see one. Painting first and
    // calling second — the natural order to write — leaves the bar showing
    // "Measuring the prompt…" with actions disabled and CANCEL HIDDEN for the
    // whole request, in the one chapter the author is most likely watching: the
    // one they invoked the action in. Nothing else repaints until generation
    // ends, so the cancellable "Generating…" state PLAN.md:447 asks for would
    // exist only for authors who happened to navigate away.
    const pending = runGenerationAction({ prompt, ...target });

    renderActionBar(panel);

    let result;

    try {
        result = await pending;
    } catch (error) {
        // A superseded failure is not news: reporting an error about a chapter
        // the author has already left is noise, and the same reasoning
        // session.js applies to stale saves.
        if (panel.isConnected && isCurrentTarget(target.generation, target.chapterId)) {
            renderGenerationError(panel, error, () => {
                void startAction(panel, target.action, target.selection);
            });
        }

        return;
    } finally {
        // ⚠️ Resolved live rather than through the captured panel. After a close
        // and reopen this closure holds a detached node, and the REOPENED panel
        // is the one still showing "Generating in …" that has to be released.
        const live = document.getElementById('sillynovel-panel');

        if (live) {
            renderActionBar(live);

            if (!getActiveGeneration()) {
                setActionNote(live, 'idle', '');
            }
        }
    }

    // null means something was already running; the bar already says so.
    if (result === null || !panel.isConnected) {
        return;
    }

    // The workspace moved while this was in flight — a switch, or a close and
    // reopen. The result belongs to a chapter that is no longer the target, so
    // it is discarded rather than painted over whatever is on screen now.
    if (!isCurrentTarget(result.generation, result.chapterId)) {
        return;
    }

    const check = validate(result.text, result.action);
    const nextSuggestion = {
        text: result.text,
        action: result.action,
        resultKind: ACTIONS[result.action]?.resultKind ?? 'prose',
        chapterId: result.chapterId,
        generation: result.generation,
        source: target.source,
        selection: target.selection,
        warnings: check.warnings,
    };

    appendSuggestion(panel, nextSuggestion);
}

/**
 * @param {HTMLElement} panel
 * @param {unknown} error
 * @param {() => void} retry
 */
function renderGenerationError(panel, error, retry) {
    if (error?.kind === GenerateErrorKind.CANCELLED) {
        // Cancelled is not failed. Reached from our own Cancel button, from the
        // author pressing SillyTavern's stop button, and from any other
        // extension calling stopGeneration() — all of them global.
        setSuggestionStatus(panel, 'idle', 'Generation cancelled.');
        renderSuggestion(panel);
        return;
    }

    setSuggestionStatus(panel, 'error', error?.message ?? 'That did not work.', retry);
    renderSuggestion(panel);
}

/**
 * @param {HTMLElement} panel
 * @param {string} action
 * @param {{start: number, end: number, text: string}|null} [presetSelection]
 */
async function startAction(panel, action, presetSelection = null) {
    const config = ACTIONS[action];

    if (!config) {
        return;
    }

    // ⚠️ A pending recovery offer blocks this, reusing checkpoint 7's halt
    // predicate. The editor holds the draft while the server holds something
    // else, so generating from one of two unreconciled versions and then
    // offering to insert into it produces a third, with no honest answer for
    // which chapter state it belongs to. A CONFLICT halt is deliberately not
    // blocked: generation is read-only, and the author may want the prose
    // precisely so they can copy it out.
    if (getHalt() === 'offer') {
        renderHaltStatus(panel);
        panel.querySelector('.sillynovel-recovery')?.scrollIntoView({ block: 'nearest' });
        return;
    }

    if (getActiveGeneration()) {
        renderActionBar(panel);
        return;
    }

    const workspace = getWorkspace();

    if (!workspace) {
        return;
    }

    const editor = editorOf(panel);
    const source = editor?.value ?? '';
    const profile = readProfileForm(panel);
    const profileSource = renderProfileText(profile);
    let selection = null;

    if (config.needsSelection) {
        const start = presetSelection?.start ?? editor?.selectionStart ?? 0;
        const end = presetSelection?.end ?? editor?.selectionEnd ?? 0;
        const text = presetSelection?.text ?? source.slice(start, end);

        // A retry inherits the earlier anchor, so an edit that broke it breaks the retry too.
        if (presetSelection && (!editor || !anchorHolds(presetSelection, editor))) {
            setActionNote(panel, 'error', 'The selected passage changed. Select it again and rerun the action.');
            return;
        }

        if (text.trim() === '') {
            setActionNote(panel, 'error', `Select a passage to ${action} first.`);
            return;
        }

        selection = { start, end, text, chapterId: workspace.chapter.id, broken: false };
        selectionAnchors.add(selection);
    }

    const target = {
        action,
        chapterId: workspace.chapter.id,
        chapterTitle: workspace.chapter.title,
        generation: getWorkspaceGeneration(),
        source,
        profileSource,
        selection,
    };

    setSuggestionStatus(panel, null);
    setActionNote(panel, 'busy', 'Measuring the prompt…');

    building = true;
    renderActionBar(panel);
    renderInspectorControls(panel);

    try {
        let prompt;

        try {
            prompt = await buildPrompt(action, {
                manuscript: source,
                selection: selection?.text ?? '',
                profile,
            });
        } catch (error) {
            if (panel.isConnected) {
                setActionNote(panel, 'error', error?.message ?? 'That did not work.');

                if (isCurrentTarget(target.generation, target.chapterId)) {
                    // A BUDGET refusal is the moment the Inspector is most
                    // worth opening, so it gets the arithmetic that failed.
                    refusalInspection(panel, error, target, source);
                    renderInspection(panel);
                }
            }

            return;
        }

        if (!panel.isConnected || !isCurrentTarget(target.generation, target.chapterId)) {
            return;
        }

        if (!actionSnapshotIsCurrent(panel, target)) {
            setActionNote(panel, 'error', 'The chapter or Writing Profile changed while the prompt was measured. Run the action again.');
            return;
        }

        captureInspection(prompt, target, source, 'built');
        renderInspection(panel);

        renderTrimNote(panel, prompt);

        if (needsPreflight(prompt)) {
            showPreflight(panel, prompt, target);
            return;
        }

        await runGeneration(panel, prompt, target);
    } finally {
        building = false;

        // Live, not captured: after a close and reopen the captured panel is
        // detached and the REOPENED one is the one holding a disabled button.
        const live = document.getElementById('sillynovel-panel');

        if (live) {
            renderActionBar(live);
            // Refresh was disabled while `building`; this is what releases it.
            renderInspectorControls(live);
        }
    }
}

/** @param {HTMLElement} panel @param {object} target */
function actionSnapshotIsCurrent(panel, target) {
    const editor = editorOf(panel);

    return Boolean(editor)
        && isCurrentTarget(target.generation, target.chapterId)
        && editor.value === target.source
        && renderProfileText(readProfileForm(panel)) === target.profileSource;
}

/**
 * Take the suggestion into the manuscript.
 *
 * @param {HTMLElement} panel
 */
function insertSuggestion(panel) {
    const editor = editorOf(panel);

    if (!suggestion || suggestion.resultKind !== 'prose' || suggestion.selection || !editor) {
        return;
    }

    const existing = editor.value;
    const needsSpace = existing.length > 0
        && !/\s$/.test(existing)
        && !/^\s/.test(suggestion.text);

    // Verbatim, plus at most the one joining space: cleanUpMessage already
    // stripped the model's trailing whitespace (script.js:6431), so a
    // continuation arrives with no leading space of its own. Nothing else is
    // trimmed or reflowed — what is in the pane is what lands in the draft.
    const payload = (needsSpace ? ' ' : '') + suggestion.text;

    // Focus moves to the editor deliberately: execCommand needs it, and the
    // caret then sits after the inserted prose, which is where the author wants
    // to keep writing.
    editor.focus();
    editor.setSelectionRange(existing.length, existing.length);
    pendingEditStart = existing.length;

    let inserted = false;

    try {
        // ⚠️ execCommand rather than assignment. Assigning to .value wipes the
        // textarea's native undo stack, so accepting a suggestion would make
        // Ctrl-Z unable to undo it AND destroy the author's ability to undo the
        // paragraph they typed before it. Deprecated with no standard
        // replacement (setRangeText does not restore undo either).
        inserted = document.execCommand('insertText', false, payload);
    } catch {
        inserted = false;
    }

    if (!inserted) {
        editor.value = existing + payload;
        editor.setSelectionRange(editor.value.length, editor.value.length);
    }

    // ⚠️ Consumed. Leaving the pane live over prose that is now manuscript means
    // a second click appends the same paragraph twice — and every "insert is
    // verbatim" check still passes, because each append was.
    //
    // The status line goes with it: a "Copied." left over from before the insert
    // describes a suggestion that is now manuscript, and it also suppresses the
    // pane's own empty hint, so the pane ends up saying nothing true at all.
    removeCurrentSuggestion(panel, false);

    // The fallback assignment fires no input event, so nothing applied the edit yet.
    applyPendingEdit();

    // ⚠️ Called on BOTH paths, including the one where execCommand fired
    // `input` natively. A `true` return says the edit was applied, not that an
    // event was dispatched, and this checkpoint's save-and-record guarantee
    // should not rest on that distinction holding in every browser. The call is
    // idempotent, so the redundant one costs nothing.
    handleEditorChange(panel);
}

/** @param {HTMLElement} panel */
function replaceSelection(panel) {
    const editor = editorOf(panel);

    if (!suggestion || suggestion.resultKind !== 'prose' || !suggestion.selection || !editor) {
        return;
    }

    const { start, end } = suggestion.selection;

    // ⚠️ The anchor, not the text at its offsets: an identical passage can slide
    // into those offsets after the selected one is deleted.
    if (!anchorHolds(suggestion.selection, editor)) {
        setSuggestionStatus(
            panel,
            'error',
            'The passage you selected has changed or moved, so it cannot be replaced safely. Select it again and retry, or copy the rewrite.',
        );
        renderSuggestion(panel);
        return;
    }

    const existing = editor.value;
    const replacement = suggestion.text;

    editor.focus();
    editor.setSelectionRange(start, end);
    // Other results in this chapter's history may be anchored after this one.
    pendingEditStart = start;

    let inserted = false;

    try {
        inserted = document.execCommand('insertText', false, replacement);
    } catch {
        inserted = false;
    }

    if (!inserted) {
        editor.value = existing.slice(0, start) + replacement + existing.slice(end);
        const caret = start + replacement.length;
        editor.setSelectionRange(caret, caret);
    }

    removeCurrentSuggestion(panel, false);
    applyPendingEdit();
    handleEditorChange(panel);
}

/** @param {HTMLElement} panel */
function expandNotes(panel) {
    const toggle = panel.querySelector('.sillynovel-notes-toggle');
    const body = panel.querySelector('.sillynovel-notes-body');

    if (toggle && body) {
        toggle.setAttribute('aria-expanded', 'true');
        body.hidden = false;
    }
}

/** @param {HTMLElement} panel */
function addSuggestionToNotes(panel) {
    const notes = notesEditorOf(panel);

    if (!suggestion || suggestion.resultKind !== 'notes' || !notes) {
        return;
    }

    expandNotes(panel);

    if (getNotesHalt() !== null) {
        notesSaver.renderHalt(panel);
        setSuggestionStatus(panel, 'error', 'Resolve the notes save problem before adding more.');
        return;
    }

    const existing = notes.value;
    const payload = (existing.trim() ? '\n\n' : '') + suggestion.text;

    notes.focus();
    notes.setSelectionRange(existing.length, existing.length);

    let inserted = false;

    try {
        inserted = document.execCommand('insertText', false, payload);
    } catch {
        inserted = false;
    }

    if (!inserted) {
        notes.value = existing + payload;
        notes.setSelectionRange(notes.value.length, notes.value.length);
    }

    removeCurrentSuggestion(panel, false);
    handleNotesChange(panel);
}

/** @param {HTMLElement} panel */
function discardSuggestion(panel) {
    // Rejection changes only the pane; neither manuscript nor notes is touched.
    removeCurrentSuggestion(panel, true);
}

/**
 * Legacy copy path.
 *
 * ⚠️ Not redundant. navigator.clipboard is undefined outside a secure context —
 * and SillyTavern is commonly reached over plain http on a LAN address, where
 * the modern API simply is not there. The async API can also be denied outright
 * by policy. This path is gated on user activation rather than on a permission,
 * so it survives both.
 *
 * @param {string} text
 * @returns {boolean}
 */
function copyViaSelection(text) {
    const scratch = document.createElement('textarea');

    // Off-screen rather than hidden: a display:none element cannot be selected.
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.top = '-1000px';
    scratch.style.opacity = '0';

    document.body.append(scratch);

    try {
        scratch.select();
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        scratch.remove();
    }
}

/**
 * Copy, by whichever path this browser actually offers.
 *
 * Shared by the suggestion pane and the Context Inspector so the fallback
 * ladder exists once rather than three times.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyToClipboard(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }

        return copyViaSelection(text);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] copy failed`, error);

        // The modern API can be denied by policy even where it exists, so a
        // rejection is not the end of the road.
        return copyViaSelection(text);
    }
}

/** @param {HTMLElement} panel */
async function copySuggestion(panel) {
    if (!suggestion) {
        return;
    }

    const target = suggestion;
    const copied = await copyToClipboard(target.text);

    if (!panel.isConnected || suggestion !== target) {
        return;
    }

    if (copied) {
        // ⚠️ The pane KEEPS the suggestion. Copying is non-destructive and
        // repeatable; clearing here would punish the author for copying before
        // deciding.
        setSuggestionStatus(panel, 'idle', 'Copied.');
    } else {
        setSuggestionStatus(panel, 'error', 'Could not copy — select the text and copy it manually.');
    }

    renderSuggestion(panel);
}

/* --- context inspector (checkpoint 9) ------------------------------------

   PLAN.md:365 asks for "the actual assembled prompt", and the honest version of
   that claim is narrower than it sounds. Two things happen after we hand the
   array to generateRaw and we can see neither: createRawPrompt prepends a
   `name: ` prefix on non-openai, non-instruct backends (script.js:3885) and
   then applies instruct formatting. So the heading says "Handed to
   SillyTavern", not "the wire", and the note says what happens afterwards.

   The list is numbered because block ORDER is a tunable (ARCHITECTURE.md:98):
   the sent order and PROMPT_BLOCKS agree today, and the numbering is what will
   make it visible on the day someone tunes one without the other. */

/** What the author is told the region is, before any figures. */
const INSPECTOR_NOTE = 'This is the prompt SillyNovel assembles, with macros expanded the way '
    + 'SillyTavern expands them on the way out. Time and chance macros re-roll every time, so this '
    + 'is a faithful sample rather than a byte-for-byte copy, and SillyTavern applies provider '
    + 'formatting after this point. Building it costs no model request. Block order is a tunable; '
    + 'the labels are not.';

/**
 * The two ways the figures could be misread, said plainly.
 *
 * Framing is counted as one joined string (generate.js), so per-block figures
 * for the instruction and the contract do not exist and must not be implied.
 * And every count is taken BEFORE substituteParams runs, so the text on screen
 * can be visibly longer than the number beside it claims.
 */
const COUNT_CAVEAT = 'Framing is the instruction, the contract and the [MANUSCRIPT] header line '
    + 'counted as one joined string, so those have no per-block figures; the Writing Profile, '
    + 'selection and manuscript are counted on their own and shown beside their blocks. All counts are '
    + 'taken before macros expand — SillyTavern expands them after we count, and the safety '
    + 'margin is what covers the difference, along with the chat envelope no per-block count sees.';

const RESERVE_SOURCE_LABEL = {
    provider: 'from your API settings',
    fallback: "SillyNovel's fallback — this backend exposes none",
    'raised-by-sillynovel': 'raised by SillyNovel',
};

/**
 * The reply-reserve figure, saying where the number came from — and, when
 * SillyNovel raised it, what it was raised FROM, since that is the setting the
 * author can actually see in their API panel.
 *
 * @param {{reserveTokens: number|null, authorReserveTokens?: number|null, reserveSource: string}} figures
 */
function reserveFigure(figures) {
    const base = tokenFigure(figures.reserveTokens);

    if (figures.reserveSource === 'raised-by-sillynovel' && typeof figures.authorReserveTokens === 'number') {
        return `${base} · raised by SillyNovel from ${figures.authorReserveTokens.toLocaleString()} in your API settings`;
    }

    return `${base} · ${RESERVE_SOURCE_LABEL[figures.reserveSource] ?? 'source unknown'}`;
}

/** @param {HTMLElement} panel */
function isInspectorOpen(panel) {
    return panel.querySelector('.sillynovel-inspector-toggle')?.getAttribute('aria-expanded') === 'true';
}

/**
 * @param {HTMLElement} panel
 * @param {string|null} state
 * @param {string} [text]
 * @param {() => void} [retry]
 */
function setInspectorStatus(panel, state, text, retry) {
    const status = panel.querySelector('.sillynovel-inspector-status');

    if (!status) {
        return;
    }

    if (!state) {
        status.hidden = true;
        status.replaceChildren();
        return;
    }

    status.dataset.state = state;
    // replaceChildren, not textContent: it also clears any Retry button an
    // earlier failure left behind.
    status.replaceChildren(document.createTextNode(text ?? ''));

    if (retry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sillynovel-inline-retry';
        button.textContent = 'Retry';
        button.addEventListener('click', retry);
        status.append(' ', button);
    }

    status.hidden = false;
}

/** @param {object} prompt @param {string} label */
function blockFor(prompt, label) {
    return prompt.blocks.find((block) => block.label === label) ?? null;
}

/**
 * The figures the Inspector may show, as a deliberate ALLOWLIST.
 *
 * ⚠️ AGENTS.md rule 13. This module never reaches into SillyTavern's context
 * or the settings object behind it; every figure here arrives as a number
 * already chosen by generate.js. Keep it that way — those settings sit beside
 * provider credentials, and an allowlist of numbers cannot become a key dump.
 * The guard is a grep over this file finding no such reads at all.
 *
 * @param {object} prompt a buildPrompt() result
 */
function figuresFromPrompt(prompt) {
    return {
        action: prompt.action,
        contextTokens: prompt.contextTokens,
        reserveTokens: prompt.reserveTokens,
        authorReserveTokens: prompt.authorReserveTokens ?? null,
        reserveSource: prompt.reserveSource,
        framingTokens: prompt.framingTokens,
        profileTokens: prompt.profileTokens ?? null,
        selectionTokens: prompt.selectionTokens ?? null,
        marginTokens: prompt.marginTokens,
        allowanceTokens: prompt.allowanceTokens,
        manuscriptTokens: blockFor(prompt, 'MANUSCRIPT')?.tokens ?? null,
        inputTokens: prompt.inputTokens,
        trimmed: prompt.trimmed,
        sentWords: prompt.sentWords,
        totalWords: prompt.totalWords,
    };
}

/**
 * The same shape, from what a BUDGET refusal knew when it was thrown.
 *
 * A null is "not reached before the refusal" and is rendered as such: at the
 * earliest throw site nothing has been counted at all, and saying so is the
 * report that the tokenizer never ran.
 *
 * @param {object} budget GenerateError.budget
 */
function figuresFromBudget(budget) {
    return {
        action: budget.action ?? null,
        contextTokens: budget.contextTokens,
        reserveTokens: budget.reserveTokens,
        authorReserveTokens: budget.authorReserveTokens ?? null,
        reserveSource: budget.reserveSource,
        framingTokens: budget.framingTokens,
        profileTokens: budget.profileTokens ?? null,
        selectionTokens: budget.selectionTokens ?? null,
        marginTokens: budget.marginTokens,
        allowanceTokens: budget.allowanceTokens,
        manuscriptTokens: null,
        inputTokens: null,
        trimmed: false,
        sentWords: null,
        totalWords: null,
    };
}

/**
 * Store what the Inspector will show.
 *
 * ⚠️ `blocks[].content` is deliberately NOT read here. It is the raw,
 * unwrapped duplicate of the same text; everything displayed comes from
 * `messages[].content` through expandForDisplay, which carries the `[LABEL]`
 * header that is actually sent and the macro expansion that is actually
 * applied. Reading blocks[].content instead is the easiest mistake to make in
 * this file and would show a prompt the model never received.
 *
 * @param {object} prompt a buildPrompt() result
 * @param {{chapterId: string, generation: number}} target
 * @param {string} source the manuscript the prompt was built from
 * @param {'built'|'sent'} origin
 */
function captureInspection(prompt, target, source, origin) {
    inspection = {
        origin,
        action: prompt.action,
        source,
        // What the profile rendered to at capture time — a string, compared
        // as a string, so staleness never re-counts anything.
        profileSource: prompt.profileText ?? '',
        chapterId: target.chapterId,
        generation: target.generation,
        messages: expandForDisplay(prompt.messages).map((message, index) => {
            const block = blockFor(prompt, message.label);

            return {
                position: index + 1,
                role: message.role,
                label: message.label,
                expanded: message.expanded,
                failed: message.failed,
                text: message.content,
                reason: block?.reason ?? '',
                tokenLabel: typeof block?.tokens === 'number'
                    ? `${block.tokens.toLocaleString()} tokens`
                    : 'counted with the framing',
            };
        }),
        excluded: prompt.blocks
            .filter((block) => !block.included)
            .map((block) => ({ label: block.label, reason: block.reason })),
        figures: figuresFromPrompt(prompt),
        refusal: null,
    };
}

/**
 * A refusal is the state that most needs this region, so show the arithmetic
 * that failed rather than only the sentence.
 *
 * @param {HTMLElement} panel
 * @param {unknown} error
 * @param {{chapterId: string, generation: number}} target
 * @param {string} source
 */
function refusalInspection(panel, error, target, source) {
    const kind = error?.kind ?? null;

    // Not a refusal at all: a getTokenCountAsync round trip can fail outright,
    // and that is a transient failure with a Retry, not a verdict about the
    // prompt.
    if (!kind) {
        console.error(`[${EXTENSION_NAME}] could not measure the prompt`, error);
        inspection = null;

        if (panel.isConnected) {
            setInspectorStatus(panel, 'error', 'Could not measure the prompt.', () => {
                void buildInspection(panel);
            });
        }

        return;
    }

    const budget = error?.budget ?? null;

    inspection = {
        origin: 'built',
        action: budget?.action ?? target.action ?? 'continue',
        source,
        profileSource: null,
        chapterId: target.chapterId,
        generation: target.generation,
        messages: [],
        // ⚠️ These reasons are generated HERE rather than by generate.js, a
        // deliberate exception to ARCHITECTURE.md:162-163. That rule asks the
        // assembler to record a reason per block; on this path there is no
        // assembled prompt for it to have recorded reasons about.
        excluded: PROMPT_BLOCKS.map((label) => ({
            label,
            reason: 'not assembled — the prompt was refused before assembly',
        })),
        figures: budget ? figuresFromBudget(budget) : null,
        refusal: {
            message: error?.message ?? 'The prompt could not be assembled.',
            kind,
        },
    };

    if (panel.isConnected) {
        setInspectorStatus(panel, null);
    }
}

/**
 * Flip a capture from "built" to "sent" when its generation goes out.
 *
 * ⚠️ Relabels only. Re-capturing here would re-run substituteParams and
 * re-roll {{roll}}, {{random}} and {{time}}, so the region would show a
 * DIFFERENT sample than the one this generation was actually assembled from.
 *
 * @param {{chapterId: string, generation: number}} target
 */
function markInspectionSent(target) {
    if (inspection
        && inspection.action === target.action
        && inspection.chapterId === target.chapterId
        && inspection.generation === target.generation) {
        inspection.origin = 'sent';
    }
}

/**
 * Build the prompt for display. Spends token counts; sends nothing.
 *
 * @param {HTMLElement} panel
 */
async function buildInspection(panel) {
    if (inspecting) {
        return;
    }

    const workspace = getWorkspace();

    if (!workspace) {
        return;
    }

    const target = {
        action: 'continue',
        chapterId: workspace.chapter.id,
        // Captured at the trigger, like every other long action in this file.
        generation: getWorkspaceGeneration(),
    };
    // ⚠️ Read ONCE, here, and threaded through. This exact string is both
    // what the prompt is assembled from and what staleness is compared against
    // later; reading the editor again after the await would let the two differ.
    const source = editorOf(panel)?.value ?? '';

    inspecting = true;
    setInspectorStatus(panel, 'busy', 'Measuring…');
    renderInspectorControls(panel);
    renderInspection(panel);

    try {
        const prompt = await buildContinuePrompt(source, { profile: readProfileForm(panel) });

        // Token counting is async and can round-trip to the server, so the
        // workspace may have moved while it ran. Painting chapter A's prompt
        // under chapter B's title is the hazard clearSuggestion exists for.
        if (!panel.isConnected || !isCurrentTarget(target.generation, target.chapterId)) {
            return;
        }

        captureInspection(prompt, target, source, 'built');
        setInspectorStatus(panel, null);
    } catch (error) {
        if (!panel.isConnected || !isCurrentTarget(target.generation, target.chapterId)) {
            return;
        }

        refusalInspection(panel, error, target, source);
    } finally {
        inspecting = false;

        // Live, not captured: after a close and reopen the captured panel is
        // detached and the REOPENED one is the one holding a stale control.
        const live = document.getElementById('sillynovel-panel');

        if (live) {
            renderInspection(live);
            renderInspectorControls(live);
        }
    }
}

/** @param {HTMLElement} panel */
function renderInspectorControls(panel) {
    const refresh = panel.querySelector('.sillynovel-inspector-refresh');
    const copy = panel.querySelector('.sillynovel-inspector-copy');

    if (refresh) {
        // Disabled while an action is measuring: that path hands this region
        // its capture for free, so refreshing now would pay for the same counts
        // twice. Re-enabled when action measurement finishes.
        refresh.disabled = inspecting || building;
    }

    if (copy) {
        copy.disabled = !inspection || inspection.messages.length === 0;
    }
}

/** @param {HTMLElement} panel */
function renderInspectorStale(panel) {
    const stale = panel.querySelector('.sillynovel-inspector-stale');

    if (!stale) {
        return;
    }

    const editor = editorOf(panel);

    // ⚠️ A STRING COMPARISON against the snapshot, never a re-measure. This
    // runs on every keystroke, and token counting must not run in the typing
    // path (ARCHITECTURE.md:165-166). Do not "improve" this into a rebuild.
    const profileUnchanged = inspection?.profileSource === null
        || renderProfileText(readProfileForm(panel)) === inspection?.profileSource;

    stale.hidden = !inspection || !editor || (editor.value === inspection.source && profileUnchanged);
}

/** @param {HTMLElement} panel */
function renderInspectorNote(panel) {
    const note = panel.querySelector('.sillynovel-inspector-note');

    if (!note) {
        return;
    }

    if (!inspection || inspection.refusal) {
        note.textContent = INSPECTOR_NOTE;
        return;
    }

    const label = ACTIONS[inspection.action]?.label ?? 'action';

    note.textContent = `${INSPECTOR_NOTE} ${inspection.origin === 'sent'
        ? `This is the prompt that was assembled and sent for the last ${label}.`
        : 'Built from the editor. Nothing was sent.'}`;
}

/** @param {HTMLElement} panel */
function renderInspectorRefusal(panel) {
    const box = panel.querySelector('.sillynovel-inspector-refusal');

    if (!box) {
        return;
    }

    const refusal = inspection?.refusal ?? null;

    box.textContent = refusal?.message ?? '';
    box.hidden = refusal === null;
}

/** @param {number|null} value */
function tokenFigure(value) {
    return typeof value === 'number'
        ? `${value.toLocaleString()} tokens`
        : 'not reached — the refusal came first';
}

/** @param {HTMLElement} panel */
function renderInspectorFigures(panel) {
    const list = panel.querySelector('.sillynovel-inspector-figures');
    const caveat = panel.querySelector('.sillynovel-inspector-caveat');
    const figures = inspection?.figures ?? null;

    if (!list) {
        return;
    }

    if (!figures) {
        list.replaceChildren();
        list.hidden = true;

        if (caveat) {
            caveat.hidden = true;
        }

        return;
    }

    const manuscript = figures.trimmed && typeof figures.sentWords === 'number'
        ? `${tokenFigure(figures.manuscriptTokens)} · last ~${figures.sentWords.toLocaleString()} words of ${figures.totalWords.toLocaleString()}`
        : tokenFigure(figures.manuscriptTokens);

    const rows = [
        ['Action', ACTIONS[figures.action]?.label ?? 'not reached — the refusal came first'],
        ['Context size', tokenFigure(figures.contextTokens)],
        ['Reply reserve', reserveFigure(figures)],
        ['Framing', tokenFigure(figures.framingTokens)],
        ['Writing Profile', figures.profileTokens === 0 ? 'empty — not sent' : tokenFigure(figures.profileTokens)],
        ['Selection', figures.selectionTokens === 0
            ? 'none — this action takes no selection'
            : tokenFigure(figures.selectionTokens)],
        ['Safety margin', tokenFigure(figures.marginTokens)],
        ['Room left for the manuscript', tokenFigure(figures.allowanceTokens)],
        ['Manuscript sent', manuscript],
        ['Total input', tokenFigure(figures.inputTokens)],
    ];

    list.replaceChildren(...rows.map(([label, value]) => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        const amount = document.createElement('span');

        name.className = 'sillynovel-inspector-figure-label';
        name.textContent = label;
        amount.className = 'sillynovel-inspector-figure-value';
        amount.textContent = value;
        item.append(name, amount);

        return item;
    }));

    list.hidden = false;

    if (caveat) {
        caveat.textContent = COUNT_CAVEAT;
        caveat.hidden = false;
    }
}

/** @param {HTMLElement} panel */
function renderInspectorExcluded(panel) {
    const list = panel.querySelector('.sillynovel-inspector-blocks');
    const heading = panel.querySelector('.sillynovel-inspector-heading[data-part="excluded"]');
    const excluded = inspection?.excluded ?? [];

    if (list) {
        list.replaceChildren(...excluded.map((block) => {
            const item = document.createElement('li');
            item.textContent = `[${block.label}] — ${block.reason}`;
            return item;
        }));
    }

    if (heading) {
        heading.hidden = excluded.length === 0;
    }
}

/** @param {object} message */
function macroNote(message) {
    if (message.failed) {
        return 'macro expansion failed — showing the unexpanded text';
    }

    return message.expanded ? 'macros expanded' : 'no macros to expand';
}

/** @param {HTMLElement} panel */
function renderInspectorWire(panel) {
    const list = panel.querySelector('.sillynovel-inspector-wire');
    const heading = panel.querySelector('.sillynovel-inspector-heading[data-part="wire"]');
    const messages = inspection?.messages ?? [];

    if (list) {
        list.replaceChildren(...messages.map((message) => {
            const item = document.createElement('li');
            const head = document.createElement('p');
            const reason = document.createElement('p');
            const text = document.createElement('div');

            item.className = 'sillynovel-inspector-message';

            head.className = 'sillynovel-inspector-message-head';
            head.textContent = `${message.position} · ${message.role} · [${message.label}]`;

            reason.className = 'sillynovel-inspector-message-reason';
            reason.textContent = [message.reason, message.tokenLabel, macroNote(message)]
                .filter(Boolean)
                .join(' · ');

            // ⚠️ textContent, never innerHTML. CSS white-space: pre-wrap is
            // what preserves the paragraph breaks markup would have carried.
            text.className = 'sillynovel-inspector-message-text';
            text.textContent = message.text;

            item.append(head, reason, text);

            return item;
        }));
    }

    if (heading) {
        heading.hidden = messages.length === 0;
    }
}

/** @param {HTMLElement} panel */
function renderInspection(panel) {
    const region = panel.querySelector('.sillynovel-inspector');
    const empty = panel.querySelector('.sillynovel-inspector-empty');

    if (region) {
        if (inspecting) {
            region.dataset.state = 'busy';
        } else if (inspection === null) {
            region.dataset.state = 'empty';
        } else if (inspection.refusal) {
            region.dataset.state = 'refused';
        } else {
            region.dataset.state = 'ready';
        }
    }

    // Painting into a collapsed body is wasted work; expanding repaints.
    if (!isInspectorOpen(panel)) {
        return;
    }

    if (empty) {
        empty.hidden = inspection !== null || inspecting;
    }

    renderInspectorNote(panel);
    renderInspectorRefusal(panel);
    renderInspectorFigures(panel);
    renderInspectorExcluded(panel);
    renderInspectorWire(panel);
    renderInspectorStale(panel);
}

/**
 * Drop what the region is showing. Called on every chapter install.
 *
 * ⚠️ Clears, but deliberately does NOT collapse and does NOT rebuild. The
 * disclosure state belongs to the author, and rebuilding here would spend two
 * to five tokenizer round trips on every chapter switch — incidental counting
 * is exactly what ARCHITECTURE.md:165-166 rules out. Expanding is an explicit
 * act and may pay for itself; navigating is not.
 *
 * @param {HTMLElement} panel
 */
function clearInspection(panel) {
    inspection = null;
    setInspectorStatus(panel, null);
    renderInspection(panel);
    renderInspectorControls(panel);
}

/**
 * A role-annotated transcript, not JSON.
 *
 * JSON.stringify escapes every newline, which turns a full chapter into one
 * unreadable line — the opposite of what a region that exists to be pasted
 * into a diff is for. The separators cost paste-ready fidelity: this cannot be
 * dropped verbatim into a playground, and it is not meant to be.
 */
function inspectionTranscript() {
    if (!inspection) {
        return '';
    }

    const label = ACTIONS[inspection.action]?.label ?? 'action';
    const lines = [
        inspection.origin === 'sent'
            ? `SillyNovel — the prompt assembled and sent for the last ${label}`
            : 'SillyNovel — prompt built from the editor; nothing was sent',
        '',
    ];

    for (const message of inspection.messages) {
        lines.push(`--- ${message.position} · ${message.role} ---`, message.text, '');
    }

    if (inspection.excluded.length > 0) {
        lines.push('--- not sent ---');

        for (const block of inspection.excluded) {
            lines.push(`[${block.label}] — ${block.reason}`);
        }
    }

    return lines.join('\n');
}

/** @param {HTMLElement} panel */
async function copyInspection(panel) {
    const text = inspectionTranscript();

    if (!text) {
        return;
    }

    const copied = await copyToClipboard(text);

    if (!panel.isConnected) {
        return;
    }

    if (copied) {
        setInspectorStatus(panel, 'idle', 'Copied.');
    } else {
        setInspectorStatus(panel, 'error', 'Could not copy — select the text and copy it manually.');
    }
}

/**
 * Wire the region's controls. Called once per mount, like wireEditor.
 *
 * @param {HTMLElement} panel
 */
function wireInspector(panel) {
    const toggle = panel.querySelector('.sillynovel-inspector-toggle');
    const body = panel.querySelector('.sillynovel-inspector-body');
    const refresh = panel.querySelector('.sillynovel-inspector-refresh');
    const copy = panel.querySelector('.sillynovel-inspector-copy');

    if (toggle && body) {
        // Set explicitly rather than relying on the template's `hidden`
        // surviving DOMPurify, so "collapsed by default" is our guarantee.
        body.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');

        toggle.onclick = () => {
            const open = toggle.getAttribute('aria-expanded') === 'true';

            toggle.setAttribute('aria-expanded', String(!open));
            body.hidden = open;

            if (open) {
                return;
            }

            if (inspection === null) {
                void buildInspection(panel);
            } else {
                renderInspection(panel);
            }
        };
    }

    if (refresh) {
        refresh.onclick = () => { void buildInspection(panel); };
    }

    if (copy) {
        copy.onclick = () => { void copyInspection(panel); };
    }

    renderInspectorControls(panel);
    renderInspection(panel);
}

/* --- the Writing Profile (Phase 3 checkpoint 2) --------------------------

   Explicit Save, no idle debounce: the profile is short, edited rarely, and
   its loss window is "typed but not yet Saved at a crash", which the dirty
   indicator shows the author the whole time. The recovery module is
   chapter-keyed with offer/halt semantics that would have to be duplicated
   for a second document kind — machinery the manuscript earns and this does
   not. Leave-flushes (close, tab hidden, Ctrl-S inside the region) cover the
   ordinary ways an edit is abandoned. */

const PROFILE_CONFLICT_MESSAGE = 'The Writing Profile was changed somewhere else since you opened it, so your '
    + 'edits were not saved. Copy anything you want to keep, then press Reload profile to see the '
    + 'current version — reloading replaces what is in these fields.';

const PROFILE_TOO_LARGE_MESSAGE = 'This profile is too large to save. Shorten the longest fields — 8 KB each, '
    + '32 KB for prose examples.';

/** True while a profile save is in flight. Never gates writing actions. */
let profileSaving = false;

/** @param {HTMLElement} panel */
function profileFieldsOf(panel) {
    return [...panel.querySelectorAll('.sillynovel-profile-field')];
}

/**
 * The profile as the FORM holds it — what is sent, and what is saved.
 *
 * Starts from the saved object so unknown keys a newer client wrote survive
 * the round trip on this side too; the server preserves them regardless.
 *
 * @param {HTMLElement} panel
 */
function readProfileForm(panel) {
    const form = { ...(getProfile()?.data ?? {}) };

    for (const field of profileFieldsOf(panel)) {
        form[field.dataset.field] = field.value;
    }

    return form;
}

/** @param {HTMLElement} panel */
function isProfileDirty(panel) {
    const saved = getProfile()?.data ?? {};

    // A non-string from a hand-edited file compares as '' and is written back
    // as '' on the next save — the form cannot hold anything else.
    return profileFieldsOf(panel).some((field) => field.value !== String(saved[field.dataset.field] ?? ''));
}

/**
 * Paint the textareas from the SAVED profile. Called after resolve, after
 * Reload, and on Discard — never from renderWorkspaceContent, so a chapter
 * switch cannot clobber unsaved edits in a project-scoped document.
 *
 * @param {HTMLElement} panel
 */
function renderProfileForm(panel) {
    const saved = getProfile()?.data ?? {};

    for (const field of profileFieldsOf(panel)) {
        field.value = String(saved[field.dataset.field] ?? '');
    }

    renderProfileStatus(panel);
}

/**
 * @param {HTMLElement} panel
 * @param {string} state
 * @param {string} text
 */
function setProfileStatus(panel, state, text) {
    const status = panel.querySelector('.sillynovel-profile-status');

    if (status) {
        status.dataset.state = state;
        status.textContent = text;
    }
}

/** @param {HTMLElement} panel */
function renderProfileStatus(panel) {
    const save = panel.querySelector('.sillynovel-profile-save');
    const discard = panel.querySelector('.sillynovel-profile-discard');
    const reload = panel.querySelector('.sillynovel-profile-reload');
    const halt = getProfileHalt();
    const dirty = isProfileDirty(panel);

    if (save) {
        save.disabled = profileSaving || halt !== null || !dirty;
    }
    if (discard) {
        discard.disabled = profileSaving || !dirty;
    }
    if (reload) {
        reload.hidden = halt === null;
    }

    if (halt === 'conflict') {
        setProfileStatus(panel, 'conflict', PROFILE_CONFLICT_MESSAGE);
    } else if (profileSaving) {
        setProfileStatus(panel, 'saving', 'Saving…');
    } else if (dirty) {
        setProfileStatus(panel, 'dirty', 'Unsaved changes — press Save profile.');
    } else {
        setProfileStatus(panel, 'idle', getProfile() ? 'Saved on the server.' : '');
    }
}

/** @param {HTMLElement} panel */
function handleProfileChange(panel) {
    renderProfileStatus(panel);
    // The prompt is built from the form, so an edited profile makes a displayed
    // prompt stale exactly as an edited chapter does.
    renderInspectorStale(panel);
}

/**
 * Save the profile now. Returns 'clean', 'dirty' or 'failed', like autoSave.
 *
 * @param {HTMLElement} panel
 */
async function saveProfileNow(panel) {
    if (profileSaving || getProfileHalt() !== null || !isProfileDirty(panel)) {
        return 'clean';
    }

    const data = readProfileForm(panel);
    let outcome = 'failed';
    let failure = null;

    profileSaving = true;
    renderProfileStatus(panel);

    try {
        const result = await saveProfile(data);

        if (result !== null) {
            outcome = panel.isConnected && isProfileDirty(panel) ? 'dirty' : 'clean';
        }
    } catch (error) {
        failure = error;
    } finally {
        profileSaving = false;

        // Live, not captured: after a close and reopen the captured panel is
        // detached and the REOPENED one is the one holding a disabled button.
        const live = document.getElementById('sillynovel-panel');

        if (live) {
            renderProfileStatus(live);

            // A conflict is rendered by the halt above; anything else is a
            // message that stands until the next edit repaints it.
            if (failure && getProfileHalt() === null) {
                setProfileStatus(live, 'error', failure?.status === 413
                    ? PROFILE_TOO_LARGE_MESSAGE
                    : (failure?.message ?? 'The profile could not be saved.'));
            }
        }
    }

    return outcome;
}

/**
 * Fire-and-forget save of a dirty profile as the author leaves. The result is
 * discarded by session.js's generation guard where the workspace has moved on;
 * what matters is that the bytes reach the server.
 *
 * @param {HTMLElement} panel
 */
function flushProfile(panel) {
    if (profileSaving || getProfileHalt() !== null || !isProfileDirty(panel)) {
        return;
    }

    void saveProfile(readProfileForm(panel)).catch(() => {
        // Nothing left to tell.
    });
}

/** @param {HTMLElement} panel */
async function reloadProfileNow(panel) {
    try {
        await reloadProfile();
    } catch (error) {
        if (panel.isConnected) {
            setProfileStatus(panel, 'error', error?.message ?? 'The profile could not be reloaded.');
        }
        return;
    }

    const live = document.getElementById('sillynovel-panel');

    if (live) {
        renderProfileForm(live);
        renderInspectorStale(live);
    }
}

/**
 * Wire the region's controls. Called once per mount, like wireInspector.
 *
 * @param {HTMLElement} panel
 */
function wireProfile(panel) {
    const toggle = panel.querySelector('.sillynovel-profile-toggle');
    const body = panel.querySelector('.sillynovel-profile-body');

    if (toggle && body) {
        // Set explicitly rather than relying on the template's `hidden`
        // surviving DOMPurify, so "collapsed by default" is our guarantee.
        body.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');

        toggle.onclick = () => {
            const open = toggle.getAttribute('aria-expanded') === 'true';
            toggle.setAttribute('aria-expanded', String(!open));
            body.hidden = open;
        };
    }

    for (const field of profileFieldsOf(panel)) {
        field.addEventListener('input', () => { handleProfileChange(panel); });
    }

    const save = panel.querySelector('.sillynovel-profile-save');
    const discard = panel.querySelector('.sillynovel-profile-discard');
    const reload = panel.querySelector('.sillynovel-profile-reload');

    if (save) {
        save.onclick = () => { void saveProfileNow(panel); };
    }
    if (discard) {
        discard.onclick = () => {
            renderProfileForm(panel);
            renderInspectorStale(panel);
        };
    }
    if (reload) {
        reload.onclick = () => { void reloadProfileNow(panel); };
    }
}

/**
 * Wire the notes region. Called once per mount, like wireEditor.
 *
 * The disclosure state is NOT reset on a chapter switch — renderWorkspaceContent
 * repaints the text and never touches `hidden`, so an author who keeps notes
 * open keeps them open, as with the Inspector.
 *
 * @param {HTMLElement} panel
 */
function wireNotes(panel) {
    const toggle = panel.querySelector('.sillynovel-notes-toggle');
    const body = panel.querySelector('.sillynovel-notes-body');
    const editor = notesEditorOf(panel);

    if (toggle && body) {
        // Set explicitly rather than relying on the template's `hidden`
        // surviving DOMPurify, so "collapsed by default" is our guarantee.
        body.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');

        toggle.onclick = () => {
            const open = toggle.getAttribute('aria-expanded') === 'true';
            toggle.setAttribute('aria-expanded', String(!open));
            body.hidden = open;
        };
    }

    if (editor) {
        editor.addEventListener('input', () => { handleNotesChange(panel); });
        editor.addEventListener('blur', () => { void notesSaver.autoSave(panel); });
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

    // Located BEFORE the edit lands, while the selection still describes it.
    editor.addEventListener('beforeinput', (event) => {
        pendingEditStart = editStartFor(event, editor);
    });

    editor.addEventListener('input', () => {
        // An input with no beforeinput ahead of it cannot be located: 0 breaks every anchor.
        pendingEditStart ??= 0;
        applyPendingEdit();
        handleEditorChange(panel);
    });

    editor.addEventListener('blur', () => {
        void autoSave(panel);
    });

    panel.addEventListener('keydown', (event) => {
        const shortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';

        if (!shortcut) {
            return;
        }

        event.preventDefault();

        // The document under the cursor: a shortcut pressed inside the profile
        // saves the profile, and never the chapter it happens to share a panel
        // with.
        if (event.target instanceof Element && event.target.closest('.sillynovel-profile')) {
            void saveProfileNow(panel);
            return;
        }

        // Before the offer check: the offer belongs to the chapter, and a
        // shortcut pressed inside the notes must not be diverted to its banner.
        if (event.target instanceof Element && event.target.closest('.sillynovel-notes')) {
            void notesSaver.autoSave(panel);
            return;
        }

        // Under the halt predicate this would silently no-op, and a writer who
        // presses it believes they have saved. Say what is needed instead — but
        // do NOT perform the accept: a save shortcut should not decide which
        // version of the chapter wins.
        if (getHalt() === 'offer') {
            renderHaltStatus(panel);
            panel.querySelector('.sillynovel-recovery')?.scrollIntoView({ block: 'nearest' });
            return;
        }

        void autoSave(panel);
    });

    panel.querySelector('.sillynovel-recovery-keep')
        ?.addEventListener('click', () => { void keepRecoveredDraft(panel); });
    panel.querySelector('.sillynovel-recovery-discard')
        ?.addEventListener('click', () => { void discardRecoveredDraft(panel); });

    panel.querySelector('.sillynovel-actions')
        ?.addEventListener('click', (event) => {
            const button = event.target instanceof Element
                ? event.target.closest('.sillynovel-action')
                : null;
            const action = button?.dataset.action;

            if (action) {
                void startAction(panel, action);
            }
        });
    panel.querySelector('.sillynovel-cancel')
        ?.addEventListener('click', () => { cancelGeneration(); });

    panel.querySelector('.sillynovel-preflight-confirm')
        ?.addEventListener('click', () => {
            const confirmed = pendingPreflight;

            pendingPreflight = null;
            hidePreflight(panel);

            if (confirmed) {
                if (actionSnapshotIsCurrent(panel, confirmed.target)) {
                    void runGeneration(panel, confirmed.prompt, confirmed.target);
                } else {
                    setActionNote(
                        panel,
                        'error',
                        'The chapter or Writing Profile changed while confirmation was open. Run the action again.',
                    );
                    renderActionBar(panel);
                }
            }
        });

    panel.querySelector('.sillynovel-preflight-cancel')
        ?.addEventListener('click', () => {
            pendingPreflight = null;
            hidePreflight(panel);
            setActionNote(panel, 'idle', '');
            renderActionBar(panel);
        });

    panel.querySelector('.sillynovel-suggestion-actions')
        ?.addEventListener('click', (event) => {
            const button = event.target instanceof Element
                ? event.target.closest('.sillynovel-suggestion-action')
                : null;

            switch (button?.dataset.act) {
                case 'insert':
                    insertSuggestion(panel);
                    break;
                case 'replace':
                    replaceSelection(panel);
                    break;
                case 'add-to-notes':
                    addSuggestionToNotes(panel);
                    break;
                case 'copy':
                    void copySuggestion(panel);
                    break;
                case 'discard':
                    discardSuggestion(panel);
                    break;
                default:
                    break;
            }
        });

    panel.querySelector('.sillynovel-history-previous')
        ?.addEventListener('click', () => { moveSuggestionHistory(panel, -1); });
    panel.querySelector('.sillynovel-history-next')
        ?.addEventListener('click', () => { moveSuggestionHistory(panel, 1); });
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
        void notesSaver.autoSave(panel);
        flushProfile(panel);
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
    cancelScheduledDraft();

    if (!panel) {
        return;
    }

    // Suggestions are panel-session state. The in-flight generation remains in
    // generate.js so a reopened panel cannot start a second paid request.
    suggestion = null;
    suggestionHistory.clear();
    // The anchors belong to that history and to a mounted editor; both go.
    selectionAnchors.clear();
    pendingEditStart = null;
    editorChapterId = null;
    lastSeenText.clear();
    pendingPreflight = null;
    // The rendered prompt is view state too, and it holds a copy of the
    // manuscript. It goes when the panel goes.
    inspection = null;

    // Flush the local copy first and unconditionally. The ~500 ms timer may not
    // have fired for the last keystrokes, and unlike the server save this one
    // still matters when saving is halted. session.js suspends it while an
    // offer is pending.
    recordDraft(editorOf(panel)?.value ?? '');

    // The profile has its own halt and its own dirtiness; a chapter's halt
    // must not stop it from reaching the server.
    flushProfile(panel);

    chapterSaver.flushOnClose(panel);
    // No recordDraft on this path: notes have no recovery copy by design.
    notesSaver.flushOnClose(panel);
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

        wireInspector(panel);
        wireProfile(panel);
        renderProfileForm(panel);
        wireEditor(panel);
        wireNotes(panel);

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
