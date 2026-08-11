/**
 * SillyNovel — Writing Workspace (SillyTavern UI extension)
 *
 * STATUS: no workspace UI is registered yet — that is Phase 2 (docs/PLAN.md).
 * What this file does today is run the compatibility canary below on load.
 *
 * RULES (see AGENTS.md):
 *  - Use the stable context API via getContext(). Never import ST internals.
 *  - Generated prose is NEVER auto-inserted into a draft.
 */

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

jQuery(async () => {
    const context = SillyTavern.getContext();
    const probe = probeContextApis(context);

    if (probe.missing.length > 0) {
        console.warn(`[${EXTENSION_NAME}] missing context APIs:`, probe.missing);
    }

    console.log(`[${EXTENSION_NAME}] loaded`, probe);
});

export { probeContextApis };
