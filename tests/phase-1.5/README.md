# Phase 1.5 — integration spike artifacts

The Phase 1.5 spike proved that per-user storage, atomic writes, CSRF, and
cross-user isolation actually work under this deployment before any feature code
was written. Its throwaway routes were deleted afterwards, deliberately — a test
endpoint that ships is a vulnerability, and deletion is the only reliable
guarantee it never does.

What is kept here is the **evidence** and the **scenarios**, not a runnable
suite.

## What is in here

| File | What it is | Use it for |
|---|---|---|
| `SPEC.md` | The ~62 spike checks rewritten as scenarios against real storage routes | **Start here.** This is what Phase 2's integration tests implement. |
| `RESULTS.md` | Unchanged snapshot of the spike's results | Evidence of what was proven, and how |
| `historical/*.sh.disabled` | The original scripts, sanitized | Reference for *how* things were verified. **Never run them.** |

## ⚠️ The scripts do not run, and must not be made to

`historical/` targets `/api/plugins/sillynovel/spike/*` routes that were deleted
at the end of Phase 1.5, so every request would `404`. Forcing them to run would
be worse than useless — they stop and start the real `sillynovel` container and
execute `rm -rf` inside a live test user's data directory.

They are named `*.sh.disabled` on purpose. Removing the executable bit is not
enough, because `bash file.sh` ignores it entirely.

Two sanitizations were applied before committing, both marked `[sanitized]` in
place:

- an `echo` of the first 8 characters of each CSRF token was removed — session
  tokens do not belong in scrollback or CI logs, even truncated;
- a write to a machine-specific absolute scratch path was removed.

No credentials were ever embedded: the test accounts are passwordless, and
`login()` posts `{"handle": "..."}` with no password field.

## ⚠️ `RESULTS.md` is a snapshot — one line in it is stale

It is preserved **verbatim**, so a correction that happened afterwards is not
reflected in it:

> **`RESULTS.md` line 223** reads *"worth a note for Phase 3's generation-UI
> error handling."* That requirement moved to **Phase 2**, because `Continue`
> ships in Phase 2 under the thin-vertical-slice ordering. The live version of
> the requirement is in the project plan's Phase 2 verification list: `Continue`
> must treat `"No message generated"` as a distinct, actionable error state.

Corrections live here rather than in the snapshot, so the snapshot stays a
snapshot.

## What did not survive

The spike's **plugin implementation** — the storage routes themselves — was
deleted and is not recoverable. That is expected. The path-handling and
atomic-write recipe it proved is written up as a requirement in the project's
architecture reference, and Phase 2 implements it fresh from there. The
`*_target.js` files that existed alongside these scripts were the *post*-deletion
cleaned-up sources, not the spike code, and are not kept.

## Environment these assume

Server on `127.0.0.1:8000`, container named `sillynovel`, two non-admin test
users `sillynovel-test-a` and `sillynovel-test-b`, passwordless local login,
CSRF token from `GET /csrf-token` sent as `X-CSRF-Token`.

Isolation tests must run between the two test users and **never** through
`default-user`, which is an Admin account and can read every user's data by
design — an isolation test involving it passes while proving nothing.
