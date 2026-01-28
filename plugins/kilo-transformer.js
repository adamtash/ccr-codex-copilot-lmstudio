// ~/.claude-code-router/plugins/kilo-transformer.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class KiloTransformer {
  name = "kilo-transformer";

  constructor(options) {
    this.options = options || {};
    this.debug = this.options.debug || false;
    this.headersFile =
      this.options.headers_file ||
      this.options.headersFile ||
      process.env.KILO_HEADERS_FILE ||
      "";
    this.stripAuthorization = this.options.strip_authorization !== false;
    this.version = this.options.version || "5.1.0";
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

  generateKiloHeaders() {
    const taskId = crypto.randomUUID();
    const editorVersion = "Visual Studio Code - Insiders 1.109.0-insider";
    
    return {
      "authorization": `Bearer ${this.options.api_key || ""}`,
      "Accept": "application/json",
      "X-Stainless-Retry-Count": "0",
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": "5.12.2",
      "X-Stainless-OS": "MacOS",
      "X-Stainless-Arch": "arm64",
      "X-Stainless-Runtime": "node",
      "X-Stainless-Runtime-Version": "v22.21.1",
      "HTTP-Referer": "https://kilocode.ai",
      "X-Title": "Kilo Code",
      "X-KiloCode-Version": this.version,
      "User-Agent": `Kilo-Code/${this.version}`,
      "content-type": "application/json",
      "X-KiloCode-EditorName": editorVersion,
      "X-KiloCode-TaskId": taskId,
      "accept-language": "*",
      "sec-fetch-mode": "cors",
    };
  }

  async transformRequestIn(request) {
    const body = typeof request === "string" ? JSON.parse(request) : { ...request };

    if (this.debug) {
      console.log("\n[DEBUG] KiloTransformer Transform Request In");
      console.log("Original Request:", JSON.stringify(body, null, 2));
    }

    // Track if the original request was for streaming
    this.isStreamRequest = body.stream === true;

    // Build Kilo-specific headers
    const kiloHeaders = this.generateKiloHeaders();
    
    // Load headers from file if specified
    const injectedHeaders = this.loadHeadersFromFile();
    
    // Merge headers: request headers < kilo headers < injected headers
    let headers = {
      ...(request.headers || {}),
      ...kiloHeaders,
      ...injectedHeaders,
    };

    // Handle authorization
    if (this.stripAuthorization && !("Authorization" in injectedHeaders) && !("authorization" in injectedHeaders)) {
      delete headers.Authorization;
      delete headers.authorization;
    }

    // Add Kilo-specific metadata headers from request if available
    if (body.organization_id || this.options.organization_id) {
      headers["X-KiloCode-OrganizationId"] = body.organization_id || this.options.organization_id;
    }
    if (body.project_id || this.options.project_id) {
      headers["X-KiloCode-ProjectId"] = body.project_id || this.options.project_id;
    }

    headers = this.sanitizeHeaders(headers);

    // Transform the request body to Kilo format
    // Kilo uses OpenAI-compatible format but with some specific requirements
    const transformedBody = {
      model: body.model,
      messages: body.messages || [],
      max_tokens: body.max_tokens || 4096,
      temperature: body.temperature ?? 0,
      stream: body.stream ?? true,
      tools: body.tools,
      tool_choice: body.tool_choice,
      ...((body.tools || body.tool_choice) && { parallel_tool_calls: body.parallel_tool_calls ?? false }),
    };

    // Remove undefined values
    Object.keys(transformedBody).forEach(key => {
      if (transformedBody[key] === undefined) {
        delete transformedBody[key];
      }
    });

    const result = {
      body: transformedBody,
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

  async transformResponseOut(response) {
    if (this.debug) {
      console.log("\n[DEBUG] KiloTransformer Transform Response Out");
      console.log("Original Response Status:", response.status);
      console.log("Original Response Headers:", Object.fromEntries(response.headers.entries()));
    }

    // Check if this is a streaming response
    const contentType = response.headers.get("Content-Type") || "";
    const isStream = contentType.includes("event-stream") || contentType.includes("text/event-stream");

    if (!isStream) {
      // Non-streaming response - pass through as-is
      if (this.debug) {
        console.log("Non-streaming response - passing through");
      }
      return response;
    }

    // Handle streaming response
    if (!response.body) {
      return response;
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const self = this;
    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body.getReader();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer.trim()) {
                self.processStreamLine(buffer, controller, encoder);
              }
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.trim()) {
                self.processStreamLine(line, controller, encoder);
              }
            }
          }
        } catch (error) {
          console.error("Stream processing error:", error);
          controller.error(error);
        } finally {
          try {
            reader.releaseLock();
          } catch (e) {
            console.error("Error releasing reader lock:", e);
          }
          controller.close();
        }
      },
    });

    const streamResponse = new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...this.getCorsHeaders(),
      },
    });

    if (this.debug) {
      console.log("Streaming Response Created");
      console.log("Response transformation complete (streaming)\n");
    }

    return streamResponse;
  }

  processStreamLine(line, controller, encoder) {
    if (this.debug) {
      console.log("[DEBUG] Stream Line:", line);
    }

    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();

      if (data === "[DONE]") {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        return;
      }

      if (!data) return;

      try {
        const chunk = JSON.parse(data);
        
        // Transform the chunk if needed
        const transformedChunk = this.transformChunk(chunk);
        
        if (transformedChunk) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(transformedChunk)}\n\n`));
        }
      } catch (error) {
        // If parsing fails, pass through the original line
        if (this.debug) {
          console.log("[DEBUG] Failed to parse chunk, passing through:", line);
        }
        controller.enqueue(encoder.encode(line + "\n"));
      }
    } else if (line.startsWith(": ")) {
      // Comment lines (like ": OPENROUTER PROCESSING") - filter them out
      if (this.debug) {
        console.log("[DEBUG] Filtering out comment line:", line);
      }
      // Don't forward comment lines
      return;
    } else {
      // Pass through other lines
      controller.enqueue(encoder.encode(line + "\n"));
    }
  }

  transformChunk(chunk) {
    // Kilo/OpenRouter returns chunks in OpenAI-compatible format
    // We pass them through with minimal transformation
    
    if (!chunk || typeof chunk !== "object") {
      return chunk;
    }

    // Ensure the chunk has the required fields
    const transformed = {
      ...chunk,
      object: chunk.object || "chat.completion.chunk",
    };

    // Handle tool_calls in delta if present
    if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
      const delta = chunk.choices[0].delta;
      
      // Ensure tool_calls are properly formatted
      if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
        delta.tool_calls = delta.tool_calls.map(tc => ({
          index: tc.index ?? 0,
          id: tc.id,
          type: tc.type || "function",
          function: tc.function || {},
        }));
      }
    }

    return transformed;
  }

  getCorsHeaders() {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
  }
}

module.exports = KiloTransformer;
