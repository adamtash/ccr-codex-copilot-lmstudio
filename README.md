# ccr-codex-copilot-lmstudio

Curated setup for **Claude Code Router** with example configurations for:
- GitHub Copilot
- OpenAI Codex (Responses API)
- LM Studio (local OpenAI-compatible server)
- Kilo Code (kilo.ai)

## What this is based on
This setup follows the same routing + transformer model as the upstream **claude-code-router** project, where:
- Providers define upstreams (Copilot, Codex, LM Studio).
- Transformers adapt request/response formats or inject headers.
- Router picks default provider/model pairs.  
See the upstream project for full context and updates:
https://github.com/musistudio/claude-code-router

## Contents
- `config.example.json` — example router config with Copilot/Codex/LM Studio.
- `presets/example/manifest.json` — preset template for quick switching.
- `plugins/copilot-transformer.js` — Copilot header injector + token refresh.
- `plugins/codex-transformer.js` — Chat Completions → Responses API conversion.
- `plugins/kilo-transformer.js` — Kilo Code header injector and request transformer.
- `codex-headers.example.json` — Codex auth header
- `scripts/copilot-auth-simple.sh` — device-flow login + token cache helper.

## Quick start
1) Install or clone Claude Code Router (CCR).
2) Copy example files into your CCR directory:
   - `config.example.json` → `config.json`
   - `codex-headers.example.json` → `codex-headers.json`
3) Set `CCR_HOME` to your CCR install directory:
   - Example: `export CCR_HOME="$HOME/.claude-code-router"`
4) Edit `config.json` (see below) and start CCR.

## Configuration notes
### 1) Providers
`config.example.json` includes three providers:
- **LM Studio**: `http://localhost:1234/v1/chat/completions`
- **Copilot**: `https://api.individual.githubcopilot.com/chat/completions`
- **Codex**: `https://chatgpt.com/backend-api/codex/responses`

### 2) Transformers
- `copilot-transformer`:
  - Adds required Copilot headers.
  - Uses a local token cache (`~/.copilot-tokens.json` by default).
  - Auto-refreshes token when close to expiry.
- `codex-transformer`:
  - Converts Chat Completions → Responses API format.
  - Merges headers from `codex-headers.json`.
  - Can enable reasoning via `options.reasoning`.
- `kilo-transformer`:
  - Adds Kilo Code-specific headers (e.g., `X-KiloCode-Version`, `X-KiloCode-TaskId`).
  - Loads custom headers from an optional headers file.
  - Strips Authorization header unless overridden (configurable via `strip_authorization`).
  - Generates random task IDs for each request.

### 3) Codex headers
`codex-headers.example.json` is a template.  
Create `codex-headers.json` and paste real values there.

#### Capturing Codex headers (VS Code)

Recommended approaches:
- **Proxy the Extension Host**: launch VS Code with `HTTPS_PROXY`/`HTTP_PROXY` set to a local proxy (Proxyman, Charles, mitmproxy) and trust the proxy cert. This shows the actual `/backend-api/codex/responses` request headers you need.
- **OS-level capture**: use Wireshark/tcpdump to inspect traffic from the Extension Host process.

Once you see the request, copy the relevant request headers into `codex-headers.json`.

### 4) Copilot auth
Run:
```
bash scripts/copilot-auth-simple.sh
```
This script will:
- authenticate via GitHub device flow
- fetch a Copilot token
- save it to `~/.copilot-tokens.json`
- update your CCR config automatically (if `jq` is installed)

### 5) Presets
If you use CCR presets, copy `presets/example/manifest.json` and customize it.

## Not affiliated
This repository is an independent setup helper. It is not affiliated with GitHub, OpenAI, or Anthropic.
