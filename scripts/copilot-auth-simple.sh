#!/bin/bash
# scripts/copilot-auth-simple.sh
# Requires: curl, jq

set -e

CLIENT_ID="01ab8ac9400c4e429b23"
DEVICE_CODE_URL="https://github.com/login/device/code"
ACCESS_TOKEN_URL="https://github.com/login/oauth/access_token"
COPILOT_API_KEY_URL="https://api.github.com/copilot_internal/v2/token"
TOKEN_FILE="${COPILOT_TOKEN_FILE:-$HOME/.copilot-tokens.json}"
USER_AGENT="GitHubCopilotChat/0.26.7"

# Copilot required headers for completions/chat API
COPILOT_HEADERS=(
  -H "User-Agent: GitHubCopilotChat/0.26.7"
  -H "Editor-Version: vscode/1.99.3"
  -H "Editor-Plugin-Version: copilot-chat/0.26.7"
  -H "Copilot-Integration-ID: vscode-chat"
  -H "OpenAI-Intent: conversation-panel"
  -H "x-github-api-version: 2025-04-01"
  -H "X-Initiator: user"
  -H "Content-Type: application/json"
)

CONFIG_FILE_GLOBAL="${COPILOT_GLOBAL_CONFIG:-$HOME/.claude-code-router/config.json}"
PLUGIN_PATH_DEFAULT="${CCR_HOME:-$HOME/.claude-code-router}/plugins/copilot-transformer.js"

update_config() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "jq is required to update config.json automatically."
    return 0
  fi

  cfg="$CONFIG_FILE_GLOBAL"
  mkdir -p "$(dirname "$cfg")"
  if [ ! -f "$cfg" ]; then
    echo "{}" > "$cfg"
  fi

  cp "$cfg" "$cfg.bak" 2>/dev/null || true

  tmp=$(mktemp)
  jq --arg plugin "$PLUGIN_PATH_DEFAULT" '
    (.transformers //= []) |
    (if (.transformers | map(.path) | index($plugin)) == null then
      .transformers += [{path:$plugin}]
    else . end)
  ' "$cfg" > "$tmp" && mv "$tmp" "$cfg"

  tmp=$(mktemp)
  jq --arg url "$endpoint" --arg key "$copilot_token" --arg pluginName "copilot-transformer" '
    (.Providers //= []) |
    (if (.Providers | map(.name) | index("Copilot")) == null then
      .Providers += [{"name":"Copilot","api_base_url":$url,"api_key":$key,"models":["gpt-5-mini","gpt-4.1"],"transformer":{"use":[$pluginName]}}]
    else
      (.Providers[] | select(.name=="Copilot") | .api_base_url) = $url |
      (.Providers[] | select(.name=="Copilot") | .api_key) = $key |
      (.Providers[] | select(.name=="Copilot") | .models) = ["gpt-5-mini","gpt-4.1"] |
      (.Providers[] | select(.name=="Copilot") | .transformer.use) = [$pluginName]
    end) |
    (.Router //= {}) |
    .Router.default = "Copilot,gpt-5-mini,gpt-4.1" |
    .Router.background = "Copilot,gpt-5-mini,gpt-4.1" |
    .Router.think = "Copilot,gpt-5-mini,gpt-4.1" |
    .Router.longContext = "Copilot,gpt-5-mini,gpt-4.1" |
    .Router.webSearch = "Copilot,gpt-5-mini,gpt-4.1"
  ' "$cfg" > "$tmp" && mv "$tmp" "$cfg"

  echo "Updated global config: $cfg"
}

if [ -f "$TOKEN_FILE" ]; then
  stored_expires=$(jq -r .expiresAt "$TOKEN_FILE" 2>/dev/null || echo "")
  stored_github=$(jq -r .githubToken "$TOKEN_FILE" 2>/dev/null || echo "")
  stored_endpoint=$(jq -r .endpoint "$TOKEN_FILE" 2>/dev/null || echo "")
  stored_token_val=$(jq -r .copilotToken "$TOKEN_FILE" 2>/dev/null || echo "")
  now=$(date +%s)
  buffer=300
  if [ -n "$stored_expires" ] && [ "$stored_expires" -gt $((now + buffer)) ] 2>/dev/null; then
    endpoint="$stored_endpoint"
    copilot_token="$stored_token_val"
    update_config
    echo "Using existing Copilot token."
    exit 0
  fi

  if [ -n "$stored_github" ] && [ "$stored_github" != "null" ]; then
    echo "Attempting to refresh Copilot token..."
    copilot_resp=$(curl -s "$COPILOT_API_KEY_URL" -H "Accept: application/json" -H "Authorization: Bearer $stored_github" -H "User-Agent: $USER_AGENT" -H "Editor-Version: vscode/1.99.3" -H "Editor-Plugin-Version: copilot-chat/0.26.7")
    new_token=$(echo "$copilot_resp" | jq -r .token)
    new_endpoint=$(echo "$copilot_resp" | jq -r '.endpoints.api // empty')
    new_expires=$(echo "$copilot_resp" | jq -r .expires_at)
    if [ -n "$new_token" ] && [ "$new_token" != "null" ]; then
      if [[ "$new_endpoint" != */chat/completions ]]; then
        new_endpoint="${new_endpoint}/chat/completions"
      fi
      cat > "$TOKEN_FILE" <<EOF
{
  "githubToken": "$stored_github",
  "copilotToken": "$new_token",
  "endpoint": "$new_endpoint",
  "expiresAt": $new_expires,
  "lastUpdated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
      endpoint="$new_endpoint"
      copilot_token="$new_token"
      update_config
      echo "Refreshed and saved new Copilot token."
      exit 0
    else
      echo "Refresh failed, will start device auth."
    fi
  fi
fi

resp=$(curl -s -X POST "$DEVICE_CODE_URL" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $USER_AGENT" \
  -d '{"client_id":"'$CLIENT_ID'","scope":"read:user"}')

device_code=$(echo "$resp" | jq -r .device_code)
user_code=$(echo "$resp" | jq -r .user_code)
verification_uri=$(echo "$resp" | jq -r .verification_uri)
interval=$(echo "$resp" | jq -r .interval)
expires_in=$(echo "$resp" | jq -r .expires_in)

if [ "$device_code" = "null" ]; then
  echo "Failed to start device flow: $resp"
  exit 1
fi

echo "Go to: $verification_uri"
echo "Enter code: $user_code"
echo "Waiting for authorization..."

access_token=""
attempts=$((expires_in / interval))
for ((i=0; i<attempts; i++)); do
  sleep $interval
  poll=$(curl -s -X POST "$ACCESS_TOKEN_URL" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "User-Agent: $USER_AGENT" \
    -d '{"client_id":"'$CLIENT_ID'","device_code":"'$device_code'","grant_type":"urn:ietf:params:oauth:grant-type:device_code"}')
  token=$(echo "$poll" | jq -r .access_token)
  error=$(echo "$poll" | jq -r .error)
  if [ "$token" != "null" ]; then
    access_token="$token"
    break
  fi
  if [ "$error" != "null" ] && [ "$error" != "authorization_pending" ]; then
    echo "Auth error: $poll"
    exit 1
  fi
  echo -n "."
done

if [ -z "$access_token" ]; then
  echo
  echo "Timed out waiting for authorization."
  exit 1
fi
echo
echo "GitHub OAuth successful!"

copilot=$(curl -s "$COPILOT_API_KEY_URL" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer $access_token" \
  "${COPILOT_HEADERS[@]}")

copilot_token=$(echo "$copilot" | jq -r .token)
endpoint=$(echo "$copilot" | jq -r '.endpoints.api // "https://copilot-proxy.githubusercontent.com/v1/engines/copilot-codex/completions"')
if [[ "$endpoint" != */chat/completions ]]; then
  endpoint="${endpoint}/chat/completions"
fi
expires_at=$(echo "$copilot" | jq -r .expires_at)

if [ "$copilot_token" = "null" ]; then
  echo "Failed to get Copilot token: $copilot"
  exit 1
fi

cat > "$TOKEN_FILE" <<EOF
{
  "githubToken": "$access_token",
  "copilotToken": "$copilot_token",
  "endpoint": "$endpoint",
  "expiresAt": $expires_at,
  "lastUpdated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

update_config
echo
echo "Copilot token saved to: $TOKEN_FILE"
