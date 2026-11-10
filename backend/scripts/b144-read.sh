#!/usr/bin/env bash
# Read-only curl matrix for "Manage Service/Content" — Delivery Genie (#sub-141) and, new
# here, its Delivery Runner twin (#sub-144).
#
# Unlike the delivery-charge screens, this `:app` segment picks ROWS as well as keys:
# `genie` reads the root `vehicle_category` row whose `eCatType='Genie'` (280) and `runner`
# the one whose `eCatType='Runner'` (287). Every read below therefore names the row it is
# allowed to see and the row it must never see, so a scope that silently widened would show
# up as a FAIL rather than a plausible-looking list.
#
# The image cases matter just as much: both root rows keep their artwork in the READ-ONLY
# legacy install (`webimages/icons/VehicleCategory/<rowId>/` and
# `assets/img/home-new/services/`), so a stream that worked for Genie's folder but not for
# Runner's would be a broken panel that no status-only check of the JSON would catch.
#
# Usage: bash scripts/b144-read.sh
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

# <label> <path> <body substring> — for the messages whose wording the panel repeats.
says() {
  local label=$1 path=$2 want=$3 body
  body=$(curl -s -b "$JAR" -H "$CSRF" "$API$path")
  printf '%-58s %s' "$label" "$(echo "$body" | head -c 120 | tr -d '\n')"
  case "$body" in
    *"$want"*) echo '  OK';;
    *) echo "  FAIL (want: $want)";;
  esac
}

login

echo '--- reads: each app sees its own root row and only its own ---'
hit 'GET /genie-service-content/genie/list' 200 GET /genie-service-content/genie/list
hit 'GET /genie-service-content/runner/list' 200 GET /genie-service-content/runner/list
expect 'genie list holds exactly row 280' /genie-service-content/genie/list \
  '[i["id"] for i in o["items"]] == [280]'
expect 'runner list holds exactly row 287' /genie-service-content/runner/list \
  '[i["id"] for i in o["items"]] == [287]'
expect 'genie list says it is Delivery Genie' /genie-service-content/genie/list \
  'o["items"][0]["label"] == "Delivery Genie" and o["items"][0]["app"] == "genie"'
expect 'runner list says it is Delivery Runner' /genie-service-content/runner/list \
  'o["items"][0]["label"] == "Delivery Runner" and o["items"][0]["app"] == "runner"'
expect 'the runner row is the Runner category' /genie-service-content/runner/list \
  'o["items"][0]["catType"] == "Runner"'
expect 'the runner row is named "Delivery Runner"' /genie-service-content/runner/list \
  'o["items"][0]["displayName"] == "Delivery Runner"'
expect 'no genie id appears on the runner path' /genie-service-content/runner/list \
  'all(i["id"] != 280 for i in o["items"])'
expect 'no runner id appears on the genie path' /genie-service-content/genie/list \
  'all(i["id"] != 287 for i in o["items"])'

echo '--- reads: the runner row detail, in the shapes the editor renders ---'
hit 'GET /genie-service-content/runner/287' 200 GET /genie-service-content/runner/287
expect '26 shipped languages, every name filled' /genie-service-content/runner/287 \
  'len(o["item"]["languages"]) == 26 and o["item"]["namesFilled"] == 26 and o["item"]["languagesTotal"] == 26'
expect 'every language holds the same stored text' /genie-service-content/runner/287 \
  'set(o["item"]["names"].values()) == {"Delivery Runner"}'
expect 'four artwork slots, in the legacy order' /genie-service-content/runner/287 \
  '[i["slot"] for i in o["item"]["images"]] == ["icon","promote","full-logo","services-icon"]'
expect 'the icon column carries a stored file name' /genie-service-content/runner/287 \
  'o["item"]["icon"].endswith(".png")'
expect 'the runner row holds no promotional image' /genie-service-content/runner/287 \
  'next(i["value"] for i in o["item"]["images"] if i["slot"] == "promote") == ""'
expect 'both JSON copy columns are offered' /genie-service-content/runner/287 \
  '[b["key"] for b in o["item"]["blobs"]] == ["tPromoteBannerTitle","vServiceCatTitleHomepage"]'
expect 'neither column is unparsed' /genie-service-content/runner/287 \
  'all(not b["unparsed"] for b in o["item"]["blobs"])'
expect 'the promote title is 26 keys, all blank' /genie-service-content/runner/287 \
  'all(b["values"] and not any(b["values"].values()) for b in o["item"]["blobs"] if b["key"] == "tPromoteBannerTitle")'
expect 'the home copy carries titles but no sub-titles' /genie-service-content/runner/287 \
  'next(b["values"] for b in o["item"]["blobs"] if b["key"] == "vServiceCatTitleHomepage").get("vServiceCatTitleHomepage_EN") == "Delivery Runner" and not any(k.startswith("vServiceCatSubTitleHomepage") for k in next(b["values"] for b in o["item"]["blobs"] if b["key"] == "vServiceCatTitleHomepage"))'
expect 'the blob editor still offers both bases' /genie-service-content/runner/287 \
  'next(b["fields"] for b in o["item"]["blobs"] if b["key"] == "vServiceCatTitleHomepage")[1]["base"] == "vServiceCatSubTitleHomepage"'
expect 'the OTP switch reads unset, as stored' /genie-service-content/runner/287 \
  'o["item"]["settings"]["eOTPCodeEnable"] == ""'
expect 'settings carry the four columns with their DDL choices' /genie-service-content/runner/287 \
  'len(o["item"]["settingSpecs"]) == 4 and o["item"]["settings"]["ePromoteBanner"] == "No"'
expect 'orders are the runner row own: 6 / 61' /genie-service-content/runner/287 \
  'o["item"]["displayOrder"] == 6 and o["item"]["displayOrderHomepage"] == 61'
expect 'nothing else is promoted today' /genie-service-content/runner/287 \
  'o["item"]["promotedElsewhere"] == []'

echo '--- reads: the genie row still reads as before (sibling regression) ---'
hit 'GET /genie-service-content/genie/280' 200 GET /genie-service-content/genie/280
expect 'genie 280 is Delivery Genie and keeps its own orders' /genie-service-content/genie/280 \
  'o["item"]["label"] == "Delivery Genie" and o["item"]["displayOrder"] == 5 and o["item"]["displayOrderHomepage"] == 4'
expect 'genie 280 home copy does carry sub-titles' /genie-service-content/genie/280 \
  'any(k.startswith("vServiceCatSubTitleHomepage") for k in next(b["values"] for b in o["item"]["blobs"] if b["key"] == "vServiceCatTitleHomepage"))'

echo '--- reads: scope is a wall, not a filter ---'
hit 'GET /runner/280 (a row of the other app 404)' 404 GET /genie-service-content/runner/280
hit 'GET /genie/287 (a row of the other app 404)' 404 GET /genie-service-content/genie/287
says '  the runner 404 names Delivery Runner' /genie-service-content/runner/280 \
  'No Delivery Runner service content row #280'
says '  the genie 404 names Delivery Genie' /genie-service-content/genie/287 \
  'No Delivery Genie service content row #287'
hit 'GET /runner/999999 (no such row 404)' 404 GET /genie-service-content/runner/999999
hit 'GET /runner/0 (not a row id 400)' 400 GET /genie-service-content/runner/0
hit 'GET /runner/abc (bad id 400)' 400 GET /genie-service-content/runner/abc
hit 'GET /runner/list-x (id route 400)' 400 GET /genie-service-content/runner/list-x
hit 'GET /medical/list (no such app 400)' 400 GET /genie-service-content/medical/list
hit 'GET /GENIE/list (segment is case-exact 400)' 400 GET /genie-service-content/GENIE/list

echo '--- reads: artwork bytes, both from the read-only legacy tree ---'
stream 'GET /runner/287/image/icon' 200 /genie-service-content/runner/287/image/icon
stream 'GET /runner/287/image/services-icon' 200 /genie-service-content/runner/287/image/services-icon
stream 'GET /genie/280/image/icon (sibling still serves)' 200 /genie-service-content/genie/280/image/icon
stream 'GET /runner/287/image/promote (column empty 404)' 404 /genie-service-content/runner/287/image/promote
stream 'GET /runner/287/image/full-logo (column empty 404)' 404 /genie-service-content/runner/287/image/full-logo
says '  an empty slot says so, not "file missing"' /genie-service-content/runner/287/image/promote \
  'No promotional banner image on file'
hit 'GET /runner/287/image/nosuchslot (400)' 400 GET /genie-service-content/runner/287/image/nosuchslot
type=$(curl -s -o /dev/null -w '%{content_type}' -b "$JAR" -H "$CSRF" \
  "$API/genie-service-content/runner/287/image/icon")
printf '%-58s %s' 'the runner icon is served as an image' "$type"
case "$type" in image/*) echo '  OK';; *) echo '  FAIL (want image/*)';; esac

echo '--- reads: auth ---'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$CSRF" "$API/genie-service-content/runner/list")
printf '%-58s %s' 'GET /runner/list (anonymous)' "$code"; [ "$code" = 401 ] && echo '  OK' || echo '  FAIL (want 401)'
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/genie-service-content/runner/list")
printf '%-58s %s' 'GET /runner/list without X-Requested-With' "$code"; [ "$code" = 401 ] && echo '  OK' || echo '  FAIL (want 401)'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$CSRF" -X PUT -H 'Content-Type: application/json' \
  -d '{"names":{"EN":"x"}}' "$API/genie-service-content/runner/287")
printf '%-58s %s' 'PUT /runner/287 (anonymous)' "$code"; [ "$code" = 401 ] && echo '  OK' || echo '  FAIL (want 401)'

echo '--- reads: the three runner keys are grantable under sub-group 144 ---'
hit 'GET /permissions/tree' 200 GET /permissions/tree
# `/permissions/tree` answers a bare array of display groups; each carries `subGroups`, each of
# those its `permissions`. Sub-group 144 must expose exactly the three keys the routes demand.
expect 'sub-group 144 carries exactly view / update / update-status' /permissions/tree \
  'sorted(p["permission_name"] for g in o for s in g["subGroups"] if s["id"] == 144 for p in s["permissions"]) == ["update-service-content-runner-delivery","update-status-service-content-runner-delivery","view-service-content-runner-delivery"]'
expect 'they belong to display group 34, Delivery Runner' /permissions/tree \
  'next((g["name"] for g in o if any(s["id"] == 144 for s in g["subGroups"]))) == "Delivery Runner"'
expect 'sub-group 144 is the first of group 34 (legacy order)' /permissions/tree \
  'next(s["display_order"] for g in o if g["id"] == 34 for s in g["subGroups"] if s["id"] == 144) == 1'
expect 'the genie keys stay on 141, the runner keys on 144' /permissions/tree \
  'not any("runner" in p["permission_name"] for g in o for s in g["subGroups"] if s["id"] == 141 for p in s["permissions"]) and not any("genie-delivery" in p["permission_name"] for g in o for s in g["subGroups"] if s["id"] == 144 for p in s["permissions"])'

echo '--- runner list shape (what the panel renders) ---'
curl -s -b "$JAR" -H "$CSRF" "$API/genie-service-content/runner/list" | python3 -m json.tool
echo '--- runner row shape (names, copy, artwork, settings) ---'
curl -s -b "$JAR" -H "$CSRF" "$API/genie-service-content/runner/287" \
  | python3 -c 'import sys,json;i=json.load(sys.stdin)["item"];i["blobs"]=[{**b,"values":{k:(v[:60]+"…" if len(str(v))>60 else v) for k,v in list(b["values"].items())[:3]}} for b in i["blobs"]];print(json.dumps(i,indent=2,ensure_ascii=False))'
