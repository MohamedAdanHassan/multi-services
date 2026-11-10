#!/usr/bin/env bash
# Read-only curl matrix for Delivery Runner → Banners (#sub-143), the third `:app` slice of
# the shared `banners` table.
#
# This segment picks ROWS as well as keys: `runner` sees `eType='Runner'` and nothing else, so
# every case below names the group it may read (69) and the neighbour it must never see (genie's
# 68, parcel's 50 and 70). A scope that quietly widened to `eType IN (...)` would fail here rather
# than return a plausible-looking list.
#
# The Runner slice is also the first incomplete banner this screen has ever served: group 69
# ships its Latvian and Slovenian rows only, so the reads check the label fallback (the list must
# call it "Piegādes skrējējs", not "Banner #69"), the 2 / 26 language counts and the fact that the
# 24 absent languages arrive as empty fields rather than as missing keys.
#
# Usage: bash scripts/b143-read.sh
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
  printf '%-58s %s' "$label" "$code"
  if [ "$code" = "$want" ]; then echo '  OK'
  else echo "  FAIL (want $want): $(echo "${out%$'\n'*}" | head -c 300)"; fi
}

# <label> <path> <python expression over the parsed body>
expect() {
  local label=$1 path=$2 expr=$3 got
  got=$(curl -s -b "$JAR" -H "$CSRF" "$API$path" | python3 -c \
    "import sys,json;o=json.load(sys.stdin);print('YES' if ($expr) else 'NO')" 2>/dev/null)
  printf '%-58s %s' "$label" "$got"
  if [ "$got" = YES ]; then echo '  OK'; else echo "  FAIL: $expr"; fi
}

# <label> <expected status> <path> — the byte streams: their body is an image, and capturing
# one into a shell variable only drops its null bytes and prints a warning.
stream() {
  local label=$1 want=$2 path=$3 code
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$CSRF" "$API$path")
  printf '%-58s %s' "$label" "$code"
  if [ "$code" = "$want" ]; then echo '  OK'; else echo "  FAIL (want $want)"; fi
}

login

echo '--- reads: the runner slice sees group 69 and no other app’s rows ---'
hit 'GET /banner/runner/list (was an unknown app)' 200 GET /banner/runner/list
expect 'runner list holds exactly one group, id 69' /banner/runner/list \
  'o["total"] == 1 and [i["id"] for i in o["items"]] == [69]'
expect 'labelled by Latvian, since the group has no English row' /banner/runner/list \
  'o["items"][0]["title"] == "Piegādes skrējējs"'
expect 'language counts say 2 of 26, not 26 blank ones' /banner/runner/list \
  'o["items"][0]["languageCount"] == 2 and o["items"][0]["rowCount"] == 2'
expect 'both languages carry text, group is Active, slot 2' /banner/runner/list \
  'o["items"][0]["translationsFilled"] == 2 and o["items"][0]["status"] == "Active" and o["items"][0]["displayOrder"] == 2'
expect 'the shipped picture is named and reported present' /banner/runner/list \
  'o["items"][0]["image"] == "20230113155822173.png" and o["items"][0]["hasImage"] is True'
hit 'GET /banner/runner/69 (own slice group)' 200 GET /banner/runner/69
stream 'GET /banner/runner/69/image (legacy artwork bytes)' 200 /banner/runner/69/image
stream 'GET /banner/genie/68/image (neighbour still served)' 200 /banner/genie/68/image
hit 'GET /banner/runner/68 (a genie group) -> 404' 404 GET /banner/runner/68
hit 'GET /banner/runner/50 (a parcel group) -> 404' 404 GET /banner/runner/50
hit 'GET /banner/runner/70 (a parcel group) -> 404' 404 GET /banner/runner/70
hit 'GET /banner/runner/999999 (missing 404)' 404 GET /banner/runner/999999
hit 'GET /banner/runner/abc (bad id 400)' 400 GET /banner/runner/abc
hit 'GET /banner/runner/0 (not a row id 400)' 400 GET /banner/runner/0
hit 'GET /banner/runner/defaults (next slot 3)' 200 GET /banner/runner/defaults

echo '--- reads: the detail view offers all 26 languages, 2 filled ---'
expect 'the edit form lists 26 language fields' /banner/runner/69 \
  'len(o["item"]["languages"]) == 26'
expect 'English is present as an empty field, not a missing one' /banner/runner/69 \
  'next(l for l in o["item"]["languages"] if l["code"] == "EN")["text"] == ""'
expect 'the two shipped languages hold their stored text' /banner/runner/69 \
  '{l["code"]: l["text"] for l in o["item"]["languages"]}["LV"] == "Piegādes skrējējs"'
expect 'translationsFilled counts text, not rows' /banner/runner/69 \
  'o["item"]["translationsFilled"] == 2 and o["item"]["languageCount"] == 2 and o["item"]["rowCount"] == 2'
expect 'the title falls back to the first language with text' /banner/runner/69 \
  'o["item"]["title"] == "Piegādes skrējējs"'
expect 'slot, colour and location read off the group' /banner/runner/69 \
  'o["item"]["displayOrder"] == 2 and o["item"]["statusBarColor"] == "" and o["item"]["locationIds"] == "-1"'
expect 'defaults pre-fills the runner slot 3 and 26 blank languages' /banner/runner/defaults \
  'o["item"]["displayOrder"] == 3 and len(o["item"]["languages"]) == 26 and o["item"]["translationsFilled"] == 0'

echo '--- reads: filters are group properties over this slice only ---'
expect 'search on the Latvian text finds it' '/banner/runner/list?search=Pieg%C4%81des' \
  'o["total"] == 1'
expect 'search on genie’s English title finds nothing' '/banner/runner/list?search=Delivery%20Genie' \
  'o["total"] == 0'
expect 'the Active filter keeps the group' '/banner/runner/list?status=Active' \
  'o["total"] == 1'
expect 'the Inactive filter excludes it' '/banner/runner/list?status=Inactive' \
  'o["total"] == 0'
expect 'a search on the id text finds nothing' '/banner/runner/list?search=69' \
  'o["total"] == 0'
expect 'paging reports one page of one group' '/banner/runner/list?page=1&limit=1' \
  'o["total"] == 1 and o["pages"] == 1 and len(o["items"]) == 1'
expect 'page 2 is empty, not an error' '/banner/runner/list?page=2&limit=1' \
  'o["total"] == 1 and o["items"] == []'

echo '--- reads: the other two slices still exclude the runner group ---'
expect 'genie list is still just group 68' /banner/genie/list \
  '[i["id"] for i in o["items"]] == [68]'
expect 'genie list never shows the runner title' /banner/genie/list \
  'not any(i["id"] == 69 for i in o["items"])'
expect 'parcel list is still groups 50 and 70 only' /banner/delivery/list \
  'sorted(i["id"] for i in o["items"]) == [50, 70]'
hit 'GET /banner/genie/69 (a runner group) -> 404' 404 GET /banner/genie/69
hit 'GET /banner/delivery/69 (a runner group) -> 404' 404 GET /banner/delivery/69
hit 'GET /banner/store/list (no such slice 400)' 400 GET /banner/store/list
hit 'GET /banner/list (old flat path gone)' 404 GET /banner/list

echo '--- reads: auth gates the runner keys before any query ---'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$CSRF" "$API/banner/runner/list")
printf '%-58s %s' 'GET /banner/runner/list (anonymous)' "$code"; [ "$code" = 401 ] && echo '  OK' || echo '  FAIL (want 401)'
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/banner/runner/list")
printf '%-58s %s' 'GET ... without X-Requested-With' "$code"; [ "$code" = 401 ] && echo '  OK' || echo '  FAIL (want 401)'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$CSRF" -X POST -H 'Content-Type: application/json' -d '{"texts":{"EN":"x"}}' "$API/banner/runner")
printf '%-58s %s' 'POST /banner/runner (anonymous)' "$code"; [ "$code" = 401 ] && echo '  OK' || echo '  FAIL (want 401)'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$CSRF" "$API/banner/runner/69/image")
printf '%-58s %s' 'GET image (anonymous)' "$code"; [ "$code" = 401 ] && echo '  OK' || echo '  FAIL (want 401)'

echo '--- reads: the permission tree exposes sub-group 143’s five seeded keys ---'
tree=$(curl -s -b "$JAR" -H "$CSRF" "$API/permissions/tree")
for key in view create edit delete update-status; do
  case "$tree" in
    *"$key-banner-runner-delivery"*) echo "  ok   tree carries $key-banner-runner-delivery";;
    *) echo "  FAIL tree is missing $key-banner-runner-delivery";;
  esac
done

echo '--- runner list shape (what the #sub-143 panel renders) ---'
curl -s -b "$JAR" -H "$CSRF" "$API/banner/runner/list" | python3 -m json.tool
