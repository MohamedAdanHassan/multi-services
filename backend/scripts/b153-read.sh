#!/usr/bin/env bash
# Read-only curl matrix for the Vehicle Type :app registry
# (#sub-15 ride / #sub-138 parcel / #sub-153 genie).
# Usage: bash scripts/b153-read.sh
set -u
API=${API:-http://localhost:4000/api}
JAR=$(mktemp)
CSRF='X-Requested-With: XMLHttpRequest'

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
  printf '%-52s %s' "$label" "$code"
  if [ "$code" = "$want" ]; then echo '  OK'
  else echo "  FAIL (want $want): $(echo "${out%$'\n'*}" | head -c 300)"; fi
}

login
echo '--- reads: every app gets its own slice ---'
hit 'GET /vehicle-type/ride/list (taxi #sub-15)' 200 GET /vehicle-type/ride/list
hit 'GET /vehicle-type/delivery/list (parcel #sub-138)' 200 GET /vehicle-type/delivery/list
hit 'GET /vehicle-type/genie/list (genie #sub-153)' 200 GET /vehicle-type/genie/list
hit 'GET /vehicle-type/genie/list?limit=50 (paged)' 200 GET '/vehicle-type/genie/list?page=1&limit=50'
hit 'GET /vehicle-type/genie/list?status=Active' 200 GET '/vehicle-type/genie/list?status=Active'
hit 'GET /vehicle-type/genie/list?search=Car' 200 GET '/vehicle-type/genie/list?search=Car'
hit 'GET /vehicle-type/genie/406 (own row)' 200 GET /vehicle-type/genie/406
hit 'GET /vehicle-type/genie/407 (own row)' 200 GET /vehicle-type/genie/407
hit 'GET /vehicle-type/genie/defaults (eType DeliverAll)' 200 GET /vehicle-type/genie/defaults

echo '--- reads: a slice never reaches another ---'
hit 'GET /vehicle-type/delivery/406 (cross-slice 404)' 404 GET /vehicle-type/delivery/406
hit 'GET /vehicle-type/ride/406 (cross-slice 404)' 404 GET /vehicle-type/ride/406
hit 'GET /vehicle-type/genie/397 (parcel row 404)' 404 GET /vehicle-type/genie/397
hit 'GET /vehicle-type/genie/1 (ride row 404)' 404 GET /vehicle-type/genie/1
hit 'GET /vehicle-type/ride/406 (genie row 404)' 404 GET /vehicle-type/ride/406

echo '--- reads: unknown app and bad input ---'
hit 'GET /vehicle-type/medical/list (unknown app 400)' 400 GET /vehicle-type/medical/list
hit 'GET /vehicle-type/deliverall/list (not an app 400)' 400 GET /vehicle-type/deliverall/list
hit 'GET /vehicle-type/genie/999999 (missing 404)' 404 GET /vehicle-type/genie/999999
hit 'GET /vehicle-type/genie/abc (bad id 400)' 400 GET /vehicle-type/genie/abc
hit 'GET /vehicle-type/list (old flat path gone)' 404 GET /vehicle-type/list

echo '--- genie list shape ---'
curl -s -b "$JAR" -H "$CSRF" "$API/vehicle-type/genie/list" | python3 -m json.tool
