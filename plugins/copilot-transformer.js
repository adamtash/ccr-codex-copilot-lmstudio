// ~/.claude-code-router/plugins/copilot-transformer.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class CopilotTransformer {
  name = 'copilot-transformer';

  copilotHeaders({ vision, isAgent }) {
    const VERSION = '0.26.7';
    const EDITOR_VERSION = 'vscode/1.103.2';
    const API_VERSION = '2025-04-01';
    const headers = {
      'Copilot-Integration-ID': 'vscode-chat',
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Plugin-Version': `copilot-chat/${VERSION}`,
      'editor-plugin-version': `copilot-chat/${VERSION}`,
      'Editor-Version': EDITOR_VERSION,
      'editor-version': EDITOR_VERSION,
      'User-Agent': `GitHubCopilotChat/${VERSION}`,
      'OpenAI-Intent': 'conversation-panel',
      'openai-intent': 'conversation-panel',
      'x-github-api-version': API_VERSION,
      'X-Initiator': isAgent ? 'agent' : 'user',
      'x-request-id': crypto.randomUUID(),
      'x-vscode-user-agent-library-version': 'electron-fetch',
      'Content-Type': 'application/json',
    };
    if (vision) {
      headers['copilot-vision-request'] = 'true';
    }
    return headers;
  }

  // Token file helpers
  tokenFilePath() {
    return process.env.COPILOT_TOKEN_FILE || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.copilot-tokens.json');
  }

  isTokenExpired(tokenData, bufferSeconds = 300) {
    if (!tokenData || !tokenData.expiresAt) return true;
    const now = Math.floor(Date.now() / 1000);
    return now >= (Number(tokenData.expiresAt) - bufferSeconds);
  }

  async refreshCopilotToken(existingData) {
    if (!existingData || !existingData.githubToken) throw new Error('No GitHub token found to refresh Copilot token. Please run auth script.');
    const url = 'https://api.github.com/copilot_internal/v2/token';
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${existingData.githubToken}`,
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'Editor-Version': 'vscode/1.99.3',
      'Editor-Plugin-Version': 'copilot-chat/0.26.7',
    };
    const fetchImpl = global.fetch || (await import('node-fetch')).default;
    const res = await fetchImpl(url, { headers });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Failed to refresh Copilot token: ${res.status} ${txt}`);
    }
    const data = await res.json();
    if (!data.token) throw new Error('No token in Copilot refresh response');
    let endpoint = data.endpoints?.api || '';
    if (endpoint && !endpoint.endsWith('/chat/completions')) endpoint = `${endpoint}/chat/completions`;
    const updated = {
      ...existingData,
      copilotToken: data.token,
      endpoint: endpoint || existingData.endpoint,
      expiresAt: data.expires_at,
      lastUpdated: new Date().toISOString(),
    };
    try { fs.writeFileSync(this.tokenFilePath(), JSON.stringify(updated, null, 2)); } catch (e) { /* ignore write errors */ }
    return updated;
  }

  async ensureValidToken() {
    const tokenFile = this.tokenFilePath();
    if (!fs.existsSync(tokenFile)) return null;
    let data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    if (this.isTokenExpired(data, 300)) {
      try { data = await this.refreshCopilotToken(data); } catch (e) { return data; }
    }
    return data;
  }

  async transformRequestIn(request) {
      const messages = request.messages || [];
      const vision = messages.some(
        (m) => typeof m.content !== 'string' && Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')
      );
      const isAgent = messages.some((m) => ['assistant', 'tool'].includes(m.role));
      const headers = this.copilotHeaders({ vision, isAgent });

      // Load and ensure token validity (will refresh if needed)
      try {
        const tokenData = await this.ensureValidToken();
        if (tokenData) {
          if (tokenData.copilotToken) {
            headers['Authorization'] = `Bearer ${tokenData.copilotToken}`;
          }
          const cfg = { headers };
          if (tokenData.endpoint) {
            cfg.url = tokenData.endpoint;
          } else if (request.api_base_url) {
            cfg.url = request.api_base_url;
          }

          const body = {
            ...request,
            model: request.model?.split(',').pop() || request.model,
            headers: { ...(request.headers || {}), ...headers }
          };

          return {
            body,
            config: cfg,
          };
        }
      } catch (e) {
        // refresh failed or no token available — fall back to provider values
      }

      // Fallback: use provider fields if present
      if (request.api_key && !headers.Authorization) {
        headers['Authorization'] = `Bearer ${request.api_key}`;
      }
      const config = { headers };
      if (request.api_base_url) {
        config.url = request.api_base_url;
      }

      const body = {
        ...request,
        model: request.model?.split(',').pop() || request.model,
        headers: { ...(request.headers || {}), ...headers }
      };
      return {
        body,
        config,
      };
  }

  async transformResponseOut(response) {
    return response;
  }
}

module.exports = CopilotTransformer;
