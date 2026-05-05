#!/bin/bash
# backend/scripts/verify.sh
# Verifies the deployed dropbox-893 stack by testing every API endpoint.
#
# Usage:
#   ./scripts/verify.sh --email your@email.com --password yourpassword
#   ./scripts/verify.sh --public-only
#
#   --public-only  Checks GET /albums (no Cognito). Use if slideshow fails in browser.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUTPUTS_FILE="${REPO_ROOT}/dropbox_outputs.json"

EMAIL=""
PASSWORD=""
PUBLIC_ONLY=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --email)    EMAIL="$2";    shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --public-only) PUBLIC_ONLY=true; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [ "$PUBLIC_ONLY" != true ]; then
  if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
    echo "Usage: ./scripts/verify.sh --email your@email.com --password yourpassword"
    echo "    or: ./scripts/verify.sh --public-only"
    exit 1
  fi
fi

if [ ! -f "$OUTPUTS_FILE" ]; then
  echo "  ❌ dropbox_outputs.json not found. Run deploy.sh first."
  exit 1
fi

API_URL=$(grep -E '"base_url"' "$OUTPUTS_FILE" | sed 's/.*"\(.*\)".*/\1/')
CLIENT_ID=$(grep -E '"user_pool_client_id"' "$OUTPUTS_FILE" | sed 's/.*"\(.*\)".*/\1/')
USER_POOL_ID=$(grep -E '"user_pool_id"' "$OUTPUTS_FILE" | sed 's/.*"\(.*\)".*/\1/')
REGION=$(grep -E '"aws_region"' "$OUTPUTS_FILE" | head -1 | sed 's/.*"\(.*\)".*/\1/')

PASS=0; FAIL=0

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║        dropbox-893 — Verify Deployment       ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  API URL:    $API_URL"
echo "  Client ID:  $CLIENT_ID"
echo "  Region:     $REGION"
echo ""

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }
check() { [ "$3" = "$2" ] && pass "$1 (HTTP $3)" || fail "$1 (expected HTTP $2, got HTTP $3)"; }

# ── Slideshow (public, no auth) ───────────────────────────────────────────────
echo "  ── Slideshow /albums (public, no auth) ───────────"
set +e
ALBUMS_HTTP=$(curl -sS -o /tmp/dropbox_verify_albums.json -w "%{http_code}" "${API_URL}albums" 2>/dev/null)
CURL_EC=$?
set -e
[ "$CURL_EC" -ne 0 ] && ALBUMS_HTTP="000"
if [ "$ALBUMS_HTTP" = "200" ]; then
  pass "GET ${API_URL}albums (HTTP 200)"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json; json.load(open('/tmp/dropbox_verify_albums.json'))" 2>/dev/null && pass "GET /albums returns JSON" || fail "GET /albums body is not valid JSON"
  fi
else
  fail "GET ${API_URL}albums (expected HTTP 200, got HTTP ${ALBUMS_HTTP})"
  echo ""
  echo "  ⚠️  If you see HTTP 403 here: API Gateway has no /albums resource yet."
  echo "      Deploy backend from dropbox-893: cd backend && ./scripts/deploy.sh"
  echo "      Amplify-only deploy does NOT create API routes."
fi

rm -f /tmp/dropbox_verify_albums.json

if [ "$PUBLIC_ONLY" = true ]; then
  echo ""
  echo "  ────────────────────────────────────────────────────"
  TOTAL=$((PASS + FAIL))
  echo "  Results (public only): ${PASS}/${TOTAL} passed"
  echo "  ────────────────────────────────────────────────────"
  echo ""
  [ "$FAIL" -eq 0 ] && exit 0 || exit 1
fi

# ── Auth ──────────────────────────────────────────────────────────────────────
echo ""
echo "  ── Auth ─────────────────────────────────────────"
COGNITO_URL="https://cognito-idp.${REGION}.amazonaws.com/"
AUTH_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$COGNITO_URL" \
  -H "Content-Type: application/x-amz-json-1.1" \
  -H "X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth" \
  -d "{\"AuthFlow\":\"USER_PASSWORD_AUTH\",\"AuthParameters\":{\"USERNAME\":\"${EMAIL}\",\"PASSWORD\":\"${PASSWORD}\"},\"ClientId\":\"${CLIENT_ID}\"}")

HTTP_CODE=$(echo "$AUTH_RESPONSE" | tail -1)
AUTH_BODY=$(echo "$AUTH_RESPONSE" | head -1)

if [ "$HTTP_CODE" = "200" ]; then
  pass "Sign in (HTTP 200)"
  ID_TOKEN=$(echo "$AUTH_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['AuthenticationResult']['IdToken'])" 2>/dev/null)
  [ -n "$ID_TOKEN" ] && pass "ID token received" || fail "ID token missing"
else
  fail "Sign in (HTTP $HTTP_CODE)"
  ID_TOKEN=""
fi

# ── Endpoints ─────────────────────────────────────────────────────────────────
echo ""
echo "  ── Authenticated endpoints ──────────────────────"

if [ -z "$ID_TOKEN" ]; then
  echo "  ⚠️  Skipping — no token available"
else
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: ${ID_TOKEN}" "${API_URL}files")
  check "GET /files" "200" "$STATUS"

  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: ${ID_TOKEN}" "${API_URL}files?prefix=Music/")
  check "GET /files?prefix=Music/" "200" "$STATUS"

  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: ${ID_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"key":"verify-test/test.txt","contentType":"text/plain"}' \
    "${API_URL}files")
  check "POST /files (presigned upload URL)" "200" "$STATUS"

  # ── Find an MP3 by recursing into subfolders ────────────────────────────────
  # 1. List top-level Music/ to get subfolders
  # 2. Pick the first subfolder and list its files
  # 3. Use the first MP3 found to test the presigned download URL
  echo ""
  echo "  ── Locating MP3 for presigned download test ─────"

  FIRST_FILE=""

  # Check for files directly in Music/ first
  FILES_BODY=$(curl -s -H "Authorization: ${ID_TOKEN}" "${API_URL}files?prefix=Music/")
  FIRST_FILE=$(echo "$FILES_BODY" | python3 -c \
    "import sys,json; f=json.load(sys.stdin).get('files',[]); print(f[0]['key']) if f else print('')" 2>/dev/null)

  # If no direct files, recurse into first subfolder
  if [ -z "$FIRST_FILE" ]; then
    FIRST_FOLDER=$(echo "$FILES_BODY" | python3 -c \
      "import sys,json; f=json.load(sys.stdin).get('folders',[]); print(f[0]['key']) if f else print('')" 2>/dev/null)

    if [ -n "$FIRST_FOLDER" ]; then
      echo "  ℹ️  No files directly in Music/ — checking subfolder: $FIRST_FOLDER"
      ENCODED_FOLDER=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${FIRST_FOLDER}'))" 2>/dev/null)
      SUB_BODY=$(curl -s -H "Authorization: ${ID_TOKEN}" "${API_URL}files?prefix=${ENCODED_FOLDER}")
      FIRST_FILE=$(echo "$SUB_BODY" | python3 -c \
        "import sys,json; f=json.load(sys.stdin).get('files',[]); print(f[0]['key']) if f else print('')" 2>/dev/null)

      # If still no files, try one level deeper
      if [ -z "$FIRST_FILE" ]; then
        SECOND_FOLDER=$(echo "$SUB_BODY" | python3 -c \
          "import sys,json; f=json.load(sys.stdin).get('folders',[]); print(f[0]['key']) if f else print('')" 2>/dev/null)
        if [ -n "$SECOND_FOLDER" ]; then
          echo "  ℹ️  Checking deeper subfolder: $SECOND_FOLDER"
          ENCODED_SECOND=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${SECOND_FOLDER}'))" 2>/dev/null)
          DEEP_BODY=$(curl -s -H "Authorization: ${ID_TOKEN}" "${API_URL}files?prefix=${ENCODED_SECOND}")
          FIRST_FILE=$(echo "$DEEP_BODY" | python3 -c \
            "import sys,json; f=json.load(sys.stdin).get('files',[]); print(f[0]['key']) if f else print('')" 2>/dev/null)
        fi
      fi
    fi
  fi

  if [ -n "$FIRST_FILE" ]; then
    echo "  ℹ️  Testing with: $FIRST_FILE"
    ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${FIRST_FILE}', safe=''))" 2>/dev/null)
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "Authorization: ${ID_TOKEN}" "${API_URL}files/${ENCODED}")
    check "GET /files/{key} (presigned download URL 12hr)" "200" "$STATUS"
  else
    echo "  ⚠️  No files found in Music/ or subfolders — skipping GET /files/{key}"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "  ────────────────────────────────────────────────────"
TOTAL=$((PASS + FAIL))
echo "  Results: ${PASS}/${TOTAL} passed"
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ All checks passed — dropbox-893 is working correctly"
else
  echo "  ❌ ${FAIL} check(s) failed — review output above"
fi
echo "  ────────────────────────────────────────────────────"
echo ""
