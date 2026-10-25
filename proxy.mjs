// proxy.mjs - Bridge between OpenAI-compatible clients (e.g. OpenCode) and Bike4Mind API
// Includes automatic API key pooling, multi-key rotation, and zero-downtime credit exhaustion failover.
import http from 'node:http';
import fs from 'node:fs';

const TARGET = process.env.BIKE4MIND_TARGET_URL || 'https://app.bike4mind.com/api/ai/v1/completions';
const PORT = parseInt(process.env.PORT || '4000', 10);

// Helper to mask keys for safe logging and status reporting
function maskKey(key) {
  if (!key || typeof key !== 'string') return 'none';
  if (key.length <= 12) return '***';
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

// Key pool manager with live hot-reloading and depletion tracking
class KeyPoolManager {
  constructor() {
    this.keys = [];
    this.currentIndex = 0;
    this.depleted = new Map(); // key -> reason string
    this.loadKeys();
  }

  loadKeys() {
    const loaded = [];

    // 1. Load from keys.txt if present (one key per line)
    try {
      if (fs.existsSync('keys.txt')) {
        const lines = fs.readFileSync('keys.txt', 'utf8')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'));
        loaded.push(...lines);
      }
    } catch (_) {}

    // 2. Load from comma/newline-separated BIKE4MIND_API_KEYS env var
    if (process.env.BIKE4MIND_API_KEYS) {
      const envKeys = process.env.BIKE4MIND_API_KEYS
        .split(/[,\n]/)
        .map(k => k.trim())
        .filter(Boolean);
      loaded.push(...envKeys);
    }

    // 3. Fallback to single BIKE4MIND_API_KEY env var
    if (process.env.BIKE4MIND_API_KEY) {
      const single = process.env.BIKE4MIND_API_KEY.trim();
      if (single && !loaded.includes(single)) {
        loaded.push(single);
      }
    }

    const unique = [...new Set(loaded)];
    for (const k of unique) {
      if (!this.keys.includes(k)) {
        this.keys.push(k);
      }
    }
  }

  getKey(preferredKey = null) {
    this.loadKeys();

    // If client supplied a specific key that isn't depleted, try it first
    if (preferredKey && !['pool', '{env:BIKE4MIND_API_KEY}', '***'].includes(preferredKey) && !this.depleted.has(preferredKey)) {
      if (!this.keys.includes(preferredKey)) {
        this.keys.push(preferredKey);
      }
      return preferredKey;
    }

    if (this.keys.length === 0) return null;

    // Search for next non-depleted key in pool
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.currentIndex + i) % this.keys.length;
      const key = this.keys[idx];
      if (!this.depleted.has(key)) {
        this.currentIndex = idx;
        return key;
      }
    }

    return null; // All keys depleted
  }

  markDepleted(key, reason = 'insufficient_credits') {
    if (!key) return;
    if (!this.depleted.has(key)) {
      this.depleted.set(key, reason);
      const remaining = this.keys.filter(k => !this.depleted.has(k)).length;
      console.warn(`[KeyPool] ÃƒÂ¢Ã…Â¡Ã‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Key ${maskKey(key)} marked DEPLETED (${reason}). Active keys remaining: ${remaining}/${this.keys.length}`);
      // Advance index
      this.currentIndex = (this.currentIndex + 1) % (this.keys.length || 1);
    }
  }

  getStatus() {
    this.loadKeys();
    const active = this.keys.filter(k => !this.depleted.has(k));
    return {
      total: this.keys.length,
      available: active.length,
      depleted: this.depleted.size,
      keys: this.keys.map((k, idx) => ({
        index: idx + 1,
        key: maskKey(k),
        status: this.depleted.has(k) ? `depleted (${this.depleted.get(k)})` : (this.keys[this.currentIndex] === k ? 'active' : 'standby')
      }))
    };
  }
}

const pool = new KeyPoolManager();
console.log(`[KeyPool] Initialized with ${pool.keys.length} key(s) detected.`);

// Checks if an upstream response indicates key exhaustion / invalidation
function isDepletionError(status, bodyText) {
  if (status === 401) return 'unauthorized / revoked';
  if (status === 403 && /quota|limit|credit|forbidden/i.test(bodyText)) return 'forbidden / quota exceeded';
  if (status === 422 && /insufficient_credits|spend_cap_exceeded|balance|credit/i.test(bodyText)) return 'insufficient_credits';
  if (status === 429 && /quota|credit/i.test(bodyText)) return 'quota_exhausted';
  return false;
}

http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    }).end();
    return;
  }

  // Health check & Key Pool status
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      status: 'ok',
      provider: 'Bike4Mind Proxy (with Auto-Key Failover)',
      port: PORT,
      target: TARGET,
      keyPool: pool.getStatus()
    }, null, 2));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);

        // Sanitize unexpected fields that fail Bike4Mind strict schema validation
        delete payload.user;
        delete payload.prompt_cache_reset;
        delete payload.stream_options;

        // Model aliases for convenient selection
        if (payload.model === 'claude-3-5-sonnet' || payload.model === 'sonnet-5.5' || payload.model === 'sonnet') {
          payload.model = 'claude-sonnet-5-5';
        } else if (payload.model === 'claude-3-5-haiku' || payload.model === 'haiku-5.5' || payload.model === 'haiku') {
          payload.model = 'claude-haiku-5-5';
        } else if (payload.model === 'opus-5.5' || payload.model === 'opus') {
          payload.model = 'claude-opus-5-5';
        }

        // Ensure massive output token budget so Claude's extended thinking (3-4k tokens)
        // + large file writes (like render.ts) never hit the default 4,096 token limit
        if (!payload.max_tokens || payload.max_tokens < 128000) {
          payload.max_tokens = 128000;
          payload.maxTokens = 128000;
        }

        // Default reasoning effort to medium for reasoning-capable models if not explicitly set
        if (payload.model.includes('sonnet') || payload.model.includes('opus') || payload.model.includes('fable')) {
          if (!payload.reasoning_effort && !payload.options?.reasoningEffort) {
            payload.options = { ...payload.options, reasoningEffort: 'medium' };
          }
        }

        // Translate OpenAI tools format: { type: "function", function: { name, description, parameters } }
        // into Bike4Mind tools format: { toolSchema: { name, description, parameters } }
        if (Array.isArray(payload.tools)) {
          payload.tools = payload.tools.map(t => {
            if (t.toolSchema) return t;
            if (t.function) {
              return {
                toolSchema: {
                  name: t.function.name,
                  description: t.function.description || '',
                  parameters: t.function.parameters || { type: 'object', properties: {} }
                }
              };
            }
            return t;
          });
        }

        // Translate OpenAI messages format to Bike4Mind:
        // 1. messages with content: null -> content: ""
        // 2. assistant tool_calls -> content blocks with type: "tool_use"
        // 3. role: "tool" -> role: "user" with content block type: "tool_result"
        // 4. Consecutive tool results are merged into a single user message
        if (Array.isArray(payload.messages)) {
          const translatedMessages = [];

          for (const msg of payload.messages) {
            if (msg.role === 'tool') {
              const toolResultBlock = {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id || '',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
              };

              const prev = translatedMessages[translatedMessages.length - 1];
              if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
                prev.content.push(toolResultBlock);
              } else {
                translatedMessages.push({
                  role: 'user',
                  content: [toolResultBlock]
                });
              }
            } else if (msg.role === 'assistant') {
              const contentBlocks = [];

              if (typeof msg.content === 'string' && msg.content.trim()) {
                contentBlocks.push({ type: 'text', text: msg.content });
              } else if (Array.isArray(msg.content)) {
                contentBlocks.push(...msg.content);
              }

              if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                  let parsedArgs = {};
                  try {
                    parsedArgs = typeof tc.function?.arguments === 'string'
                      ? JSON.parse(tc.function.arguments)
                      : (tc.function?.arguments || {});
                  } catch (_) {
                    parsedArgs = {};
                  }

                  contentBlocks.push({
                    type: 'tool_use',
                    id: tc.id || `toolu_${Date.now()}`,
                    name: tc.function?.name || tc.name,
                    input: parsedArgs
                  });
                }
              }

              translatedMessages.push({
                role: 'assistant',
                content: contentBlocks.length > 0 ? contentBlocks : (msg.content || '')
              });
            } else {
              translatedMessages.push({
                role: msg.role || 'user',
                content: msg.content === null || msg.content === undefined ? '' : msg.content
              });
            }
          }

          payload.messages = translatedMessages;
        }

        const isClientStreaming = payload.stream !== false;
        const requestedModel = payload.model;

        // Determine client incoming authorization header if any
        let incomingToken = null;
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
          incomingToken = authHeader.slice(7).trim();
        }

        // Start SSE response headers immediately to prevent OpenCode client header timeout
        if (isClientStreaming) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          });
          res.write(': keepalive\n\n');
        }

        const keepaliveTimer = setInterval(() => {
          if (!res.writableEnded && isClientStreaming) {
            res.write(': keepalive\n\n');
          }
        }, 8000);

        // Failover retry loop: try keys from pool until success or all depleted
        let upstream = null;
        let activeKeyUsed = null;
        const maxAttempts = Math.max(1, pool.keys.length);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          activeKeyUsed = pool.getKey(incomingToken);

          if (!activeKeyUsed) {
            console.error('[KeyPool] ÃƒÂ¢Ã‚ÂÃ…â€™ All API keys in pool are depleted or no keys configured!');
            break;
          }

          const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${activeKeyUsed}`
          };

          console.log(`[Proxy] Forwarding ${payload.model} (key: ${maskKey(activeKeyUsed)}, messages: ${payload.messages.length}) to B4M...`);

          try {
            upstream = await fetch(TARGET, {
              method: 'POST',
              headers,
              body: JSON.stringify(payload),
            });
          } catch (netErr) {
            console.error(`[Proxy] Network error with key ${maskKey(activeKeyUsed)}:`, netErr.message);
            continue;
          }

          if (upstream.ok) {
            // Success! Proceed to stream or return response
            break;
          }

          // Check if failure is due to credit exhaustion, invalidation, or rate limit
          const errText = await upstream.text();
          const depletionReason = isDepletionError(upstream.status, errText);

          if (depletionReason) {
            console.warn(`[Proxy] Upstream ${upstream.status} indicates key exhaustion (${depletionReason}) on key ${maskKey(activeKeyUsed)}. Auto-switching to next key...`);
            pool.markDepleted(activeKeyUsed, depletionReason);
            incomingToken = null; // force pool selection on next attempt
            upstream = null;
            continue;
          } else {
            // Other error (e.g. 400 bad request, schema error) - don't rotate key
            console.error(`[Proxy] Upstream error ${upstream.status}:`, errText);
            clearInterval(keepaliveTimer);
            if (isClientStreaming) {
              res.write(`data: ${JSON.stringify({ error: { message: `Upstream error ${upstream.status}: ${errText}` } })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            } else {
              res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(errText);
            }
            return;
          }
        }

        if (!upstream || !upstream.ok) {
          clearInterval(keepaliveTimer);
          const failureMsg = pool.keys.length === 0
            ? 'No Bike4Mind API keys configured in proxy.'
            : 'All Bike4Mind API keys in pool are exhausted or unavailable.';
          console.error(`[KeyPool] Request aborted: ${failureMsg}`);
          if (isClientStreaming) {
            res.write(`data: ${JSON.stringify({ error: { message: failureMsg } })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: failureMsg }));
          }
          return;
        }

        // Process successful response
        if (isClientStreaming) {
          let requestId = 'chatcmpl-' + Date.now();
          let buffer = '';
          let hasToolCalls = false;
          let sentFinishReason = false;
          let lastUsage = null;
          let finishReasonToUse = null;

          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();

          const emitFinishIfNeeded = () => {
            if (sentFinishReason) return;
            sentFinishReason = true;
            clearInterval(keepaliveTimer);

            const finalReason = hasToolCalls ? 'tool_calls' : (finishReasonToUse || 'stop');
            const finishChunk = {
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: finalReason
              }]
            };
            if (lastUsage) {
              finishChunk.usage = {
                prompt_tokens: lastUsage.inputTokens || 0,
                completion_tokens: lastUsage.outputTokens || 0,
                total_tokens: (lastUsage.inputTokens || 0) + (lastUsage.outputTokens || 0)
              };
            }
            res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data:')) continue;

              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') {
                emitFinishIfNeeded();
                res.write('data: [DONE]\n\n');
                continue;
              }

              try {
                const b4mChunk = JSON.parse(dataStr);

                if (b4mChunk.requestId) {
                  requestId = b4mChunk.requestId;
                }
                if (b4mChunk.usage) {
                  lastUsage = b4mChunk.usage;
                }

                if (b4mChunk.type === 'content') {
                  if (b4mChunk.text && !sentFinishReason) {
                    const openAiChunk = {
                      id: requestId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: requestedModel,
                      choices: [{
                        index: 0,
                        delta: { content: b4mChunk.text },
                        finish_reason: null
                      }]
                    };
                    res.write(`data: ${JSON.stringify(openAiChunk)}\n\n`);
                  }
                  if (b4mChunk.stopReason) {
                    finishReasonToUse = b4mChunk.stopReason === 'end_turn' ? 'stop' : (b4mChunk.stopReason === 'max_tokens' ? 'length' : b4mChunk.stopReason);
                    emitFinishIfNeeded();
                  }
                } else if (b4mChunk.type === 'tool_use' && Array.isArray(b4mChunk.tools)) {
                  hasToolCalls = true;

                  if (!sentFinishReason) {
                    for (let i = 0; i < b4mChunk.tools.length; i++) {
                      const tool = b4mChunk.tools[i];
                      const openAiToolChunk = {
                        id: requestId,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: requestedModel,
                        choices: [{
                          index: 0,
                          delta: {
                            tool_calls: [{
                              index: i,
                              id: tool.id || `call_${Date.now()}_${i}`,
                              type: 'function',
                              function: {
                                name: tool.name,
                                arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments || {})
                              }
                            }]
                          },
                          finish_reason: null
                        }]
                      };
                      res.write(`data: ${JSON.stringify(openAiToolChunk)}\n\n`);
                    }
                  }
                }
              } catch (e) {
                // If not valid JSON, ignore
              }
            }
          }

          emitFinishIfNeeded();
          clearInterval(keepaliveTimer);
          res.end();
        } else {
          // Non-streaming response collection
          let fullText = '';
          let toolCalls = [];
          let usage = null;
          let requestId = 'chatcmpl-' + Date.now();

          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') continue;
              try {
                const chunk = JSON.parse(trimmed.slice(5).trim());
                if (chunk.type === 'meta' && chunk.requestId) requestId = chunk.requestId;
                if (chunk.type === 'content' && chunk.text) fullText += chunk.text;
                if (chunk.type === 'tool_use' && Array.isArray(chunk.tools)) {
                  toolCalls.push(...chunk.tools.map((t, idx) => ({
                    id: t.id || `call_${Date.now()}_${idx}`,
                    type: 'function',
                    function: {
                      name: t.name,
                      arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments || {})
                    }
                  })));
                }
                if (chunk.usage) usage = chunk.usage;
              } catch (_) {}
            }
          }

          const responseObj = {
            id: requestId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: fullText || null,
                tool_calls: toolCalls.length ? toolCalls : undefined
              },
              finish_reason: toolCalls.length ? 'tool_calls' : 'stop'
            }],
            usage: usage ? {
              prompt_tokens: usage.inputTokens || 0,
              completion_tokens: usage.outputTokens || 0,
              total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0)
            } : undefined
          };

          clearInterval(keepaliveTimer);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }).end(JSON.stringify(responseObj));
        }
      } catch (err) {
        console.error('[Proxy Error]:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      }
    });
  }
}).listen(PORT, () => {
  console.log(`[B4M Proxy] Listening on http://localhost:${PORT}/v1`);
});
