/**
 * Phase 3 checkpoint 6 browser-console harness. It stubs generateRaw, makes no
 * model request, and restores the original chapter after checking a real save.
 * Run it only in a disposable test chapter with the SillyNovel panel open.
 * Every row should read PASS (12 rows).
 */
(async () => {
    const panel = document.getElementById('sillynovel-panel');
    const editor = panel?.querySelector('.sillynovel-editor');
    const saveStatus = panel?.querySelector('.sillynovel-save-status');
    const rewrite = panel?.querySelector('.sillynovel-action[data-action="rewrite"]');
    const expand = panel?.querySelector('.sillynovel-action[data-action="expand"]');

    if (!panel || !editor || !saveStatus || !rewrite || !expand) {
        throw new Error('Open a SillyNovel test chapter before running this harness.');
    }

    if (saveStatus.dataset.state === 'dirty') {
        throw new Error('Save the chapter before running this harness.');
    }

    const realGetContext = SillyTavern.getContext;
    const realFetch = window.fetch;
    const base = realGetContext.call(SillyTavern);
    const originalChapter = editor.value;
    const selected = 'The rain silvered the empty road.';
    const proposed = 'Rain glazed the abandoned road with silver.';
    const testSource = `Before the bell. ${selected} After the bell.`;
    const selectionStart = testSource.indexOf(selected);
    const selectionEnd = selectionStart + selected.length;
    const calls = { chapter: 0, notes: 0 };
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

    async function runSelectionAction(button, source, start, end) {
        editor.value = source;
        editor.focus();
        editor.setSelectionRange(start, end);
        button.click();

        await waitFor(() => {
            const preflight = panel.querySelector('.sillynovel-preflight');

            if (preflight && !preflight.hidden) {
                panel.querySelector('.sillynovel-preflight-confirm')?.click();
            }

            return Boolean(panel.querySelector('.sillynovel-replace'));
        }, `${button.textContent} result`);
    }

    function discard() {
        panel.querySelector('.sillynovel-discard')?.click();
    }

    /**
     * An edit as the author makes it: beforeinput while the selection still
     * describes the range, then the change. Chrome sends no beforeinput for
     * execCommand, so it is dispatched here in the browser's own order.
     */
    function authorEdit(start, end, text) {
        editor.focus();
        editor.setSelectionRange(start, end);
        editor.dispatchEvent(new InputEvent('beforeinput', {
            inputType: text ? 'insertText' : 'deleteContentBackward',
            data: text || null,
            bubbles: true,
            cancelable: true,
        }));
        document.execCommand(text ? 'insertText' : 'delete', false, text);
    }

    /** A refusal is a VISIBLE error; a hidden status keeps its last data-state. */
    function refused() {
        const status = panel.querySelector('.sillynovel-suggestions-status');
        return Boolean(status) && !status.hidden && status.dataset.state === 'error';
    }

    function staleShown() {
        return panel.querySelector('.sillynovel-suggestion-stale')?.hidden === false;
    }

    async function restoreChapter() {
        editor.value = originalChapter;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('blur', { bubbles: true }));
        await waitFor(
            () => saveStatus.textContent === 'Saved' || saveStatus.textContent === 'No unsaved changes',
            'chapter cleanup',
        );
    }

    SillyTavern.getContext = () => ({
        ...base,
        generateRaw: async () => proposed,
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
        await runSelectionAction(rewrite, testSource, selectionStart, selectionEnd);

        const labels = Array.from(panel.querySelectorAll('.sillynovel-suggestion-action'))
            .map((button) => button.textContent);
        check('Rewrite shows original and proposed',
            panel.querySelector('.sillynovel-suggestion-original')?.textContent === selected
                && panel.querySelector('.sillynovel-suggestion-text')?.textContent === proposed
                && labels.join('|') === 'Replace|Copy|Discard',
            labels.join(', '));

        const beforeDiscard = editor.value;
        discard();
        check('Discard leaves manuscript byte-identical', editor.value === beforeDiscard && calls.chapter === 0, { ...calls });

        await runSelectionAction(expand, testSource, selectionStart, selectionEnd);
        const editedInside = testSource.slice(0, selectionStart + 4)
            + 'X'
            + testSource.slice(selectionStart + 5);
        editor.value = editedInside;
        panel.querySelector('.sillynovel-replace')?.click();
        check('changed selection is refused',
            editor.value === editedInside && refused(),
            panel.querySelector('.sillynovel-suggestions-status')?.textContent);
        discard();

        const duplicateSource = `${selected} Between them. ${selected}`;
        await runSelectionAction(rewrite, duplicateSource, 0, selected.length);
        const changedOriginal = `X${duplicateSource.slice(1)}`;
        editor.value = changedOriginal;
        panel.querySelector('.sillynovel-replace')?.click();
        check('duplicate passage is never used as a fallback',
            editor.value === changedOriginal && refused(),
            panel.querySelector('.sillynovel-suggestions-status')?.textContent);
        discard();

        await runSelectionAction(rewrite, testSource, selectionStart, selectionEnd);
        authorEdit(0, 0, 'Z');
        const shifted = `Z${testSource}`;
        const staleBefore = staleShown();
        panel.querySelector('.sillynovel-replace')?.click();
        check('edit before selection is refused',
            editor.value === shifted && staleBefore && refused(),
            { staleBefore, status: panel.querySelector('.sillynovel-suggestions-status')?.textContent });
        discard();

        // The selected FIRST copy is deleted; the identical second copy slides
        // into the stored offsets, so the text there still matches.
        await runSelectionAction(rewrite, duplicateSource, 0, selected.length);
        authorEdit(0, `${selected} Between them. `.length, '');
        const staleSlid = staleShown();
        panel.querySelector('.sillynovel-replace')?.click();
        check('identical passage shifted into the anchor is refused',
            editor.value === selected && staleSlid && refused(),
            { editor: editor.value, staleSlid });
        discard();

        await runSelectionAction(rewrite, testSource, selectionStart, selectionEnd);
        const suffix = ' A later edit.';
        authorEdit(testSource.length, testSource.length, suffix);
        check('edit after selection shows no stale warning', !staleShown(), 'stale hidden');
        panel.querySelector('.sillynovel-replace')?.click();

        const replaced = testSource.slice(0, selectionStart) + proposed + testSource.slice(selectionEnd) + suffix;
        check('edit after selection keeps anchor valid', editor.value === replaced, editor.value);
        check('Replace consumes suggestion', panel.querySelector('.sillynovel-suggestion')?.hidden, 'suggestion hidden');

        const undoWorked = document.execCommand('undo') && editor.value === testSource + suffix;
        check('undo restores selected passage', undoWorked, editor.value);

        const redoWorked = undoWorked && document.execCommand('redo') && editor.value === replaced;
        check('redo reapplies replacement', redoWorked, editor.value);

        if (!redoWorked) {
            editor.value = replaced;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        }

        await waitFor(() => saveStatus.textContent === 'Saved', 'the chapter save');
        check('only manuscript saved', calls.chapter === 1 && calls.notes === 0, { ...calls });
    } finally {
        try {
            await restoreChapter();
        } finally {
            SillyTavern.getContext = realGetContext;
            window.fetch = realFetch;
        }
    }

    console.table(results);
    return results;
})();
