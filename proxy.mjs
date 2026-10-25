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

// Safely normalize tool call arguments to a valid JSON string
function formatToolArgs(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch (_) {
      return '{}';
    }
  }
  return '{}';
}

// Key pool manager with debounced caching and live depletion tracking
class KeyPoolManager {
  constructor() {
    this.keys = [];
    this.currentIndex = 0;
    this.depleted = new Map(); // key -> reason string
    this.lastLoad = 0;
    this.loadKeys(true);
  }

  loadKeys(force = false) {
    // 2-second debounce to avoid hitting disk on rapid agent tool loops
    if (!force && Date.now() - this.lastLoad < 2000) return;
    this.lastLoad = Date.now();

    const loaded = [];

    // 1. Load from keys.txt if present (checks local and workspace candidate paths)
    const keyCandidates = [
      'keys.txt',
      'C:/Users/brosf/Documents/A vio projects/VioPls/testing/keys.txt',
      'C:/Users/brosf/Documents/A vio projects/VioPls/proxy/keys.txt'
    ];
    for (const kp of keyCandidates) {
      try {
        if (fs.existsSync(kp)) {
          const lines = fs.readFileSync(kp, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
          if (lines.length > 0) {
            loaded.push(...lines);
            break;
          }
        }
      } catch (_) {}
    }

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
    this.keys = unique;
    if (this.keys.length > 0) {
      this.currentIndex = this.currentIndex % this.keys.length;
    } else {
      this.currentIndex = 0;
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
      console.warn(`[KeyPool] [!] Key ${maskKey(key)} marked DEPLETED (${reason}). Active keys remaining: ${remaining}/${this.keys.length}`);
      if (this.keys.length > 0) {
        this.currentIndex = (this.currentIndex + 1) % this.keys.length;
      }
    }
  }

  reset() {
    this.depleted.clear();
    console.log('[KeyPool] All keys have been reset and marked available.');
  }

  getStatus() {
    this.loadKeys(true);
    const active = this.keys.filter(k => !this.depleted.has(k));
    const safeIdx = this.keys.length > 0 ? this.currentIndex % this.keys.length : 0;
    return {
      total: this.keys.length,
      available: active.length,
      depleted: this.depleted.size,
      keys: this.keys.map((k, idx) => ({
        index: idx + 1,
        key: maskKey(k),
        status: this.depleted.has(k) ? `depleted (${this.depleted.get(k)})` : (this.keys[safeIdx] === k ? 'active' : 'standby')
      }))
    };
  }
}

const pool = new KeyPoolManager();
console.log(`[KeyPool] Initialized with ${pool.keys.length} key(s) detected.`);

// Checks if an upstream response indicates key exhaustion / invalidation
function isDepletionError(status, bodyText) {
  if (status === 401) return 'unauthorized / revoked';
  if (status === 403 && /quota|limit|forbidden/i.test(bodyText)) return 'forbidden / quota exceeded';
  if (status === 422) {
    try {
      const parsed = JSON.parse(bodyText);
      const code = parsed.errorCode || '';
      const text = `${parsed.error || ''} ${parsed.message || ''}`.trim();
      if (/insufficient_credits|spend_cap_exceeded|balance_too_low|quota_exceeded/i.test(code)) {
        return code || 'insufficient_credits';
      }
      if (/insufficient.*credit|not enough credit|spend.*cap/i.test(text)) {
        return 'insufficient_credits';
      }
    } catch (_) {
      if (/insufficient.*credit|spend_cap/i.test(bodyText)) return 'insufficient_credits';
    }
  }
  if (status === 429) return 'rate_limited';
  return false;
}

// Vision Sidecar: Directive Parser for targeted frame verification
function parseVisionDirective(text) {
  if (!text || typeof text !== 'string') return null;
  const tagMatch = text.match(/\{(?:\~\~|\~\~")([\s\S]*?)(?:\~\~"|\~\~\})/);
  if (!tagMatch) return null;

  let raw = tagMatch[1].trim();
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).trim();

  let region = null;
  const regionMatch = raw.match(/region\s*=\s*\[?\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]?/i);
  if (regionMatch) {
    region = [parseInt(regionMatch[1], 10), parseInt(regionMatch[2], 10), parseInt(regionMatch[3], 10), parseInt(regionMatch[4], 10)];
    raw = raw.replace(regionMatch[0], '').trim();
  }

  let comparePath = null;
  const compareMatch = raw.match(/compare\s*=\s*["']?([^"'\s]+)["']?/i);
  if (compareMatch) {
    comparePath = compareMatch[1].trim();
    raw = raw.replace(compareMatch[0], '').trim();
  }

  const afterTag = text.slice(tagMatch.index + tagMatch[0].length).trim();
  let imagePath = null;
  const pathRegex = /([a-zA-Z]:[\\\/][^\s"'<>]+\.(?:png|jpe?g|webp|bmp)|(?:\.{1,2}[\\\/]|[a-zA-Z0-9_\-\.\/\\\\]+?)\.(?:png|jpe?g|webp|bmp))/i;
  const pathMatch = afterTag.match(pathRegex) || text.match(pathRegex);
  if (pathMatch) imagePath = pathMatch[0].trim();

  return {
    rawMatch: tagMatch[0],
    query: raw.replace(/^["'\s]+|["'\s]+$/g, '').trim(),
    region,
    comparePath,
    imagePath
  };
}

function buildVisionPrompt(directive) {
  let prompt = `You are a pixel-accurate motion design visual inspection verifier.
Your job is to answer the user's specific questions with empirical visual evidence, NOT generic commentary.

USER QUESTIONS:
${directive.query}
`;

  if (directive.region) {
    const [x, y, w, h] = directive.region;
    prompt += `\nCRITICAL REGION FOCUS:
You must focus your visual inspection specifically within the bounding box:
X=${x}, Y=${y}, Width=${w}, Height=${h} (within standard 1920x1080 frame). Zoom in mentally to this specific area to answer the questions.\n`;
  }

  if (directive.comparePath) {
    prompt += `\nCOMPARE MODE:
You are inspecting two frames (Frame A and Frame B) across a transition seam or cut.
Examine continuity, alignment, lighting changes, shader pops, or visual jumps between the two frames.\n`;
  }

  prompt += `
MANDATORY RULES:
1. Answer each numbered question (Q1, Q2, etc.) directly.
2. Format each answer with a clear Yes / No / Value, followed immediately by concrete spatial evidence (coordinates like ~x=600, ~y=450, colors, ring/gap/edge positions).
   Example of good answer: "Yes: ring left at ~x=600, red bar centre at x=960, square right at x=1240".
   Example of BAD answer: "Yes, it looks good" or "All elements pass".
3. ANOMALIES / DEFECTS (UNASKED): Even if not asked, if you see any obvious visual defects, clipping, Z-fighting, black screen, missing shaders, NaN colors, overlapping text, or glitched geometry, list them under this section with their locations. If no defects are observed, write "None observed".
`;
  return prompt;
}

// Vision Sidecar: Transcribe image blocks into structured empirical visual evidence
async function executeVisionInspection(imageBlocks, directive, apiKey) {
  const prompt = buildVisionPrompt(directive);
  const content = [{ type: 'text', text: prompt }];

  for (const block of imageBlocks) {
    if (block.type === 'image_url' && block.image_url?.url) {
      content.push({ type: 'image_url', image_url: { url: block.image_url.url } });
    } else if (block.type === 'image' && block.source) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${block.source.media_type || 'image/png'};base64,${block.source.data}` }
      });
    }
  }

  try {
    const res = await fetch(TARGET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        messages: [{ role: 'user', content }],
        max_tokens: 3000
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let desc = '';
    for (const l of text.split('\n')) {
      if (l.startsWith('data:') && !l.includes('[DONE]')) {
        try {
          const chunk = JSON.parse(l.slice(5).trim());
          if (chunk.type === 'content' && chunk.text) desc += chunk.text;
        } catch (_) {}
      }
    }
    return desc.trim();
  } catch (err) {
    console.warn('[Proxy Vision] Targeted inspection error:', err.message);
    return null;
  }
}

async function transcribeImages(messages, apiKey) {
  if (!Array.isArray(messages)) return;

  // 1. Locate any vision directive tag across messages
  let globalDirective = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (typeof m.content === 'string') {
      const d = parseVisionDirective(m.content);
      if (d) { globalDirective = d; break; }
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && typeof b.text === 'string') {
          const d = parseVisionDirective(b.text);
          if (d) { globalDirective = d; break; }
        }
      }
      if (globalDirective) break;
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const rawArgs = typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || '');
        const d = parseVisionDirective(rawArgs);
        if (d) { globalDirective = d; break; }
      }
      if (globalDirective) break;
    }
  }

  // 2. Process image blocks
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLatestTurn = i >= messages.length - 2;

    if (Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        const isImg = block && (block.type === 'image_url' || block.type === 'image');
        if (!isImg) continue;

        // If this is a historical image from an earlier turn, strip it to avoid token accumulation
        if (!isLatestTurn) {
          msg.content[j] = { type: 'text', text: '[Historical screenshot from earlier turn omitted to preserve token budget]' };
          continue;
        }

        // For the active/latest image: check if query directive was provided
        if (!globalDirective) {
          console.log('[Proxy Vision] Image present but no query directive tag found. Returning explicit failure message.');
          msg.content[j] = {
            type: 'text',
            text: '[Vision Inspection Error: No query directive given]\nFormat required: {~~"Specific questions to verify (Q1: ..., Q2: ...)"~~} [region=[x,y,w,h]] [compare="path/to/second_frame.png"]]'
          };
          continue;
        }

        console.log(`[Proxy Vision] Intercepted targeted image query: "${globalDirective.query.slice(0, 60)}..." Transcribing via claude-haiku-5-5...`);
        const report = await executeVisionInspection([block], globalDirective, apiKey);
        if (report) {
          msg.content[j] = {
            type: 'text',
            text: `[Visual Inspection Report: ${globalDirective.query}]\n\n${report}`
          };
          console.log('[Proxy Vision] Successfully produced empirical visual evidence report.');
        } else {
          msg.content[j] = {
            type: 'text',
            text: `[Visual Inspection Error: Failed to execute vision inspection for query "${globalDirective.query}". Please retry.]`
          };
        }
      }
    }
  }

  // 3. Check for standalone file-path directive in text (e.g. {~~"..."~~} path/to/frame.png)
  // If present and image exists on disk, load and inspect even without client image block upload!
  if (globalDirective && globalDirective.imagePath) {
    const rawPath = globalDirective.imagePath;
    let resolvedPath = rawPath;
    if (!fs.existsSync(resolvedPath)) {
      const candidates = [
        rawPath,
        `C:/Users/brosf/Documents/A vio projects/VioPls/Agentic motion design toolset/app/${rawPath}`,
        `C:/Users/brosf/Documents/A vio projects/VioPls/Agentic motion design toolset/${rawPath}`,
        `C:/Users/brosf/Documents/A vio projects/VioPls/${rawPath}`
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) { resolvedPath = c; break; }
      }
    }

    if (fs.existsSync(resolvedPath)) {
      console.log(`[Proxy Vision] Found disk image from directive at: ${resolvedPath}. Inspecting...`);
      try {
        const fileBuf = fs.readFileSync(resolvedPath);
        const b64 = fileBuf.toString('base64');
        const ext = resolvedPath.endsWith('.jpg') || resolvedPath.endsWith('.jpeg') ? 'jpeg' : 'png';
        const imgBlock = {
          type: 'image_url',
          image_url: { url: `data:image/${ext};base64,${b64}` }
        };

        const imageBlocks = [imgBlock];
        if (globalDirective.comparePath && fs.existsSync(globalDirective.comparePath)) {
          const compBuf = fs.readFileSync(globalDirective.comparePath);
          const compB64 = compBuf.toString('base64');
          const compExt = globalDirective.comparePath.endsWith('.jpg') || globalDirective.comparePath.endsWith('.jpeg') ? 'jpeg' : 'png';
          imageBlocks.push({
            type: 'image_url',
            image_url: { url: `data:image/${compExt};base64,${compB64}` }
          });
        }

        const report = await executeVisionInspection(imageBlocks, globalDirective, apiKey);
        if (report) {
          const latestMsg = messages[messages.length - 1];
          const reportBlock = `\n\n[Visual Inspection Report for ${globalDirective.imagePath}]:\nQuery: ${globalDirective.query}\n\n${report}`;
          if (typeof latestMsg.content === 'string') {
            latestMsg.content += reportBlock;
          } else if (Array.isArray(latestMsg.content)) {
            latestMsg.content.push({ type: 'text', text: reportBlock });
          }
          console.log('[Proxy Vision] Appended disk-image visual inspection report to message.');
        }
      } catch (diskErr) {
        console.warn('[Proxy Vision] Error reading disk image:', diskErr.message);
      }
    }
  }
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

  // Health check & Key Pool status (with optional ?reset=true or /reset endpoint)
  if (req.method === 'GET') {
    if (req.url === '/reset' || req.url === '/v1/reset' || req.url?.includes('reset=true')) {
      pool.reset();
    }
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

        // Detect compaction or summarization requests
        const isCompaction = payload.model?.includes('haiku') || (Array.isArray(payload.messages) && payload.messages.some(m => {
          const str = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
          return /compact|summarize conversation|summarise conversation|summary of the conversation|conversation history/i.test(str);
        }));

        if (isCompaction) {
          payload.model = 'claude-haiku-5-5';
          payload.max_tokens = 4096;
          payload.maxTokens = 4096;
          console.log('[Proxy] Compaction request detected -> auto-routed to claude-haiku-5-5 (max_tokens: 4096) for ultra-low credit cost.');
        } else {
          // Ensure full 128k output token budget so Claude's extended thinking (3-4k tokens)
          // + large file writes (like render.ts) never hit the default 4,096 token limit
          if (!payload.max_tokens || payload.max_tokens < 128000) {
            payload.max_tokens = 128000;
            payload.maxTokens = 128000;
          }
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

        // Determine client incoming authorization header if any
        let incomingToken = null;
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
          incomingToken = authHeader.slice(7).trim();
        }

        // Vision Sidecar: Transcribe image blocks using fast, cheap Claude Haiku 5.5
        // Replaces multi-megabyte base64 images with dense, technical visual descriptions,
        // saving ~99% on vision tokens and permanently stopping multi-megabyte context bloat!
        const visionKey = pool.getKey(incomingToken);
        if (visionKey && Array.isArray(payload.messages)) {
          await transcribeImages(payload.messages, visionKey);
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
              let toolText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
              // If historical tool output is huge, truncate the middle to drastically reduce prompt tokens
              if (toolText.length > 3000) {
                toolText = toolText.slice(0, 1500) + '\n...[historical tool output truncated]...\n' + toolText.slice(-500);
              }

              const toolResultBlock = {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id || '',
                content: toolText
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
                for (const b of msg.content) {
                  // Do not echo back internal reasoning/thinking blocks from earlier turns (saves megabytes of tokens)
                  if (b && (b.type === 'thinking' || b.type === 'reasoning')) continue;
                  contentBlocks.push(b);
                }
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

        // Failover retry loop: try keys from pool until success or all depleted
        // Notice: headers are NOT sent yet, preserving true HTTP status codes (401, 422, 500) if all keys fail!
        let upstream = null;
        let activeKeyUsed = null;
        const maxAttempts = Math.max(1, pool.keys.length);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          activeKeyUsed = pool.getKey(incomingToken);

          if (!activeKeyUsed) {
            console.error('[KeyPool] [x] All API keys in pool are depleted or no keys configured!');
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
            // Success! Break out of retry loop
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
            // Other error (e.g. 400 bad request, schema error) - don't rotate key, return real HTTP status
            console.error(`[Proxy] Upstream error ${upstream.status}:`, errText);
            res.writeHead(upstream.status, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }).end(errText);
            return;
          }
        }

        if (!upstream || !upstream.ok) {
          const failureMsg = pool.keys.length === 0
            ? 'No Bike4Mind API keys configured in proxy.'
            : 'All Bike4Mind API keys in pool are exhausted or unavailable.';
          console.error(`[KeyPool] Request aborted: ${failureMsg}`);
          // Return honest 422 HTTP status to the client
          res.writeHead(422, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }).end(JSON.stringify({ error: { message: failureMsg, type: 'insufficient_credits', code: 422 } }));
          return;
        }

        // Process successful response
        if (isClientStreaming) {
          // Send 200 SSE headers now that upstream is confirmed healthy
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          });
          res.write(': keepalive\n\n');

          const keepaliveTimer = setInterval(() => {
            if (!res.writableEnded) {
              res.write(': keepalive\n\n');
            }
          }, 8000);

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

          let seenDone = false;
          try {
            while (!seenDone) {
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
                  seenDone = true;
                  break;
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
                      // Record finishReasonToUse, but do NOT prematurely emit finish chunk before [DONE]
                      finishReasonToUse = b4mChunk.stopReason === 'end_turn'
                        ? 'stop'
                        : (b4mChunk.stopReason === 'max_tokens' ? 'length' : b4mChunk.stopReason);
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
                                  arguments: formatToolArgs(tool.arguments)
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
                  console.error('[Proxy Stream Chunk Error]:', e.message);
                }
              }
            }
          } catch (streamErr) {
            // If upstream closes the connection (e.g. CloudFront socket teardown),
            // log cleanly and let finally handle safe termination.
            console.warn('[Proxy] Upstream stream disconnected:', streamErr.message);
          } finally {
            emitFinishIfNeeded();
            clearInterval(keepaliveTimer);
            if (!res.writableEnded) {
              res.write('data: [DONE]\n\n');
              res.end();
            }
          }
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
                      arguments: formatToolArgs(t.arguments)
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

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }).end(JSON.stringify(responseObj));
        }
      } catch (err) {
        console.error('[Proxy Error]:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(JSON.stringify({ error: err.message }));
        } else {
          try {
            if (!res.writableEnded) {
              res.write('data: [DONE]\n\n');
            }
          } catch (_) {}
          res.end();
        }
      }
    });
  }
}).listen(PORT, () => {
  console.log(`[B4M Proxy] Listening on http://localhost:${PORT}/v1`);
});
