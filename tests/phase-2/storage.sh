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
echo "== 8. the Writing Profile (Phase 3) =="

# A nested-key reader for {profile: {...}} bodies; jget reads the top level only.
pget() { python3 -c "import sys,json;print(json.load(sys.stdin).get('profile',{}).get('$1',''))"; }
put_profile() { # out url jar csrf etag-quoted json
  curl -s -o "$1" -w "%{http_code}" -b "$3" -H "X-CSRF-Token: $4" -H "Content-Type: application/json" \
    -H "If-Match: $5" -X PUT "$2" --data-binary "$6"
}
put_profile_file() { # out url jar csrf etag-quoted file
  curl -s -o "$1" -w "%{http_code}" -b "$3" -H "X-CSRF-Token: $4" -H "Content-Type: application/json" \
    -H "If-Match: $5" -X PUT "$2" --data-binary "@$6"
}

CODE=$(req "$R" POST "$API/projects" "$JAR_A" "$CSRF_A" '{"title":"Second project"}')
PID2=$(jget id < "$R")
check "second project -> 201 (code=$CODE)" "$([ "$CODE" = "201" ] && echo 1 || echo 0)"

PURL="$API/projects/$PID/profile"
PURL2="$API/projects/$PID2/profile"

# --- first run: absent file reads as the canonical default -------------------
CODE=$(req "$R" GET "$PURL" "$JAR_A" "$CSRF_A")
check "GET profile on a fresh project -> 200 (code=$CODE)" "$([ "$CODE" = "200" ] && echo 1 || echo 0)"
EMPTY=$(python3 -c "
import json; p=json.load(open('$R'))['profile']
fields=['voice','genre','pov','tense','styleInstructions','proseExamples','boundaries']
print(1 if p.get('schemaVersion')==1 and all(p.get(f)=='' for f in fields) else 0)")
check "fresh profile has schemaVersion 1 and seven empty fields" "$EMPTY"
DEFAULT_TAG=$(etag_of "$JAR_A" "$PURL")
DEFAULT_TAG2=$(etag_of "$JAR_A" "$PURL2")
check "two fresh projects share the canonical default etag" "$([ -n "$DEFAULT_TAG" ] && [ "$DEFAULT_TAG" = "$DEFAULT_TAG2" ] && echo 1 || echo 0)"

# --- compare-and-swap ----------------------------------------------------------
CODE=$(req "$R" PUT "$PURL" "$JAR_A" "$CSRF_A" '{"profile":{"voice":"dry"}}')
check "PUT profile without If-Match -> 428 (code=$CODE)" "$([ "$CODE" = "428" ] && echo 1 || echo 0)"

CODE=$(put_profile "$R" "$PURL" "$JAR_A" "$CSRF_A" "$DEFAULT_TAG" '{"profile":{"voice":"dry, close third"}}')
check "first PUT with the default etag -> 200 (code=$CODE)" "$([ "$CODE" = "200" ] && echo 1 || echo 0)"
TAG1=$(jget etag < "$R")
check "saved etag differs from the default" "$([ -n "$TAG1" ] && [ "\"$TAG1\"" != "$DEFAULT_TAG" ] && echo 1 || echo 0)"

python3 -c "
import json
json.dump({'profile': {'voice': '  leading\n\ntabs\ttoo\n日本語 café 🌒 ends with space  ', 'genre': 'gothic'}},
          open('$BODY_DIR/pfixture.json', 'w'))
"
CODE=$(put_profile_file "$R" "$PURL" "$JAR_A" "$CSRF_A" "\"$TAG1\"" "$BODY_DIR/pfixture.json")
TAG2=$(jget etag < "$R")
req "$R" GET "$PURL" "$JAR_A" "$CSRF_A" > /dev/null
MATCH=$(python3 -c "
import json
sent = json.load(open('$BODY_DIR/pfixture.json'))['profile']['voice']
got  = json.load(open('$R'))['profile']['voice']
print(1 if repr(sent) == repr(got) else 0)")
check "unicode/whitespace profile round-trip byte-identical (code=$CODE)" "$([ "$CODE" = "200" ] && [ "$MATCH" = "1" ] && echo 1 || echo 0)"

CODE=$(put_profile "$R" "$PURL" "$JAR_A" "$CSRF_A" "$DEFAULT_TAG" '{"profile":{"voice":"STALE WRITE"}}')
check "stale etag -> 412 (code=$CODE)" "$([ "$CODE" = "412" ] && echo 1 || echo 0)"
req "$R" GET "$PURL" "$JAR_A" "$CSRF_A" > /dev/null
check "rejected write changed nothing" "$([ "$(pget voice < "$R" | head -c 5)" != "STALE" ] && echo 1 || echo 0)"

# two writers, one etag: exactly one may win
put_profile "$BODY_DIR/pa.out" "$PURL" "$JAR_A" "$CSRF_A" "\"$TAG2\"" '{"profile":{"voice":"writer A"}}' > "$BODY_DIR/pa.code" &
put_profile "$BODY_DIR/pb.out" "$PURL" "$JAR_A" "$CSRF_A" "\"$TAG2\"" '{"profile":{"voice":"writer B"}}' > "$BODY_DIR/pb.code" &
wait
CA=$(cat "$BODY_DIR/pa.code"); CB=$(cat "$BODY_DIR/pb.code")
check "parallel same-etag PUTs: exactly one 200 (codes=$CA,$CB)" "$([ "$CA$CB" = "200412" ] || [ "$CA$CB" = "412200" ] && echo 1 || echo 0)"
req "$R" GET "$PURL" "$JAR_A" "$CSRF_A" > /dev/null
WINNER=$( [ "$CA" = "200" ] && echo "writer A" || echo "writer B" )
check "profile holds the winner's bytes" "$([ "$(pget voice < "$R")" = "$WINNER" ] && echo 1 || echo 0)"
TAG3=$(etag_of "$JAR_A" "$PURL")

CODE=$(put_profile "$R" "$PURL" "$JAR_A" "$CSRF_A" "$TAG3" "{\"profile\":{\"voice\":\"$WINNER\"}}")
check "identical PUT returns the same etag (code=$CODE)" "$([ "$CODE" = "200" ] && [ "\"$(jget etag < "$R")\"" = "$TAG3" ] && echo 1 || echo 0)"

for pair in 'wildcard:*' 'weak:W/"'"${TAG3//\"/}"'"' 'multi:'"$TAG3"', '"$TAG3" 'unquoted:'"${TAG3//\"/}" 'malformed:"nothex"'; do
  label="${pair%%:*}"; value="${pair#*:}"
  CODE=$(put_profile "$R" "$PURL" "$JAR_A" "$CSRF_A" "$value" '{"profile":{"voice":"BAD IF-MATCH"}}')
  check "If-Match $label rejected on profile (code=$CODE)" "$([ "$CODE" != "200" ] && echo 1 || echo 0)"
done
req "$R" GET "$PURL" "$JAR_A" "$CSRF_A" > /dev/null
check "no rejected If-Match write landed" "$([ "$(pget voice < "$R")" = "$WINNER" ] && echo 1 || echo 0)"

# --- payload contracts ---------------------------------------------------------
for bad in '{"profile":"x"}' '{"profile":[]}' '{}' '{"profile":{"voice":12}}' '{"profile":{"schemaVersion":2}}'; do
  CODE=$(put_profile "$R" "$PURL" "$JAR_A" "$CSRF_A" "$TAG3" "$bad")
  check "invalid body $bad -> 400 (code=$CODE)" "$([ "$CODE" = "400" ] && echo 1 || echo 0)"
done

python3 -c "
import json
json.dump({'profile': {'voice': 'a' * 8193}}, open('$BODY_DIR/p_over.json', 'w'))
json.dump({'profile': {'voice': '日' * 3000}}, open('$BODY_DIR/p_multi.json', 'w'))   # 9,000 bytes, 3,000 chars
json.dump({'profile': {'proseExamples': 'b' * (32 * 1024 - 10)}}, open('$BODY_DIR/p_under.json', 'w'))
json.dump({'profile': {'proseExamples': 'b' * (32 * 1024 + 10)}}, open('$BODY_DIR/p_ex_over.json', 'w'))
json.dump({'profile': {'futureKey': 'z' * (100 * 1024)}}, open('$BODY_DIR/p_total.json', 'w'))
"
CODE=$(put_profile_file "$R" "$PURL" "$JAR_A" "$CSRF_A" "$TAG3" "$BODY_DIR/p_over.json")
check "field one byte over 8 KiB -> 413 (code=$CODE)" "$([ "$CODE" = "413" ] && echo 1 || echo 0)"
CODE=$(put_profile_file "$R" "$PURL" "$JAR_A" "$CSRF_A" "$TAG3" "$BODY_DIR/p_multi.json")
check "multi-byte field over the BYTE cap (3,000 chars) -> 413 (code=$CODE)" "$([ "$CODE" = "413" ] && echo 1 || echo 0)"
CODE=$(put_profile_file "$R" "$PURL" "$JAR_A" "$CSRF_A" "$TAG3" "$BODY_DIR/p_ex_over.json")
check "prose examples over 32 KiB -> 413 (code=$CODE)" "$([ "$CODE" = "413" ] && echo 1 || echo 0)"
CODE=$(put_profile_file "$R" "$PURL" "$JAR_A" "$CSRF_A" "$TAG3" "$BODY_DIR/p_total.json")
check "unknown key of 100 KiB -> 413 profile too large (code=$CODE)" "$([ "$CODE" = "413" ] && grep -q 'profile too large' "$R" && echo 1 || echo 0)"
req "$R" GET "$PURL" "$JAR_A" "$CSRF_A" > /dev/null
check "rejected oversize writes changed nothing" "$([ "$(pget voice < "$R")" = "$WINNER" ] && echo 1 || echo 0)"
CODE=$(put_profile_file "$R" "$PURL" "$JAR_A" "$CSRF_A" "$TAG3" "$BODY_DIR/p_under.json")
check "prose examples just under 32 KiB -> 200 (code=$CODE)" "$([ "$CODE" = "200" ] && echo 1 || echo 0)"
TAG4=$(jget etag < "$R")

# --- unknown-field preservation, owned by the server ---------------------------
CODE=$(put_profile "$R" "$PURL" "$JAR_A" "$CSRF_A" "\"$TAG4\"" '{"profile":{"voice":"kept","futureKey":{"a":1}}}')
TAG5=$(jget etag < "$R")
req "$R" GET "$PURL" "$JAR_A" "$CSRF_A" > /dev/null
check "unknown key written is returned (code=$CODE)" "$([ "$(python3 -c "import json;print(json.load(open('$R'))['profile'].get('futureKey',{}).get('a'))")" = "1" ] && echo 1 || echo 0)"
CODE=$(put_profile "$R" "$PURL" "$JAR_A" "$CSRF_A" "\"$TAG5\"" '{"profile":{"voice":"kept again"}}')
TAG6=$(jget etag < "$R")
req "$R" GET "$PURL" "$JAR_A" "$CSRF_A" > /dev/null
check "unknown key SURVIVES a PUT that omits it (code=$CODE)" "$([ "$(python3 -c "import json;print(json.load(open('$R'))['profile'].get('futureKey',{}).get('a'))")" = "1" ] && echo 1 || echo 0)"
check "prose examples were REPLACED by that PUT (absent = empty)" "$([ "$(pget proseExamples < "$R")" = "" ] && echo 1 || echo 0)"
CODE=$(put_profile "$R" "$PURL" "$JAR_A" "$CSRF_A" "\"$TAG6\"" '{"profile":{"voice":"kept","futureKey":"changed"}}')
TAG7=$(jget etag < "$R")
req "$R" GET "$PURL" "$JAR_A" "$CSRF_A" > /dev/null
check "unknown key in the body wins over the file (code=$CODE)" "$([ "$(pget futureKey < "$R")" = "changed" ] && echo 1 || echo 0)"

# --- hostile identifiers on the new path ---------------------------------------
for hostile in '..%2F..%2Fetc%2Fpasswd' '%2Fetc%2Fpasswd' '%00' 'aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee' "$PID-evil" "$(printf 'a%.0s' $(seq 1 4096))"; do
  CODE=$(req "$R" GET "$API/projects/$hostile/profile" "$JAR_A" "$CSRF_A")
  LEAK=$(grep -qiE '/home/node|/data/|\.sillynovel' "$R" && echo 1 || echo 0)
  check "hostile project id on profile rejected (code=$CODE)" "$([ "$CODE" != "200" ] && echo 1 || echo 0)"
  check "hostile profile response discloses no path" "$([ "$LEAK" = "0" ] && echo 1 || echo 0)"
done
GHOST="123e4567-e89b-42d3-a456-426614174000"
CODE=$(req "$R" GET "$API/projects/$GHOST/profile" "$JAR_A" "$CSRF_A")
check "well-formed nonexistent project: GET profile -> 404 (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"
CODE=$(put_profile "$R" "$API/projects/$GHOST/profile" "$JAR_A" "$CSRF_A" "$DEFAULT_TAG" '{"profile":{"voice":"ghost"}}')
check "well-formed nonexistent project: PUT profile -> 404 (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"

# --- cross-user isolation ------------------------------------------------------
CODE=$(req "$R" GET "$PURL" "$JAR_B" "$CSRF_B")
check "user B cannot read A's profile (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"
CODE=$(put_profile "$R" "$PURL" "$JAR_B" "$CSRF_B" "\"$TAG7\"" '{"profile":{"voice":"B WAS HERE"}}')
check "user B cannot write A's profile (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"
req "$R" GET "$PURL" "$JAR_A" "$CSRF_A" > /dev/null
check "A's profile unchanged after B's attempts" "$([ "$(pget voice < "$R")" = "kept" ] && echo 1 || echo 0)"

# --- reads never write ---------------------------------------------------------
T_ONE=$(etag_of "$JAR_A" "$PURL"); sleep 1; T_TWO=$(etag_of "$JAR_A" "$PURL")
check "repeated profile GET returns the same etag" "$([ -n "$T_ONE" ] && [ "$T_ONE" = "$T_TWO" ] && echo 1 || echo 0)"

echo
echo "== 9. per-chapter notes (Phase 3) =="

put_cas() { put_profile "$@"; }            # the wrapper is generic: out url jar csrf etag-quoted json
put_cas_file() { put_profile_file "$@"; }
EMPTY_SHA='"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"'

CODE=$(req "$R" POST "$API/projects/$PID/chapters" "$JAR_A" "$CSRF_A" '{"title":"Chapter two"}')
CID2=$(jget id < "$R")
check "second chapter -> 201 (code=$CODE)" "$([ "$CODE" = "201" ] && echo 1 || echo 0)"
NURL="$API/projects/$PID/chapters/$CID/notes"
NURL2="$API/projects/$PID/chapters/$CID2/notes"
CH_TAG_BEFORE=$(etag_of "$JAR_A" "$API/projects/$PID/chapters/$CID")

# --- first run: no notes/ directory, no file -----------------------------------
CODE=$(req "$R" GET "$NURL" "$JAR_A" "$CSRF_A")
check "GET notes on a note-less chapter -> 200 (code=$CODE)" "$([ "$CODE" = "200" ] && echo 1 || echo 0)"
check "note-less chapter reads as empty content" "$([ "$(jget content < "$R")" = "" ] && echo 1 || echo 0)"
N_DEFAULT=$(etag_of "$JAR_A" "$NURL")
check "empty notes carry the digest of '' (the same etag createChapter mints)" "$([ "$N_DEFAULT" = "$EMPTY_SHA" ] && echo 1 || echo 0)"
check "two note-less chapters share that etag" "$([ "$(etag_of "$JAR_A" "$NURL2")" = "$EMPTY_SHA" ] && echo 1 || echo 0)"

# --- compare-and-swap ----------------------------------------------------------
CODE=$(req "$R" PUT "$NURL" "$JAR_A" "$CSRF_A" '{"content":"a note"}')
check "PUT notes without If-Match -> 428 (code=$CODE)" "$([ "$CODE" = "428" ] && echo 1 || echo 0)"
CODE=$(put_cas "$R" "$NURL" "$JAR_A" "$CSRF_A" "$EMPTY_SHA" '{"content":"first note"}')
check "first PUT with the empty digest creates notes/ -> 200 (code=$CODE)" "$([ "$CODE" = "200" ] && echo 1 || echo 0)"
NTAG1=$(jget etag < "$R")
check "saved notes etag differs from the empty digest" "$([ -n "$NTAG1" ] && [ "\"$NTAG1\"" != "$EMPTY_SHA" ] && echo 1 || echo 0)"
req "$R" GET "$NURL" "$JAR_A" "$CSRF_A" > /dev/null
check "GET returns the saved note" "$([ "$(jget content < "$R")" = "first note" ] && echo 1 || echo 0)"
CODE=$(put_cas "$R" "$NURL" "$JAR_A" "$CSRF_A" "$EMPTY_SHA" '{"content":"STALE"}')
check "stale notes etag -> 412 (code=$CODE)" "$([ "$CODE" = "412" ] && echo 1 || echo 0)"
req "$R" GET "$NURL" "$JAR_A" "$CSRF_A" > /dev/null
check "rejected notes write changed nothing" "$([ "$(jget content < "$R")" = "first note" ] && echo 1 || echo 0)"

put_cas "$BODY_DIR/na.out" "$NURL" "$JAR_A" "$CSRF_A" "\"$NTAG1\"" '{"content":"writer A"}' > "$BODY_DIR/na.code" &
put_cas "$BODY_DIR/nb.out" "$NURL" "$JAR_A" "$CSRF_A" "\"$NTAG1\"" '{"content":"writer B"}' > "$BODY_DIR/nb.code" &
wait
NCA=$(cat "$BODY_DIR/na.code"); NCB=$(cat "$BODY_DIR/nb.code")
check "parallel same-etag notes PUTs: exactly one 200 (codes=$NCA,$NCB)" "$([ "$NCA$NCB" = "200412" ] || [ "$NCA$NCB" = "412200" ] && echo 1 || echo 0)"
req "$R" GET "$NURL" "$JAR_A" "$CSRF_A" > /dev/null
NWINNER=$( [ "$NCA" = "200" ] && echo "writer A" || echo "writer B" )
check "notes hold the winner's bytes" "$([ "$(jget content < "$R")" = "$NWINNER" ] && echo 1 || echo 0)"
NTAG2=$(etag_of "$JAR_A" "$NURL")
CODE=$(put_cas "$R" "$NURL" "$JAR_A" "$CSRF_A" "$NTAG2" "{\"content\":\"$NWINNER\"}")
check "identical notes PUT returns the same etag (code=$CODE)" "$([ "$CODE" = "200" ] && [ "\"$(jget etag < "$R")\"" = "$NTAG2" ] && echo 1 || echo 0)"

for pair in 'wildcard:*' 'weak:W/"'"${NTAG2//\"/}"'"' 'multi:'"$NTAG2"', '"$NTAG2" 'unquoted:'"${NTAG2//\"/}" 'malformed:"nothex"'; do
  label="${pair%%:*}"; value="${pair#*:}"
  CODE=$(put_cas "$R" "$NURL" "$JAR_A" "$CSRF_A" "$value" '{"content":"BAD IF-MATCH"}')
  check "If-Match $label rejected on notes (code=$CODE)" "$([ "$CODE" != "200" ] && echo 1 || echo 0)"
done
req "$R" GET "$NURL" "$JAR_A" "$CSRF_A" > /dev/null
check "no rejected notes If-Match write landed" "$([ "$(jget content < "$R")" = "$NWINNER" ] && echo 1 || echo 0)"

# --- body contract and byte cap (section 6's fixtures) ------------------------
CODE=$(put_cas "$R" "$NURL" "$JAR_A" "$CSRF_A" "$NTAG2" '{"content":12}')
check "non-string notes -> 400 (code=$CODE)" "$([ "$CODE" = "400" ] && echo 1 || echo 0)"
CODE=$(put_cas "$R" "$NURL" "$JAR_A" "$CSRF_A" "$NTAG2" '{}')
check "missing notes content -> 400 (code=$CODE)" "$([ "$CODE" = "400" ] && echo 1 || echo 0)"
CODE=$(put_cas_file "$R" "$NURL" "$JAR_A" "$CSRF_A" "$NTAG2" "$BODY_DIR/fixture.json")
req "$R" GET "$NURL" "$JAR_A" "$CSRF_A" > /dev/null
MATCH=$(python3 -c "
import json
sent = json.load(open('$BODY_DIR/fixture.json'))['content']
got  = json.load(open('$R'))['content']
print(1 if repr(sent) == repr(got) else 0)")
check "unicode/whitespace notes round-trip byte-identical (code=$CODE)" "$([ "$CODE" = "200" ] && [ "$MATCH" = "1" ] && echo 1 || echo 0)"
NTAG3=$(etag_of "$JAR_A" "$NURL")
CODE=$(put_cas_file "$R" "$NURL" "$JAR_A" "$CSRF_A" "$NTAG3" "$BODY_DIR/over_cap.json")
check "notes just over the byte cap -> 413 (code=$CODE)" "$([ "$CODE" = "413" ] && grep -q 'notes too large' "$R" && echo 1 || echo 0)"
CODE=$(put_cas_file "$R" "$NURL" "$JAR_A" "$CSRF_A" "$NTAG3" "$BODY_DIR/multibyte_over_cap.json")
check "multi-byte notes over the BYTE cap -> 413 (code=$CODE)" "$([ "$CODE" = "413" ] && echo 1 || echo 0)"
check "rejected oversize notes changed nothing" "$([ "$(etag_of "$JAR_A" "$NURL")" = "$NTAG3" ] && echo 1 || echo 0)"
CODE=$(put_cas_file "$R" "$NURL" "$JAR_A" "$CSRF_A" "$NTAG3" "$BODY_DIR/under_cap.json")
check "notes just under the byte cap -> 200 (code=$CODE)" "$([ "$CODE" = "200" ] && echo 1 || echo 0)"
NTAG4=$(jget etag < "$R")

# --- the chapter must exist: absent-equals-empty never applies to the chapter --
CODE=$(req "$R" GET "$API/projects/$PID/chapters/$MISSING_ID/notes" "$JAR_A" "$CSRF_A")
check "notes of a nonexistent chapter: GET -> 404, not empty (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"
CODE=$(put_cas "$R" "$API/projects/$PID/chapters/$MISSING_ID/notes" "$JAR_A" "$CSRF_A" "$EMPTY_SHA" '{"content":"ghost"}')
check "notes of a nonexistent chapter: PUT -> 404 (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"
CODE=$(req "$R" GET "$API/projects/$GHOST/chapters/$CID/notes" "$JAR_A" "$CSRF_A")
check "notes under a nonexistent project: GET -> 404 (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"
CODE=$(put_cas "$R" "$API/projects/$GHOST/chapters/$CID/notes" "$JAR_A" "$CSRF_A" "$EMPTY_SHA" '{"content":"ghost"}')
check "notes under a nonexistent project: PUT -> 404 (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"

# --- hostile identifiers on BOTH segments ------------------------------------
for hostile in '..%2F..%2Fetc%2Fpasswd' '%2Fetc%2Fpasswd' '%00' 'aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee' "$CID-evil" "$(printf 'a%.0s' $(seq 1 4096))"; do
  CODE=$(req "$R" GET "$API/projects/$hostile/chapters/$CID/notes" "$JAR_A" "$CSRF_A")
  LEAK=$(grep -qiE '/home/node|/data/|\.sillynovel' "$R" && echo 1 || echo 0)
  check "hostile project id on notes rejected (code=$CODE)" "$([ "$CODE" != "200" ] && [ "$LEAK" = "0" ] && echo 1 || echo 0)"
  CODE=$(req "$R" GET "$API/projects/$PID/chapters/$hostile/notes" "$JAR_A" "$CSRF_A")
  LEAK=$(grep -qiE '/home/node|/data/|\.sillynovel' "$R" && echo 1 || echo 0)
  check "hostile chapter id on notes rejected (code=$CODE)" "$([ "$CODE" != "200" ] && [ "$LEAK" = "0" ] && echo 1 || echo 0)"
done

# --- cross-user isolation ------------------------------------------------------
CODE=$(req "$R" GET "$NURL" "$JAR_B" "$CSRF_B")
check "user B cannot read A's notes (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"
CODE=$(put_cas "$R" "$NURL" "$JAR_B" "$CSRF_B" "\"$NTAG4\"" '{"content":"B WAS HERE"}')
check "user B cannot write A's notes (code=$CODE)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)"
check "A's notes unchanged after B's attempts" "$([ "$(etag_of "$JAR_A" "$NURL")" = "\"$NTAG4\"" ] && echo 1 || echo 0)"

# --- notes never touch the chapter or the listing ------------------------------
check "chapter content untouched by notes writes" "$([ "$(etag_of "$JAR_A" "$API/projects/$PID/chapters/$CID")" = "$CH_TAG_BEFORE" ] && echo 1 || echo 0)"
req "$R" GET "$API/projects/$PID" "$JAR_A" "$CSRF_A" > /dev/null
check "notes/ invisible to the chapter listing" "$([ "$(python3 -c "import json;print(len(json.load(open('$R'))['chapters']))")" = "2" ] && echo 1 || echo 0)"

# --- reads never write ---------------------------------------------------------
T1=$(etag_of "$JAR_A" "$NURL2"); sleep 1; T2=$(etag_of "$JAR_A" "$NURL2")
check "repeated GET on a note-less chapter stays the empty digest" "$([ "$T1" = "$EMPTY_SHA" ] && [ "$T2" = "$EMPTY_SHA" ] && echo 1 || echo 0)"

# --- the race: two chapters' FIRST notes saves in one fresh project ------------
CODE=$(req "$R" POST "$API/projects" "$JAR_A" "$CSRF_A" '{"title":"Race project"}')
PID3=$(jget id < "$R")
req "$R" POST "$API/projects/$PID3/chapters" "$JAR_A" "$CSRF_A" '{"title":"R1"}' > /dev/null; RC1=$(jget id < "$R")
req "$R" POST "$API/projects/$PID3/chapters" "$JAR_A" "$CSRF_A" '{"title":"R2"}' > /dev/null; RC2=$(jget id < "$R")
put_cas "$BODY_DIR/r1.out" "$API/projects/$PID3/chapters/$RC1/notes" "$JAR_A" "$CSRF_A" "$EMPTY_SHA" '{"content":"r1"}' > "$BODY_DIR/r1.code" &
put_cas "$BODY_DIR/r2.out" "$API/projects/$PID3/chapters/$RC2/notes" "$JAR_A" "$CSRF_A" "$EMPTY_SHA" '{"content":"r2"}' > "$BODY_DIR/r2.code" &
wait
RC=$(cat "$BODY_DIR/r1.code")$(cat "$BODY_DIR/r2.code")
check "two first notes saves racing to create notes/ -> both 200 (codes=$RC)" "$([ "$RC" = "200200" ] && echo 1 || echo 0)"

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'FAILED: %s\n' "${FAILURES[@]}"
  exit 1
fi
