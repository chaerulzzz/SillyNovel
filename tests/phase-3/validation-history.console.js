/**
 * Phase 3 checkpoint 7 browser-console harness. It uses the real tokenizer,
 * stubs generateRaw, makes no model request, and never edits the manuscript.
 */
(async () => {
    let panel = document.getElementById('sillynovel-panel');
    let editor = panel?.querySelector('.sillynovel-editor');
    const continueButton = panel?.querySelector('.sillynovel-action[data-action="continue"]');

    if (!panel || !editor || !continueButton) {
        throw new Error('Open a SillyNovel test chapter before running this harness.');
    }

    if (!panel.querySelector('.sillynovel-suggestion')?.hidden) {
        throw new Error('Close and reopen the workspace to start with empty suggestion history.');
    }

    const { validate } = await import('/scripts/extensions/third-party/sillynovel-writing/lib/validate.js');
    const realGetContext = SillyTavern.getContext;
    const realFetch = window.fetch;
    const base = realGetContext.call(SillyTavern);
    const originalChapter = editor.value;
    const generated = [
        'Here is the continuation:\n\nShe crossed the empty road.',
        'She crossed the empty road without looking back.',
        'The empty road shone beneath her feet.',
    ];
    const calls = { model: 0, chapter: 0, notes: 0 };
    const results = [];

    function check(name, ok, detail) {
        results.push({ case: name, result: ok ? 'PASS' : 'FAIL', detail });
    }

    async function waitFor(predicate, label, timeoutMs = 10000) {
        const started = performance.now();

        while (performance.now() - started < timeoutMs) {
            if (predicate()) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        throw new Error(`Timed out waiting for ${label}.`);
    }

    async function generate(expected) {
        panel.querySelector('.sillynovel-action[data-action="continue"]')?.click();

        await waitFor(() => {
            const preflight = panel.querySelector('.sillynovel-preflight');

            if (preflight && !preflight.hidden) {
                panel.querySelector('.sillynovel-preflight-confirm')?.click();
            }

            return panel.querySelector('.sillynovel-suggestion-text')?.textContent === expected;
        }, 'the stubbed result');
    }

    const validatorCases = [
        ['preamble', 'Here is the rewrite:\n\nShe left.', 'continue', false],
        ['markdown heading', '# Chapter\nShe left.', 'continue', false],
        ['bold title', '**Chapter**\nShe left.', 'continue', false],
        ['wrapper quotes', '“She left.”', 'continue', false],
        ['trailing commentary', 'She left.\n\nLet me know if you want more.', 'continue', false],
        ['clean prose', 'She left.', 'continue', true],
        ['notes', '- She leaves.', 'summarize', true],
        ['empty notes', '   ', 'summarize', false],
    ];

    for (const [name, text, action, expected] of validatorCases) {
        const result = validate(text, action);
        check(`validator: ${name}`, result.ok === expected, result.warnings.join(' '));
    }

    SillyTavern.getContext = () => ({
        ...base,
        generateRaw: async () => {
            const value = generated[calls.model];
            calls.model += 1;
            return value;
        },
    });

    window.fetch = async (input, init = {}) => {
        const url = String(input instanceof Request ? input.url : input);
        const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

        if (method === 'PUT' && url.includes('/api/plugins/sillynovel/projects/')) {
            if (/\/chapters\/[^/]+\/notes$/.test(url)) calls.notes += 1;
            else if (/\/chapters\/[^/]+$/.test(url)) calls.chapter += 1;
        }

        return realFetch.call(window, input, init);
    };

    try {
        await generate(generated[0]);
        check('warning keeps text and Insert',
            panel.querySelector('.sillynovel-suggestions-status')?.dataset.state === 'warning'
                && Boolean(panel.querySelector('.sillynovel-inline-retry'))
                && Boolean(panel.querySelector('.sillynovel-insert'))
                && panel.querySelector('.sillynovel-suggestion-text')?.textContent === generated[0],
            panel.querySelector('.sillynovel-suggestions-status')?.textContent);

        await generate(generated[1]);
        check('two results show newest position',
            panel.querySelector('.sillynovel-history-position')?.textContent === '2 / 2',
            panel.querySelector('.sillynovel-history-position')?.textContent);

        panel.querySelector('.sillynovel-history-previous')?.click();
        check('Previous restores warning result',
            panel.querySelector('.sillynovel-suggestion-text')?.textContent === generated[0]
                && panel.querySelector('.sillynovel-suggestions-status')?.dataset.state === 'warning',
            panel.querySelector('.sillynovel-history-position')?.textContent);

        panel.querySelector('.sillynovel-inline-retry')?.click();
        await waitFor(() => {
            const preflight = panel.querySelector('.sillynovel-preflight');

            if (preflight && !preflight.hidden) {
                panel.querySelector('.sillynovel-preflight-confirm')?.click();
            }

            return panel.querySelector('.sillynovel-suggestion-text')?.textContent === generated[2];
        }, 'the retry result');
        check('Retry preserves earlier results',
            panel.querySelector('.sillynovel-history-position')?.textContent === '3 / 3',
            panel.querySelector('.sillynovel-history-position')?.textContent);

        panel.querySelector('.sillynovel-discard')?.click();
        check('Discard reveals previous result',
            panel.querySelector('.sillynovel-suggestion-text')?.textContent === generated[1]
                && panel.querySelector('.sillynovel-history-position')?.textContent === '2 / 2',
            panel.querySelector('.sillynovel-history-position')?.textContent);

        check('history never writes documents',
            editor.value === originalChapter && calls.chapter === 0 && calls.notes === 0,
            { ...calls });

        panel.querySelector('.sillynovel-panel-close')?.click();
        await waitFor(() => !document.getElementById('sillynovel-panel'), 'workspace close');
        document.getElementById('sillynovel_wand_button')?.click();
        await waitFor(() => Boolean(document.getElementById('sillynovel-panel')), 'workspace reopen');

        panel = document.getElementById('sillynovel-panel');
        editor = panel.querySelector('.sillynovel-editor');
        // The panel mounts before its chapter loads; the editor is empty until then.
        await waitFor(() => editor.value === originalChapter, 'the reopened chapter').catch(() => {});
        check('panel close clears history',
            panel.querySelector('.sillynovel-suggestion')?.hidden
                && panel.querySelector('.sillynovel-suggestion-history')?.hidden
                && editor.value === originalChapter,
            'suggestion and history hidden');
    } finally {
        SillyTavern.getContext = realGetContext;
        window.fetch = realFetch;
    }

    console.table(results);
    return results;
})();
