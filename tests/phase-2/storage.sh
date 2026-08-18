#!/usr/bin/env bash
#
# SillyNovel Phase 2 — storage integration tests.
#
# Implements the read/create/replace scenarios of tests/phase-1.5/SPEC.md
# against the real storage routes, plus the compare-and-swap and If-Match
# cases that are new in Phase 2.
#
# SAFE TO RUN. It does not stop the container and does not delete anything
# outside its own freshly created projects. Destructive scenarios (symlink
# swaps, container restarts) stay manual — see README.md.
#
# Requires: the container running, and passwordless local test users
# `sillynovel-test-a` and `sillynovel-test-b`. Never uses `default-user`,
# which is Admin and can read every user's data by design.
#
#   ./tests/phase-2/storage.sh
#
set -u

BASE="${SILLYNOVEL_BASE:-http://127.0.0.1:8000}"
API="$BASE/api/plugins/sillynovel"

COOKIE_DIR=$(mktemp -d)
chmod 700 "$COOKIE_DIR"
BODY_DIR=$(mktemp -d)
trap 'rm -rf "$COOKIE_DIR" "$BODY_DIR"' EXIT

JAR_A="$COOKIE_DIR/a.jar"
JAR_B="$COOKIE_DIR/b.jar"
R="$BODY_DIR/body"

PASS=0
FAIL=0
declare -a FAILURES=()

check() {
  local desc="$1" cond="$2"
  if [ "$cond" = "1" ]; then
    PASS=$((PASS + 1)); printf 'PASS  %s\n' "$desc"
  else
    FAIL=$((FAIL + 1)); FAILURES+=("$desc"); printf 'FAIL  %s\n' "$desc"
  fi
}

jget() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))" 2>/dev/null; }

login() {
  local jar="$1" handle="$2" csrf
  csrf=$(curl -s -c "$jar" -b "$jar" "$BASE/csrf-token" | jget token)
  curl -s -c "$jar" -b "$jar" -X POST "$BASE/api/users/login" \
    -H "Content-Type: application/json" -H "X-CSRF-Token: $csrf" \
    -d "{\"handle\":\"$handle\"}" > /dev/null
  echo "$csrf"
}

# req <outfile> <method> <url> <jar> <csrf|""> [data] [extra-header]
req() {
  local out="$1" method="$2" url="$3" jar="$4" csrf="$5" data="${6:-}" extra="${7:-}"
  local -a args=(-s -o "$out" -w '%{http_code}' -b "$jar" -X "$method" "$url")
  [ -n "$csrf" ] && args+=(-H "X-CSRF-Token: $csrf")
  [ -n "$extra" ] && args+=(-H "$extra")
  [ -n "$data" ] && args+=(-H "Content-Type: application/json" -d "$data")
  curl "${args[@]}"
}

etag_of() {
  curl -s -D- -o /dev/null -b "$1" "$2" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}'
}

echo "== setup =="
CSRF_A=$(login "$JAR_A" "sillynovel-test-a")
CSRF_B=$(login "$JAR_B" "sillynovel-test-b")

CODE=$(req "$R" POST "$API/projects" "$JAR_A" "$CSRF_A" '{"title":"Harness project"}')
PID=$(jget id < "$R")
check "create project -> 201 (code=$CODE)" "$([ "$CODE" = "201" ] && echo 1 || echo 0)"

CODE=$(req "$R" POST "$API/projects/$PID/chapters" "$JAR_A" "$CSRF_A" '{"title":"Chapter one"}')
CID=$(jget id < "$R")
check "create chapter -> 201 (code=$CODE)" "$([ "$CODE" = "201" ] && echo 1 || echo 0)"

echo
echo "== 1. middleware gates =="

CODE=$(curl -s -o "$R" -w '%{http_code}' "$API/projects")
UNSUCC=$([ "$CODE" -lt 200 ] || [ "$CODE" -ge 300 ] && echo 1 || echo 0)
check "unauthenticated GET unsuccessful (code=$CODE)" "$UNSUCC"
check "unauthenticated GET leaks no project data" \
  "$(grep -q '"projects"' "$R" && echo 0 || echo 1)"

CODE=$(req "$R" POST "$API/projects" "$JAR_A" "" '{"title":"no csrf"}')
check "POST without CSRF rejected (code=$CODE)" "$([ "$CODE" != "201" ] && echo 1 || echo 0)"

CODE=$(req "$R" POST "$API/projects" "$JAR_B" "$CSRF_A" '{"title":"cross session"}')
check "A's CSRF token with B's session rejected (code=$CODE)" \
  "$([ "$CODE" != "201" ] && echo 1 || echo 0)"

echo
echo "== 2. compare-and-swap (new in Phase 2) =="

TAG=$(etag_of "$JAR_A" "$API/projects/$PID/chapters/$CID")
CODE=$(req "$R" PUT "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" \
  '{"content":"version one"}' "If-Match: $TAG")
check "write with current If-Match -> 200 (code=$CODE)" "$([ "$CODE" = "200" ] && echo 1 || echo 0)"

CODE=$(req "$R" PUT "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" \
  '{"content":"version two"}' "If-Match: $TAG")
check "write with stale If-Match -> 412 (code=$CODE)" "$([ "$CODE" = "412" ] && echo 1 || echo 0)"

req "$R" GET "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" > /dev/null
check "rejected write changed nothing" \
  "$([ "$(jget content < "$R")" = "version one" ] && echo 1 || echo 0)"

# Two simultaneous writers holding the same ETag: exactly one must win, and the
# loser must be TOLD it lost. Without a server-side lock both pass the hash
# comparison and both report success.
TAG=$(etag_of "$JAR_A" "$API/projects/$PID/chapters/$CID")
req "$BODY_DIR/r1" PUT "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" \
  '{"content":"CONCURRENT-ALPHA"}' "If-Match: $TAG" > "$BODY_DIR/c1" &
req "$BODY_DIR/r2" PUT "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" \
  '{"content":"CONCURRENT-BETA"}' "If-Match: $TAG" > "$BODY_DIR/c2" &
wait
C1=$(cat "$BODY_DIR/c1"); C2=$(cat "$BODY_DIR/c2")
OK_COUNT=$(( $([ "$C1" = "200" ] && echo 1 || echo 0) + $([ "$C2" = "200" ] && echo 1 || echo 0) ))
CONFLICT_COUNT=$(( $([ "$C1" = "412" ] && echo 1 || echo 0) + $([ "$C2" = "412" ] && echo 1 || echo 0) ))
check "concurrent same-ETag writes: exactly one 200 (got $C1/$C2)" \
  "$([ "$OK_COUNT" = "1" ] && echo 1 || echo 0)"
check "concurrent same-ETag writes: the other gets 412" \
  "$([ "$CONFLICT_COUNT" = "1" ] && echo 1 || echo 0)"

req "$R" GET "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" > /dev/null
FINAL=$(jget content < "$R")
WINNER=$([ "$C1" = "200" ] && echo "CONCURRENT-ALPHA" || echo "CONCURRENT-BETA")
check "final bytes equal the winner's ($FINAL)" \
  "$([ "$FINAL" = "$WINNER" ] && echo 1 || echo 0)"

# A content hash does not advance when the bytes do not change.
TAG=$(etag_of "$JAR_A" "$API/projects/$PID/chapters/$CID")
CODE=$(req "$R" PUT "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" \
  "{\"content\":\"$FINAL\"}" "If-Match: $TAG")
SAME=$(jget etag < "$R")
check "identical save succeeds (code=$CODE)" "$([ "$CODE" = "200" ] && echo 1 || echo 0)"
check "identical save returns the SAME etag, not an advance" \
  "$([ "\"$SAME\"" = "$TAG" ] && echo 1 || echo 0)"

echo
echo "== 3. If-Match validation =="

TAG=$(etag_of "$JAR_A" "$API/projects/$PID/chapters/$CID")
CODE=$(req "$R" PUT "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" '{"content":"x"}')
check "missing If-Match rejected (code=$CODE)" "$([ "$CODE" != "200" ] && echo 1 || echo 0)"

for bad_desc in 'wildcard:*' \
                "weak:W/$TAG" \
                "multi:$TAG, \"deadbeef\"" \
                'unquoted:0123456789abcdef' \
                'malformed:"not-a-hash"'; do
  label="${bad_desc%%:*}"; value="${bad_desc#*:}"
  CODE=$(req "$R" PUT "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" \
    '{"content":"should not land"}' "If-Match: $value")
  check "If-Match $label rejected (code=$CODE)" "$([ "$CODE" != "200" ] && echo 1 || echo 0)"
done

req "$R" GET "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" > /dev/null
check "no rejected If-Match write landed" \
  "$([ "$(jget content < "$R")" = "$FINAL" ] && echo 1 || echo 0)"

echo
echo "== 4. hostile identifiers =="

for hostile in '..%2F..%2Fetc%2Fpasswd' \
               '%2Fetc%2Fpasswd' \
               '%00' \
               'aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee' \
               "$CID-evil" \
               "$(printf 'a%.0s' $(seq 1 4096))"; do
  CODE=$(req "$R" GET "$API/projects/$PID/chapters/$hostile" "$JAR_A" "$CSRF_A")
  LEAK=$(grep -qiE '/home/node|/data/|\.sillynovel' "$R" && echo 1 || echo 0)
  check "hostile id rejected (code=$CODE)" "$([ "$CODE" != "200" ] && echo 1 || echo 0)"
  check "hostile id response discloses no path" "$([ "$LEAK" = "0" ] && echo 1 || echo 0)"
done

echo
echo "== 5. cross-user isolation (A -> B, never default-user) =="

CODE=$(req "$R" GET "$API/projects/$PID" "$JAR_B" "$CSRF_B")
check "B cannot read A's project (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"

CODE=$(req "$R" GET "$API/projects/$PID/chapters/$CID" "$JAR_B" "$CSRF_B")
check "B cannot read A's chapter (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"

TAG=$(etag_of "$JAR_A" "$API/projects/$PID/chapters/$CID")
CODE=$(req "$R" PUT "$API/projects/$PID/chapters/$CID" "$JAR_B" "$CSRF_B" \
  '{"content":"B OVERWRITE"}' "If-Match: $TAG")
check "B cannot replace A's chapter (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"

req "$R" GET "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" > /dev/null
check "A re-reads: B's attempts had zero side effect" \
  "$([ "$(jget content < "$R")" = "$FINAL" ] && echo 1 || echo 0)"

CODE=$(req "$R" GET "$API/projects" "$JAR_B" "$CSRF_B")
check "B's project list does not contain A's project" \
  "$(grep -q "$PID" "$R" && echo 0 || echo 1)"

echo
echo "== 6. payload contracts =="

TAG=$(etag_of "$JAR_A" "$API/projects/$PID/chapters/$CID")
CODE=$(req "$R" PUT "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" \
  '{"content":12345}' "If-Match: $TAG")
check "non-string content -> 400 (code=$CODE)" "$([ "$CODE" = "400" ] && echo 1 || echo 0)"

CODE=$(req "$R" PUT "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" \
  '{}' "If-Match: $TAG")
check "missing content -> 400 (code=$CODE)" "$([ "$CODE" = "400" ] && echo 1 || echo 0)"

# Round-trip of awkward text. The fixture never passes through the shell as a
# string — it is written to a file, sent with --data-binary @file, and compared
# by reading both files in Python. Interpolating this data into a shell or
# Python literal produces spurious failures while the stored bytes are correct,
# which is exactly what happened during the Phase 1.5 spike.
python3 -c "
import json
json.dump({'content': '  leading\n\ntabs\ttoo\n日本語 café 🌒 ends with space  '},
          open('$BODY_DIR/fixture.json', 'w'))
"
TAG=$(etag_of "$JAR_A" "$API/projects/$PID/chapters/$CID")
curl -s -o /dev/null -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" -H "Content-Type: application/json" \
  -H "If-Match: $TAG" -X PUT "$API/projects/$PID/chapters/$CID" \
  --data-binary "@$BODY_DIR/fixture.json"
req "$R" GET "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" > /dev/null
MATCH=$(python3 -c "
import json
sent = json.load(open('$BODY_DIR/fixture.json'))['content']
got  = json.load(open('$R'))['content']
print(1 if repr(sent) == repr(got) else 0)
")
check "unicode/whitespace round-trip byte-identical" "$MATCH"
FINAL=$(python3 -c "import json;print(json.load(open('$BODY_DIR/fixture.json'))['content'], end='')")

# Byte-cap boundary. MAX_CHAPTER_BYTES is 1 MiB; content is built directly into
# a JSON file so a 1MB+ payload never passes through a shell variable.
python3 -c "
import json
json.dump({'content': 'x' * (1024 * 1024 - 200)}, open('$BODY_DIR/under_cap.json', 'w'))
json.dump({'content': 'x' * (1024 * 1024 + 200)}, open('$BODY_DIR/over_cap.json', 'w'))
# Many 3-byte UTF-8 characters: character COUNT alone looks far under any
# reasonable cap, but BYTE length exceeds it. Catches a cap mistakenly
# enforced on .length instead of Buffer.byteLength.
json.dump({'content': '日' * 400000}, open('$BODY_DIR/multibyte_over_cap.json', 'w'))
"

TAG=$(etag_of "$JAR_A" "$API/projects/$PID/chapters/$CID")
CODE=$(curl -s -o "$R" -w '%{http_code}' -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" \
  -H "Content-Type: application/json" -H "If-Match: $TAG" \
  -X PUT "$API/projects/$PID/chapters/$CID" --data-binary "@$BODY_DIR/under_cap.json")
check "just-under byte cap accepted (code=$CODE)" "$([ "$CODE" = "200" ] && echo 1 || echo 0)"

TAG=$(jget etag < "$R")
CODE=$(curl -s -o "$R" -w '%{http_code}' -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" \
  -H "Content-Type: application/json" -H "If-Match: \"$TAG\"" \
  -X PUT "$API/projects/$PID/chapters/$CID" --data-binary "@$BODY_DIR/over_cap.json")
check "just-over byte cap rejected -> 413 (code=$CODE)" "$([ "$CODE" = "413" ] && echo 1 || echo 0)"

CODE=$(curl -s -o "$R" -w '%{http_code}' -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" \
  -H "Content-Type: application/json" -H "If-Match: \"$TAG\"" \
  -X PUT "$API/projects/$PID/chapters/$CID" --data-binary "@$BODY_DIR/multibyte_over_cap.json")
check "multi-byte over byte cap (not char count) rejected -> 413 (code=$CODE)" \
  "$([ "$CODE" = "413" ] && echo 1 || echo 0)"

req "$R" GET "$API/projects/$PID/chapters/$CID" "$JAR_A" "$CSRF_A" > /dev/null
UNDER_CAP_CONTENT=$(python3 -c "import json;print(json.load(open('$BODY_DIR/under_cap.json'))['content'], end='')")
check "rejected over-cap writes changed nothing (chapter still holds the under-cap write)" \
  "$([ "$(jget content < "$R")" = "$UNDER_CAP_CONTENT" ] && echo 1 || echo 0)"

# Valid-shaped but never-created identifier, and replace-of-missing-target.
MISSING_ID=$(python3 -c "import uuid;print(uuid.uuid4())")

CODE=$(req "$R" GET "$API/projects/$PID/chapters/$MISSING_ID" "$JAR_A" "$CSRF_A")
check "well-formed but nonexistent chapter id -> 404 (code=$CODE)" \
  "$([ "$CODE" = "404" ] && echo 1 || echo 0)"

CODE=$(req "$R" PUT "$API/projects/$PID/chapters/$MISSING_ID" "$JAR_A" "$CSRF_A" \
  '{"content":"should never land"}' 'If-Match: "0000000000000000000000000000000000000000000000000000000000000000"')
check "replace of missing target -> 404, not a match-failure code (code=$CODE)" \
  "$([ "$CODE" = "404" ] && echo 1 || echo 0)"

CODE=$(req "$R" GET "$API/projects/$PID/chapters/$MISSING_ID" "$JAR_A" "$CSRF_A")
check "replace of missing target created nothing (still 404 after)" \
  "$([ "$CODE" = "404" ] && echo 1 || echo 0)"

echo
echo "== 7. reconciliation reads do not write =="

BEFORE=$(req "$R" GET "$API/projects/$PID" "$JAR_A" "$CSRF_A"; cat "$R")
sleep 1
req "$R" GET "$API/projects/$PID" "$JAR_A" "$CSRF_A" > /dev/null
AFTER=$(cat "$R")
check "repeated project GET is stable" "$([ "$BEFORE" != "" ] && [ "${BEFORE#*\{}" = "${AFTER#*\{}" ] && echo 1 || echo 0)"

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'FAILED: %s\n' "${FAILURES[@]}"
  exit 1
fi
