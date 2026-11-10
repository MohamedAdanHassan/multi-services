#!/usr/bin/env bash
# Read-only curl matrix for Delivery Runner → Vehicle Type (#sub-156).
#
# This registration is NOT a row slice, and that is the whole thing under test. The legacy
# `store_vehicle_type.php?eType=runner` renamed its page script and re-suffixed the five keys
# it checked, and left line 39's `AND eType = 'DeliverAll'` alone — so `runner` and `genie`
# serve the identical two rows (406, 407) of the shared `vehicle_type` table, and the seeded
# sub-group says as much in its own name: "Vehicle Type (Please note that Vehicle Type defined
# here will be applied into Delivery Genie, Delivery Runner & Store Deliveries.)".
#
# So the cases below do three things: prove the runner app answers at all, prove its list and
# its row payloads are byte-for-byte genie's (one row, two menus — not a copy), and prove the
# runner app still cannot reach a taxi / parcel / UberX row, since the shared scope is
# DeliverAll and nothing wider. The `-deliverall` and `-medical` key families sit in RBAC over
# the same table but were never registered as `:app` entries, and stay rejected here.
#
# Usage: bash scripts/b156-read.sh
set -u
API=${API:-http://localhost:4000/api}
JAR=$(mktemp -p .)
CSRF='X-Requested-With: XMLHttpRequest'
trap 'rm -f "$JAR"' EXIT

PASS=0
FAIL=0

login() {
  curl -s -c "$JAR" -H "$CSRF" -H 'Content-Type: application/json' \
    -d '{"email":"admin.test@ondemand.local","password":"TestPass123!"}' \
    "$API/auth/login" | head -c 200
  echo
}

# <label> <expected status> <method> <path> [body]
hit() {
  local label=$1 want=$2 method=$3 path=$4 body=${5:-}
  local out code
  if [ -n "$body" ]; then
    out=$(curl -s -b "$JAR" -H "$CSRF" -H 'Content-Type: application/json' -X "$method" \
      -w '\n%{http_code}' -d "$body" "$API$path")
  else
    out=$(curl -s -b "$JAR" -H "$CSRF" -X "$method" -w '\n%{http_code}' "$API$path")
  fi
  code=${out##*$'\n'}
  printf '%-62s %s' "$label" "$code"
  if [ "$code" = "$want" ]; then echo '  OK'; PASS=$((PASS+1))
  else echo "  FAIL (want $want): $(echo "${out%$'\n'*}" | head -c 300)"; FAIL=$((FAIL+1)); fi
}

# <label> <path> <python expression over the parsed body>
expect() {
  local label=$1 path=$2 expr=$3 got
  got=$(curl -s -b "$JAR" -H "$CSRF" "$API$path" | python3 -c \
    "import sys,json;o=json.load(sys.stdin);print('YES' if ($expr) else 'NO')" 2>/dev/null)
  printf '%-62s %s' "$label" "$got"
  if [ "$got" = YES ]; then echo '  OK'; PASS=$((PASS+1)); else echo "  FAIL: $expr"; FAIL=$((FAIL+1)); fi
}

# <label> <pathA> <pathB> — the two bodies equal as parsed JSON, i.e. one row seen twice.
same() {
  local label=$1 a=$2 b=$3 got
  got=$(python3 -c "
import json,subprocess
def get(p):
    out = subprocess.run(['curl','-s','-b','$JAR','-H','$CSRF','$API'+p],
                         capture_output=True, text=True).stdout
    return json.loads(out)
print('YES' if get('$a') == get('$b') else 'NO')" 2>/dev/null)
  printf '%-62s %s' "$label" "$got"
  if [ "$got" = YES ]; then echo '  OK'; PASS=$((PASS+1)); else echo "  FAIL: $a <> $b"; FAIL=$((FAIL+1)); fi
}

# <label> <path> <needle> — the raw body contains the text.
has() {
  local label=$1 path=$2 needle=$3
  curl -s -b "$JAR" -H "$CSRF" "$API$path" | grep -qF -- "$needle"
  local rc=$?
  printf '%-62s %s' "$label" "$([ $rc -eq 0 ] && echo YES || echo NO)"
  if [ $rc -eq 0 ]; then echo '  OK'; PASS=$((PASS+1)); else echo "  FAIL: no '$needle'"; FAIL=$((FAIL+1)); fi
}

login

echo '--- reads: the runner app answers over the shared DeliverAll slice ---'
hit 'GET /vehicle-type/runner/list (was an unknown app)' 200 GET /vehicle-type/runner/list
expect 'runner list holds exactly the two DeliverAll rows' /vehicle-type/runner/list \
  'o["total"] == 2 and sorted(i["id"] for i in o["items"]) == [406, 407]'
expect 'the list rows keep the legacy money columns' /vehicle-type/runner/list \
  'all({"deliveryCharge","cancelCharge","radius","commission","persons"} <= set(i) for i in o["items"])'
expect 'the row keeps its own name and icon' /vehicle-type/runner/list \
  'any(i["id"] == 407 and i["name"] == "Car" and i["iconType"] == "Car" for i in o["items"])'
expect 'both shipped rows are fully translated (26 of 26)' /vehicle-type/runner/list \
  'all(i["namesFilled"] == 26 and i["languagesTotal"] == 26 for i in o["items"])'
expect 'the runner detail reports the shared eType' /vehicle-type/runner/406 \
  'o["item"]["readonly"]["eType"] == "DeliverAll"'
expect 'the runner form offers the same 26 languages' /vehicle-type/runner/406 \
  'len(o["item"]["languages"]) == 26 and len(o["item"]["settings"]) == 44'
hit 'GET /vehicle-type/runner/406 (shared row)' 200 GET /vehicle-type/runner/406
hit 'GET /vehicle-type/runner/407 (shared row)' 200 GET /vehicle-type/runner/407
hit 'GET /vehicle-type/runner/defaults' 200 GET /vehicle-type/runner/defaults
expect 'defaults are a blank row of the shared slice' /vehicle-type/runner/defaults \
  'o["item"]["id"] == 0 and o["item"]["readonly"]["eType"] == "DeliverAll"'
expect 'defaults carry no category options, as genie has none' /vehicle-type/runner/defaults \
  'o["item"]["scopeOptions"]["categories"] == []'
hit 'GET /vehicle-type/runner/list?page=1&limit=50' 200 GET '/vehicle-type/runner/list?page=1&limit=50'
hit 'GET /vehicle-type/runner/list?status=Active' 200 GET '/vehicle-type/runner/list?status=Active'
hit 'GET /vehicle-type/runner/list?search=Car' 200 GET '/vehicle-type/runner/list?search=Car'
expect 'search narrows to the one Car row' '/vehicle-type/runner/list?search=Car' \
  'o["total"] == 1 and o["items"][0]["id"] == 407'
expect 'search for a taxi word finds nothing here' '/vehicle-type/runner/list?search=Luxurious' \
  'o["total"] == 0'

echo '--- reads: runner and genie are one row seen twice, not two copies ---'
same 'runner list body == genie list body' /vehicle-type/runner/list /vehicle-type/genie/list
same 'runner 406 detail == genie 406 detail' /vehicle-type/runner/406 /vehicle-type/genie/406
same 'runner 407 detail == genie 407 detail' /vehicle-type/runner/407 /vehicle-type/genie/407
same 'runner defaults == genie defaults' /vehicle-type/runner/defaults /vehicle-type/genie/defaults

echo '--- reads: the shared scope is DeliverAll and nothing wider ---'
hit 'GET /vehicle-type/runner/1 (a Ride row) 404' 404 GET /vehicle-type/runner/1
hit 'GET /vehicle-type/runner/2 (a Ride row) 404' 404 GET /vehicle-type/runner/2
hit 'GET /vehicle-type/runner/8 (an UberX row) 404' 404 GET /vehicle-type/runner/8
hit 'GET /vehicle-type/runner/29 (an UberX row) 404' 404 GET /vehicle-type/runner/29
hit 'GET /vehicle-type/runner/397 (a parcel row) 404' 404 GET /vehicle-type/runner/397
hit 'GET /vehicle-type/ride/406 (the shared row, from ride) 404' 404 GET /vehicle-type/ride/406
hit 'GET /vehicle-type/delivery/406 (the shared row, from parcel) 404' 404 GET /vehicle-type/delivery/406
expect 'runner list never grows into the taxi slice' /vehicle-type/runner/list \
  'all(i["id"] not in (1, 2, 3) for i in o["items"])'

echo '--- reads: unregistered key families stay unregistered ---'
hit 'GET /vehicle-type/medical/list (keys exist, no :app) 400' 400 GET /vehicle-type/medical/list
hit 'GET /vehicle-type/deliverall/list (keys exist, no :app) 400' 400 GET /vehicle-type/deliverall/list
hit 'GET /vehicle-type/store/list (no such app) 400' 400 GET /vehicle-type/store/list
hit 'GET /vehicle-type/runner/999999 (missing) 404' 404 GET /vehicle-type/runner/999999
hit 'GET /vehicle-type/runner/abc (bad id) 400' 400 GET /vehicle-type/runner/abc
hit 'GET /vehicle-type/list (old flat path gone) 404' 404 GET /vehicle-type/list

echo '--- reads: the slice is real, so a deleted row stays hidden from both menus ---'
expect 'no Deleted DeliverAll row leaks into the runner list' /vehicle-type/runner/list \
  'all(i["status"] != "Deleted" for i in o["items"])'

echo '--- auth: every runner path demands a session ---'
for p in /vehicle-type/runner/list /vehicle-type/runner/406 /vehicle-type/runner/defaults; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "$CSRF" "$API$p")
  printf '%-62s %s' "GET $p without a cookie" "$code"
  if [ "$code" = 401 ]; then echo '  OK'; PASS=$((PASS+1)); else echo '  FAIL (want 401)'; FAIL=$((FAIL+1)); fi
done

echo '--- the RBAC tree carries the five runner keys under sub-group 156 ---'
for k in view create edit delete update-status; do
  has "tree carries ${k}-vehicle-type-runner-delivery" /permissions/tree "${k}-vehicle-type-runner-delivery"
done
has 'tree still carries the genie family alongside it' /permissions/tree \
  'view-vehicle-type-genie-delivery'

echo
echo "read matrix: $PASS OK, $FAIL FAIL"
[ "$FAIL" -eq 0 ] || exit 1
