/**
 * SillyNovel — the docked workspace panel (Phase 2, checkpoint 3).
 *
 * Shell only: a launcher target, a panel that docks/maximizes/closes, and the
 * body classes that extension/style.css keys its SillyTavern coexistence rules
 * off. No editor, no storage calls — those arrive in checkpoints 4-9.
 *
 * RULES (see AGENTS.md):
 *  - Use the stable context API via getContext(). Never import ST internals.
 */

import { getSettings, resetWorkspace } from './session.js';
import { renderWorkspace } from './view.js';

const EXTENSION_NAME = 'sillynovel-writing';

/**
 * First argument to renderExtensionTemplateAsync. It performs a literal
 * substitution into `scripts/extensions/${extensionName}/${templateId}.html`
 * (extensions.js), with no automatic `third-party/` prefixing — so the segment
 * has to be spelled out here to match our actual mount path.
 */
const TEMPLATE_SCOPE = `third-party/${EXTENSION_NAME}`;
const TEMPLATE_ID = 'templates/workspace';

const PANEL_ID = 'sillynovel-panel';
const BODY_OPEN_CLASS = 'sillynovel-panel-open';
const BODY_MAXIMIZED_CLASS = 'sillynovel-panel-maximized';

/**
 * The panel node, or null when closed.
 *
 * The panel is DESTROYED on close rather than hidden. `.sillynovel-panel` is
 * unconditionally `display: flex`, so a retained-but-closed node would stay
 * visible while openPanel() short-circuits on it. Destroying it also makes
 * "starts closed on every page load" true without extra work.
 *
 * @type {HTMLElement|null}
 */
let panelEl = null;

/**
 * The in-flight open, or null. Template rendering is async, so a double click
 * must not build two panels — every concurrent caller awaits this same promise.
 * @type {Promise<HTMLElement|null>|null}
 */
let openInFlight = null;

/**
 * Point the maximize control at whichever action is currently available.
 *
 * @param {HTMLElement} panel
 * @param {boolean} isMaximized
 */
function syncMaximizeButton(panel, isMaximized) {
    const button = panel.querySelector('.sillynovel-panel-maximize');
    const icon = button?.querySelector('i');

    if (!button || !icon) {
        return;
    }

    const label = isMaximized ? 'Restore workspace to docked' : 'Maximize workspace';
    icon.className = `fa-solid fa-fw ${isMaximized ? 'fa-compress' : 'fa-expand'}`;
    button.setAttribute('aria-label', label);
    button.title = label;
}

/**
 * @param {string} label
 * @param {string} iconClasses
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function buildHeaderButton(label, iconClasses, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;

    const icon = document.createElement('i');
    icon.className = iconClasses;
    button.append(icon);
    button.addEventListener('click', onClick);

    return button;
}

/**
 * @param {string} bodyHtml already sanitized by renderExtensionTemplateAsync
 * @param {boolean} isMaximized
 * @returns {HTMLElement}
 */
function buildPanel(bodyHtml, isMaximized) {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'sillynovel-panel';
    // Focusable programmatically but not in the tab order: the panel is a
    // docked region, not a modal, so it neither traps focus nor sits between
    // ST's own controls when tabbing.
    panel.tabIndex = -1;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'SillyNovel writing workspace');

    const header = document.createElement('div');
    header.className = 'sillynovel-panel-header';

    const title = document.createElement('h3');
    title.className = 'sillynovel-panel-title';
    title.textContent = 'SillyNovel';

    const maximizeButton = buildHeaderButton('Maximize workspace', 'fa-solid fa-fw fa-expand', toggleMaximize);
    maximizeButton.classList.add('sillynovel-panel-maximize');

    const closeButton = buildHeaderButton('Close workspace', 'fa-solid fa-fw fa-xmark', closePanel);
    closeButton.classList.add('sillynovel-panel-close');

    header.append(title, maximizeButton, closeButton);

    const body = document.createElement('div');
    body.className = 'sillynovel-panel-body';
    body.innerHTML = bodyHtml;

    panel.append(header, body);
    syncMaximizeButton(panel, isMaximized);

    return panel;
}

/**
 * Send focus somewhere sensible after the panel closes.
 *
 * NOT to our launcher item: activating it closed the whole wand dropdown.
 * ST binds a click handler on `html` (extensions.js) that fades #extensionsMenu
 * out unless the click landed inside #sd_gen, #extensionsMenuButton or
 * #roll_dice, and our item is none of those — so by now it lives inside a
 * `display: none` container and cannot take focus.
 *
 * The wand button is where the user launched from, and ST already makes it
 * focusable: it carries the `interactable` class, and ST's keyboard module
 * gives every interactable a tabindex.
 */
function restoreFocus() {
    const wandButton = document.getElementById('extensionsMenuButton');

    if (wandButton instanceof HTMLElement && wandButton.isConnected && wandButton.offsetParent !== null) {
        wandButton.focus();
        return;
    }

    // Nothing visible to return to (the wand button lives inside #sheld, which
    // may still be settling). Drop focus rather than leaving it on a node we
    // are about to remove.
    if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
    }
}

/**
 * Render the template, then mount. The order is load-bearing: nothing touches
 * the DOM or the body classes until the render has resolved, so a template
 * that fails to resolve can never leave SillyTavern shrunk with no way back.
 *
 * @returns {Promise<HTMLElement>}
 */
async function renderAndMount() {
    const context = SillyTavern.getContext();
    const bodyHtml = await context.renderExtensionTemplateAsync(TEMPLATE_SCOPE, TEMPLATE_ID);

    // renderTemplateAsync does NOT reject when a template is missing or fails
    // to compile: it logs, raises its own toast, and resolves with undefined
    // (public/scripts/templates.js). Awaiting it is therefore not enough — a
    // bad template path would mount a blank panel and shrink SillyTavern with
    // no explanation. Turn that silent resolution back into a failure so the
    // caller's rollback runs and ST's layout is left untouched.
    if (typeof bodyHtml !== 'string' || bodyHtml.trim() === '') {
        throw new Error(`template "${TEMPLATE_SCOPE}/${TEMPLATE_ID}" rendered no content`);
    }

    // Defensive: never end up with two panels if a stale node survived.
    document.getElementById(PANEL_ID)?.remove();

    const isMaximized = getSettings().panelMaximized === true;
    const panel = buildPanel(bodyHtml, isMaximized);

    document.body.append(panel);
    panelEl = panel;

    document.body.classList.add(BODY_OPEN_CLASS);
    if (isMaximized) {
        document.body.classList.add(BODY_MAXIMIZED_CLASS);
    }

    panel.focus();

    // Deliberately NOT awaited. Resolution must never gate the panel appearing:
    // if it did, a slow or failed request would leave SillyTavern shrunk with no
    // close control — the same failure the template guard above prevents,
    // arriving by a different route.
    renderWorkspace(panel);

    return panel;
}

/**
 * Open the workspace, or focus it if it is already open.
 * @returns {Promise<HTMLElement|null>} null if the panel could not be opened
 */
export function openPanel() {
    if (openInFlight) {
        return openInFlight;
    }

    if (panelEl) {
        panelEl.focus();
        return Promise.resolve(panelEl);
    }

    openInFlight = renderAndMount()
        .catch((error) => {
            console.error(`[${EXTENSION_NAME}] could not open the workspace panel`, error);

            if (typeof toastr !== 'undefined') {
                toastr.error('SillyNovel could not open the workspace. See the browser console.');
            }

            // Undo any partial mount. The body classes are only added after a
            // successful render, so normally there is nothing to remove here.
            document.getElementById(PANEL_ID)?.remove();
            panelEl = null;
            document.body.classList.remove(BODY_OPEN_CLASS, BODY_MAXIMIZED_CLASS);

            return null;
        })
        .finally(() => {
            openInFlight = null;
        });

    return openInFlight;
}

/** Close the workspace and give SillyTavern its layout back. */
export function closePanel() {
    if (!panelEl) {
        return;
    }

    // Order matters: drop the body classes FIRST so ST's chrome — including
    // #sheld, which contains the wand button — is rendered again before
    // restoreFocus() tries to move focus into it. This is what makes closing
    // from the maximized state land somewhere visible.
    document.body.classList.remove(BODY_OPEN_CLASS, BODY_MAXIMIZED_CLASS);

    panelEl.remove();
    panelEl = null;

    // Every open re-resolves against the server rather than trusting a snapshot
    // taken before the panel was last closed.
    resetWorkspace();

    restoreFocus();
}

/**
 * Toggle docked/maximized. The mode is a UI preference and is remembered;
 * whether the panel is open is deliberately not.
 */
export function toggleMaximize() {
    if (!panelEl) {
        return;
    }

    const context = SillyTavern.getContext();
    const isMaximized = document.body.classList.toggle(BODY_MAXIMIZED_CLASS);

    getSettings().panelMaximized = isMaximized;
    context.saveSettingsDebounced();

    syncMaximizeButton(panelEl, isMaximized);
}

/** @returns {boolean} whether the workspace is currently mounted */
export function isPanelOpen() {
    return panelEl !== null;
}
