# Phase 2 — storage integration tests

`storage.sh` exercises the real project/chapter routes. **Safe to run:** it does
not stop the container and deletes nothing outside the projects it creates.

```bash
./tests/phase-2/storage.sh
```

Requires the container running, plus passwordless local test users
`sillynovel-test-a` and `sillynovel-test-b`. Isolation checks run strictly
between those two and **never** through `default-user`, which is an Admin
account able to read every user's data by design — an isolation test involving
it passes while proving nothing.

## What it covers

Derived from `tests/phase-1.5/SPEC.md`, restricted to the scenarios Phase 2's
routes can actually exercise, plus what is new here.

| Area | Notes |
|---|---|
| Middleware gates | unauthenticated read, missing CSRF, cross-session CSRF token |
| **Compare-and-swap** | new in Phase 2 — two simultaneous `PUT`s with the same ETag |
| `If-Match` validation | wildcard, weak, multi-value, unquoted, malformed, missing |
| Hostile identifiers | encoded traversal, absolute path, null byte, wrong UUID version, prefix confusion, overlong |
| Cross-user isolation | read and replace, plus A re-reading to prove zero side effect |
| Payload contracts | non-string, missing, unicode/whitespace round-trip |
| Reconciliation | repeated `GET` is stable |

The compare-and-swap case is the one with no prior evidence. Phase 1.5 tested
replace-while-**reading**; two writers racing on the same ETag was never covered,
and without a server-side lock both pass the hash comparison and both are told
they succeeded.

## Not covered here — deliberately

**Delete scenarios.** SPEC §4.2 and §5 bundle read, replace, *and* delete into
single rows. Phase 2 has no `DELETE` route, so only the read/replace portions run
now; the delete third moves to Phase 5 when deletion exists.

**Destructive host scenarios**, which stay manual and local-only against
disposable data: symlink swaps of the storage directory or a leaf (SPEC §4),
container restart persistence (§3.3), forced post-temp failure (§3.6), and
orphan/dangling reconciliation. These manipulate the deployed state directly and
must never be part of an unattended run.

Reconciliation was verified manually during Phase 2 by injecting an orphan `.md`
and a dangling metadata entry: the orphan was adopted and readable, the dangling
entry dropped, and `project.json` was **byte-identical** after the `GET` —
confirming reads repair the response only.

### Symlink sentinels — manual procedure, and a real gotcha

Verifies every ancestor level rejects a symlink, not just the leaf: storage
root (`sillynovel/`), `projects/`, and a project's `chapters/`. Run against a
disposable project on `sillynovel-test-a`.

```bash
D=~/.sillynovel/data/sillynovel-test-a/sillynovel
# ... authenticate, make a request through the path once (see below) ...
mv "$D" "${D}.real" && ln -s "${D}.real" "$D"
sleep 2                                   # see the warning below — do not skip
curl ... # expect 500 {"error":"storage unavailable","blocker":true}
rm "$D" && mv "${D}.real" "$D"            # restore before anything else touches it
```

Same pattern one level down for `projects/` (expect `BlockerError`, 500) and for
a specific project's `chapters/` directory (expect `RequestError`, 404 on both
`GET` and `PUT` — verified during Phase 2 with a sentinel file planted alongside
the swapped-in directory, confirming nothing leaked into it on either read or
write).

**Two more levels, added after a follow-up review found the first pass
incomplete.** `readChapter`/`writeChapter` initially checked only `chapters/`
before touching a leaf — but `lstat` on `chaptersDir` resolves every ancestor
component transparently on the way there; it does not protect against `projects/`
or the specific project's own directory being swapped further up the same path.
Both need their own direct sentinel, against a **real chapter `GET`/`PUT`**, not
just `listProjects`/`createProject`:

- **`projects/` swapped**, with a real `projectId`/`chapterId` already created
  before the swap: direct chapter `GET` and `PUT` both rejected (500,
  `BlockerError`), nothing written into the sentinel.
- **The specific project's own directory swapped** (`projects/<id>/`, one level
  below `projects/`, one level above `chapters/`) — this is the scenario with
  the sharpest possible consequence and had **zero** prior coverage, since the
  first pass's sentinel only ever swapped `chapters/` itself. Verified with a
  **decoy chapter file at the exact same chapter ID** planted inside the
  sentinel tree: `GET` returned `404`, not the decoy's content; `PUT` returned
  `404`, not a write into the decoy. Without the fix, `GET` would have silently
  returned attacker-controlled content and `PUT` would have silently written
  outside the real tree — no error at all, since the swapped path still
  resolves to something that looks like a perfectly normal chapter file.

```bash
D=~/.sillynovel/data/sillynovel-test-a/sillynovel
PID=... ; CID=...                         # a real project + chapter, created first
mkdir -p "$D/sentinel-project/chapters"
echo "DECOY" > "$D/sentinel-project/chapters/$CID.md"
mv "$D/projects/$PID" "$D/projects/$PID.real"
ln -s "$D/sentinel-project" "$D/projects/$PID"
sleep 2                                   # same caching gotcha, see below
curl ... # GET and PUT on $PID/chapters/$CID — expect 404, never the decoy
rm "$D/projects/$PID" && mv "$D/projects/$PID.real" "$D/projects/$PID"
```

⚠️ **The virtiofs mount caches directory metadata for up to ~1 second.** If any
request successfully touched the real path shortly before the swap — which is
easy to do by accident, e.g. while setting up the test project — a request made
*immediately* after the swap can still see the pre-swap state and wrongly
appear to pass through. This is not a bug in the checks; it was confirmed with a
plain `container exec` process outside the plugin entirely, so it is the mount
itself, not this codebase. **Always sleep at least 2 seconds after the swap
before asserting rejection**, or a working check will look broken. See
`docs/ARCHITECTURE.md §9` for the full account — it also means the accepted
TOCTOU risk there is closer to a one-second window than a microsecond one.

## A note on comparing text

Fixture text is written to a file and compared by reading both files in Python.
Interpolating prose containing newlines or emoji into a shell or Python literal
produces spurious failures while the stored bytes are perfectly correct — this
bit the Phase 1.5 spike, and it bit this harness once during development.

## Leftover data

There is no `DELETE` route in Phase 2, so each run leaves its projects behind in
`sillynovel-test-a`'s directory. Harmless for a disposable test account; Phase 5
adds cleanup along with deletion.
