#!/usr/bin/env bash
# Read-only curl matrix for the Banners :app registry (#sub-140 parcel / #sub-142 genie).
# The third slice, Delivery Runner (#sub-143, its own `eType='Runner'` rows and its own five
# banner-runner-delivery keys), is verified by b143-read.sh; here it appears only as a segment
# that must now resolve rather than 400.
# Usage: bash scripts/b142-read.sh
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
  printf '%-46s %s' "$label" "$code"
  if [ "$code" = "$want" ]; then echo '  OK'
  else echo "  FAIL (want $want): $(echo "${out%$'\n'*}" | head -c 300)"; fi
}

login
echo '--- reads ---'
hit 'GET /banner/delivery/list (parcel #sub-140)' 200 GET /banner/delivery/list
hit 'GET /banner/genie/list (genie #sub-142)' 200 GET /banner/genie/list
hit 'GET /banner/genie/68 (own slice group)' 200 GET /banner/genie/68
hit 'GET /banner/delivery/68 (cross-slice 404)' 404 GET /banner/delivery/68
hit 'GET /banner/genie/50 (cross-slice 404)' 404 GET /banner/genie/50
hit 'GET /banner/delivery/70 (own slice group)' 200 GET /banner/delivery/70
hit 'GET /banner/runner/list (third app, #sub-143)' 200 GET /banner/runner/list
hit 'GET /banner/store/list (no such slice 400)' 400 GET /banner/store/list
hit 'GET /banner/genie/defaults (next slot 4)' 200 GET /banner/genie/defaults
hit 'GET /banner/delivery/defaults' 200 GET /banner/delivery/defaults
hit 'GET /banner/genie/999999 (missing 404)' 404 GET /banner/genie/999999
hit 'GET /banner/genie/abc (bad id 400)' 400 GET /banner/genie/abc
hit 'GET /banner/list (old flat path gone)' 404 GET /banner/list
hit 'GET /banner/genie/68/image (picture bytes)' 200 GET /banner/genie/68/image

echo '--- genie list shape ---'
curl -s -b "$JAR" -H "$CSRF" "$API/banner/genie/list" | python3 -m json.tool | head -40
