#!/bin/bash
# backend/scripts/deploy.sh
# Deploys the dropbox-893 CDK stack and writes dropbox_outputs.json at repo root.
#
# Idempotent — safe to run on every deploy:
#   - Cognito app client: checked by name, created only if missing
#   - API Gateway:        checked by name, imports real logical ID if found
#   - S3 bucket:          imported by name, never created or deleted
#
# Usage:
#   cd backend && ./scripts/deploy.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${BACKEND_DIR}/.." && pwd)"
CONFIG_FILE="${BACKEND_DIR}/bin/config.ts"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║          dropbox-893 — Backend Deploy        ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Validate config.ts ────────────────────────────────────────────────────────
if [ ! -f "$CONFIG_FILE" ]; then
  echo "  ❌ backend/bin/config.ts not found."
  echo "     Run: cp backend/bin/config.example.ts backend/bin/config.ts"
  echo "     Then fill in your values and re-run."
  exit 1
fi

# ── Read config values ────────────────────────────────────────────────────────
CONFIG_ID=$(grep -E '^\s+id:' "$CONFIG_FILE" | head -1 | sed 's/.*"\(.*\)".*/\1/')
AWS_REGION=$(grep -E '^\s+awsRegion:' "$CONFIG_FILE" | head -1 | sed 's/.*"\(.*\)".*/\1/')
USER_POOL_ID=$(grep -E '^\s+userPoolId:' "$CONFIG_FILE" | head -1 | sed 's/.*"\(.*\)".*/\1/')

if [ -z "$CONFIG_ID" ] || [ -z "$AWS_REGION" ] || [ -z "$USER_POOL_ID" ]; then
  echo "  ❌ Could not read required values from config.ts."
  exit 1
fi

STACK_NAME="DropboxStack-${CONFIG_ID}"
CLIENT_NAME="${CONFIG_ID}-dropbox-client"
API_NAME="${CONFIG_ID}-dropbox-api"

echo "  Stack:       $STACK_NAME"
echo "  Region:      $AWS_REGION"
echo "  ID prefix:   $CONFIG_ID"
echo "  User Pool:   $USER_POOL_ID"
echo ""

# ── Check / create Cognito app client (idempotent) ────────────────────────────
echo "  Checking Cognito app client '$CLIENT_NAME'..."

EXISTING_CLIENT_ID=$(aws cognito-idp list-user-pool-clients \
  --user-pool-id "$USER_POOL_ID" \
  --region "$AWS_REGION" \
  --query "UserPoolClients[?ClientName=='${CLIENT_NAME}'].ClientId" \
  --output text 2>/dev/null || true)

if [ -n "$EXISTING_CLIENT_ID" ] && [ "$EXISTING_CLIENT_ID" != "None" ]; then
  echo "  ✅ App client exists: $EXISTING_CLIENT_ID"
  DROPBOX_CLIENT_ID="$EXISTING_CLIENT_ID"
else
  echo "  Creating app client '$CLIENT_NAME'..."
  DROPBOX_CLIENT_ID=$(aws cognito-idp create-user-pool-client \
    --user-pool-id "$USER_POOL_ID" \
    --client-name "$CLIENT_NAME" \
    --no-generate-secret \
    --explicit-auth-flows \
      ALLOW_USER_PASSWORD_AUTH \
      ALLOW_USER_SRP_AUTH \
      ALLOW_REFRESH_TOKEN_AUTH \
    --prevent-user-existence-errors ENABLED \
    --region "$AWS_REGION" \
    --query "UserPoolClient.ClientId" \
    --output text)
  echo "  ✅ App client created: $DROPBOX_CLIENT_ID"
fi

# ── Check API Gateway (idempotent) ────────────────────────────────────────────
echo ""
echo "  Checking API Gateway '$API_NAME'..."

EXISTING_API_ID=$(aws apigateway get-rest-apis \
  --region "$AWS_REGION" \
  --query "items[?name=='${API_NAME}'].id" \
  --output text 2>/dev/null || true)

DROPBOX_API_LOGICAL_ID=""

if [ -n "$EXISTING_API_ID" ] && [ "$EXISTING_API_ID" != "None" ]; then
  echo "  ✅ API Gateway exists: $EXISTING_API_ID"

  echo "  Fetching CloudFormation logical ID..."
  DROPBOX_API_LOGICAL_ID=$(aws cloudformation describe-stack-resources \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query "StackResources[?ResourceType=='AWS::ApiGateway::RestApi'].LogicalResourceId" \
    --output text 2>/dev/null || true)

  if [ -n "$DROPBOX_API_LOGICAL_ID" ] && [ "$DROPBOX_API_LOGICAL_ID" != "None" ]; then
    echo "  ✅ Logical ID: $DROPBOX_API_LOGICAL_ID"
  else
    echo "  ⚠️  Could not fetch logical ID — CDK will manage normally."
    DROPBOX_API_LOGICAL_ID=""
  fi
else
  echo "  ℹ️  API Gateway not found — CDK will create on first deploy."
  EXISTING_API_ID=""
fi

# ── Summary and confirm ───────────────────────────────────────────────────────
echo ""
echo "  Resources after this deploy:"
echo "    Cognito client:  $DROPBOX_CLIENT_ID (preserved)"
if [ -n "$EXISTING_API_ID" ]; then
  echo "    API Gateway:     $EXISTING_API_ID (preserved)"
else
  echo "    API Gateway:     will be created by CDK"
fi
echo "    S3 bucket:       imported only — never modified"
echo ""
read -p "  Proceed? (y/n): " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then echo "  Cancelled."; exit 0; fi

# ── Install deps ──────────────────────────────────────────────────────────────
cd "$BACKEND_DIR"
[ ! -d "node_modules" ] && npm install

# ── Deploy CDK stack ──────────────────────────────────────────────────────────
echo ""
echo "  Deploying CDK stack..."

DROPBOX_CLIENT_ID="$DROPBOX_CLIENT_ID" \
DROPBOX_API_LOGICAL_ID="$DROPBOX_API_LOGICAL_ID" \
  npx cdk deploy "$STACK_NAME" --require-approval never

# ── Re-fetch API Gateway ID if CDK just created it ────────────────────────────
if [ -z "$EXISTING_API_ID" ]; then
  echo ""
  echo "  Resolving new API Gateway ID..."
  EXISTING_API_ID=$(aws apigateway get-rest-apis \
    --region "$AWS_REGION" \
    --query "items[?name=='${API_NAME}'].id" \
    --output text)
  echo "  ✅ API Gateway created: $EXISTING_API_ID"
fi

# ── Read CloudFormation outputs ───────────────────────────────────────────────
get_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

API_URL=$(get_output "DropboxApiUrl")
USER_POOL_ID_OUT=$(get_output "DropboxUserPoolId")
APP_CLIENT_ID=$(get_output "DropboxAppClientId")
PRIVATE_BUCKET=$(get_output "DropboxPrivateBucket")

# ── Write dropbox_outputs.json ────────────────────────────────────────────────
cat > "${REPO_ROOT}/dropbox_outputs.json" << OUTPUTS
{
  "version": "1",
  "aws_region": "${AWS_REGION}",
  "auth": {
    "user_pool_id":        "${USER_POOL_ID_OUT}",
    "user_pool_client_id": "${APP_CLIENT_ID}"
  },
  "api": {
    "base_url": "${API_URL}"
  },
  "storage": {
    "private_bucket": "${PRIVATE_BUCKET}"
  }
}
OUTPUTS

echo ""
echo "  ✅ dropbox_outputs.json written to repo root"
echo ""
echo "  ────────────────────────────────────────────────────"
echo "  API URL:        $API_URL"
echo "  API Gateway ID: $EXISTING_API_ID"
echo "  User Pool:      $USER_POOL_ID_OUT"
echo "  App Client:     $APP_CLIENT_ID"
echo "  Private Bucket: $PRIVATE_BUCKET"
echo "  ────────────────────────────────────────────────────"
echo ""
echo "  Next: share dropbox_outputs.json with music-player-893 and dliv-web-893."
echo ""
