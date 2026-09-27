# Security model

## Threat model

The bridge runs on `localhost`. Anyone with shell access to your machine can already see your `~/.codex/auth.json` directly — the bridge doesn't expand the attack surface beyond that. The threat model is therefore:

| Concern | Status |
|---|---|
| Token theft via this package | Possible only if the package itself is compromised at install time (npm supply chain). See [Supply chain](#supply-chain). |
| Token leaked over the network | Not possible: bridge listens on `127.0.0.1` only by default and never sends tokens anywhere except `auth.openai.com` (refresh) and `chatgpt.com` (proxied requests). |
| Token logged accidentally | Bridge never logs token contents. `doctor`, `health`, and audit lines redact tokens. |
| Token written to disk in extra places | `auth.json` is written back **only** to the file it was read from, with mode `0o600`. The bridge does not copy it elsewhere. |
| Accidental commit to git | `.gitignore` blocks `auth.json`, `*.tgz`, `dist/`, and `.bridge/`. |
| Account suspension | Mitigated by conservative rate limits and human-like jitter. Not eliminated. See [OpenAI Terms](#openai-terms). |

## What lives on disk

| File | Owner | Notes |
|---|---|---|
| `~/.codex/auth.json` (or equivalent) | The official `codex` CLI; the bridge only reads + refreshes | Mode `0o600`. Contains JWTs and a refresh token. **Treat as a password file.** |
| `<project>/dist/` | npm install | The published JS — read-only, no secrets. |
| `node_modules/oai-bridge/` | npm install | Same. |

The bridge does not create any other state files unless you opt into them via env vars.

## Network egress

The bridge contacts only two hosts:

1. `https://auth.openai.com/oauth/token` — OAuth refresh (RFC 6749).
2. `https://chatgpt.com/backend-api/codex/...` — proxied requests.

You can verify with `tcpdump`/`netstat`/Wireshark. You can also override either via env vars (`OAI_BRIDGE_CLIENT_ID`, or the legacy `CHATGPT_BRIDGE_CLIENT_ID`, for OAuth client, no override for hosts — that's intentional).

## Inbound listeners

`serve` and `mcp --transport http` accept inbound connections. Neither changes the egress list above.

`mcp --transport http`:

- Binds `127.0.0.1:10532` by default. It refuses to bind any non-loopback host unless `--token` (or `OAI_BRIDGE_MCP_TOKEN`) is set.
- With a token, `/mcp` requires `Authorization: Bearer <token>`. The comparison is constant-time over SHA-256 digests.
- Without a token, `/mcp` also rejects any `Host` header that is not loopback or the `--public-url` host. This blocks DNS-rebinding attacks from a web page in your browser.
- `GET /files/<token>` is unauthenticated by design. Each generated PNG gets a random 128-bit token, and the URL is the capability: anyone holding the link can fetch that one file until the bridge restarts. Tokens are not derived from the path or prompt, and only files this process wrote are reachable. Treat the links like share links.

## Supply chain

This package follows a few practices:

- **Tiny dependency tree.** 4 runtime deps: `hono`, `@hono/node-server`, `commander`, `zod`. All are widely audited and minimal.
- **No postinstall scripts.** Install does nothing executable.
- **No bundled native code.** Pure JS.
- **Reproducible-ish builds.** `bun run build` produces deterministic output for a given source.
- **Provenance.** Releases tagged `v*` are published from the GitHub Actions workflow, with npm provenance attestation. Verify with:
  ```bash
  npm view oai-bridge --json | jq '.dist.attestations'
  ```

## Reporting a vulnerability

Please do **not** open a public issue for security reports.

Email: **claude@benjifox.gay** with subject `oai-bridge security`. Expect a reply within 72 hours. Coordinated disclosure preferred.

For non-security bugs, open an issue: https://github.com/BenjiThatFoxGuy/oai-bridge/issues

## OpenAI Terms

Using the bridge is consistent with letting the official `codex` CLI (which it relies on) authenticate you, but **automating consumer surfaces is generally discouraged by OpenAI's Terms of Use**. The bridge's defaults (rate limits, jitter, single-user, localhost-only) are conservative on purpose. Use it for personal scripts and integrations, not for production multi-tenant systems.

If you're not comfortable with that, use OpenAI's paid Images API directly — that's what it's for.

## Verifying the package you installed

```bash
# Tarball integrity
npm view oai-bridge dist.shasum dist.integrity

# Inspect what got installed
ls -la node_modules/oai-bridge/dist/
```

Open `node_modules/oai-bridge/dist/index.js` and read it. It's ~23 KB of plain JS, no obfuscation. If it's bigger or weirder than the published version on https://www.npmjs.com/package/oai-bridge, something's wrong — file an issue.
