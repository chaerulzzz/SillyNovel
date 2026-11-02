import { ACTIONS } from './generate.js';

const PREAMBLE = /^\s*(?:here(?:['’]s| is)|sure|certainly|of course|okay)\b/i;
const MARKDOWN_HEADING = /^\s*#{1,6}\s/;
const BOLD_TITLE = /^\s*\*\*[^*\n]+\*\*\s*(?:\r?\n|$)/;
const TRAILING_META = /\b(?:let me know|i hope this|would you like)\b/i;
const QUOTE_PAIRS = new Map([
    ['"', '"'],
    ['“', '”'],
    ["'", "'"],
]);

/** @param {string} text @param {string} action */
export function validate(text, action) {
    const value = typeof text === 'string' ? text.trim() : '';
    const warnings = [];

    if (!value) {
        warnings.push('The result is empty.');
        return { ok: false, warnings };
    }

    if (ACTIONS[action]?.resultKind !== 'prose') {
        return { ok: true, warnings };
    }

    const lines = value.split(/\r?\n/);
    const firstLine = lines[0];
    const lastLines = lines.slice(-2).join('\n');

    if (PREAMBLE.test(firstLine)) {
        warnings.push("Starts with a preamble ('Here is…') — the model added commentary.");
    }

    if (MARKDOWN_HEADING.test(firstLine) || BOLD_TITLE.test(value)) {
        warnings.push('Starts with a markdown heading — review it before using the prose.');
    }

    const closingQuote = QUOTE_PAIRS.get(value[0]);
    const innerLineStartsWithQuote = lines.slice(1).some((line) => /^\s*["“']/.test(line));

    if (closingQuote && value.at(-1) === closingQuote && !innerLineStartsWithQuote) {
        warnings.push('The whole result is wrapped in quotation marks.');
    }

    if (TRAILING_META.test(lastLines)) {
        warnings.push('Ends with model commentary instead of manuscript prose.');
    }

    return { ok: warnings.length === 0, warnings };
}
