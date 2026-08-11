# Storage integration test specification

The Phase 1.5 spike ran ~62 checks against throwaway routes that no longer
exist. This file is what survived them: the **scenarios**, rewritten so Phase 2
can implement them against its real project/chapter storage routes.

Routes are deliberately written generically ("the chapter resource") — Phase 2
defines the actual paths. What matters is that each scenario is covered, and
covered the way described, because several of these pass for the wrong reason if
you check only the HTTP status code.

## How to assert

Three rules carried over from the spike, each of which caught something:

1. **Check the filesystem out of band, not just the response.** A rejected write
   that still created a file is a failure that returns `400` and looks fine.
   Compare a directory listing before and after.
2. **Compare payloads in a real language, not in `bash`.** A round-trip check on
   text containing newlines and emoji spuriously failed under shell string
   equality while the stored data was byte-perfect. Use Python/Node `repr()`
   comparison.
3. **Re-read after a rejected operation.** Proving an attacker got a `404` is
   weaker than proving the resource is still byte-identical afterward.

---

## 1. Middleware gates

| # | Scenario | Expected |
|---|---|---|
| 1.1 | Unauthenticated `GET` of any storage route | Unsuccessful, **and** no resource body. Assert on both — not on a specific code; ST may `401`, `403`, or redirect. |
| 1.2 | Authenticated `GET` | Succeeds; `request.user.directories` populated server-side |
| 1.3 | Authenticated write **with** CSRF token | Succeeds |
| 1.4 | Authenticated write **without** CSRF token | Rejected, **and creates nothing** (verify by directory listing before/after) |
| 1.5 | Valid CSRF token from user A's session, sent with user B's cookie | Rejected — tokens are session-bound |
| 1.6 | Unauthenticated write | Rejected, and creates nothing |
| 1.7 | Any response body, any route | Never contains a filesystem path. Grep responses for `/home/node` and `/data/`. |

## 2. Canonical path handling

| # | Scenario | Expected |
|---|---|---|
| 2.1 | `directories.root` is relative (this deployment: `dataRoot: ./data`) | Resolved with `path.resolve()` then `realpath()`; containment checked against the canonical root. **This was a real bug in the spike** — do not assume absoluteness. |
| 2.2 | Storage directory created | Non-recursively, under the canonical root |
| 2.3 | Probe/diagnostic responses | Expose key *names* only, never their values |

## 3. Atomic write

| # | Scenario | Expected |
|---|---|---|
| 3.1 | Create, then read back | Byte-identical |
| 3.2 | Replace with clearly distinct content, then read | Exactly the new version — never the old, never a mix |
| 3.3 | `container stop` + `start`, then read | Still exactly the new version |
| 3.4 | Inspect the file on the host | Non-zero size, sane mode (`644`/`664`) — no zero-byte stub, no `--w-------` artifact |
| 3.5 | 20 rounds of replace-while-reading | Every successful read is exactly one complete version. Zero truncated, empty, or mixed. |
| 3.6 | Forced failure after the temp file exists — replace the rename target with a **non-empty directory** | Non-2xx, sanitized body, and the error is `EISDIR`/`ENOTEMPTY`. That error can only originate from `rename()`, which by construction runs after open/write/sync/close all succeeded — deterministic proof the temp file existed, with no timing assumptions. |
| 3.7 | After 3.6 | No orphaned `.tmp-*` file remains; the sentinel content is untouched |

⚠️ **Not covered by any scenario here:** durability across an abrupt *host*
crash or power loss. The parent directory is not `fsync`ed after `rename`, and
`container stop`/`start` does not test it — the host page cache survives a
container restart. See `ARCHITECTURE.md §9`; whether to add a parent-directory
`fsync` is an open Phase 2 decision with a latency cost.

## 4. Symlink hardening

| # | Scenario | Expected |
|---|---|---|
| 4.1 | Replace the storage **directory** with a symlink to a sibling sentinel | Every request rejected. Sentinel byte-identical afterward; nothing written into it. |
| 4.2 | Replace a **leaf** resource with a symlink to a sentinel file | `GET`, replace, **and** delete each rejected — verify all three separately, not just read |
| 4.3 | After each individual attempt in 4.2 | Sentinel content unchanged — checked per attempt, not once at the end |

## 5. Cross-user isolation — run in this exact order

Run as `sillynovel-test-a` → `sillynovel-test-b`. **Never through
`default-user`**: it is Admin and can read all users' data by design, so the
test would pass while proving nothing.

1. A creates a resource and owns it.
2. A reads v1, replaces it with v2.
3. B attempts read, replace, and delete using A's identifier.
4. All three of B's operations rejected.
5. **A re-reads: still exactly v2.** This is the step that proves B's attempts
   had zero side effect, rather than merely that they returned an error.
6. `container stop` + `start`; A re-reads: still exactly v2.
7. A deletes — only after every assertion above has completed.

## 6. HTTP contract and payload handling

| # | Scenario | Expected |
|---|---|---|
| 6.1 | Non-string content; missing content | `400` |
| 6.2 | Payload just under the byte cap | Accepted |
| 6.3 | Payload just over the byte cap | `413` |
| 6.4 | Many multi-byte UTF-8 characters — well under a naive *character* count but over the **byte** cap | Rejected. A character-count cap passes this and is wrong. |
| 6.5 | Round-trip of leading/trailing whitespace, embedded newlines, Japanese text, emoji, accented Latin | Byte-identical, compared via `repr()` — not shell string equality |
| 6.6 | Well-formed but non-existent identifier | `404` |
| 6.7 | Replace of a missing target | `404`, and creates nothing (verify on the host) |

## 7. Hostile identifiers

Send each to the normal, UUID-validated route. **No endpoint accepts a
filesystem path**, so this tests identifier validation — which is the actual
invariant — rather than path sanitization.

1. Encoded traversal (`..%2F..%2Fetc%2Fpasswd`)
2. Absolute path (`%2Fetc%2Fpasswd`)
3. Overlong segment (8 KiB)
4. Encoded null byte
5. Wrong-version UUID (valid shape, not v4)
6. Canonical UUID plus trailing path
7. Prefix confusion (`<uuid>-evil`)
8. Literal-slash trailing path — a router-boundary case; `400` or `404` are both
   acceptable by design

For **all** cases: rejected, **zero filesystem operations performed** (verify via
before/after directory listing count), and **zero path disclosure** in any
response body.

## 8. Revisions and conflict — new in Phase 2, not covered by the spike

The spike had no revision model. These have no prior evidence and need building
from scratch:

| # | Scenario | Expected |
|---|---|---|
| 8.1 | Write with a current `If-Match` revision | Succeeds; revision advances |
| 8.2 | Write with a stale `If-Match` revision | `412`, and **creates/modifies nothing** |
| 8.3 | Write with no `If-Match` | Rejected — last-write-wins must not be reachable by omission |
| 8.4 | Chapter 1 edited, then an in-flight chapter 2 save completes | Chapter 2 succeeds. Revisions are **per chapter**; a project-level revision would spuriously invalidate it. |
| 8.5 | Same chapter open in two tabs, both save | Second gets a conflict warning, not silent loss |

## 9. Environment assumptions

Any harness implementing this spec depends on:

- Server on `127.0.0.1:8000`, container named `sillynovel`.
- Two non-admin test users, `sillynovel-test-a` and `sillynovel-test-b`.
- **Passwordless local accounts** — login posts `{"handle": "..."}` with no
  password. This is a local-development property; do not point a harness at
  accounts that hold real work.
- CSRF token fetched from `GET /csrf-token`, sent as `X-CSRF-Token`.
- Scenarios 3.3, 3.6, 4.x and 5.6 restart the container or manipulate files
  inside a user's data directory. Keep that out of any unattended run, and never
  point it at a deployment holding real manuscripts.
