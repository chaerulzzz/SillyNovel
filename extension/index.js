/**
 * SillyNovel — Writing Workspace (SillyTavern UI extension)
 *
 * Registers a launcher in SillyTavern's wand (extensions) menu that opens the
 * docked writing workspace, and runs the compatibility canary below on load.
 *
 * RULES (see AGENTS.md):
 *  - Use the stable context API via getContext(). Never import ST internals.
 *  - Generated prose is NEVER auto-inserted into a draft.
 */

import { openPanel } from './lib/panel.js';

const EXTENSION_NAME = 'sillynovel-writing';

/**
 * PERMANENT compatibility canary — do NOT delete.
 *
 * This originated as a Phase 1.5 probe, and AGENTS.md rule 10 says spike and
 * probe code gets deleted rather than flag-gated. This function is the
 * deliberate exception, decided at the close of Phase 1.5 (docs/PROGRESS.md):
 * the *behavioral* spike checks were deleted, and this existence-only check
 * was kept. It mounts no endpoint and performs no network, filesystem, or
 * model I/O — it reads typeof off the context object and writes one line to
 * the console, so its cost is negligible.
 *
 * It earns its place by failing loudly. SillyTavern is pinned by digest, and
 * an upgrade that silently drops a context API would otherwise surface as a
 * confusing runtime error deep inside a generation. `getWorldInfoPrompt` in
 * particular is exposed but NOT in the public extension guide — semi-private,
 * so it must stay covered here even though project-attached World Info uses
 * the manual keyword scan rather than calling it (ARCHITECTURE.md §4).
 *
 * Phase 2 builds the workspace UI around this, not in place of it.
 *
 * @param {object} context result of SillyTavern.getContext()
 * @returns {{required: object, semiPrivate: object, missing: string[]}}
 */
function probeContextApis(context) {
    const required = ['generateRaw', 'getTokenCountAsync', 'getTokenizerModel', 'stopGeneration'];
    const semiPrivate = ['getWorldInfoPrompt'];

    const check = (names) => Object.fromEntries(
        names.map((name) => [name, typeof context?.[name] === 'function']),
    );

    const requiredResults = check(required);
    const semiPrivateResults = check(semiPrivate);

    const missing = [...required, ...semiPrivate]
        .filter((name) => typeof context?.[name] !== 'function');

    return { required: requiredResults, semiPrivate: semiPrivateResults, missing };
}

/**
 * Add the workspace launcher to SillyTavern's wand menu.
 *
 * The lookup mirrors the built-in `gallery` extension: resolve #extensionsMenu
 * by id and bail loudly if it is absent, rather than assuming it exists. The
 * menu is created dynamically (extensions.js renders the `wandMenu` template
 * and appends it to <body>), and although initExtensions() completes before
 * third-party scripts are injected, the defensive check costs nothing.
 *
 * Keyboard handling is deliberately NOT hand-rolled. ST registers
 * `#extensionsMenu div:has(.extensionsMenuExtensionButton)` as an interactable,
 * observes nodes added after init, assigns tabindex, and turns Enter into a
 * real click() — so this markup gets focus and Enter-activation for free.
 * Going through a real click also matters: that is what bubbles to ST's own
 * handler and closes the wand dropdown. A custom keydown calling openPanel()
 * directly would leave the menu floating open above the workspace.
 *
 * @returns {boolean} whether the launcher was added
 */
function addWorkspaceLauncher() {
    const menu = document.getElementById('extensionsMenu');

    if (!(menu instanceof HTMLElement)) {
        console.warn(`[${EXTENSION_NAME}] #extensionsMenu not found; no workspace launcher registered`);
        return false;
    }

    const item = document.createElement('div');
    item.id = 'sillynovel_wand_button';
    item.classList.add('list-group-item', 'flex-container', 'flexGap5');

    const icon = document.createElement('div');
    icon.classList.add('fa-solid', 'fa-feather-pointed', 'extensionsMenuExtensionButton');

    const label = document.createElement('span');
    label.textContent = 'SillyNovel Workspace';

    item.append(icon, label);
    item.addEventListener('click', () => {
        openPanel();
    });

    menu.append(item);
    return true;
}

jQuery(async () => {
    const context = SillyTavern.getContext();
    const probe = probeContextApis(context);

    if (probe.missing.length > 0) {
        console.warn(`[${EXTENSION_NAME}] missing context APIs:`, probe.missing);
    }

    addWorkspaceLauncher();

    console.log(`[${EXTENSION_NAME}] loaded`, probe);
});

export { probeContextApis, addWorkspaceLauncher };
