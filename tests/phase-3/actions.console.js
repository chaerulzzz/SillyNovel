/**
 * Phase 3 checkpoint 4 browser-console harness. It uses the real tokenizer,
 * stubs generateRaw, and makes no model request. Every row should read PASS.
 */
(async () => {
    const mod = await import('/scripts/extensions/third-party/sillynovel-writing/lib/generate.js');
    const results = [];
    const manuscript = 'Mara closed the gate. Rain silvered the road beyond it.';
    const selection = 'Rain silvered the road beyond it.';
    const profile = { voice: 'Close and restrained', tense: 'Past' };

    function check(name, ok, detail) {
        results.push({ case: name, result: ok ? 'PASS' : 'FAIL', detail });
    }

    const expectedActions = ['continue', 'rewrite', 'expand', 'summarize', 'brainstorm'];
    check(
        'action registry',
        JSON.stringify(Object.keys(mod.ACTIONS)) === JSON.stringify(expectedActions),
        Object.keys(mod.ACTIONS).join(', '),
    );

    const prompts = {};

    for (const action of expectedActions) {
        const config = mod.ACTIONS[action];
        const prompt = await mod.buildPrompt(action, { manuscript, selection, profile });
        const labels = prompt.messages.map((message) => message.content.match(/^\[([^\]]+)\]/)?.[1]);
        const manuscriptTokens = prompt.blocks.find((block) => block.label === 'MANUSCRIPT')?.tokens;
        const selectionBlock = prompt.blocks.find((block) => block.label === 'SELECTION');
        const arithmetic = prompt.inputTokens === prompt.framingTokens + prompt.profileTokens
            + prompt.selectionTokens + manuscriptTokens;
        const selectionShape = config.needsSelection
            ? prompt.selectionText === selection
                && prompt.selectionWords === selection.trim().split(/\s+/).length
                && prompt.selectionTokens > 0
                && selectionBlock?.included
                && labels.includes('SELECTION')
                && labels.indexOf('MANUSCRIPT') < labels.indexOf('SELECTION')
            : prompt.selectionText === ''
                && prompt.selectionTokens === 0
                && !selectionBlock?.included
                && !labels.includes('SELECTION');
        const instruction = prompt.blocks.find((block) => block.label === 'CURRENT WRITING INSTRUCTION');
        const contract = prompt.blocks.find((block) => block.label === 'OUTPUT CONTRACT');

        prompts[action] = prompt;
        check(`${action} prompt`, prompt.action === action
            && instruction?.content === config.instruction
            && contract?.content === config.contract
            && selectionShape
            && arithmetic, {
            labels: labels.join(' → '),
            selectionTokens: prompt.selectionTokens,
            inputTokens: prompt.inputTokens,
            arithmetic,
        });
    }

    try {
        await mod.buildPrompt('rewrite', { manuscript, selection: '' });
        check('selection required', false, 'did not throw');
    } catch (error) {
        check('selection required', error.kind === 'empty' && error.message.includes('Select a passage'), error.message);
    }

    try {
        await mod.buildPrompt('unknown', { manuscript });
        check('unknown action rejected', false, 'did not throw');
    } catch (error) {
        check('unknown action rejected', error instanceof TypeError, error.message);
    }

    const realGetContext = SillyTavern.getContext;
    const base = realGetContext.call(SillyTavern);
    let captured = null;
    let release;
    let first = null;
    const gate = new Promise((resolve) => { release = resolve; });

    SillyTavern.getContext = () => ({
        ...base,
        generateRaw: (options) => {
            captured = options;
            return gate;
        },
    });

    try {
        first = mod.runAction({
            prompt: prompts.rewrite,
            chapterId: 'chapter-a',
            chapterTitle: 'Chapter A',
            generation: 7,
        });
        const active = mod.getActiveGeneration();
        const second = await mod.runAction({
            prompt: prompts.continue,
            chapterId: 'chapter-b',
            chapterTitle: 'Chapter B',
            generation: 8,
        });

        release('stub replacement');
        const result = await first;
        const sentSelection = captured.prompt.some((message) => message.content.startsWith('[SELECTION]\n'));

        check('runAction identity and single-flight', active?.action === 'rewrite'
            && active?.chapterId === 'chapter-a'
            && second === null
            && result.action === 'rewrite'
            && result.chapterId === 'chapter-a'
            && sentSelection
            && captured.trimNames === false
            && mod.getActiveGeneration() === null, {
            active,
            second,
            result,
            sentSelection,
            trimNames: captured.trimNames,
        });
    } finally {
        release?.('stub replacement');
        await first?.catch(() => {});
        SillyTavern.getContext = realGetContext;
    }

    console.table(results);
    return results;
})();
