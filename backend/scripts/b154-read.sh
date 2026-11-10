#!/usr/bin/env bash
# Read-only curl matrix for Delivery Charges.
#
# The :app segment of this screen gates permissions, not rows: `delivery_charges` has no
# service-line column, so genie (#sub-154) is the same table the Runner and un-suffixed
# menus edit. Runner (#sub-157) is now registered over these very rows, so the witness for
# "an app this screen does not know" has to be a service line that really exists elsewhere
# (`store`); it is refused by the route's zod enum, before anything is queried.
#
# The runner reads of the same table are covered by b157-read.sh, which also proves the two
# menus hand back identical payloads.
#
# Usage: bash scripts/b154-read.sh
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
hit 'GET /delivery-charge/genie/list' 200 GET /delivery-charge/genie/list
hit 'GET /delivery-charge/genie/list?page=1&limit=50' 200 GET '/delivery-charge/genie/list?page=1&limit=50'
hit 'GET .../list?status=Active' 200 GET '/delivery-charge/genie/list?status=Active'
hit 'GET .../list?status=Deleted (unknown filter)' 200 GET '/delivery-charge/genie/list?status=Deleted'
hit 'GET .../list?search=50' 200 GET '/delivery-charge/genie/list?search=50'
hit 'GET .../list?sort=orderPrice&order=asc' 200 GET '/delivery-charge/genie/list?sort=orderPrice&order=asc'
hit 'GET .../list?sort=location (whitelisted)' 200 GET '/delivery-charge/genie/list?sort=location&order=desc'
hit 'GET .../list?sort=id;DROP (injection falls back)' 200 GET '/delivery-charge/genie/list?sort=id%3B%20DROP'
hit 'GET /delivery-charge/genie/1 (the All-Location row)' 200 GET /delivery-charge/genie/1
hit 'GET /delivery-charge/genie/defaults' 200 GET /delivery-charge/genie/defaults

echo '--- reads: bad input, missing rows, unknown apps ---'
hit 'GET /delivery-charge/genie/999999 (missing 404)' 404 GET /delivery-charge/genie/999999
hit 'GET /delivery-charge/genie/abc (bad id 400)' 400 GET /delivery-charge/genie/abc
hit 'GET /delivery-charge/genie/0 (not a row id 400)' 400 GET /delivery-charge/genie/0
hit 'GET /delivery-charge/store/list (app not registered 400)' 400 GET /delivery-charge/store/list
hit 'GET /delivery-charge/genie/list-x (id route 400)' 400 GET /delivery-charge/genie/list-x

echo '--- reads: auth ---'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$CSRF" "$API/delivery-charge/genie/list")
printf '%-56s %s' 'GET /delivery-charge/genie/list (anonymous)' "$code"; [ "$code" = 401 ] && echo '  OK' || echo '  FAIL (want 401)'
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/delivery-charge/genie/list")
printf '%-56s %s' 'GET ... without X-Requested-With' "$code"; [ "$code" = 401 ] && echo '  OK' || echo '  FAIL (want 401)'

echo '--- genie list shape (features drive which columns exist) ---'
curl -s -b "$JAR" -H "$CSRF" "$API/delivery-charge/genie/list" | python3 -m json.tool
echo '--- genie row 1 shape ---'
curl -s -b "$JAR" -H "$CSRF" "$API/delivery-charge/genie/1" | python3 -m json.tool
