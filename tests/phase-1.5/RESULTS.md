# Phase 1.5 B-impl results (captured pre-B-clean)

Source for the eventual B-doc entry in docs/PROGRESS.md. All 62 scripted
checks passed (one apparent failure was a bash string-comparison artifact,
corrected via direct Python verification — see B2 note).

## Real bugs found and fixed during B-impl (not pre-existing spike-design flaws)

1. **`directories.root` is not guaranteed absolute.** B1's design assumed it
   was. Empirically: `typeof "string"`, length 22, `isAbsolute: false` — this
   deployment's `dataRoot: ./data` makes it relative to the server's cwd
   (`/home/node/app`). `directories` itself was correctly populated (not the
   real PLAN.md blocker). Fixed: `path.resolve(root)` before `realpath()`,
   matching how ST's own code resolves the same value.
2. **`getWorldInfoPrompt`'s `chat` param is `string[]`, not message objects.**
   Empirically confirmed against `public/script.js:4565`:
   `coreChat.map(x => x.mes).reverse()` — plain text, most recent first
   (depth 0). Original code passed `{is_user, mes}` objects, threw
   `TypeError: messages[depth].trim is not a function`. Fixed.

Both fixes double as B7 dev-loop evidence (below) — no throwaway edits were
needed to demonstrate the restart/reload asymmetry.

## B1–B3: storage routes, canonical path handling, atomic write

- `directories.root` (fixed, see above) resolves to a real, writable,
  canonical directory; `sillynovel-spike/` created non-recursively.
- Atomic write proven: exclusive same-dir temp (`wx`) → write → `fh.sync()`
  → `fh.close()` → `rename()`. Content `"VERSION-ONE-éè-content"` (v1)
  created, read back byte-identical. Replaced with
  `"VERSION-TWO-different-content-entirely"` (v2), read back exactly v2 (not
  v1, not mixed). Survived `container stop`+`start`, still exactly v2.
  Host-side: file size 38 bytes, mode `644` — no zero-byte stub (contrast
  A6's `--w-------` virtiofs artifact).
- **Concurrent-read visibility**: 20 rounds of replace-while-reading; 0/20
  bad reads (every successful read was exactly one full version, never
  truncated/empty/mixed).
- **Controlled post-temp failure**: rename target replaced with a non-empty
  directory. Result: `500`, sanitized body (no path). Failure mode
  confirmed as `EISDIR` from the server log — this is deterministic proof
  the temp file existed (EISDIR can only originate from the `rename()` call
  inside `atomicWrite`, which only runs after open/write/sync/close all
  already succeeded — stronger evidence than a timing-based poll, which was
  tried first and abandoned as unreliable). No orphan temp file afterward.
  Sentinel content (`"x"`) unchanged throughout. Plugin still served
  requests immediately after (`GET /spike/user-context` → 200).

## B2: HTTP contracts, byte cap, fixture round-trip, hostile identifiers

- Non-string content → 400; missing content → 400.
- Byte cap (spike-only, 64 KiB): 65,500 bytes accepted (201); 66,000 bytes
  rejected (413); 25,000× 3-byte UTF-8 chars (75,000 bytes, well under a
  naive *character*-count cap) correctly rejected on **byte** length.
- Fixture round-trip (leading/trailing whitespace, embedded newlines,
  Japanese text, emoji, accented Latin): confirmed **byte-identical** via
  direct Python JSON comparison (`repr()` match) — a bash string-equality
  check on the same data spuriously reported FAIL due to shell
  newline/emoji handling; the underlying data was always correct.
- Valid-but-absent UUID → 404. Replace of a missing target → 404, and
  confirmed via `test -e` on the host that nothing was created.
- **Hostile-identifier matrix, all 7 cases + 1 router-boundary case** —
  encoded traversal, absolute path, 8 KiB overlong segment, encoded null
  byte, wrong-version UUID, canonical-UUID-plus-trailing-path, prefix
  confusion (`<uuid>-evil`), and a literal-slash trailing path (router
  boundary, may 400 or 404 by design) — all rejected, all with **zero**
  filesystem operations performed (verified via before/after directory
  listing count) and **zero** path disclosure in any response body.

## B4: symlink hardening

- **Directory swap**: `sillynovel-spike` replaced with a symlink to a
  disposable sentinel sibling. Every request rejected (500, via the
  `BlockerError` path — spike dir must be a plain directory). Sentinel file
  byte-identical afterward; nothing new written into the sentinel directory.
- **Leaf swap**: a UUID entry replaced with a symlink to a sentinel file.
  `GET`, `POST` (replace), and `DELETE` **all** rejected (404 each).
  Sentinel content verified unchanged after every individual attempt, not
  just at the end.

## B5: isolation, exact sequence

1. A creates, owns the file.
2. A reads v1, replaces with v2.
3. B attempts `GET`, `POST` (replace), `DELETE` — all with A's UUID.
4. All three of B's operations → 404.
5. A re-reads: still exactly v2 (proves B's attempts had zero side effect,
   not just that they were rejected).
6. `container stop`+`start`; A re-reads: still exactly v2.
7. A deletes — only after every isolation/persistence assertion completed.

Run as `sillynovel-test-a` → `sillynovel-test-b`, never through
`default-user` (which is Admin and can read all users' data by design, so
would prove nothing).

## B6: middleware gates + authenticated harness

- Unauthenticated `GET /spike/user-context` → unsuccessful (403), no probe
  body.
- Authenticated `GET /spike/user-context` → `hasDirectories: true`, `root`
  present among key *names*, no absolute path value ever in the response.
- Authenticated `POST` with CSRF token → 201 (succeeds).
- Authenticated `POST` **without** CSRF token → 403, creates nothing
  (host-verified directory-listing count unchanged).
- A's CSRF token + B's session → 403 (rejected — tokens are session-bound).
- Unauthenticated write → 403, creates nothing.
- Harness: two independent cookie jars in a `mktemp -d` at mode `0700`,
  cleaned via `trap ... EXIT` (confirmed no stray directories survived any
  run).

## B7: dev-loop asymmetry

Demonstrated using the two real bug fixes above, not a throwaway edit:

- **Plugin side**: after the `directories.root` fix was written to disk, a
  request against the *still-running* (pre-restart) container reproduced
  the exact same `BLOCKER: directories.root missing, empty, or not
  absolute` in the logs. Only after `container stop`+`start` did the fix
  take effect.
- **Extension side**: after the `getWorldInfoPrompt` chat-format fix was
  written to disk, the *already-open* browser tab still threw the old
  `TypeError: messages[depth].trim is not a function` on retry. Only after
  a plain page reload (no container action) did the fix take effect.

## B8: World Info — native activation + manual fallback prototype

Book `SILLYNOVEL-SPIKE-TEMP` created via native ST UI under
`sillynovel-test-a`, one entry (keyword `glimmerthorn`).

- **Attached**, `isDryRun: true`: matching tail (containing "glimmerthorn")
  → `activated: true`; non-matching tail → `activated: false`.
- **Detached** (native UI), same matching tail → `activated: false` — no
  leak from an inactive book.
- Active-book selection restored to the original state ("No Worlds active")
  after the attach/detach cycle.
- **No stable per-call scoped-selection API exists** — `getWorldInfoPrompt`
  takes no book-list argument; it always reads whatever is globally active
  (confirmed against the pinned source in B0).
- **Manual keyword-scan fallback prototyped** (not just named): loads the
  named book directly via `loadWorldInfo`, scans without touching any
  global state. Tested against the still-**detached** book — correctly
  activates (uid 0) for the matching tail, correctly returns zero
  activations for the non-matching tail. Proves the fallback has zero
  dependency on the attach/detach state.
- **Real entry schema captured** (40 fields) — the semi-private API's only
  available spec. Fallback prototype implements: primary keys (`key`),
  secondary keys with AND ANY/ALL and NOT ALL/ANY logic (`keysecondary` +
  `selectiveLogic`), constant entries (`constant`), disabled entries
  (`disable`). **Not implemented** in the prototype (real Phase 2 scope
  decisions, not spike gaps): regex keys, recursion
  (`excludeRecursion`/`preventRecursion`/`delayUntilRecursion`),
  probability (`probability`/`useProbability`), insertion
  position/depth ordering.
- `saveWorldInfo` never called anywhere in the diagnostic code (true by
  construction — verified by inspection, not just by absence of errors).

## B9: token counting

Connected provider: DeepSeek, `deepseek-v4-flash`, `mainApi: "openai"`.

| Fixture | Length (chars) | Token count |
|---|---|---|
| empty | 0 | 0 |
| ascii | 44 | 12 |
| unicode | 43 | 23 |
| dialogue | 73 | 24 |
| long (repeated) | 11,400 | 2,003 |

- `tokenizerModel: "deepseek"` — the real provider-specific tokenizer is
  used, not a generic estimator.
- Empty input → 0. Repeated calls on the same fixture agree exactly.
- **Not a byte-estimation fallback**: counts don't track the ~chars/4
  formula across both ASCII and Unicode simultaneously (unicode: 43 chars →
  23 tokens, far off a chars/4 estimate of ~11 — a real tokenizer, not an
  estimator, produces this ratio).

## B10: generation invariants

Model: DeepSeek `deepseek-v4-flash` (a reasoning model — confirmed via its
"Thought for..." trace in native chat during Phase 1). **5 total model
requests made** across this investigation (bounds tracked explicitly, one
extra pair explicitly approved mid-session to rule out a timing hypothesis):

1. Normal generation, `responseLength: 64`: returned a string (47 chars);
   active chat byte-for-byte unchanged before/after (hash comparison) — the
   core "never auto-insert" invariant holds.
2. Cancellation attempt, `responseLength: 64`, `stopGeneration()` after a
   50 ms head start: rejected with **exactly** `"Cancelled by stop event"`
   — the precise error signature predicted from reading the pinned source
   in B0 (`abortController.abort(new Error('Cancelled by stop event'))`).
   Chat unchanged.
3. Immediate follow-up, `responseLength: 8`: **failed**,
   `"No message generated"`.
4–5. Repeated the cancel+follow-up pair with a 1.5 s delay before the
   follow-up (approved as one additional bounded request, to rule out a
   timing/race explanation): **identical result** — same rejection message
   on cancel, same `"No message generated"` on follow-up. Timing ruled out.

**Root cause identified from source, not further requests**: the failing
follow-up calls both used `responseLength: 8`; the one successful call used
`responseLength: 64`. `generateRaw` throws `"No message generated"`
(`public/script.js:4087-4088`) when the extracted message is empty after
cleanup. An 8-token cap is very likely consumed entirely by this reasoning
model's hidden reasoning tokens, leaving nothing for visible output —
**independent of cancellation**, which itself behaved exactly as expected
(clean rejection, chat untouched).

- **Streaming**: not observed — `generateRaw` returns `Promise<string>`
  (confirmed in B0); no incremental text was ever visible to extension code
  before the promise resolved. Recorded as "not available to us via
  `generateRaw`," not "doesn't stream" (the underlying transport may or may
  not stream; what matters for SillyNovel is product-usable delivery, which
  this API doesn't expose).
- **0 requests**: confirmed no spontaneous generation across numerous plain
  page reloads during this session.

## Accepted residual risks / open notes carried into B-doc

- `lstat` + `realpath` containment narrows but cannot mathematically
  eliminate a directory-swap race between check and use (two syscalls, not
  one) — accepted only under this project's trusted-local, single-operator
  deployment model.
- Very small `responseLength` values can fail outright (not degrade
  gracefully) against reasoning-capable models — worth a note for Phase 3's
  generation-UI error handling (treat `"No message generated"` as a
  distinct, actionable state).
- `directories.root` relative-path behavior is deployment-specific
  (`dataRoot: ./data`) — Phase 2 storage code must `path.resolve()` it, not
  assume absoluteness.
