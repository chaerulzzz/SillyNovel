/**
 * Phase 3 checkpoint 5 browser-console harness. It stubs generateRaw, makes no
 * model request, and restores the chapter notes after checking the real save.
 * Run it only in a disposable test chapter with the SillyNovel panel open.
 */
(async () => {
    const panel = document.getElementById('sillynovel-panel');
    const editor = panel?.querySelector('.sillynovel-editor');
    const notes = panel?.querySelector('.sillynovel-notes-editor');
    const notesStatus = panel?.querySelector('.sillynovel-notes-status');
    const summarize = panel?.querySelector('.sillynovel-action[data-action="summarize"]');

    if (!panel || !editor || !notes || !notesStatus || !summarize) {
        throw new Error('Open a SillyNovel test chapter before running this harness.');
    }

    if (panel.querySelector('.sillynovel-save-status')?.dataset.state === 'dirty'
        || notesStatus.dataset.state === 'dirty') {
        throw new Error('Save the chapter and notes before running this harness.');
    }

    const realGetContext = SillyTavern.getContext;
    const realFetch = window.fetch;
    const base = realGetContext.call(SillyTavern);
    const originalChapter = editor.value;
    const originalNotes = notes.value;
    const stubNotes = 'Checkpoint 5 stub notes — no model request.';
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

    SillyTavern.getContext = () => ({
        ...base,
        generateRaw: async () => stubNotes,
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

    async function restoreNotes() {
        if (notes.value === originalNotes) return;

        notes.value = originalNotes;
        notes.dispatchEvent(new Event('input', { bubbles: true }));
        notes.dispatchEvent(new Event('blur', { bubbles: true }));
        await waitFor(() => notesStatus.textContent === 'Notes saved', 'notes cleanup', 10000);
    }

    try {
        summarize.click();

        await waitFor(() => {
            const preflight = panel.querySelector('.sillynovel-preflight');

            if (preflight && !preflight.hidden) {
                panel.querySelector('.sillynovel-preflight-confirm')?.click();
            }

            return Boolean(panel.querySelector('.sillynovel-add-to-notes'));
        }, 'the Summarize result');

        const labels = Array.from(panel.querySelectorAll('.sillynovel-suggestion-action'))
            .map((button) => button.textContent);

        check('notes controls exclude Insert',
            labels.join('|') === 'Add to notes|Copy|Discard'
                && panel.querySelector('.sillynovel-insert') === null,
            labels.join(', '));
        check('generation leaves manuscript unchanged', editor.value === originalChapter, editor.value.length);

        panel.querySelector('.sillynovel-add-to-notes').click();

        const expected = originalNotes + (originalNotes.trim() ? '\n\n' : '') + stubNotes;
        check('Add to notes consumes the result',
            notes.value === expected
                && panel.querySelector('.sillynovel-suggestion')?.hidden
                && notesStatus.textContent === 'Unsaved notes',
            { notes: notes.value, status: notesStatus.textContent });

        await waitFor(() => notesStatus.textContent === 'Notes saved', 'the notes save');
        check('only notes saved', calls.notes === 1 && calls.chapter === 0 && editor.value === originalChapter, { ...calls });
    } finally {
        try {
            await restoreNotes();
        } finally {
            SillyTavern.getContext = realGetContext;
            window.fetch = realFetch;
        }
    }

    console.table(results);
    return results;
})();
