# oai-bridge

> A localhost OpenAI-compatible HTTP proxy that uses your **ChatGPT subscription** (via OAuth) instead of a paid API key — including **image generation** with `gpt-image-2`.

[![npm version](https://img.shields.io/npm/v/oai-bridge.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/oai-bridge)
[![license: MIT](https://img.shields.io/npm/l/oai-bridge.svg?color=blue)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/BenjiThatFoxGuy/chatgpt-bridge/ci.yml?branch=main&label=ci)](https://github.com/BenjiThatFoxGuy/chatgpt-bridge/actions)
[![bundle size](https://img.shields.io/badge/published%20size-15.7%20KB-success)](https://www.npmjs.com/package/oai-bridge)
[![source size](https://img.shields.io/badge/source-~900%20LOC-informational)](./src)

```bash
npx oai-bridge serve
```

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:10531/v1", api_key="unused")
img = c.images.generate(model="gpt-image-2", prompt="a fox in the woods")
```

That's the whole demo. The OpenAI SDK calls go through the bridge, the bridge talks to ChatGPT using your existing OAuth tokens, and you get back a base64 PNG. No API key, no per-image charge — just your existing subscription.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Install](#install)
- [First-time setup](#first-time-setup)
- [Usage](#usage)
  - [HTTP API](#http-api)
  - [As a library](#as-a-library)
  - [CLI](#cli)
- [Integrations](#integrations)
- [Configuration](#configuration)
- [Comparison](#comparison)
- [Responsible use](#responsible-use)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## Why this exists

You already pay for a ChatGPT subscription. It generates images, runs the latest models, and you use it daily. But when you want to call the same models from a script, the official path is to **pay again** through `api.openai.com` — separate billing, separate quota, often more expensive per image than your monthly subscription cost.

The official `codex` CLI from OpenAI authenticates you over OAuth and lets you talk to the same models programmatically — but only as a CLI, only for code generation, and not as an HTTP server you can plug into other tools.

This package fills that gap: it's the smallest possible HTTP proxy that **speaks the OpenAI API dialect**, terminating those calls into the OAuth-authenticated upstream that the Codex CLI already uses. Your existing OpenAI SDKs, n8n workflows, ComfyUI nodes, Claude Code skills — anything that talks `localhost:port/v1/...` — just works.

## How it works

```
your code  ─►  localhost:10531/v1/...  ─►  chatgpt.com/backend-api/codex/responses
                  (this package)            (OAuth tokens from ~/.codex/auth.json)
```

OpenAI's Responses API has a built-in `image_generation` tool. The bridge wraps your OpenAI Images request as a Responses tool call, parses the SSE stream, and returns the base64 PNG in the exact shape the OpenAI Images API uses. Your client doesn't know the difference.

Read the deep dive: [docs/architecture.md](./docs/architecture.md).

---

## Install

### Option A — `npx` (zero install)

```bash
npx oai-bridge serve
```

### Option B — Global CLI

```bash
npm i -g oai-bridge
oai-bridge serve
```

### Option C — As a library

```bash
npm i oai-bridge
```

```ts
import { Auth, Upstream, generateImage, loadConfig } from "oai-bridge";

const cfg = loadConfig();
const upstream = new Upstream(cfg, new Auth(cfg));
const img = await generateImage(cfg, upstream, { prompt: "a fox" });
require("fs").writeFileSync("fox.png", Buffer.from(img.b64, "base64"));
```

### Option D — Single binary

Download from [Releases](https://github.com/BenjiThatFoxGuy/chatgpt-bridge/releases): `oai-bridge-linux`, `oai-bridge-macos`, `oai-bridge.exe`.

---

## First-time setup

You need a valid `auth.json`. The simplest way is the official Codex CLI:

```bash
npx @openai/codex login
```

This opens a browser, you sign in to ChatGPT, the CLI writes `~/.codex/auth.json`. The bridge automatically reads from there.

Verify everything works:

```bash
oai-bridge doctor
```

Expected output:

```json
{
  "status": "healthy",
  "checks": [
    { "name": "auth",     "ok": true, "detail": "loaded from …/.codex/auth.json · expires in …s" },
    { "name": "upstream", "ok": true, "detail": "HTTP 200" }
  ]
}
```

---

## Usage

### HTTP API

All endpoints are OpenAI-compatible. Point any OpenAI SDK at `http://127.0.0.1:10531/v1` with **any string** as `apiKey` — it's ignored; auth comes from `auth.json`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Bridge state (auth, rate, version) |
| `GET` | `/v1/models` | List models from upstream + image-gen aliases |
| `POST` | `/v1/responses` | Pass-through to ChatGPT's Responses API |
| `POST` | `/v1/chat/completions` | Translated to `/v1/responses` upstream |
| `POST` | `/v1/images/generations` | Generates a base64 PNG via the `image_generation` tool |
| `*` | `/v1/*` | Catch-all pass-through (forward-compat) |

#### Image generation

```bash
curl http://127.0.0.1:10531/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "a tiny dragon perched on a stack of books",
    "size": "1024x1024",
    "quality": "high"
  }' | jq -r '.data[0].b64_json' | base64 --decode > out.png
```

Response shape (matches OpenAI Images API exactly):

```json
{
  "created": 1714680000,
  "data": [{ "b64_json": "iVBORw0KGgo...", "revised_prompt": "..." }],
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 }
}
```

### As a library

```ts
import {
  generateImage,
  Auth,
  Upstream,
  loadConfig,
  CAPABILITIES,
  runInstall,
  resolveAttachments,
  translateChatMessages,
} from "oai-bridge";

// Generate an image, with optional reference images
const cfg = loadConfig();
const upstream = new Upstream(cfg, new Auth(cfg));
const img = await generateImage(cfg, upstream, {
  prompt: "hero shot, brand-consistent",
  reference_images: ["./moodboard.png", "./logo.svg"],
  size: "1536x1024",
  quality: "high",
});
// img.b64           → base64 PNG string
// img.revisedPrompt → optional, may differ from input prompt
// img.usage         → token usage from upstream

// Programmatic install (writes the IDE's MCP config)
const result = await runInstall("claude-code");

// Inspect the agent-facing surface
console.log(CAPABILITIES.verbs.map((v) => v.name));

// Build a Responses-shaped input from OpenAI Chat-shape messages
const input = await translateChatMessages(messages, cfg);
```

### CLI

Eight verbs. JSON to stdout when piped or `--json`; structured remedies on errors.

```
oai-bridge install --for <target>   Register the bridge with an IDE/agent (idempotent)
oai-bridge capabilities              Print the full machine-readable catalog
oai-bridge chat <prompt|@file|->     Send a text or multimodal message
oai-bridge image <prompt|@file|->    Generate an image (with optional --ref)
oai-bridge models                    List available chat + image models
oai-bridge serve                     Start the OpenAI-compatible HTTP server
oai-bridge mcp                       Run as a Model Context Protocol server (stdio)
oai-bridge doctor                    Health checks; exit 0 if healthy
```

`install --for <target>` accepts: `claude-code`, `claude-desktop`, `codex`, `cursor`, `zed`, `cline`, `continue`, `gemini-cli`, `aider`, `openai-sdk`, `all`. Add `--dry-run` to preview, `--uninstall` to revert.

#### Examples

```bash
# One-shot setup (the rest is agent-driven)
oai-bridge install --for claude-code

# Text only
oai-bridge chat "explain REST in one sentence"

# Vision — what's in this image?
oai-bridge chat "what font is this?" --attach screenshot.png

# File as context
oai-bridge chat "audit this spec against OpenAPI 3.1" --attach spec.md

# Image generation
oai-bridge image "a small red fox under an oak tree, watercolor" --out fox.png

# Image with reference (style/composition transfer)
oai-bridge image "hero shot, brand-consistent" \
  --ref moodboard.png --ref logo.svg --out hero.png

# Batch via stdin JSONL (each line = one job, each result = one JSON line)
oai-bridge image - <<EOF
{"prompt":"hero v1","ref":["mood.png"],"out":"v1.png"}
{"prompt":"hero v2","ref":["mood.png"],"out":"v2.png","quality":"medium"}
EOF

# Health check
oai-bridge doctor

# Start the OpenAI-SDK-compatible server
oai-bridge serve --port 11000
```

`gen <prompt>` is a deprecated alias for `image`; prints a stderr warning and forwards.

---

## Integrations

Working snippets for the most common tools:

| Tool | Snippet |
|---|---|
| **OpenAI Python SDK** | [docs/integrations.md#openai-python-sdk](./docs/integrations.md#openai-python-sdk) |
| **OpenAI Node SDK** | [docs/integrations.md#openai-node-sdk](./docs/integrations.md#openai-node-sdk) |
| **Vercel AI SDK** | [docs/integrations.md#vercel-ai-sdk](./docs/integrations.md#vercel-ai-sdk) |
| **LangChain** | [docs/integrations.md#langchain](./docs/integrations.md#langchain) |
| **n8n** | [examples/n8n.json](./examples/n8n.json) |
| **ComfyUI** | [docs/integrations.md#comfyui](./docs/integrations.md#comfyui) |
| **Claude Code Skill** | [examples/claude-code-skill/](./examples/claude-code-skill/) |
| **Claude Desktop / Cursor / Zed (MCP)** | [#use-with-claude-desktop-cursor-zed-mcp](#use-with-claude-desktop-cursor-zed-mcp) |
| **curl + jq** | [examples/curl.sh](./examples/curl.sh) |

### One-shot install (agent-native)

You don't have to hand-edit any config. Tell your agent:

> *"Install oai-bridge."*

It runs:

```bash
npx oai-bridge install --for claude-code   # or codex, cursor, zed, cline, continue, claude-desktop, gemini-cli, openai-sdk, aider, all
```

The command is idempotent: detects the target's config file location, merges the `oai-bridge` entry, and reports back as JSON. Add `--dry-run` to preview; `--uninstall` to revert. Use `--for all` to register with every IDE detected on disk in one shot.

Targets covered: `claude-code`, `claude-desktop`, `codex`, `cursor`, `zed`, `cline`, `continue`, `gemini-cli`, `aider` (snippet), `openai-sdk` (snippet), `all`.

### What an agent should read first

```bash
oai-bridge capabilities
```

Returns the entire surface as a single JSON document: every verb, args, returns, idempotency, side effects, typical latency, and structured error remedies. Agents read it once at session start and need nothing else.

### Use with Claude Desktop / Cursor / Zed (MCP)

After `oai-bridge install --for <target>`, restart the IDE. Five MCP tools become available:

- `chat(prompt, system?, model?, attachments?)` — assistant reply as plain text. `attachments` accepts paths or URLs; images become vision input, text files become contextual file_data.
- `generate_image(prompt, out?, size?, quality?, references?)` — saves a PNG into the bridge's generations directory, returns the absolute path. `references` (up to 8) shape the output's style/composition.
- `export_image(path)` — reads back a PNG `generate_image` wrote and returns its bytes as base64. For MCP clients that run in a different container/filesystem than the bridge and so can't read the returned path directly.
- `list_generations(limit?)` — generations still on disk from the bridge's current run, most recent first.
- `health()` — bridge state snapshot, including whether the generations directory is currently writable.

The bridge's image storage (and the index behind `list_generations`/`export_image`) is **not durable**: it lives only for the current bridge process and is lost on restart. Export or hand off a freshly generated image in the same turn — don't defer it.

If you'd rather configure manually, the MCP entry is:

```json
{
  "mcpServers": {
    "oai-bridge": {
      "command": "npx",
      "args": ["-y", "oai-bridge", "mcp"]
    }
  }
}
```

Full integrations guide: [docs/integrations.md](./docs/integrations.md).

---

## Configuration

Defaults are sensible. Override via environment variables:

| Env var | Legacy fallback | Default | What |
|---|---|---|---|
| `OAI_BRIDGE_HOST` | `CHATGPT_BRIDGE_HOST` | `127.0.0.1` | Bind host |
| `OAI_BRIDGE_PORT` | `CHATGPT_BRIDGE_PORT` | `10531` | Bind port |
| `OAI_BRIDGE_AUTH_FILE` | `CHATGPT_BRIDGE_AUTH_FILE` | (auto) | Override path to `auth.json` |
| `OAI_BRIDGE_IMAGE_MODEL` | `CHATGPT_BRIDGE_IMAGE_MODEL` | `gpt-5.5` | Text model that invokes the image tool |
| `OAI_BRIDGE_CLIENT_ID` | `CHATGPT_BRIDGE_CLIENT_ID` | (Codex CLI's client_id) | OAuth client_id |

The `CHATGPT_BRIDGE_*` names are deprecated but kept working indefinitely for existing installs — `OAI_BRIDGE_*` wins if both are set.

`auth.json` lookup order (first match wins):

1. `$OAI_BRIDGE_AUTH_FILE` (or legacy `$CHATGPT_BRIDGE_AUTH_FILE`)
2. `$CHATGPT_LOCAL_HOME/auth.json`
3. `$CODEX_HOME/auth.json`
4. `~/.chatgpt-local/auth.json`
5. `~/.codex/auth.json`
6. `~/.oai-bridge/auth.json`
7. `~/.chatgpt-bridge/auth.json` (legacy)

---

## Comparison

| | OpenAI API | `oai-bridge` | Reverse-eng (`acheong08/ChatGPT`, etc.) |
|---|---|---|---|
| Auth | API key | OAuth (Codex flow) | Cookie / session token |
| Cost per image | $0.02–$0.21 | $0 (subscription) | $0 (subscription) |
| Stability | Highest | High (uses developer endpoint) | Low (consumer endpoint hardened) |
| Setup | `OPENAI_API_KEY=...` | `npx @openai/codex login` | Browser cookie extraction |
| ToS posture | Sanctioned | Gray-area but uses official auth | Generally violates ToS |
| Maintenance | None on your side | Occasional patches | Constant cat-and-mouse |
| Best for | Production | Personal scripts, integrations, Claude Code | Hacking, learning |

If you need production reliability and can spend per image, use the OpenAI API. If you have a subscription and want your scripts to use it, this. If you want to learn how the consumer endpoints work, the reverse-eng projects are educational.

---

## Responsible use

- **Personal use, single user.** Not a SaaS, not a way to share one subscription across users.
- **OpenAI's Terms of Use** generally discourage automated access to consumer surfaces. The bridge ships with conservative rate limits and human-like jitter on purpose.
- **No telemetry.** Zero outbound traffic except to `chatgpt.com` and `auth.openai.com`. Read the source.
- **Tokens stay local.** `auth.json` is read, refreshed, and written back to the same file. Never copied elsewhere.

Full security model: [docs/security.md](./docs/security.md).

---

## Documentation

- [Architecture](./docs/architecture.md) — how the bridge works, end to end.
- [Integrations](./docs/integrations.md) — drop-in snippets for popular tools.
- [Troubleshooting](./docs/troubleshooting.md) — common errors, common fixes.
- [Security model](./docs/security.md) — threat model, supply-chain notes.
- [FAQ](./docs/faq.md) — questions people actually ask.
- [Releasing](./docs/releasing.md) — for maintainers.

---

## Contributing

The codebase is intentionally small (~1.7k LOC of source across 11 files; reads end-to-end in under an hour). Read it before opening a PR.

```bash
git clone https://github.com/BenjiThatFoxGuy/chatgpt-bridge.git
cd chatgpt-bridge
bun install
bun run typecheck
bun test
bun run lint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

For security issues: [SECURITY.md](./SECURITY.md). Do not file public issues.

---

## License

MIT © [João Gabriel Lozano](https://github.com/l0z4n0-a1) — 2026. This fork (`oai-bridge`) is maintained by [BenjiThatFoxGuy](https://github.com/BenjiThatFoxGuy).

This project is **clean-room implemented**. It contains no code copied from `openai-oauth`, `ima2-gen`, or any other source under non-MIT-compatible licenses. The OAuth flow follows RFC 6749 and the upstream contract is observed from public OpenAI documentation.
