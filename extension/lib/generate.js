/**
 * SillyNovel — prompt assembly, the context budget, and the single model call
 * used by every writing action.
 *
 * Split from view.js so that module stays about the DOM: this one owns what is
 * sent to the model and what comes back. Checkpoint 9's Context Inspector
 * renders exactly what buildPrompt() returns, which is why assembly stays out
 * of the DOM layer.
 *
 * RULES (see AGENTS.md):
 *  - Generated prose is NEVER auto-inserted into a draft. Nothing here touches
 *    the editor; runAction() returns text and the author decides.
 *  - Established state and writing instruction are separate LABELED blocks
 *    (ARCHITECTURE.md §3), never merged into one prose blob.
 *  - Cost preflight before a large operation (rule 6) — buildPrompt
 *    reports the numbers, view.js gates the send on them.
 *
 * Everything below about SillyTavern's behaviour was read from the pinned image
 * (public/script.js, public/scripts/openai.js), not assumed. Line references are
 * to that pinned source and are the first thing to re-check after an upgrade.
 */

const EXTENSION_NAME = 'sillynovel-writing';

/**
 * ARCHITECTURE.md §3's blocks. The LABELS are fixed — separating established
 * state from writing instruction is the whole point of §3 — but the ORDER is
 * explicitly a tunable, so this list must not be read as pinning it.
 *
 * Blocks without data stay listed because §5 requires an inclusion or
 * exclusion reason for every one.
 */
export const PROMPT_BLOCKS = [
    'WRITING PROFILE',
    'ESTABLISHED STORY STATE',
    'LORE',
    'EARLIER CHAPTERS',
    'MANUSCRIPT',
    'SELECTION',
    'CURRENT WRITING INSTRUCTION',
    'OUTPUT CONTRACT',
];

/** Blocks Phase 2 cannot fill yet, and why. Rendered by checkpoint 9. */
const DEFERRED_BLOCKS = {
    'ESTABLISHED STORY STATE': 'not implemented until Phase 4',
    LORE: 'not implemented until Phase 4',
    'EARLIER CHAPTERS': 'not implemented until Phase 3',
};

/**
 * The Writing Profile's fields, in the order they are rendered into the
 * `[WRITING PROFILE]` block and laid out in the editor — one table for both, so
 * the form and the prompt cannot disagree about what a field is called.
 */
export const PROFILE_FIELDS = [
    { key: 'voice', label: 'Voice' },
    { key: 'genre', label: 'Genre' },
    { key: 'pov', label: 'Point of view' },
    { key: 'tense', label: 'Tense' },
    { key: 'styleInstructions', label: 'Style instructions' },
    { key: 'proseExamples', label: 'Prose examples' },
    { key: 'boundaries', label: 'Boundaries' },
];

/**
 * The profile as prose-facing text: only the fields that say something, each
 * labelled, single-line values inline and multi-line ones on their own lines.
 * Returns '' when every field is blank, which is what excludes the block.
 *
 * @param {object|null} profile
 */
export function renderProfileText(profile) {
    if (!profile || typeof profile !== 'object') {
        return '';
    }

    const parts = [];

    for (const { key, label } of PROFILE_FIELDS) {
        const value = typeof profile[key] === 'string' ? profile[key].trim() : '';

        if (!value) {
            continue;
        }

        parts.push(value.includes('\n') || key === 'proseExamples'
            ? `${label}:\n${value}`
            : `${label}: ${value}`);
    }

    return parts.join('\n\n');
}

/** One table drives assembly, progress text, result controls and validation. */
export const ACTIONS = Object.freeze({
    continue: {
        label: 'Continue',
        progress: 'Generating…',
        resultKind: 'prose',
        needsSelection: false,
        instruction: 'Continue this chapter from exactly where it stops, in the same voice, tense and point of view. Write the next passage only.',
        contract: 'Reply with the continuation prose only. No preamble, no commentary, no headings, no quotation marks around the whole reply, and no restatement of what came before. Begin exactly where the manuscript stops.',
    },
    rewrite: {
        label: 'Rewrite selection',
        progress: 'Rewriting…',
        resultKind: 'prose',
        needsSelection: true,
        instruction: 'Rewrite the passage in [SELECTION] in the same voice, tense and point of view, keeping its meaning and its place in the chapter. The manuscript is context only.',
        contract: 'Reply with the replacement passage only. No preamble, no commentary, no headings, no quotation marks around the whole reply, and nothing from outside the selection.',
    },
    expand: {
        label: 'Expand selection',
        progress: 'Expanding…',
        resultKind: 'prose',
        needsSelection: true,
        instruction: 'Expand the passage in [SELECTION] with more detail, sensation and narrative beats, in the same voice, tense and point of view. It replaces the selection. The manuscript is context only.',
        contract: 'Reply with the expanded passage only. No preamble, no commentary, no headings, and no quotation marks around the whole reply.',
    },
    summarize: {
        label: 'Summarize',
        progress: 'Summarizing…',
        resultKind: 'notes',
        needsSelection: false,
        instruction: 'Summarize what happens in this chapter so far: events, who is present, and what changed. These are working notes for the author, not manuscript.',
        contract: 'Reply with clearly labeled notes only: short paragraphs or bullet points. No prose continuation and no preamble.',
    },
    brainstorm: {
        label: 'Brainstorm',
        progress: 'Brainstorming…',
        resultKind: 'notes',
        needsSelection: false,
        instruction: 'Brainstorm where this chapter could go next: several distinct directions, each in a sentence or two, with what it would cost or risk. These are working notes for the author, not manuscript.',
        contract: 'Reply with clearly labeled options only, one per bullet. No prose continuation and no preamble.',
    },
});

/**
 * Headroom above everything we counted.
 *
 * ⚠️ This is NOT slack for the framing blocks — those are counted for real and
 * subtracted from the allowance. It covers the two things that cannot be
 * counted here:
 *
 *  1. substituteParams() runs INSIDE generateRaw (createRawPrompt,
 *     script.js:3865-3892), i.e. AFTER we count, and a macro can expand.
 *  2. The provider bills the chat envelope — role wrappers and per-message
 *     overhead — which no per-block count sees.
 *
 * ~0.4% of a 64k context.
 */
const MARGIN_TOKENS = 256;

/**
 * Cost preflight threshold (AGENTS.md rule 6, ARCHITECTURE.md §7): above this
 * many ASSEMBLED input tokens, the click shows the numbers and waits.
 *
 * ⚠️ Deliberately measured on input size ALONE, not on "did we have to trim".
 * They are different questions: on a small context a trim can fire at 2,000
 * tokens (cheap), and on a large context an 8,000-token chapter sends without
 * ever being trimmed (not cheap). Tying the preflight to trimming leaves a hole
 * on both sides.
 *
 * §7 calls the threshold configurable; it becomes so when Phase 3 adds a
 * settings surface — extension_settings.sillynovel is the right home for it,
 * being a UI preference (§9).
 */
const PREFLIGHT_TOKENS = 8000;

/**
 * Reply reserve assumed on backends PLAN.md:440 does not claim to support.
 * getContext() exposes no equivalent of amount_gen, and guessing low here would
 * overfill the context rather than underfill it.
 */
const FALLBACK_RESERVE_TOKENS = 512;

/**
 * The reply reserve SillyNovel raises a too-small setting to, and the share of
 * the context it will never exceed doing so (ARCHITECTURE.md §5.1).
 *
 * The floor: `deepseek-flash` spends ~2,300 tokens reasoning before its first
 * word (2,295 and 2,059 across two live runs), then ~300 on prose, and
 * SillyTavern ships a 300-token reply budget — so on stock settings every author
 * on a reasoning model fails their first Continue outright. 4,000 is the same
 * figure the NO_MESSAGE advice has always named.
 *
 * The cap is load-bearing: ST's default context is 4k, and reserving 4,000
 * there would trip the pre-count guard and trade one total failure for another.
 * Half the context (less the margin) is the most the reply may take, so the cap
 * reaches the full floor only from ~8,256 tokens of context. Below that
 * NO_MESSAGE remains the author's signal, and its wording says which lever is
 * left — see classify().
 */
const REPLY_FLOOR_TOKENS = 4000;
const RESERVE_CAP_FRACTION = 0.5;

export const GenerateErrorKind = {
    /** No manuscript, or a selection action without a selection. */
    EMPTY: 'empty',
    /** The context cannot hold the prompt. Never sent. */
    BUDGET: 'budget',
    /**
     * generateRaw threw "No message generated" (script.js:4087-4088) — the
     * reply was empty after cleanup. PLAN.md:389 requires this be its own
     * actionable state, not a generic failure.
     */
    NO_MESSAGE: 'no-message',
    /** Stopped — by our Cancel, by ST's own stop button, or by an extension. */
    CANCELLED: 'cancelled',
    /** Anything else. */
    FAILED: 'failed',
};

export class GenerateError extends Error {
    /**
     * @param {string} kind one of GenerateErrorKind
     * @param {string} message author-facing text
     * @param {{cause?: Error|null, budget?: object|null}} [options] `budget`
     *   carries the figures known at the moment a BUDGET refusal was thrown, so
     *   the Inspector can show the arithmetic that failed rather than only the
     *   sentence. A null field means "not reached before the refusal" — which
     *   is itself the report that the tokenizer never ran — and not zero.
     */
    constructor(kind, message, { cause = null, budget = null } = {}) {
        super(message);
        this.name = 'GenerateError';
        this.kind = kind;
        this.cause = cause;
        this.budget = budget;
    }
}

/**
 * The in-flight generation, or null.
 *
 * ⚠️ Module state, and DELIBERATELY not cleared when the panel closes. Closing
 * does not cancel the request (stopGeneration is global — see
 * cancelGeneration), so a request outlives the panel. If teardown cleared this,
 * a reopened panel would show a live action button over a generation that is
 * still costing money, and one click would buy a second one. There is no
 * resetGeneration() export for exactly that reason: it is the function a
 * teardown path would reach for.
 *
 * @type {{promise: Promise<string>, action: string, chapterId: string, chapterTitle: string, generation: number}|null}
 */
let active = null;

/** @returns {{action: string, chapterId: string, chapterTitle: string, generation: number}|null} */
export function getActiveGeneration() {
    if (!active) {
        return null;
    }

    return {
        action: active.action,
        chapterId: active.chapterId,
        chapterTitle: active.chapterTitle,
        generation: active.generation,
    };
}

/**
 * Stop the running generation.
 *
 * ⚠️ stopGeneration() is GLOBAL (script.js:5548): it aborts SillyTavern's own
 * chat generation, hides ST's stop button, and emits GENERATION_STOPPED, which
 * every in-flight generateRaw — ours and any other extension's — is subscribed
 * to. It is the only cancel available to us, which is why it is wired to an
 * explicit button press and never fired implicitly on panel close.
 *
 * @returns {boolean} whether anything was running
 */
export function cancelGeneration() {
    if (!active) {
        return false;
    }

    SillyTavern.getContext().stopGeneration();
    return true;
}

/** @param {string} text */
async function countTokens(text) {
    if (!text) {
        return 0;
    }

    return await SillyTavern.getContext().getTokenCountAsync(text);
}

/**
 * The context window and the reply reserve, both from the SAME object.
 *
 * st-context.js:226 exposes `chatCompletionSettings`, which IS `oai_settings` —
 * the object createGenerationParameters reads samplers from. `maxContext`
 * (:133) is the TEXT-completion `max_context`; budgeting against it under a
 * chat-completion provider would reserve against a number nothing in the
 * request path reads.
 *
 * ⚠️ Both are snapshots taken when getContext() is called, so it is called
 * fresh here on every click and never cached across one.
 */
function readBudget() {
    const context = SillyTavern.getContext();

    if (context.mainApi === 'openai') {
        const settings = context.chatCompletionSettings ?? {};

        return resolveReserve({
            api: 'openai',
            contextTokens: Number(settings.openai_max_context) || 0,
            reserveTokens: Number(settings.openai_max_tokens) || 0,
            reserveSource: 'provider',
        });
    }

    return resolveReserve({
        api: context.mainApi,
        contextTokens: Number(context.maxContext) || 0,
        reserveTokens: FALLBACK_RESERVE_TOKENS,
        reserveSource: 'fallback',
    });
}

/**
 * The conditional floor (ARCHITECTURE.md §5.1), applied INSIDE readBudget so
 * every consumer — the pre-count guard, the allowance, the refusal figures, the
 * preflight, the options handed to generateRaw — reads one resolved number.
 * The number passed and the number reserved must be the same, and resolving
 * here is what makes that true by construction rather than by discipline.
 *
 * Scoped to chat completion. On every other backend TempResponseLength writes
 * `amount_gen` (script.js:4112-4113) — the author's own generation-length dial —
 * and the reserve there is our 512-token guess against `maxContext`, on a path
 * where no reasoning floor was ever measured. We leave it alone.
 *
 * `reserveSource` is the single source of truth for whether the reserve was
 * raised: runAction passes `responseLength` iff it reads
 * 'raised-by-sillynovel'. There is deliberately no parallel boolean — one bit in
 * two places can drift, and the Inspector already renders this field.
 *
 * `authorReserveTokens` is what was actually read, kept so the Inspector can say
 * "raised from 300 to 1,920" rather than only the resolved figure.
 *
 * @param {{api: string, contextTokens: number, reserveTokens: number, reserveSource: string}} read
 */
function resolveReserve(read) {
    const keep = { ...read, authorReserveTokens: read.reserveTokens };

    if (read.api !== 'openai' || read.reserveTokens >= REPLY_FLOOR_TOKENS) {
        return keep;
    }

    const cap = Math.floor((read.contextTokens - MARGIN_TOKENS) * RESERVE_CAP_FRACTION);
    const reserve = Math.min(REPLY_FLOOR_TOKENS, cap);

    // A context too small for the cap to improve on the author's own setting
    // (including one so small the cap is non-positive) keeps their setting; the
    // pre-count guard then refuses with their figures, not ours.
    if (reserve <= read.reserveTokens) {
        return keep;
    }

    return { ...keep, reserveTokens: reserve, reserveSource: 'raised-by-sillynovel' };
}

/**
 * The figures a BUDGET refusal carries, as a deliberate ALLOWLIST.
 *
 * ⚠️ AGENTS.md rule 13. Never spread `budget` or `chatCompletionSettings`
 * into this: the settings object IS `oai_settings` and sits beside provider
 * credentials. Four numbers and a source label cannot become a key dump.
 *
 * @param {object} budget a readBudget() result
 * @param {number|null} framingTokens null when nothing had been counted yet
 * @param {number|null} allowanceTokens null when the refusal came first
 */
function refusalFigures(
    budget,
    framingTokens,
    allowanceTokens,
    profileTokens = null,
    selectionTokens = null,
    action = null,
) {
    return {
        action,
        profileTokens,
        selectionTokens,
        contextTokens: budget.contextTokens,
        reserveTokens: budget.reserveTokens,
        authorReserveTokens: budget.authorReserveTokens,
        reserveSource: budget.reserveSource,
        marginTokens: MARGIN_TOKENS,
        framingTokens,
        allowanceTokens,
    };
}

/** Render one labeled block the way it is sent. */
function renderBlock(label, content) {
    return `[${label}]\n${content}`;
}

/**
 * The last `targetChars` characters, moved FORWARD to a paragraph boundary.
 *
 * ⚠️ Forward only. Snapping backward would make the tail LONGER than the
 * budget just measured, which is the one thing the trim loop must never do.
 *
 * If the next boundary is so far ahead that snapping would throw away most of
 * the intended tail — a long final paragraph — the raw cut is kept instead.
 * Losing a quarter of the allowance to tidiness is a worse trade than starting
 * mid-paragraph, and §5 wants the most recent manuscript window preserved.
 *
 * @param {string} text
 * @param {number} targetChars
 */
function tailFrom(text, targetChars) {
    const want = Math.max(1, Math.floor(targetChars));
    const start = text.length - want;

    if (start <= 0) {
        return text;
    }

    const boundary = text.indexOf('\n\n', start);

    if (boundary === -1 || boundary - start > want * 0.25) {
        return text.slice(start);
    }

    return text.slice(boundary + 2);
}

/**
 * Fit the manuscript into `allowance`, bounded at FOUR counting calls with a
 * defined ending.
 *
 * ⚠️ "Close enough, send it" busts the allowance and "keep shrinking" busts the
 * bound, so neither is available. The last step is an UNSNAPPED cut — a single
 * enormous paragraph is exactly what defeats the snapped steps, and it must
 * still be servable — and if even that does not fit, the caller refuses rather
 * than sending an over-budget prompt.
 *
 * @param {string} manuscript
 * @param {number} allowance
 * @returns {Promise<{text: string, tokens: number, trimmed: boolean}|null>}
 */
async function fitManuscript(manuscript, allowance) {
    const full = await countTokens(manuscript);

    if (full <= allowance) {
        return { text: manuscript, tokens: full, trimmed: false };
    }

    // chars-per-token measured on this document, not a generic estimate.
    let minRatio = manuscript.length / full;

    let text = tailFrom(manuscript, allowance * minRatio * 0.9);
    let tokens = await countTokens(text);

    if (tokens <= allowance) {
        return { text, tokens, trimmed: true };
    }

    // Re-scale using the ratio just measured ON THE TAIL, which is a closer
    // description of the text actually being sent than the whole document is.
    minRatio = Math.min(minRatio, text.length / tokens);
    text = tailFrom(manuscript, text.length * (allowance / tokens) * 0.9);
    tokens = await countTokens(text);

    if (tokens <= allowance) {
        return { text, tokens, trimmed: true };
    }

    minRatio = Math.min(minRatio, text.length / tokens);
    text = manuscript.slice(-Math.max(1, Math.floor(allowance * minRatio * 0.8)));
    tokens = await countTokens(text);

    if (tokens <= allowance) {
        return { text, tokens, trimmed: true };
    }

    return null;
}

/** Rough, and labeled as such wherever it is shown. */
function countWords(text) {
    const words = text.trim().match(/\S+/g);
    return words ? words.length : 0;
}

/**
 * Assemble one action prompt and report what it costs.
 *
 * Pure apart from token counting: it reads settings and counts, and touches no
 * module state. Checkpoint 9's Inspector calls it without generating.
 *
 * The four budget figures are a deliberate ALLOWLIST for the Inspector
 * (AGENTS.md rule 13), not a settings dump. They are returned rather than
 * recomputed by the caller because readBudget()'s values are snapshots: a
 * recompute after the build would read a DIFFERENT snapshot, and showing
 * numbers that did not produce the displayed prompt is the Inspector's worst
 * failure mode.
 *
 * @param {string} action an ACTIONS key
 * @param {{manuscript?: string, selection?: string, profile?: object|null}} [input]
 *   live form values, not saved copies
 * @returns {Promise<{messages: Array<{role: string, content: string}>,
 *   blocks: Array<object>, action: string, inputTokens: number,
 *   framingTokens: number, profileTokens: number, profileText: string,
 *   selectionTokens: number, selectionText: string, selectionWords: number,
 *   reserveTokens: number, authorReserveTokens: number, reserveSource: string,
 *   contextTokens: number, allowanceTokens: number, marginTokens: number,
 *   trimmed: boolean, sentWords: number, totalWords: number}>}
 */
export async function buildPrompt(action, { manuscript = '', selection = '', profile = null } = {}) {
    const config = ACTIONS[action];

    if (!config) {
        throw new TypeError(`Unknown writing action: ${action}`);
    }

    const text = typeof manuscript === 'string' ? manuscript : '';
    const selectionText = config.needsSelection && typeof selection === 'string' ? selection : '';

    if (text.trim() === '') {
        throw new GenerateError(
            GenerateErrorKind.EMPTY,
            'There is no manuscript yet. Write a line or two first.',
        );
    }

    if (config.needsSelection && selectionText.trim() === '') {
        throw new GenerateError(
            GenerateErrorKind.EMPTY,
            `Select a passage to ${action} first.`,
        );
    }

    const budget = readBudget();

    // ⚠️ Checked BEFORE anything is counted. When the reply reserve alone
    // exhausts the context there is no arrangement of blocks that fits, so
    // counting first would spend a tokenizer round trip to learn something
    // already known from two numbers.
    if (budget.contextTokens - budget.reserveTokens - MARGIN_TOKENS <= 0) {
        throw new GenerateError(
            GenerateErrorKind.BUDGET,
            `There is no room to send this chapter: the reply reserve (${budget.reserveTokens} tokens) `
            + `leaves nothing inside the context size (${budget.contextTokens} tokens). `
            + 'Lower the response length or raise the context size in your API settings.',
            { budget: refusalFigures(budget, null, null, null, config.needsSelection ? null : 0, action) },
        );
    }

    const instructionBlock = renderBlock('CURRENT WRITING INSTRUCTION', config.instruction);
    const contractBlock = renderBlock('OUTPUT CONTRACT', config.contract);

    // ⚠️ Counted, not absorbed by MARGIN_TOKENS. These blocks are
    // "included — never dropped", so they come off the top of the allowance;
    // and the figure shown to the author has to be the assembled total, or it
    // understates the request by every token of framing — a gap that widens
    // with every block Phases 3-4 add.
    const framingTokens = await countTokens(
        `${instructionBlock}\n\n${contractBlock}\n\n${renderBlock('MANUSCRIPT', '')}`,
    );

    const profileText = renderProfileText(profile);
    const profileBlock = profileText ? renderBlock('WRITING PROFILE', profileText) : '';
    const profileTokens = profileText ? await countTokens(profileBlock) : 0;
    const selectionBlock = selectionText ? renderBlock('SELECTION', selectionText) : '';
    const selectionTokens = selectionBlock ? await countTokens(selectionBlock) : 0;

    const allowance = budget.contextTokens - budget.reserveTokens - framingTokens
        - profileTokens - selectionTokens - MARGIN_TOKENS;

    if (allowance <= 0) {
        const profileToBlame = profileTokens > 0 && allowance + profileTokens > 0;
        const selectionToBlame = selectionTokens > 0 && allowance + selectionTokens > 0;
        const namedCosts = [
            ...(profileToBlame ? [`the Writing Profile (${profileTokens} tokens)`] : []),
            ...(selectionToBlame ? [`the selected passage (${selectionTokens} tokens)`] : []),
        ];
        const remedies = [
            ...(profileToBlame ? ['shorten the Writing Profile'] : []),
            ...(selectionToBlame ? ['shorten the selected passage'] : []),
            'lower the response length',
            'raise the context size in your API settings',
        ];

        throw new GenerateError(
            GenerateErrorKind.BUDGET,
            `There is no room left for the chapter: the reply reserve (${budget.reserveTokens} tokens)`
                + (namedCosts.length ? `, ${namedCosts.join(' and ')},` : '')
                + ` and the instructions leave nothing inside the context size (${budget.contextTokens} tokens). `
                + `Try to ${remedies.join(', or ')}.`,
            { budget: refusalFigures(budget, framingTokens, allowance, profileTokens, selectionTokens, action) },
        );
    }

    const fitted = await fitManuscript(text, allowance);

    if (!fitted) {
        const quickest = selectionTokens >= allowance
            ? ` The selected passage alone costs ${selectionTokens} tokens — shortening it is the quickest fix.`
            : profileTokens >= allowance
                ? ` The Writing Profile alone costs ${profileTokens} tokens — shortening it is the quickest fix.`
                : '';

        throw new GenerateError(
            GenerateErrorKind.BUDGET,
            `This chapter will not fit: even its last ${allowance} tokens of room cannot be filled safely. `
            + 'Lower the response length or raise the context size in your API settings.'
            + quickest,
            { budget: refusalFigures(budget, framingTokens, allowance, profileTokens, selectionTokens, action) },
        );
    }

    const blocks = PROMPT_BLOCKS.map((label) => {
        if (label === 'WRITING PROFILE') {
            return profileText
                ? { label, included: true, reason: 'included — never dropped', tokens: profileTokens, content: profileText }
                : { label, included: false, reason: 'profile is empty', content: '' };
        }

        if (label === 'MANUSCRIPT') {
            return {
                label,
                included: true,
                reason: fitted.trimmed
                    ? 'trimmed to fit the context budget'
                    : 'included',
                tokens: fitted.tokens,
                content: fitted.text,
            };
        }

        if (label === 'SELECTION') {
            return selectionText
                ? { label, included: true, reason: 'included — never dropped', tokens: selectionTokens, content: selectionText }
                : { label, included: false, reason: 'this action takes no selection', content: '' };
        }

        if (label === 'CURRENT WRITING INSTRUCTION') {
            return { label, included: true, reason: 'included — never dropped', content: config.instruction };
        }

        if (label === 'OUTPUT CONTRACT') {
            return { label, included: true, reason: 'included — never dropped', content: config.contract };
        }

        return { label, included: false, reason: DEFERRED_BLOCKS[label], content: '' };
    });

    // The profile frames the request, while manuscript and selection remain
    // separate user-authored operands. The directive and contract stay last.
    const messages = [
        ...(profileBlock ? [{ role: 'system', content: profileBlock }] : []),
        { role: 'user', content: renderBlock('MANUSCRIPT', fitted.text) },
        ...(selectionBlock ? [{ role: 'user', content: selectionBlock }] : []),
        { role: 'system', content: instructionBlock },
        { role: 'system', content: contractBlock },
    ];

    return {
        action,
        messages,
        blocks,
        inputTokens: framingTokens + profileTokens + selectionTokens + fitted.tokens,
        framingTokens,
        profileTokens,
        profileText,
        selectionTokens,
        selectionText,
        selectionWords: countWords(selectionText),
        reserveTokens: budget.reserveTokens,
        authorReserveTokens: budget.authorReserveTokens,
        reserveSource: budget.reserveSource,
        contextTokens: budget.contextTokens,
        allowanceTokens: allowance,
        marginTokens: MARGIN_TOKENS,
        trimmed: fitted.trimmed,
        sentWords: countWords(fitted.text),
        totalWords: countWords(text),
    };
}

/** Compatibility entry point used by the Continue-shaped Inspector and tests. */
export function buildContinuePrompt(manuscript, options = {}) {
    return buildPrompt('continue', { ...options, manuscript });
}

/**
 * What SillyTavern will show the model, as closely as we can honestly render it.
 *
 * The Inspector calls this rather than displaying `messages` raw, because
 * substituteParams runs INSIDE generateRaw (createRawPrompt, script.js:3886)
 * with no opt-out: an unexpanded render would show a prompt the model never
 * received.
 *
 * ⚠️ A SAMPLE, not a copy of the wire, for two reasons. `{{time}}`, `{{roll}}`
 * and `{{random}}` re-evaluate per call, so a second render differs from the
 * first. And createRawPrompt does more after we hand over — a `name: ` prefix
 * on non-openai, non-instruct backends (script.js:3885), then instruct
 * formatting — none of which is modelled here. We cannot see past generateRaw.
 *
 * ⚠️ Returns FRESH objects. createRawPrompt mutates the array it is handed
 * in place, so what is displayed must never be what is sent.
 *
 * @param {Array<{role: string, content: string}>} messages from buildPrompt
 * @returns {Array<{role: string, label: string, content: string, expanded: boolean, failed: boolean}>}
 */
export function expandForDisplay(messages) {
    const context = SillyTavern.getContext();
    const usable = typeof context?.substituteParams === 'function';

    return (messages ?? []).map((message) => {
        const content = message?.content ?? '';
        const role = message?.role ?? '';
        const label = PROMPT_BLOCKS.find((name) => content.startsWith(`[${name}]\n`)) ?? '';
        const raw = { role, label, content, expanded: false, failed: true };

        // Degrade to the unexpanded text rather than blanking the region: an
        // ST upgrade that moves substituteParams should cost fidelity, not the
        // whole Inspector. `failed` is surfaced on screen, never swallowed.
        if (!usable) {
            return raw;
        }

        try {
            const text = context.substituteParams(content);

            if (typeof text !== 'string') {
                return raw;
            }

            return { role, label, content: text, expanded: text !== content, failed: false };
        } catch (error) {
            console.warn('[SillyNovel] substituteParams failed; showing unexpanded text', error);
            return raw;
        }
    });
}

/** @param {object} prompt a buildPrompt() result */
export function needsPreflight(prompt) {
    return prompt.inputTokens > PREFLIGHT_TOKENS;
}

/**
 * Turn a generateRaw rejection into one of our states.
 *
 * ⚠️ Matched on error.message, which is brittle by nature: these are string
 * literals in the pinned source (script.js:4088 and :3956) with no error codes
 * behind them. An ST upgrade that rewords them lands here, and the fallback is
 * a generic failure with Retry rather than a crash.
 *
 * @param {unknown} error
 * @param {object|null} prompt the buildPrompt() result that was sent, so
 *   NO_MESSAGE can name the lever that is actually left
 */
function classify(error, prompt = null) {
    const message = String(error?.message ?? error ?? '');

    if (message === 'No message generated') {
        // ⚠️ The number in this message is not decoration — it is the whole
        // advice. Measured against DeepSeek `deepseek-flash`: reasoning cost
        // **2,295 tokens** before the model wrote its first word, then used ~300
        // more for the prose itself. At a 300-token budget and again at 2,000 the
        // reply came back `finish_reason: "length"` with an EMPTY `content`; at
        // 8,000 it came back `"stop"` with real prose. So the budget has to clear
        // the model's thinking cost *and* leave room to write, and SillyTavern's
        // stock 300 is not close.
        //
        // Reasoning effort is NOT the lever, at least here: openai.js:2548-2557
        // collapses Minimum/Low/Medium/High to `'high'` for DeepSeek, so the UI
        // cannot ask for less. Only `Auto` (field omitted) and `Maximum` differ.
        //
        // This message is the author's only clue, because generateRaw throws a
        // bare Error — the usage figures that would let us diagnose it for them
        // never reach us.
        //
        // Three cases, because once the floor has fired the response-length
        // setting is no longer the lever. If we already raised it as far as the
        // context allows, the context size is; if we raised it to the full
        // floor and the model still ran out, only their own setting above the
        // floor will do.
        const lead = 'The model returned no output — it used the entire reply budget thinking and '
            + 'ran out before writing. ';
        let advice = 'Raise the response length in your API settings: a reasoning model can spend '
            + 'a few thousand tokens before its first word, so it needs room for both. Around '
            + '4000 is a reasonable starting point.';

        if (prompt?.reserveSource === 'raised-by-sillynovel') {
            const author = Number(prompt.authorReserveTokens).toLocaleString();
            const reserve = Number(prompt.reserveTokens).toLocaleString();

            advice = prompt.reserveTokens < REPLY_FLOOR_TOKENS
                ? `SillyNovel already raised the reply budget from your ${author} to ${reserve} tokens `
                    + `— the most a ${Number(prompt.contextTokens).toLocaleString()}-token context can `
                    + 'spare — so the response length setting is not the lever here. Raise the '
                    + 'context size in your API settings; from about 8,300 tokens SillyNovel can '
                    + 'reserve the full 4,000.'
                : `SillyNovel already raised the reply budget from your ${author} to 4,000 tokens `
                    + 'and the model still ran out, so it needs more than that. Set the response '
                    + 'length above 4,000 in your API settings — once your own setting is at least '
                    + 'that high, SillyNovel leaves it alone.';
        }

        return new GenerateError(GenerateErrorKind.NO_MESSAGE, lead + advice, { cause: error });
    }

    if (error?.name === 'AbortError' || message.startsWith('Cancelled by')) {
        return new GenerateError(GenerateErrorKind.CANCELLED, 'Generation cancelled.', { cause: error });
    }

    return new GenerateError(
        GenerateErrorKind.FAILED,
        message || 'The model could not be reached.',
        { cause: error },
    );
}

/**
 * Run one writing action. Single-flight across every action and chapter.
 *
 * ⚠️ Single-flight is GLOBAL, not per chapter, and that is deliberate: one
 * model request at a time is the honest product model, and every extra one is
 * money. The cross-chapter consequence — B's actions disabled behind A's
 * request — is surfaced by getActiveGeneration() rather than hidden behind a
 * button that looks stuck.
 *
 * ⚠️ The caller's (chapterId, generation) pair comes back untouched so it can be
 * checked against session.js's isCurrentTarget(). A chapter id alone is
 * identity, not a generation: close and reopen and the same id is open again.
 *
 * @param {{prompt: object, chapterId: string, chapterTitle: string, generation: number}} options
 * @returns {Promise<{text: string, action: string, chapterId: string, generation: number}|null>}
 */
export async function runAction({ prompt, chapterId, chapterTitle, generation }) {
    if (active) {
        return null;
    }

    const action = prompt.action;
    const context = SillyTavern.getContext();

    const options = {
        // A FRESH array of fresh objects: createRawPrompt mutates the messages
        // it is handed in place (script.js:3886), so handing it the array we
        // also hand the Inspector would rewrite what the Inspector shows.
        prompt: prompt.messages.map((message) => ({ role: message.role, content: message.content })),

        // ⚠️ Load-bearing. The default (true) reaches cleanUpMessage's
        // trimWrongNames (script.js:6443-6455), which DELETES the whole reply
        // when it starts with the user's persona name followed by a colon, and
        // TRUNCATES at "\n<persona>:" anywhere else. A novel whose character
        // shares the persona's name, or any passage in script format, would be
        // silently cut — and an emptied reply then surfaces as the completely
        // unrelated "No message generated".
        trimNames: false,
    };

    // responseLength is passed iff the reserve was raised (ARCHITECTURE.md
    // §5.1), and the key is ADDED rather than set to undefined so anything
    // inspecting the options sees it absent. prompt.reserveTokens is the same
    // figure the allowance was computed from, because readBudget() resolves the
    // floor before any arithmetic — the number passed and the number reserved
    // cannot differ.
    //
    // What ST does with it: TempResponseLength.save (script.js:3963) swaps
    // openai_max_tokens for ours, createGenerationParameters reads it once
    // (openai.js:2750), and the CHAT_COMPLETION_SETTINGS_READY hook restores it
    // at openai.js:3052 — before the fetch at :3055, so the override never
    // spans the network call. The finally at script.js:4050 is the backstop
    // for throw and abort. The window is prompt assembly only, but it is not
    // purely ours: other extensions' CHAT_COMPLETION_PROMPT_READY listeners
    // (script.js:3978) run inside it, so "milliseconds" holds only while none
    // of them does slow work there.
    //
    // saveSettings (script.js:7992) refuses to serialize while an override is
    // live and reschedules a second later; session.js arms that timer on every
    // chapter open. Worst case is the settings persisting ~1 s late — and, the
    // point of that guard, oai_settings is never written to disk holding our
    // number.
    if (prompt.reserveSource === 'raised-by-sillynovel') {
        options.responseLength = prompt.reserveTokens;
    }

    const promise = context.generateRaw(options);

    active = { promise, action, chapterId, chapterTitle, generation };

    try {
        const text = await promise;
        return { text, action, chapterId, generation };
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] generation failed`, error);
        throw classify(error, prompt);
    } finally {
        // Only retire our own entry.
        if (active?.promise === promise) {
            active = null;
        }
    }
}

/** Compatibility entry point for the checkpoint-1 harness. */
export function runContinue(options) {
    return runAction(options);
}
