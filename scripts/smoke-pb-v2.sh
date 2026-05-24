#!/usr/bin/env bash
set -euo pipefail

MC_URL="${MC_URL:-https://mc-dev.pdlab.dev}"
DISCORD_USER_ID="${DISCORD_USER_ID:-81888309009190912}"

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"

HMAC_SECRET=$(kubectl -n mission-control get secret pete-bot-hmac-secret \
  -o jsonpath='{.data.PETE_BOT_HMAC_SECRET}' | base64 -d)
if [ -z "$HMAC_SECRET" ]; then
  echo "[smoke] FAIL: HMAC secret is empty"
  exit 1
fi
echo "[smoke] HMAC secret length: ${#HMAC_SECRET} chars"

# Port-forward mc-backend for auth-gated GET calls
kubectl -n mission-control port-forward svc/mission-control-backend 13000:3000 &>/tmp/smoke-pf-mc.log &
MC_PF_PID=$!
trap "kill $MC_PF_PID 2>/dev/null || true" EXIT
sleep 3
MC_LOCAL="http://127.0.0.1:13000"

# 1. Create plan via MC public ingress (agent-facing -- no auth needed)
PLAN_RESP=$(curl -fsS -X POST "$MC_URL/api/v1/plans" \
  -H 'content-type: application/json' \
  -d '{
    "kind": "proposed_fix",
    "severity": "warn",
    "source": "agent",
    "summary": "PB v2 autonomous smoke test from runbook",
    "actions": [
      {"actionId": "yes", "label": "Looks good", "style": "primary"},
      {"actionId": "dismiss", "label": "Dismiss", "style": "secondary"}
    ],
    "expiresInSeconds": 600
  }')
PLAN_ID=$(echo "$PLAN_RESP" | jq -r '.planId')
echo "[smoke] created plan: $PLAN_ID"
[ "$PLAN_ID" = "null" ] && { echo "[smoke] FAIL: no planId returned: $PLAN_RESP"; exit 1; }

# 2. Poll for presented via port-forward (auth-gated route uses X-Forwarded headers)
STATUS=""
for i in {1..15}; do
  sleep 2
  STATUS=$(curl -fsS \
    -H 'x-forwarded-email: pedelgadillo@gmail.com' \
    -H 'x-forwarded-user: pedro' \
    -H 'x-forwarded-groups: mc-admins' \
    "$MC_LOCAL/api/v1/plans/$PLAN_ID" | jq -r '.plan.status' 2>/dev/null || echo "fetch_err")
  echo "[smoke] poll $i: status=$STATUS"
  [ "$STATUS" = "presented" ] && break
done
if [ "$STATUS" != "presented" ]; then
  echo "[smoke] FAIL: never reached presented (got '$STATUS' after 30s)"
  echo "[smoke] mc-backend logs (last 30):"
  kubectl -n mission-control logs deploy/mission-control-backend --tail=30 | grep -iE 'notify|plan|pete-bot' || true
  exit 1
fi

# 3. Forge an HMAC-signed click -- bypasses Discord entirely
TIMESTAMP=$(date +%s%3N)
BODY=$(jq -nc \
  --arg planId "$PLAN_ID" \
  --arg actionId "yes" \
  --arg discordUserId "$DISCORD_USER_ID" \
  --arg clickTs "$(date -u +%FT%TZ)" \
  '{planId: $planId, actionId: $actionId, discordUserId: $discordUserId, clickTs: $clickTs}')

SIG=$(printf '%s' "${TIMESTAMP}.${BODY}" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex | awk '{print $NF}')

echo "[smoke] posting click (body=$BODY)"
CB_RESP=$(curl -sS -w '\n%{http_code}' -X POST "$MC_URL/api/v1/discord/callback" \
  -H "content-type: application/json" \
  -H "x-pete-bot-signature: sha256=$SIG" \
  -H "x-pete-bot-timestamp: $TIMESTAMP" \
  -d "$BODY")
CB_BODY=$(echo "$CB_RESP" | head -n -1)
CB_STATUS=$(echo "$CB_RESP" | tail -1)
echo "[smoke] callback status: $CB_STATUS"
echo "[smoke] callback body: $CB_BODY"
[ "$CB_STATUS" != "200" ] && { echo "[smoke] FAIL: callback non-200"; exit 1; }

# 4. Confirm clicked + actor recorded via port-forward
sleep 2
DETAIL=$(curl -fsS \
  -H 'x-forwarded-email: pedelgadillo@gmail.com' \
  -H 'x-forwarded-user: pedro' \
  -H 'x-forwarded-groups: mc-admins' \
  "$MC_LOCAL/api/v1/plans/$PLAN_ID")
FINAL_STATUS=$(echo "$DETAIL" | jq -r '.plan.status')
ACTED_BY=$(echo "$DETAIL" | jq -r '.actions[] | select(.action_id=="yes") | .acted_by_user')
echo "[smoke] final status=$FINAL_STATUS acted_by=$ACTED_BY"

if [ "$FINAL_STATUS" = "clicked" ] && [ "$ACTED_BY" = "pedro" ]; then
  echo "[smoke] PASS"
  exit 0
fi
echo "[smoke] FAIL: status=$FINAL_STATUS acted_by=$ACTED_BY (expected clicked/pedro)"
exit 1
