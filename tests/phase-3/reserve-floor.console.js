/**
 * SillyNovel — Phase 3 checkpoint 1: the responseLength conditional floor.
 *
 * A BROWSER-CONSOLE harness, zero model cost. Paste the whole file into the
 * devtools console of an authenticated SillyTavern tab with the SillyNovel
 * workspace panel CLOSED (generate.js's single-flight is global, and a real
 * click during a case would collide with the stub). The final expression is
 * the results table; every row should read PASS.
 *
 * How it works: getContext() returns a fresh object per call, so each case
 * wraps SillyTavern.getContext for its own duration and restores it in
 * `finally` — the live oai_settings is never touched. Token counting stays
 * REAL (a server round trip, no model cost); only generateRaw is stubbed, to
 * capture the options object it was handed. Reload the page before running so
 * the import below resolves to the extension's own module instance.
 */
(async () => {
    const mod = await import('/scripts/extensions/third-party/sillynovel-writing/lib/generate.js');
    const real = SillyTavern.getContext.bind(SillyTavern);
    const results = [];
    const liveBefore = { ...real().chatCompletionSettings };
    const TEXT = 'The rain had not stopped for three days. She counted the hours by the drip.';

    async function under({ mainApi = 'openai', ctx, reply, maxContext }, fn) {
        let captured = null;
        SillyTavern.getContext = () => {
            const base = real();
            return {
                ...base,
                mainApi,
                chatCompletionSettings: mainApi === 'openai' && ctx
                    ? { ...base.chatCompletionSettings, openai_max_context: ctx.context, openai_max_tokens: ctx.reserve }
                    : base.chatCompletionSettings,
                maxContext: maxContext ?? base.maxContext,
                generateRaw: async (options) => {
                    captured = options;
                    if (reply instanceof Error) throw reply;
                    return reply ?? 'stub prose';
                },
            };
        };
        try {
            return await fn(() => captured);
        } finally {
            SillyTavern.getContext = real;
        }
    }

    function check(name, ok, detail) {
        results.push({ case: name, result: ok ? 'PASS' : 'FAIL', detail });
    }

    async function budgetCase(name, stub, expect) {
        await under(stub, async (sent) => {
            const prompt = await mod.buildContinuePrompt(TEXT);
            await mod.runContinue({ prompt, chapterId: 'harness', chapterTitle: 'harness', generation: 0 });
            const options = sent();
            const arithmetic = prompt.allowanceTokens === prompt.contextTokens - prompt.reserveTokens - prompt.framingTokens - prompt.marginTokens
                && prompt.inputTokens === prompt.framingTokens + prompt.blocks.find((b) => b.label === 'MANUSCRIPT').tokens;
            const shape = prompt.reserveTokens === expect.reserve
                && prompt.reserveSource === expect.source
                && prompt.authorReserveTokens === expect.author;
            const wire = expect.raised
                ? ('responseLength' in options && options.responseLength === prompt.reserveTokens)
                : !('responseLength' in options);
            check(name, shape && wire && arithmetic && options.trimNames === false, {
                reserve: prompt.reserveTokens, source: prompt.reserveSource, author: prompt.authorReserveTokens,
                responseLength: 'responseLength' in options ? options.responseLength : '(absent)',
                arithmetic, trimNames: options.trimNames,
            });
        });
    }

    async function refusalCase(name, stub, expectAuthor) {
        await under(stub, async () => {
            try {
                await mod.buildContinuePrompt(TEXT);
                check(name, false, 'did not throw');
            } catch (error) {
                check(name, error.kind === 'budget' && error.budget?.reserveTokens === expectAuthor
                    && error.budget?.framingTokens === null, {
                    kind: error.kind, reserve: error.budget?.reserveTokens, framing: error.budget?.framingTokens,
                });
            }
        });
    }

    async function messageCase(name, stub, mustContain) {
        await under({ ...stub, reply: new Error('No message generated') }, async () => {
            const prompt = await mod.buildContinuePrompt(TEXT);
            try {
                await mod.runContinue({ prompt, chapterId: 'harness', chapterTitle: 'harness', generation: 0 });
                check(name, false, 'did not throw');
            } catch (error) {
                check(name, error.kind === 'no-message' && error.message.includes(mustContain),
                    { kind: error.kind, snippet: error.message.slice(-120) });
            }
        });
    }

    await budgetCase('A non-openai backend untouched', { mainApi: 'textgenerationwebui', maxContext: 4096 },
        { reserve: 512, source: 'fallback', author: 512, raised: false });
    await budgetCase('B author at the floor untouched', { ctx: { context: 32768, reserve: 4000 } },
        { reserve: 4000, source: 'provider', author: 4000, raised: false });
    await budgetCase('B2 author above the floor untouched', { ctx: { context: 32768, reserve: 5000 } },
        { reserve: 5000, source: 'provider', author: 5000, raised: false });
    await budgetCase('C 32k context, 300 -> raised to 4000', { ctx: { context: 32768, reserve: 300 } },
        { reserve: 4000, source: 'raised-by-sillynovel', author: 300, raised: true });
    await budgetCase('D 4096 context, 300 -> raised to 1920', { ctx: { context: 4096, reserve: 300 } },
        { reserve: 1920, source: 'raised-by-sillynovel', author: 300, raised: true });
    await budgetCase('E 4096 context, 2000 -> cap cannot improve, untouched', { ctx: { context: 4096, reserve: 2000 } },
        { reserve: 2000, source: 'provider', author: 2000, raised: false });
    await refusalCase('F 512 context refuses before counting with the author figures', { ctx: { context: 512, reserve: 300 } }, 300);
    await messageCase('NO_MESSAGE not raised names the setting', { ctx: { context: 32768, reserve: 5000 } }, 'Around 4000');
    await messageCase('NO_MESSAGE raised to the floor says above 4,000', { ctx: { context: 32768, reserve: 300 } }, 'above 4,000');
    await messageCase('NO_MESSAGE raised below the floor says context size', { ctx: { context: 4096, reserve: 300 } }, 'context size');

    // The harness must leave the author's real settings exactly as it found
    // them: every stub lived on a copy, never on oai_settings itself.
    const liveAfter = real().chatCompletionSettings;
    check('live settings untouched by the harness',
        liveAfter.openai_max_tokens === liveBefore.openai_max_tokens
            && liveAfter.openai_max_context === liveBefore.openai_max_context,
        { before: [liveBefore.openai_max_tokens, liveBefore.openai_max_context],
            after: [liveAfter.openai_max_tokens, liveAfter.openai_max_context] });

    console.table(results);
    return results;
})();
