#!/usr/bin/env bash
# Read-only curl matrix for Delivery Runner → Delivery Charges (#sub-157).
#
# There is no row slice to prove here, and that is the point. `delivery_charges.php` reads
# `?eType=runner` only to rename its page script and re-suffix the five keys it checks
# (lines 13–31); its list query is `FROM delivery_charges dc LEFT JOIN location_master …
# WHERE 1 = 1` (lines 106, 131), and the table has no service-line column to add to that.
# So the runner menu prices exactly the rows Genie (#sub-154) prices, which is what sub-group
# 157's own seeded name warns about: "Delivery Charges(Please note that Delivery Charges
# defined here will be applied into Delivery Genie, Delivery Runner & Store Deliveries.)".
#
# The cases below therefore do three things: prove the runner app answers at all, prove its
# list / row / defaults payloads are byte-for-byte genie's (one table, two menus — not a copy
# that could drift), and prove the keys guarding it are the runner family under sub-group 157,
# edit included even though the seed gave that key the last id (847). An entry that quietly
# grew a runner-only scope, or that reused genie's keys, fails here.
#
# Two live facts shape the expectations: the table holds ONE row (#1, All locations, band
# 0→200), and `location_master` holds NO row tagged `eFor='UserDeliveryCharge'`, so the zone
# dropdown both menus offer is empty and the 0 sentinel is the only legal scope outside a
# seeded zone. Both module switches are on, so nine field specs exist and one scheme prices
# one distance band.
#
# Usage: bash scripts/b157-read.sh
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

# <label> <pathA> <pathB> — the two bodies equal as parsed JSON, i.e. one table seen twice.
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

# <label> <subGroupId> <permission_name> — the tree carries that exact key under that sub-group.
under() {
  local label=$1 sub=$2 key=$3 got
  got=$(curl -s -b "$JAR" -H "$CSRF" "$API/permissions/tree" | python3 -c "
import sys, json
want_sub, want_key = int('$sub'), '$key'
tree = json.load(sys.stdin)
hits = [p for g in tree for s in g.get('subGroups', []) if s['id'] == want_sub
        for p in s['permissions'] if p['permission_name'] == want_key]
print('YES' if len(hits) == 1 else 'NO')" 2>/dev/null)
  printf '%-62s %s' "$label" "$got"
  if [ "$got" = YES ]; then echo '  OK'; PASS=$((PASS+1)); else echo "  FAIL: $key not under sub-$sub"; FAIL=$((FAIL+1)); fi
}

login

echo '--- reads: the runner app answers over the whole shared table ---'
hit 'GET /delivery-charge/runner/list (was an unknown app)' 200 GET /delivery-charge/runner/list
expect 'runner list holds every live row, not a runner slice' /delivery-charge/runner/list \
  'o["total"] == len(o["items"]) and o["total"] >= 1'
expect 'the shipped All-locations scheme is listed here' /delivery-charge/runner/list \
  'any(r["id"] == 1 and r["scopeLabel"] == "All locations" for r in o["items"])'
expect 'the list keeps the legacy money columns' /delivery-charge/runner/list \
  'all({"orderPrice","chargeAbove","chargeBelow","freeOrderSubtotal","freeRadius","buyAnyCompleted","buyAnyCancelled"} <= set(r) for r in o["items"])'
expect 'the list keeps the band columns the distance-wise switch exposes' /delivery-charge/runner/list \
  'all(r["distanceFrom"] == 0 and r["distanceTo"] == 200 and r["distanceOpen"] is False for r in o["items"] if r["id"] == 1)'
expect 'runner reads the same switches genie reads' /delivery-charge/runner/list \
  'o["features"] == {"distanceWise": True, "buyAnyService": True}'
expect 'and the same currency' /delivery-charge/runner/list 'o["currency"]["name"] == "USD"'
expect 'and no zone tagged for this screen, which is the live census' /delivery-charge/runner/list \
  'o["locations"] == []'
hit 'GET /delivery-charge/runner/1 (the All-locations row)' 200 GET /delivery-charge/runner/1
expect 'the runner detail reports the shared scope label' /delivery-charge/runner/1 \
  'o["item"]["scope"]["label"] == "All locations" and o["item"]["scope"]["locationId"] == 0'
expect 'the shared row reads its stored amounts' /delivery-charge/runner/1 \
  'o["item"]["settings"]["fOrderPriceValue"] == "50" and o["item"]["settings"]["fDeliveryChargeAbove"] == "5" and o["item"]["settings"]["fDeliveryChargeBuyAnyService"] == "15"'
expect 'the shared row shows the band it was priced in' /delivery-charge/runner/1 \
  'o["item"]["distance"]["label"] == "0 – 200 km" and o["item"]["distance"]["open"] is False'
expect 'distance-wise freezes the scope of a scheme, from either menu' /delivery-charge/runner/1 \
  'o["item"]["scopeEditable"] is False'
expect 'nine specs, two of them behind the Buy Any Service switch' /delivery-charge/runner/1 \
  'len(o["item"]["fieldSpecs"]) == 9 and sum(1 for s in o["item"]["fieldSpecs"] if s.get("feature") == "buyAnyService") == 2'
hit 'GET /delivery-charge/runner/defaults' 200 GET /delivery-charge/runner/defaults
expect 'defaults are a blank scheme of nine specs' /delivery-charge/runner/defaults \
  'o["item"]["id"] == 0 and len(o["item"]["fieldSpecs"]) == 9'
expect 'defaults open with the ∞ band the list shows' /delivery-charge/runner/defaults \
  'o["item"]["distance"]["open"] is True and "∞" in o["item"]["distance"]["label"]'
expect 'a new scheme may still choose its scope' /delivery-charge/runner/defaults \
  'o["item"]["scopeEditable"] is True and o["item"]["scope"]["locationId"] == 0'
hit 'GET /delivery-charge/runner/list?page=1&limit=50' 200 GET '/delivery-charge/runner/list?page=1&limit=50'
expect 'the paged form adds the page fields around the same rows' \
  '/delivery-charge/runner/list?page=1&limit=50' \
  'o["page"] == 1 and o["limit"] == 50 and o["pages"] == 1 and [r["id"] for r in o["items"]] == [1]'
hit 'GET /delivery-charge/runner/list?status=Active' 200 GET '/delivery-charge/runner/list?status=Active'
hit 'GET /delivery-charge/runner/list?search=50' 200 GET '/delivery-charge/runner/list?search=50'
hit 'GET /delivery-charge/runner/list?sort=orderPrice&order=asc' 200 GET '/delivery-charge/runner/list?sort=orderPrice&order=asc'
hit 'GET .../list?sort=location (whitelisted)' 200 GET '/delivery-charge/runner/list?sort=location&order=desc'
hit 'GET .../list?status=Deleted (unknown filter)' 200 GET '/delivery-charge/runner/list?status=Deleted'
expect 'an unknown status filters nothing rather than everything' \
  '/delivery-charge/runner/list?status=Deleted' 'o["total"] == len(o["items"]) and o["total"] >= 1'
hit 'GET .../list?sort=id;DROP (injection falls back)' 200 GET '/delivery-charge/runner/list?sort=id%3B%20DROP'

echo '--- reads: runner and genie are one table seen twice, not two copies ---'
same 'runner list body == genie list body' /delivery-charge/runner/list /delivery-charge/genie/list
same 'runner 1 detail == genie 1 detail' /delivery-charge/runner/1 /delivery-charge/genie/1
same 'runner defaults == genie defaults' /delivery-charge/runner/defaults /delivery-charge/genie/defaults
same 'paged runner list == paged genie list' '/delivery-charge/runner/list?page=1&limit=50' '/delivery-charge/genie/list?page=1&limit=50'
same 'searched runner list == searched genie list' '/delivery-charge/runner/list?search=50' '/delivery-charge/genie/list?search=50'
same 'sorted runner list == sorted genie list' '/delivery-charge/runner/list?sort=orderPrice&order=asc' '/delivery-charge/genie/list?sort=orderPrice&order=asc'

echo '--- reads: apps that never owned this screen stay unregistered ---'
hit 'GET /delivery-charge/store/list (no such menu) 400' 400 GET /delivery-charge/store/list
hit 'GET /delivery-charge/deliverall/list (no such menu) 400' 400 GET /delivery-charge/deliverall/list
hit 'GET /delivery-charge/ride/list (an app of other screens) 400' 400 GET /delivery-charge/ride/list
hit 'GET /delivery-charge/runner/999999 (missing 404)' 404 GET /delivery-charge/runner/999999
hit 'GET /delivery-charge/runner/abc (bad id 400)' 400 GET /delivery-charge/runner/abc
hit 'GET /delivery-charge/runner/0 (not a row id 400)' 400 GET /delivery-charge/runner/0
hit 'GET /delivery-charge/runner/list-x (id route 400)' 400 GET /delivery-charge/runner/list-x
hit 'GET /delivery-charge/list (old flat path gone) 404' 404 GET /delivery-charge/list

echo '--- auth: every runner path demands a session ---'
for p in /delivery-charge/runner/list /delivery-charge/runner/1 /delivery-charge/runner/defaults; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "$CSRF" "$API$p")
  printf '%-62s %s' "GET $p without a cookie" "$code"
  if [ "$code" = 401 ]; then echo '  OK'; PASS=$((PASS+1)); else echo '  FAIL (want 401)'; FAIL=$((FAIL+1)); fi
done
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/delivery-charge/runner/list")
printf '%-62s %s' 'GET runner list without X-Requested-With' "$code"
if [ "$code" = 401 ]; then echo '  OK'; PASS=$((PASS+1)); else echo '  FAIL (want 401)'; FAIL=$((FAIL+1)); fi

echo '--- the RBAC tree carries the five runner keys under sub-group 157 ---'
for k in view create edit delete update-status; do
  under "tree carries ${k}-delivery-charges-runner-delivery" 157 "${k}-delivery-charges-runner-delivery"
done
under 'genie keeps its own family under sub-group 154' 154 'view-delivery-charges-genie-delivery'
under 'the un-suffixed menu keeps its key under sub-group 27' 27 'view-delivery-charges'
expect 'no runner key leaked under the genie sub-group' /permissions/tree \
  'not any(p["permission_name"].endswith("-runner-delivery") for g in o for s in g.get("subGroups", []) if s["id"] == 154 for p in s["permissions"])'

echo '--- the runner menu is one screen three menus own (names verbatim from the DB) ---'
expect 'sub-group 157 still carries the sharing warning' /permissions/tree \
  'any("will be applied into Delivery Genie, Delivery Runner & Store Deliveries" in s["name"] for g in o for s in g.get("subGroups", []) if s["id"] == 157)'
expect 'and it is filed under Delivery Runner, group 34' /permissions/tree \
  'any(g["id"] == 34 and g["name"] == "Delivery Runner" for g in o for s in g.get("subGroups", []) if s["id"] == 157)'
expect "runner's tree order is view, create, delete, update-status, edit" /permissions/tree \
  '[p["id"] for g in o for s in g.get("subGroups", []) if s["id"] == 157 for p in s["permissions"]] == [838, 839, 840, 841, 847]'

echo
echo "read matrix: $PASS OK, $FAIL FAIL"
[ "$FAIL" -eq 0 ] || exit 1
