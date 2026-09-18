# Phase 3 tests

## `reserve-floor.console.js` — the `responseLength` conditional floor

A browser-console harness, **zero model cost**. It proves every branch of
`resolveReserve()` (`extension/lib/generate.js`) and the exact options object
handed to `generateRaw`, against the real tokenizer, without touching the
author's live settings.

**Run it:**

1. Reload an authenticated SillyTavern tab, so the `import` resolves to the
   extension's own module instance.
2. Keep the SillyNovel workspace panel **closed** — the generation single-flight
   is global, and a real click during a case would collide with the stub.
3. Paste the whole file into the devtools console. The result is a table; every
   row must read `PASS`, including the last one, which asserts the live
   `openai_max_tokens` / `openai_max_context` are byte-identical before and
   after.

**How it isolates itself:** `SillyTavern.getContext()` returns a fresh object
per call, so each case wraps `getContext` for its own duration and restores it
in `finally`. Every stub lives on a copy of `chatCompletionSettings`; the real
`oai_settings` object is never assigned to. Only `generateRaw` is replaced, to
capture the options object; token counting is real (a server round trip).

| case | context / reserve | expects |
|---|---|---|
| A | non-openai backend | 512 / `fallback`, `responseLength` absent |
| B, B2 | 32k / 4000 and 5000 | untouched, absent |
| C | 32k / 300 | raised to 4000, `responseLength: 4000` |
| D | 4096 / 300 | raised to 1920, `responseLength: 1920` |
| E | 4096 / 2000 | cap cannot improve → untouched, absent |
| F | 512 / 300 | BUDGET refusal before counting, author figures |
| NO_MESSAGE ×3 | as B2 / C / D | the three advice variants |

## What the harness cannot prove, and what was spent instead

The claim the floor exists to make — *a reasoning model on a 300-token setting
returns prose instead of "No message generated"* — is only observable on the
wire. It was proven once at the close of checkpoint 1 with **two live DeepSeek
requests** (`docs/PROGRESS.md`, Phase 3): with the author's setting at 300, the
wire carried `max_tokens: 4000` on a 32k context and `1920` on a 4,096 context,
both returned `finish_reason: "stop"`, and both would have failed at 300
(877 and 1,170 completion tokens). The setting was restored to 300 after each
request, byte-for-byte, and the author's original values persisted through a
reload after teardown.

To repeat the live check, lower `#openai_max_tokens` **through the UI input**
(so the live value and the debounced save stay consistent), tick
`#oai_max_context_unlocked` before setting a context below 4,096 (the slider is
capped at 4,095 otherwise), and register a zero-cost probe on
`CHAT_COMPLETION_SETTINGS_READY` to read the exact `max_tokens` on the wire.
Restore everything through the same inputs afterwards.

## The Writing Profile routes — `tests/phase-2/storage.sh` section 8

The profile's storage checks live in the Phase 2 suite as section 8, sharing its
login and project setup and its single PASS/FAIL total (the filename is a
location, not a claim). They cover the first-run default and its canonical
etag, compare-and-swap including two parallel writers, every If-Match rejection,
the body contract, byte caps (a multi-byte case included), **server-owned
unknown-field preservation**, hostile ids on the new path, cross-user isolation,
and read stability. A plugin change needs a container restart before the suite
sees it.

**Manual, not automated (destructive):** replace `profile.json` with a symlink
and confirm GET and PUT both answer 404 — sleep at least 2 s after the swap,
virtiofs caches directory metadata for about a second.
