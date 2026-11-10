#!/usr/bin/env bash
# Read-only curl matrix for Distance wise Delivery Charges (#sub-155).
#
# Like its parent, the :app segment gates permissions and not rows: `custom_delivery_charges_order`
# has no service-line column, so the genie bands (group 33, sub 155) are the same rows the Runner
# (34/158) and the un-suffixed menu (9/27) edit. `genie` and `runner` are both registered now, so
# this matrix is the genie side plus the proof that a segment naming no registered menu is refused
# before anything is queried; `b158-read.sh` is the runner twin showing it reads identical payloads.
#
# The live install holds two bands — #1 for vehicle type 406 (0 – 200) and #2 for 407 (0 – 100) —
# so the reads below name real rows and a real search term rather than empty results.
#
# Usage: bash scripts/b155-read.sh
set -u
API=${API:-http://localhost:4000/api}
JAR=$(mktemp -p .)
CSRF='X-Requested-With: XMLHttpRequest'
trap 'rm -f "$JAR"' EXIT

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
  printf '%-56s %s' "$label" "$code"
  if [ "$code" = "$want" ]; then echo '  OK'
  else echo "  FAIL (want $want): $(echo "${out%$'\n'*}" | head -c 300)"; fi
}

login
echo '--- reads: the whole list and its paged form ---'
hit 'GET /distance-charge/genie/list' 200 GET /distance-charge/genie/list
hit 'GET .../list?page=1&limit=50' 200 GET '/distance-charge/genie/list?page=1&limit=50'
hit 'GET .../list?limit=1 (paging really pages)' 200 GET '/distance-charge/genie/list?page=2&limit=1'
hit 'GET .../list?limit=99999 (clamped, not fatal)' 200 GET '/distance-charge/genie/list?limit=99999'
hit 'GET .../list?page=99 (past the last page)' 200 GET '/distance-charge/genie/list?page=99'
hit 'GET .../list?search=Car' 200 GET '/distance-charge/genie/list?search=Car'
hit 'GET .../list?search=200 (a number in a band)' 200 GET '/distance-charge/genie/list?search=200'
hit 'GET .../list?search=%25_%28escape%29' 200 GET '/distance-charge/genie/list?search=%25_%28escape%29'
hit 'GET .../list?sort=vehicleType&order=asc' 200 GET '/distance-charge/genie/list?sort=vehicleType&order=asc'
hit 'GET .../list?sort=distanceFrom&order=desc' 200 GET '/distance-charge/genie/list?sort=distanceFrom&order=desc'
hit 'GET .../list?sort=driverCompleted' 200 GET '/distance-charge/genie/list?sort=driverCompleted&order=asc'
hit 'GET .../list?sort=id;DROP (injection falls back)' 200 GET '/distance-charge/genie/list?sort=id%3B%20DROP'
hit 'GET .../list?sort=nosuchcolumn' 200 GET '/distance-charge/genie/list?sort=nosuchcolumn'
hit 'GET .../list?order=asc&limit=-5' 200 GET '/distance-charge/genie/list?order=asc&limit=-5'
hit 'GET /distance-charge/genie/1 (band of type 406)' 200 GET /distance-charge/genie/1
hit 'GET /distance-charge/genie/2 (band of type 407)' 200 GET /distance-charge/genie/2
hit 'GET /distance-charge/genie/defaults' 200 GET /distance-charge/genie/defaults

echo '--- reads: bad input, missing rows, unknown apps ---'
hit 'GET /distance-charge/genie/999999 (missing 404)' 404 GET /distance-charge/genie/999999
hit 'GET /distance-charge/genie/abc (bad id 400)' 400 GET /distance-charge/genie/abc
hit 'GET /distance-charge/genie/0 (not a row id 400)' 400 GET /distance-charge/genie/0
hit 'GET /distance-charge/genie/-1 (negative id 400)' 400 GET /distance-charge/genie/-1
hit 'GET /distance-charge/runner/list (registered twin 200)' 200 GET /distance-charge/runner/list
hit 'GET /distance-charge/store/list (no such menu 400)' 400 GET /distance-charge/store/list
hit 'GET /distance-charge/genie/list-x (id route 400)' 400 GET /distance-charge/genie/list-x
hit 'GET /distance-charge/9/defaults (un-suffixed 400)' 400 GET /distance-charge/9/defaults

echo '--- reads: auth ---'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$CSRF" "$API/distance-charge/genie/list")
printf '%-56s %s' 'GET /distance-charge/genie/list (anonymous)' "$code"; [ "$code" = 401 ] && echo '  OK' || echo '  FAIL (want 401)'
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/distance-charge/genie/list")
printf '%-56s %s' 'GET ... without X-Requested-With' "$code"; [ "$code" = 401 ] && echo '  OK' || echo '  FAIL (want 401)'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$CSRF" -X POST -H 'Content-Type: application/json' -d '{}' "$API/distance-charge/genie")
printf '%-56s %s' 'POST ... (anonymous)' "$code"; [ "$code" = 401 ] && echo '  OK' || echo '  FAIL (want 401)'

echo '--- genie list shape (the unit, currency, types and chains ride along) ---'
curl -s -b "$JAR" -H "$CSRF" "$API/distance-charge/genie/list" | python3 -m json.tool
echo '--- genie row 1 shape (specs, frozen scope, delete phrase) ---'
curl -s -b "$JAR" -H "$CSRF" "$API/distance-charge/genie/1" | python3 -m json.tool
echo '--- defaults shape (what the add form starts from) ---'
curl -s -b "$JAR" -H "$CSRF" "$API/distance-charge/genie/defaults" | python3 -m json.tool
