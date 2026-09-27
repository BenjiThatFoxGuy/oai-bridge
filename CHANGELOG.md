# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] — 2026-09-27

### Changed

- Default chat model bumped from `gpt-5.2` to `gpt-5.5`. `gpt-5.2` is no longer supported through the Codex/ChatGPT bridge.

## [0.4.0] — 2026-09-27

### Added — MCP HTTP transport

- `oai-bridge mcp --transport http` serves MCP over Streamable HTTP (stateless) at `/mcp`, for remote MCP clients that connect by URL. Options `--host` (default `127.0.0.1`), `--port` (default `10532`), `--public-url`, and `--token`, with `OAI_BRIDGE_MCP_*` / `OAI_BRIDGE_PUBLIC_URL` env fallbacks. Stdio stays the default and is unchanged.
- Generated PNGs are served at `GET /files/<token>`, where the token is a random 128-bit capability minted per generation. Over HTTP, `generate_image` and `list_generations` include a `url`, and `health().storage.files_base_url` is set.
- `export_image` gains `format: "url" | "base64"`. It defaults to `url` over HTTP, so a full-size image no longer blows past a client's tool-result limit as several MB of base64. The default over stdio stays `base64`.
- Security: the bridge refuses a non-loopback bind without `--token`. With a token, `/mcp` requires a bearer. Without one, `/mcp` pins the `Host` header to loopback (DNS-rebinding guard).
- Library exports: `createMcpContext`, `createMcpServer`, `createMcpHttpApp`, `resolveHttpOptions`, `startMcpServer`, `startMcpHttpServer`, `GenerationIndex`.

### Added — MCP

- `export_image(path)` — reads back a PNG `generate_image` previously wrote and returns its bytes as base64. For MCP clients that run in a different container/filesystem than the bridge and so can't read the returned path directly. Refuses any path that isn't exactly one this bridge process itself wrote (directory containment + an in-memory index check — no arbitrary filesystem reads).
- `list_generations(limit?)` — lists generations still on disk from the bridge's current run, most recent first. Backed by the same in-memory index as `export_image`; resets on every bridge restart.
- `generate_image` now always writes into a fixed per-process generations directory (`~/.oai-bridge/generations` by default) instead of the bridge process's working directory — `out`, if given, is now treated as a filename only (any directory component is stripped). This is what makes `export_image`'s directory-containment check possible.
- `health()` now reports a `storage` block (generations directory path, whether it's currently writable, and how many generations are in memory) so a calling agent can confirm the environment is reachable before calling `generate_image`, instead of only finding out after the fact.
- Tool descriptions on `generate_image`, `export_image`, and the server docstring now say in-band that this storage is not durable across bridge restarts, so a freshly generated image should be exported/handed to the user in the same turn rather than deferred.

### Changed

- **Renamed the published package and CLI from `chatgpt-bridge` to `oai-bridge`** (this fork publishes independently of the upstream project it started from, which already owns the `chatgpt-bridge` name on npm). The CLI binary, MCP server name, data directory (`~/.oai-bridge`), and `OAI_BRIDGE_*` env vars all follow. Legacy `CHATGPT_BRIDGE_*` env vars and the old `~/.chatgpt-bridge/auth.json` path keep working indefinitely as deprecated fallbacks — nothing breaks for existing installs.
- Default image model (`DEFAULTS.imageModel`) bumped from `gpt-5.4-mini` to `gpt-5.5`.

## [0.3.0] — 2026-05-03

The agent-native release. Two-line setup, three killer capabilities, one machine-readable catalog. Everything from 0.2.0 keeps working.

### Headlines

- **One-shot install for 10 IDEs / agent runtimes.** `chatgpt-bridge install --for <target>` writes the right MCP/config block to the right path on the right OS. Idempotent, supports `--dry-run` and `--uninstall`. Refuses to overwrite a non-JSON config file.
  Targets: `claude-code`, `claude-desktop`, `codex`, `cursor`, `zed`, `cline`, `continue`, `gemini-cli`, `aider` (snippet), `openai-sdk` (snippet), `all` (auto-detects what's installed).
- **Multimodal input.** Vision (`image_url` content parts) and file context (`{type:"input_file", file:{path|url|data,mime}}` — bridge extension) work first-class on `/v1/chat/completions`. Reference images (`reference_images[]` — bridge extension) drive style/composition on `/v1/images/generations`. 25 MiB per attachment, 100 MiB aggregate. Path-traversal guard blocks attempts to read `~/.codex/auth.json`.
- **Machine-readable catalog.** `chatgpt-bridge capabilities` returns one JSON document describing every verb, arg, return shape, idempotency, side effects, typical latency, and error-code → structured `remedy` mapping. Agents read once, know everything.

### Added — CLI verbs

- `chatgpt-bridge chat <prompt|@file|->` — text or multimodal message. `--attach <path|url>` repeatable; auto-detects image vs. text. `--system <text|@file>`. Streams to tty; JSON to pipe.
- `chatgpt-bridge image <prompt|@file|->` — generate one PNG. `--ref <path|url>` repeatable (max 8) for style transfer. JSON output with absolute path, byte count, latency, and `revised_prompt` from the model.
- `chatgpt-bridge models` — list available chat + image models (deduped, sorted, includes synthetic image aliases).
- `chatgpt-bridge install --for <target>` and `chatgpt-bridge capabilities` — see Headlines.
- **Stdin JSONL batch** for `chat` and `image` — pipe one job per line, get one result line per job. Exit 0 if any job succeeds, 1 if none.
- **`@file` syntax** in any string flag — `--system @persona.md`, prompt arg as `@brief.md`, etc.
- **Universal `--dry-run`** on `chat`, `image`, `install` — validates inputs, never calls upstream or writes files.
- **Documented exit codes** — `0` ok, `1` user error, `2` auth, `3` upstream, `4` rate-limited, `5` quota exhausted.

### Added — HTTP

- `/v1/chat/completions` now translates OpenAI vision parts (`image_url`) → Responses `input_image`, and the bridge-extension `input_file` part (with `file:{path|url|data,mime,filename}`) → resolved Responses `input_file`. Unknown part types pass through verbatim (forward-compat).
- `/v1/images/generations` accepts an optional `reference_images: AttachmentSpec[]` field (max 8). When refs are present, `tool_choice` flips from `required` to `auto` so the model can inspect references before invoking the image-generation tool.
- `/health`, `/v1/responses`, `/v1/models`, `/v1/*` catch-all unchanged.

### Added — MCP

- `chat` tool gains `attachments?: string[]`. `generate_image` tool gains `references?: string[]`. Same caps and semantics as the HTTP and CLI surfaces. Existing 3 tools, no new ones.

### Added — library

```ts
import {
  CAPABILITIES, CAPABILITY_VERB_NAMES,
  runInstall, type InstallTarget, type InstallResult,
  resolveAttachment, resolveAttachments, toContentPart, AttachmentError,
  type AttachmentKind, type ResolvedAttachment,
  translateChatMessages,
  DEFAULT_CHAT_MODEL,
} from "chatgpt-bridge";
```

### Changed

- `gen` is now a deprecated alias for `image` (warns to stderr, then forwards). Will be removed in 0.5.
- `doctor` returns a `remedy[]` array when any check fails (`{check, cmd, interactive?, why?}`). Agents can read it and act without involving the user.
- `gpt-5.2` is no longer hardcoded across nine source locations — `DEFAULT_CHAT_MODEL` in `config.ts` is the single source of truth (also exported).

### Fixed

- **Empty-prompt guard** on `chat` and `image`. An empty prompt (missing arg, empty stdin, or empty `prompt` field in a JSONL line) now exits with code 1 and a structured `remedy`. Previously the bridge sent a placeholder request to the upstream and wasted quota.
- **`install` refuses to overwrite garbage.** When the target config file exists but isn't valid JSON (e.g. corrupted/null-byte `~/.cursor/mcp.json` files inherited from prior tools), `install` returns `{ok:false, error, remedy:{action,path}}` and leaves the file untouched. Empty/whitespace-only files are still safe to overwrite.
- **`doctor` exit code on Windows + Node 24.** Worked around a libuv `UV_HANDLE_CLOSING` assertion that fired during synchronous teardown after the global fetch's keep-alive socket. Bun was already unaffected.
- **MCP `health` `remedy` field** is now a structured `{cmd, interactive, why}` object, matching every other surface (was a plain string).

### Internal

- New modules: `src/install.ts` (10 adaptors), `src/capabilities.ts` (catalog), `src/attachments.ts` (resolver), `src/io.ts` (CLI I/O helpers).
- Code grew from ~900 LOC across 7 source files to ~1.7k LOC across 11. Reads end-to-end in under an hour.
- Test count: 17 → 90. Coverage spans schema validation, path safety, MIME detection, install round-trips, dry-run, JSONL parsing, error-catalog parity, compiled-CLI smoke.
- `Target` switch in `installSingle` is exhaustive — TypeScript's `never` assertion catches new-target omissions at compile time.
- Zero new runtime dependencies (re-uses `zod`).

## [0.2.0] — 2026-05-03

### Added

- **`chatgpt-bridge mcp`** — Model Context Protocol server over stdio. One-line install in Claude Desktop / Cursor / Zed / Cline. Exposes 3 tools: `generate_image`, `chat`, `health`.
- **`llms.txt`** — agent-readable documentation entry point following the [llmstxt.org](https://llmstxt.org) convention.
- **`AGENTS.md`** — instructions for AI coding agents working *in this repo* (project layout, conventions, never-do list).
- **Structured CLI errors** — top-level errors now emit JSON to stderr with `ok`, `error`, `remedy` fields. Agents can parse and act on them.

### Dependencies

- `@modelcontextprotocol/sdk` (new, runtime).

## [0.1.1] — 2026-05-03

### Changed

- Documentation pass: README rewritten with TOC + comparison + clearer "why".
- Added `docs/`: architecture, security, troubleshooting, FAQ, integrations, releasing.
- Repo hygiene: `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue templates, PR template.
- All repository URLs point to `l0z4n0-a1/chatgpt-bridge` (correct GitHub handle).

### Fixed

- Build script now emits `.d.ts` declarations correctly via `tsconfig.build.json`.
- `/v1/chat/completions` non-streaming requests no longer return HTTP 400. The
  bridge always streams from upstream (Codex `/responses` requires it) and
  aggregates the response when the caller asked for non-streaming.

## [0.1.0] — 2026-05-03

### Added

- Initial public release.
- Localhost OpenAI-compatible HTTP server (`/v1/models`, `/v1/responses`, `/v1/chat/completions`, `/v1/images/generations`, catch-all pass-through, `/health`).
- OAuth token reader / refresher compatible with `~/.codex/auth.json` written by the official `codex` CLI.
- CLI: `serve`, `gen`, `doctor`, `login`, `version`.
- Library API: `generateImage`, `Auth`, `Upstream`, `createApp`, `loadConfig`.
- Examples: Python, Node, curl, n8n, Claude Code skill.

[0.3.0]: https://github.com/l0z4n0-a1/chatgpt-bridge/releases/tag/v0.3.0
[0.2.0]: https://github.com/l0z4n0-a1/chatgpt-bridge/releases/tag/v0.2.0
[0.1.1]: https://github.com/l0z4n0-a1/chatgpt-bridge/releases/tag/v0.1.1
[0.1.0]: https://github.com/l0z4n0-a1/chatgpt-bridge/releases/tag/v0.1.0
