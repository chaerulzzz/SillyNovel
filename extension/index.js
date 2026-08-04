/**
 * SillyNovel — Writing Workspace (SillyTavern UI extension)
 *
 * STATUS: scaffold only. No workspace UI is registered yet — see docs/PLAN.md
 * Phase 2. This file currently does nothing beyond confirming the extension
 * loads, which is what Phase 1.5's smoke test needs.
 *
 * RULES (see AGENTS.md):
 *  - Use the stable context API via getContext(). Never import ST internals.
 *  - Generated prose is NEVER auto-inserted into a draft.
 */

const EXTENSION_NAME = 'sillynovel-writing';

/**
 * Phase 1.5 API compatibility smoke test.
 *
 * Reports which context APIs this build of SillyTavern actually exposes, so an
 * upstream upgrade fails loudly instead of degrading silently. `generateRaw`
 * and `getTokenCountAsync` are required; `getWorldInfoPrompt` is exposed but
 * NOT documented in the public extension guide, so it is treated as
 * semi-private and must stay covered here.
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

    console.log(`[${EXTENSION_NAME}] loaded (scaffold)`, probe);
});

export { probeContextApis };
