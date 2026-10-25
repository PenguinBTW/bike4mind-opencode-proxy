# Bike4Mind OpenCode Proxy Shim

A lightweight translation proxy that enables **[OpenCode](https://opencode.ai)** (and other OpenAI-compatible coding agent CLIs) to use **[Bike4Mind](https://app.bike4mind.com)** as an LLM provider with **multi-key pooling and zero-downtime failover**.

---

## Key Features

1. **Tool Definition Schema Translation**: Converts standard OpenAI `{ type: "function", function: { ... } }` into Bike4Mind's `{ toolSchema: { name, description, parameters } }`.
2. **Multi-turn Anthropic Tool Calling Protocol**: Bridges OpenAI's `role: "tool"` into Anthropic-style `tool_use` and `tool_result` content blocks with message merging.
3. **SSE Stream Normalization**: Translates proprietary Bike4Mind SSE events into OpenAI delta chunks with clean single `finish_reason` terminations.
4. **Automatic Multi-Key Failover & Pooling**: Hot-reloads API keys from `keys.txt` or environment variables; automatically rotates to a backup key when one runs out of credits (`insufficient_credits`, 401, 403 quota, 429).
5. **Anti-Timeout SSE Keepalive**: Emits HTTP 200 headers immediately and pings `: keepalive` every 8s to prevent client timeouts during deep thinking phases on large contexts.
6. **Built-in Model Aliasing**: Map simple names (`sonnet`, `haiku`, `opus`) directly to official Bike4Mind identifiers with automatic medium reasoning effort defaults.

---

## Quick Start

### 1. Configure Your API Key(s)

You can provide keys in any of the following ways (in priority order):

#### Option A: `keys.txt` File (Recommended for Multi-Key Failover)
Create a `keys.txt` file in the proxy directory (one key per line):
```text
b4m_live_key_1_here
b4m_live_key_2_here
b4m_live_key_3_here
```
> [!NOTE]
> `keys.txt` is already listed in `.gitignore` so your keys are never committed. The proxy hot-reloads `keys.txt` on every request, so you can paste in new keys while the proxy is actively running without restarting it!

#### Option B: Environment Variable (Multiple Keys)
```powershell
$env:BIKE4MIND_API_KEYS = "b4m_live_key1,b4m_live_key2,b4m_live_key3"
```

#### Option C: Single Key
```powershell
$env:BIKE4MIND_API_KEY = "b4m_live_your_key_here"
```

---

### 2. Start the Proxy

```bash
node proxy.mjs
```

You should see:
```text
[KeyPool] Initialized with 2 key(s) detected.
[B4M Proxy] Listening on http://localhost:4000/v1
```

---

## How Automatic Key Failover Works

When running heavy coding agents, Claude Sonnet 5.5 consumes credits across long multi-turn sessions. If a key runs out mid-session:

1. Bike4Mind returns an exhaustion error (`422 insufficient_credits`, `401 unauthorized`, `403 quota`, or `429`).
2. The proxy intercepts the error, marks the failing key as `depleted`, and logs:
   ```text
   [KeyPool] ⚠️ Key b4m_live...9a81a marked DEPLETED (insufficient_credits). Active keys remaining: 1/2
   [Proxy] Upstream 422 indicates key exhaustion. Auto-switching to next key...
   ```
3. The proxy immediately retries the exact same prompt with the next standby key in the pool.
4. OpenCode receives a successful stream seamlessly — **no dropped sessions, no broken terminal turns, and no manual restarts**.

---

## Configuring OpenCode

You can configure OpenCode either locally (per project) or globally (across all projects):

### Option A: Per-Project Configuration (Local)
Copy [`opencode.json`](./opencode.json) into the root of any workspace:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "bike4mind/claude-sonnet-5-5",
  "small_model": "bike4mind/claude-haiku-5-5",
  "provider": {
    "bike4mind": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:4000/v1",
        "apiKey": "{env:BIKE4MIND_API_KEY}",
        "headerTimeout": 600000,
        "chunkTimeout": 600000,
        "timeout": false
      },
      "models": {
        "claude-sonnet-5-5": {
          "name": "Claude Sonnet 5.5 (Medium Reasoning)",
          "tools": true
        },
        "claude-haiku-5-5": {
          "name": "Claude Haiku 5.5 (Fast)",
          "tools": true
        },
        "claude-opus-5-5": {
          "name": "Claude Opus 5.5 (Deep Reasoning)",
          "tools": true
        },
        "gemini-3-flash-preview": {
          "name": "Gemini 3 Flash Preview",
          "tools": true
        },
        "deepseek-v4-pro": {
          "name": "DeepSeek V4 Pro",
          "tools": true
        }
      }
    }
  }
}
```

### Option B: Global Configuration (All Projects)
Place the configuration in your global OpenCode config path:
* **Windows**: `C:\Users\<YourUsername>\.config\opencode\opencode.json`
* **macOS / Linux**: `~/.config/opencode/opencode.json`

Once set globally, simply run `opencode` anywhere without needing a local config file.

---

## Selecting & Switching Models

### Inside OpenCode Interactive Mode
Launch OpenCode in your workspace:
```bash
opencode
```
* Press **Tab** to switch between Plan Agent and Build Agent.
* Type `/models` to open the interactive picker and select any configured model.

### From the Command Line
```bash
# Run a one-off prompt using Sonnet 5.5
opencode run --model bike4mind/claude-sonnet-5-5 "Create hello.py, run it, and show output"

# Run with Haiku for fast edits
opencode run --model bike4mind/claude-haiku-5-5 "Check git status and summarize recent commits"
```

### Supported Frontier Models

| Model ID | Display Name | Best For |
| :--- | :--- | :--- |
| `claude-sonnet-5-5` *(default)* | Claude Sonnet 5.5 | **Recommended for agentic coding**, refactoring, complex tasks |
| `claude-haiku-5-5` | Claude Haiku 5.5 | Fast file lookups, summarization, title generation |
| `claude-opus-5-5` | Claude Opus 5.5 | Complex architectural planning and deep reasoning |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview | Low-latency long-context reasoning |
| `deepseek-v4-pro` | DeepSeek V4 Pro | Strong reasoning and coding alternative |

*Aliases supported by the proxy:* `sonnet-5.5`, `sonnet`, `haiku-5.5`, `haiku`, `opus-5.5`, `opus`, `claude-3-5-sonnet`, `claude-3-5-haiku`.

---

## Health Check & Key Pool Status

Check proxy health and pool capacity:
```bash
curl http://localhost:4000
```

Response:
```json
{
  "status": "ok",
  "provider": "Bike4Mind Proxy (with Auto-Key Failover)",
  "port": 4000,
  "target": "https://app.bike4mind.com/api/ai/v1/completions",
  "keyPool": {
    "total": 3,
    "available": 2,
    "depleted": 1,
    "keys": [
      { "index": 1, "key": "b4m_live...9a81a", "status": "depleted (insufficient_credits)" },
      { "index": 2, "key": "b4m_live...1b2c3", "status": "active" },
      { "index": 3, "key": "b4m_live...4d5e6", "status": "standby" }
    ]
  }
}
```

---

## Troubleshooting

### Self-Signed / Corporate Certificate Errors (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`)
If your environment inspects TLS traffic, start the proxy with TLS rejection disabled:
```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
node proxy.mjs
```

### Port 4000 In Use (`EADDRINUSE: 4000`)
Change the port using the `PORT` environment variable:
```bash
PORT=4005 node proxy.mjs
```
Then update the `baseURL` in `opencode.json` to `http://localhost:4005/v1`.
