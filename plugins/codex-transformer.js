// ~/.claude-code-router/plugins/codex-transformer.js
const fs = require("fs");
const path = require("path");
class CodexTransformer {
  name = "codex-transformer";

  constructor(options) {
    this.options = options || {};
    this.debug = this.options.debug || false;
    this.headersFile =
      this.options.headers_file ||
      this.options.headersFile ||
      process.env.CODEX_HEADERS_FILE ||
      "";
    this.stripAuthorization = this.options.strip_authorization !== false;

    // Reasoning configuration with validation
    this.reasoning = this.validateReasoningConfig(this.options.reasoning || {});
  }

  validateReasoningConfig(config) {
    const validEfforts = ["low", "medium", "high", "none", "minimal"];
    const validSummaries = ["auto", "concise", "detailed", "none"];

    const defaults = {
      enable: false,
      effort: "minimal",
      summary: "auto",
    };

    const result = { ...defaults };

    // Validate enable
    if (config.enable !== undefined) {
      if (typeof config.enable === "boolean") {
        result.enable = config.enable;
      } else {
        console.warn(
          `[CodexTransformer] Invalid reasoning.enable value: ${config.enable}. Expected boolean. Using default: ${defaults.enable}`
        );
      }
    }

    // Validate effort
    if (config.effort !== undefined) {
      if (validEfforts.includes(config.effort)) {
        result.effort = config.effort;
      } else {
        console.warn(
          `[CodexTransformer] Invalid reasoning.effort value: ${config.effort}. Expected one of: ${validEfforts.join(", ")}. Using default: ${defaults.effort}`
        );
      }
    }

    // Validate summary
    if (config.summary !== undefined) {
      if (validSummaries.includes(config.summary)) {
        result.summary = config.summary;
      } else {
        console.warn(
          `[CodexTransformer] Invalid reasoning.summary value: ${config.summary}. Expected one of: ${validSummaries.join(", ")}. Using default: ${defaults.summary}`
        );
      }
    }

    return result;
  }

  loadHeadersFromFile() {
    if (!this.headersFile) return {};
    const p = path.isAbsolute(this.headersFile)
      ? this.headersFile
      : path.join(process.cwd(), this.headersFile);
    if (!fs.existsSync(p)) return {};
    try {
      const raw = fs.readFileSync(p, "utf8");
      const data = JSON.parse(raw);
      return typeof data === "object" && data ? data : {};
    } catch (e) {
      return {};
    }
  }

  sanitizeHeaders(headers) {
    const out = { ...headers };
    const drop = new Set(["host", "content-length", "accept-encoding", "connection"]);
    for (const key of Object.keys(out)) {
      if (drop.has(key.toLowerCase())) {
        delete out[key];
      }
      if (out[key] === undefined || out[key] === null || out[key] === "") {
        delete out[key];
      }
    }
    return out;
  }

  async transformRequestIn(request) {
    const body = typeof request === "string" ? JSON.parse(request) : { ...request };

    if (this.debug) {
      console.log("\n[DEBUG] CodexTransformer Transform Request In");
      console.log("Original Request:", JSON.stringify(body, null, 2));
    }

    // Track if this is a completion request for response conversion
    this.isCompletionRequest = body.prompt !== undefined;
    // Track if the original request was for streaming
    this.isStreamRequest = body.stream === true;

    // Convert OpenAI Chat Completions format to OpenAI Response API format
    const inputItems = this.convertToResponseInput(body);
    const tools = this.convertToolsToResponseFormat(body.tools);

    // Handle system messages separately
    let instructions = typeof body.instructions === "string" ? body.instructions : "";
    if (body.messages) {
      const systemMessage = body.messages.find((m) => m.role === "system");
      if (systemMessage) {
        if (typeof systemMessage.content === "string") {
          instructions = systemMessage.content;
        } else if (Array.isArray(systemMessage.content)) {
          const parts = [];
          for (const part of systemMessage.content) {
            if (typeof part === "object" && part !== null) {
              const text = part.text || part.content;
              if (typeof text === "string" && text) {
                parts.push(text);
              }
            }
          }
          instructions = parts.join("\n");
        }
      }
    }
    if (!instructions || !instructions.trim()) {
      instructions = "You are a helpful assistant.";
    }

    // Handle reasoning parameter
    const include = [];
    let reasoningParam = null;

    // Enable reasoning if configured in options or explicitly requested
    const shouldEnableReasoning = this.reasoning.enable || body.reasoning;

    if (shouldEnableReasoning) {
      include.push("reasoning.encrypted_content");

      // Use options as defaults, allow request body to override
      const reasoningOverrides = typeof body.reasoning === "object" ? body.reasoning : {};
      reasoningParam = this.buildReasoningParam(
        this.reasoning.effort,
        this.reasoning.summary,
        reasoningOverrides
      );
    }

    // Build OpenAI Response API request body
    const responseBody = {
      model: this.normalizeModelName(body.model),
      instructions: instructions,
      input: inputItems,
      tools: tools || [],
      tool_choice: this.convertToolChoice(body.tool_choice),
      parallel_tool_calls: body.parallel_tool_calls || false,
      store: false,
      stream: true,
      include: include,
      ...(reasoningParam && { reasoning: reasoningParam }),
    };

    const injectedHeaders = this.loadHeadersFromFile();
    let headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(request.headers || {}),
      ...injectedHeaders,
    };
    if (this.stripAuthorization && !("Authorization" in injectedHeaders) && !("authorization" in injectedHeaders)) {
      delete headers.Authorization;
      delete headers.authorization;
    }
    headers = this.sanitizeHeaders(headers);

    const result = {
      body: responseBody,
      config: {
        headers,
      },
    };

    if (this.debug) {
      console.log("Transformed Request:", JSON.stringify(result, null, 2));
      console.log("Request transformation complete\n");
    }

    return result;
  }

  normalizeModelName(name) {
    if (typeof name !== "string" || !name.trim()) {
      return "gpt-5.2-codex";
    }
    const base = name.split(":", 1)[0].trim();
    const mapping = {
      "gpt-5.2-codex": "gpt-5.2-codex",
      "gpt-5.2-codex-latest": "gpt-5.2-codex",
      gpt5: "gpt-5.2-codex",
      "gpt-5": "gpt-5.2-codex",
      codex: "gpt-5.2-codex",
    };
    return mapping[base] || base;
  }

  convertToResponseInput(body) {
    const inputItems = [];

    if (body.prompt !== undefined) {
      const messages = [{ role: "user", content: body.prompt }];
      if (body.suffix) {
        messages.push({ role: "assistant", content: body.suffix });
      }
      return messages.map((m) => ({
        role: m.role,
        content: [{ type: "input_text", text: m.content }],
      }));
    }

    if (body.messages) {
      for (const msg of body.messages) {
        if (!msg || !msg.role) continue;
        if (msg.role === "system") continue;
        inputItems.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: this.convertContentToInput(msg.content),
        });
      }
    }

    return inputItems;
  }

  convertContentToInput(content) {
    if (typeof content === "string") {
      return [{ type: "input_text", text: content }];
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === "string") {
            return { type: "input_text", text: item };
          }
          if (!item || typeof item !== "object") return null;
          if (item.type === "text") {
            return { type: "input_text", text: item.text || "" };
          }
          if (item.type === "image_url" && item.image_url?.url) {
            return { type: "input_image", image_url: item.image_url.url };
          }
          return null;
        })
        .filter(Boolean);
    }

    return [{ type: "input_text", text: String(content || "") }];
  }

  convertToolsToResponseFormat(tools) {
    if (!tools || !Array.isArray(tools)) return [];
    return tools.map((tool) => {
      if (!tool || !tool.function) return tool;
      return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      };
    });
  }

  convertToolChoice(toolChoice) {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === "string") return toolChoice;
    if (toolChoice.type === "function" && toolChoice.function?.name) {
      return { type: "function", name: toolChoice.function.name };
    }
    return toolChoice;
  }

  buildReasoningParam(defaultEffort, defaultSummary, overrides) {
    const validEfforts = ["low", "medium", "high", "none", "minimal"];
    const validSummaries = ["auto", "concise", "detailed", "none"];
    const effort = validEfforts.includes(overrides.effort)
      ? overrides.effort
      : defaultEffort;
    const summary = validSummaries.includes(overrides.summary)
      ? overrides.summary
      : defaultSummary;
    return { effort, summary };
  }

  async transformResponseOut(response) {
    if (this.isStreamRequest) {
      return response;
    }

    // If client didn't request stream, buffer and convert to JSON
    const stream = response.data;
    let buffer = "";
    const chunks = [];

    for await (const chunk of stream) {
      const text = chunk.toString();
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          chunks.push(json);
        } catch (e) {
          // ignore parse errors
        }
      }
    }

    const out = this.convertResponseToChatCompletions(chunks);
    response.data = out;
    response.headers["content-type"] = "application/json";
    return response;
  }

  convertResponseToChatCompletions(chunks) {
    let text = "";
    let role = "assistant";
    let toolCalls = [];
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    for (const chunk of chunks) {
      if (!chunk) continue;
      if (chunk.type === "response.output_text.delta") {
        text += chunk.delta || "";
      } else if (chunk.type === "response.output_text.done") {
        text += chunk.text || "";
      } else if (chunk.type === "response.output_item.added") {
        if (chunk.item?.type === "message") {
          role = chunk.item.role || role;
        }
      } else if (chunk.type === "response.output_item.done") {
        if (chunk.item?.type === "function_call") {
          toolCalls.push({
            id: chunk.item.id,
            type: "function",
            function: {
              name: chunk.item.name,
              arguments: chunk.item.arguments || "",
            },
          });
        }
      } else if (chunk.type === "response.completed") {
        if (chunk.response?.usage) {
          usage = chunk.response.usage;
        }
      }
    }

    const message = {
      role,
      content: text,
    };
    if (toolCalls.length) {
      message.tool_calls = toolCalls;
    }

    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-5.2-codex",
      choices: [
        {
          index: 0,
          message,
          finish_reason: "stop",
        },
      ],
      usage,
    };
  }
}

module.exports = CodexTransformer;
