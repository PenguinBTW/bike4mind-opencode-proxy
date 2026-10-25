# Bike4Mind OpenCode Proxy Shim

A lightweight translation proxy that enables **[OpenCode](https://opencode.ai)** (and other OpenAI-compatible coding agent CLIs) to use **[Bike4Mind](https://app.bike4mind.com)** as an LLM provider.

---

## Why This Proxy is Needed

OpenCode uses Vercel's AI SDK (`@ai-sdk/openai-compatible`) which sends standard OpenAI `/chat/completions` payloads. Bike4Mind's API (`/api/ai/v1/completions`) has distinct architectural differences:

1. **Tool Definition Schema**: Bike4Mind expects `{ toolSchema: { name, description, parameters } }` instead of OpenAI's `{ type: "function", function: { ... } }`.
2. **Multi-turn Tool Calling**: Bike4Mind rejects `role: "tool"` and requires Anthropic-style content blocks (`tool_use` in assistant messages and `tool_result` in user messages).
3. **SSE Stream Normalization**: Bike4Mind streams proprietary `content` and `tool_use` events. The proxy converts them into OpenAI delta chunks and guarantees clean, single `finish_reason` terminations.
4. **Reasoning Defaults**: Automatically injects medium reasoning effort for frontier reasoning models (`claude-sonnet-5-5`, `claude-opus-5-5`).
5. **Anti-Timeout Keepalive**: Immediately acknowledges clients with HTTP 200 headers and emits background SSE keepalive pings (`: keepalive`), preventing client timeouts during heavy reasoning phases on large multi-turn contexts.

---

## Quick Start

### 1. Set Your Bike4Mind API Key
Export your live key in your shell:

**PowerShell (Windows):**
```powershell
$env:BIKE4MIND_API_KEY = "b4m_live_your_key_here"
```

**Bash / Zsh (macOS / Linux):**
```bash
export BIKE4MIND_API_KEY="b4m_live_your_key_here"
```

### 2. Start the Proxy
```bash
node proxy.mjs
```
The proxy will start on `http://localhost:4000/v1`.

---

## Configuring OpenCode

You can configure OpenCode in one of two ways:

### Option A: Per-Project Configuration (Local)
Copy [`opencode.json`](./opencode.json) into the root of any workspace you want to work in:

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
To use Bike4Mind across **all** repositories without copying config files each time:

Place the configuration in your global OpenCode config path:
* **Windows**: `C:\Users\<YourUsername>\.config\opencode\opencode.json`
* **macOS / Linux**: `~/.config/opencode/opencode.json`

Once set globally, simply run `opencode` in any directory.

---

## Selecting & Switching Models

### Inside OpenCode Interactive Mode
Launch OpenCode in your workspace:
```bash
opencode
```
* Press **Tab** to switch between Plan Agent and Build Agent.
* Type `/models` to open the model selector and pick any configured model.

### From the Command Line
```bash
# Run a one-off prompt using Sonnet 5.5
opencode run --model bike4mind/claude-sonnet-5-5 "Create hello.py, run it, and show output"

# Run with Haiku for quick edits
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

## Health Check & Verification

Test if the proxy is running and responsive:
```bash
curl http://localhost:4000
```
Expected response:
```json
{"status":"ok","provider":"Bike4Mind Proxy","target":"https://app.bike4mind.com/api/ai/v1/completions","port":4000}
```

Test a quick tool-call completion directly through the proxy:
```bash
curl -X POST "http://localhost:4000/v1/chat/completions" \
  -H "Authorization: Bearer $BIKE4MIND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5-5",
    "messages": [{"role": "user", "content": "How many r'\''s in strawberry?"}]
  }'
```

---

## Troubleshooting

### Self-Signed / Corporate Certificate Errors (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`)
If your environment inspects TLS traffic, Node's `fetch` may fail certificate verification. Start the proxy with TLS rejection disabled in your terminal:
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
