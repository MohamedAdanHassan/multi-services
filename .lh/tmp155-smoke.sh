#!/usr/bin/env bash
# Throwaway smoke of the new distance-charge reads.
set -u
API=http://localhost:4000/api
JAR=$(mktemp -p /home/ataa/mohamed/multiservice/.lh)
CSRF='X-Requested-With: XMLHttpRequest'
trap 'rm -f "$JAR"' EXIT

curl -s -c "$JAR" -H "$CSRF" -H 'Content-Type: application/json' \
  -d '{"email":"admin.test@ondemand.local","password":"TestPass123!"}' \
  "$API/auth/login" -o /dev/null -w "login %{http_code}\n"

for p in \
  "/distance-charge/genie/list" \
  "/distance-charge/genie/defaults" \
  "/distance-charge/genie/1" \
  "/distance-charge/genie/list?page=1&limit=10&sort=vehicleType&order=asc" \
  "/distance-charge/genie/list?search=Car" \
  "/distance-charge/runner/list" \
  "/distance-charge/genie/9999"
do
  echo "== GET $p"
  curl -s -b "$JAR" -H "$CSRF" -w '\n-> %{http_code}\n' "$API$p" | head -c 1500
done
