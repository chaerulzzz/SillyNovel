/**
 * SillyNovel — prompt assembly, the context budget, and the single model call
 * Phase 2 makes (checkpoint 8).
 *
 * Split from view.js so that module stays about the DOM: this one owns what is
 * sent to the model and what comes back. Checkpoint 9's Context Inspector
 * renders exactly what buildContinuePrompt() returns, which is why assembly is a
 * separate export rather than something inlined at the click.
 *
 * RULES (see AGENTS.md):
 *  - Generated prose is NEVER auto-inserted into a draft. Nothing here touches
 *    the editor; runContinue() returns text and the author decides.
 *  - Established state and writing instruction are separate LABELED blocks
 *    (ARCHITECTURE.md §3), never merged into one prose blob.
 *  - Cost preflight before a large operation (rule 6) — buildContinuePrompt
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
 * Phase 2 has data for three of the seven. The other four are still listed,
 * because §5 requires an inclusion or exclusion REASON for every block and a
 * block nobody lists is a block nobody can explain the absence of.
 */
export const PROMPT_BLOCKS = [
    'WRITING PROFILE',
    'ESTABLISHED STORY STATE',
    'LORE',
    'EARLIER CHAPTERS',
    'MANUSCRIPT',
    'CURRENT WRITING INSTRUCTION',
    'OUTPUT CONTRACT',
];

/** Blocks Phase 2 cannot fill yet, and why. Rendered by checkpoint 9. */
const DEFERRED_BLOCKS = {
    'WRITING PROFILE': 'not implemented until Phase 3',
    'ESTABLISHED STORY STATE': 'not implemented until Phase 4',
    LORE: 'not implemented until Phase 4',
    'EARLIER CHAPTERS': 'not implemented until Phase 3',
};

/** PLAN.md:419 — "Prose continuation only — no preamble, no commentary". */
const OUTPUT_CONTRACT =
    'Reply with the continuation prose only. No preamble, no commentary, no headings, '
    + 'no quotation marks around the whole reply, and no restatement of what came before. '
    + 'Begin exactly where the manuscript stops.';

const CONTINUE_INSTRUCTION =
    'Continue this chapter from exactly where it stops, in the same voice, tense and point of view. '
    + 'Write the next passage only.';

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

export const GenerateErrorKind = {
    /** Nothing to continue from. */
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
 * a reopened panel would show a live Continue button over a generation that is
 * still costing money, and one click would buy a second one. There is no
 * resetGeneration() export for exactly that reason: it is the function a
 * teardown path would reach for.
 *
 * @type {{promise: Promise<string>, chapterId: string, chapterTitle: string, generation: number}|null}
 */
let active = null;

/** @returns {{chapterId: string, chapterTitle: string, generation: number}|null} */
export function getActiveGeneration() {
    if (!active) {
        return null;
    }

    return {
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

        return {
            api: 'openai',
            contextTokens: Number(settings.openai_max_context) || 0,
            reserveTokens: Number(settings.openai_max_tokens) || 0,
            reserveSource: 'provider',
        };
    }

    return {
        api: context.mainApi,
        contextTokens: Number(context.maxContext) || 0,
        reserveTokens: FALLBACK_RESERVE_TOKENS,
        reserveSource: 'fallback',
    };
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
function refusalFigures(budget, framingTokens, allowanceTokens) {
    return {
        contextTokens: budget.contextTokens,
        reserveTokens: budget.reserveTokens,
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
 * Assemble the Continue prompt and report what it costs.
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
 * @param {string} manuscript what the EDITOR holds, not the saved copy
 * @returns {Promise<{messages: Array<{role: string, content: string}>,
 *   blocks: Array<object>, inputTokens: number, framingTokens: number,
 *   reserveTokens: number, reserveSource: string, contextTokens: number,
 *   allowanceTokens: number, marginTokens: number, trimmed: boolean,
 *   sentWords: number, totalWords: number}>}
 */
export async function buildContinuePrompt(manuscript) {
    const text = typeof manuscript === 'string' ? manuscript : '';

    if (text.trim() === '') {
        throw new GenerateError(
            GenerateErrorKind.EMPTY,
            'There is nothing to continue yet. Write a line or two first.',
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
            { budget: refusalFigures(budget, null, null) },
        );
    }

    const instructionBlock = renderBlock('CURRENT WRITING INSTRUCTION', CONTINUE_INSTRUCTION);
    const contractBlock = renderBlock('OUTPUT CONTRACT', OUTPUT_CONTRACT);

    // ⚠️ Counted, not absorbed by MARGIN_TOKENS. These blocks are
    // "included — never dropped", so they come off the top of the allowance;
    // and the figure shown to the author has to be the assembled total, or it
    // understates the request by every token of framing — a gap that widens
    // with every block Phases 3-4 add.
    const framingTokens = await countTokens(
        `${instructionBlock}\n\n${contractBlock}\n\n${renderBlock('MANUSCRIPT', '')}`,
    );

    const allowance = budget.contextTokens - budget.reserveTokens - framingTokens - MARGIN_TOKENS;

    // Reachable when the reserve leaves a sliver that the framing then eats.
    if (allowance <= 0) {
        throw new GenerateError(
            GenerateErrorKind.BUDGET,
            `There is no room left for the chapter: the reply reserve (${budget.reserveTokens} tokens) and the `
            + `instructions leave nothing inside the context size (${budget.contextTokens} tokens). `
            + 'Lower the response length or raise the context size in your API settings.',
            { budget: refusalFigures(budget, framingTokens, allowance) },
        );
    }

    const fitted = await fitManuscript(text, allowance);

    if (!fitted) {
        throw new GenerateError(
            GenerateErrorKind.BUDGET,
            `This chapter will not fit: even its last ${allowance} tokens of room cannot be filled safely. `
            + 'Lower the response length or raise the context size in your API settings.',
            { budget: refusalFigures(budget, framingTokens, allowance) },
        );
    }

    const blocks = PROMPT_BLOCKS.map((label) => {
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

        if (label === 'CURRENT WRITING INSTRUCTION') {
            return { label, included: true, reason: 'included — never dropped', content: CONTINUE_INSTRUCTION };
        }

        if (label === 'OUTPUT CONTRACT') {
            return { label, included: true, reason: 'included — never dropped', content: OUTPUT_CONTRACT };
        }

        return { label, included: false, reason: DEFERRED_BLOCKS[label], content: '' };
    });

    // One message per block, so §3's blocks stay separable rather than becoming
    // one prose blob. Framing as `system`, manuscript as `user`: under chat
    // completion createRawPrompt adds no speaker prefixes to either
    // (script.js:3885), which is exactly why PLAN.md:440 supports and tests a
    // chat-completion provider.
    const messages = [
        { role: 'user', content: renderBlock('MANUSCRIPT', fitted.text) },
        { role: 'system', content: instructionBlock },
        { role: 'system', content: contractBlock },
    ];

    return {
        messages,
        blocks,
        inputTokens: framingTokens + fitted.tokens,
        framingTokens,
        reserveTokens: budget.reserveTokens,
        reserveSource: budget.reserveSource,
        contextTokens: budget.contextTokens,
        allowanceTokens: allowance,
        marginTokens: MARGIN_TOKENS,
        trimmed: fitted.trimmed,
        sentWords: countWords(fitted.text),
        totalWords: countWords(text),
    };
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
 * @param {Array<{role: string, content: string}>} messages from buildContinuePrompt
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

/** @param {object} prompt a buildContinuePrompt() result */
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
 */
function classify(error) {
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
        return new GenerateError(
            GenerateErrorKind.NO_MESSAGE,
            'The model returned no prose — it used the entire reply budget thinking and ran out '
            + 'before writing. Raise the response length in your API settings: a reasoning model '
            + 'can spend a few thousand tokens before its first word, so it needs room for both. '
            + 'Around 4000 is a reasonable starting point.',
            { cause: error },
        );
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
 * Ask the model to continue. Single-flight.
 *
 * ⚠️ Single-flight is GLOBAL, not per chapter, and that is deliberate: one
 * model request at a time is the honest product model, and every extra one is
 * money. The cross-chapter consequence — B's Continue disabled behind A's
 * request — is surfaced by getActiveGeneration() rather than hidden behind a
 * button that looks stuck.
 *
 * ⚠️ The caller's (chapterId, generation) pair comes back untouched so it can be
 * checked against session.js's isCurrentTarget(). A chapter id alone is
 * identity, not a generation: close and reopen and the same id is open again.
 *
 * @param {{prompt: object, chapterId: string, chapterTitle: string, generation: number}} options
 * @returns {Promise<{text: string, chapterId: string, generation: number}|null>} null if a
 *   generation was already running
 */
export async function runContinue({ prompt, chapterId, chapterTitle, generation }) {
    if (active) {
        return null;
    }

    const context = SillyTavern.getContext();

    const promise = context.generateRaw({
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

        // responseLength is not passed YET. The decision is settled and
        // documented (ARCHITECTURE.md §5): a conditional floor, scoped to
        // chat completion, raising the reserve only when the author's own
        // setting sits below it and only as far as the context affords —
        // implemented as the first item of Phase 3, not here, so Phase 2 closes
        // on the generation path it was verified against.
        //
        // The hazard is narrower than it first looked. TempResponseLength
        // (script.js:4094) stashes the author's setting in one static field, so
        // two overlapping overrides strand openai_max_tokens at ours; but the
        // override never spans the network call (restore runs at :3995/4000/4005
        // before the fetch, and on the openai path via the
        // CHAT_COMPLETION_SETTINGS_READY hook at openai.js:3052, before the
        // fetch at :3055), our single-flight means we cannot race ourselves, and
        // ST's own generateQuietPrompt takes the same risk at :3045-3057.
        // Scoping to chat completion keeps amount_gen — the author's own
        // generation-length dial on every other backend (:4112-4113) — out of
        // it entirely.
        //
        // ⚠️ When it lands, the number passed and the number reserved must be
        // the SAME: readBudget().reserveTokens IS openai_max_tokens, so
        // budgeting against one figure while requesting another would silently
        // overfill the context. NO_MESSAGE stays either way — below roughly an
        // 8.2k context the cap cannot reach the floor, and naming a setting the
        // author can change is then their only signal.
    });

    active = { promise, chapterId, chapterTitle, generation };

    try {
        const text = await promise;
        return { text, chapterId, generation };
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] generation failed`, error);
        throw classify(error);
    } finally {
        // Only retire our own entry.
        if (active?.promise === promise) {
            active = null;
        }
    }
}
