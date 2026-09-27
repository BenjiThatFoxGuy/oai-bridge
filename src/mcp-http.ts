/**
 * MCP over Streamable HTTP, plus the file host that lets export_image hand
 * out URLs instead of multi-megabyte base64 blobs.
 *
 *   oai-bridge mcp --transport http [--host 127.0.0.1] [--port 10532]
 *                  [--public-url https://bridge.example.com] [--token <secret>]
 *
 * Routes:
 *   POST/GET/DELETE /mcp    MCP Streamable HTTP transport (stateless mode).
 *                           Bearer-protected when a token is configured.
 *   GET /files/<token>      A PNG this process's generate_image wrote. The
 *                           token is a 128-bit random capability minted per
 *                           generation; holding the URL is the authorization,
 *                           so it works in a browser or an <img> tag. Tokens
 *                           die with the process (the index is in-memory).
 *   GET /health             Liveness only: { ok, version, transport }.
 *
 * Stateless mode: each /mcp request gets a fresh Server + transport. Auth,
 * upstream, and the generations index live on one shared McpContext, so a
 * generate_image in one request is exportable from the next.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { Config } from "./config.ts";
import { type McpContext, type McpServeOptions, createMcpContext, createMcpServer } from "./mcp.ts";
import { VERSION } from "./server.ts";

export const DEFAULT_MCP_HTTP_PORT = 10532;

/** base64url of 16 random bytes, as minted by GenerationIndex.add(). */
const FILE_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTS.has(host.toLowerCase()) || host.startsWith("127.");
}

/** Compare secrets without leaking length or prefix timing. */
function secretsEqual(a: string, b: string): boolean {
	const da = createHash("sha256").update(a).digest();
	const db = createHash("sha256").update(b).digest();
	return timingSafeEqual(da, db);
}

/** Host header minus port; brackets kept for IPv6 literals. */
function hostnameOf(hostHeader: string): string {
	if (hostHeader.startsWith("[")) {
		const end = hostHeader.indexOf("]");
		return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
	}
	const colon = hostHeader.lastIndexOf(":");
	return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

export interface McpHttpAppOptions {
	token?: string;
}

export function createMcpHttpApp(ctx: McpContext, opts: McpHttpAppOptions = {}): Hono {
	const app = new Hono();
	const publicHost = ctx.publicBaseUrl ? new URL(ctx.publicBaseUrl).hostname.toLowerCase() : undefined;

	app.get("/health", (c) => c.json({ ok: true, version: VERSION, transport: "http" }));

	app.use("/mcp", async (c, next) => {
		if (opts.token) {
			const header = c.req.header("authorization") ?? "";
			const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
			if (!presented || !secretsEqual(presented, opts.token)) {
				return c.json({ error: "missing or invalid bearer token" }, 401, {
					"WWW-Authenticate": 'Bearer realm="oai-bridge"',
				});
			}
			return next();
		}
		// No token means we only ever listen on loopback (startMcpHttpServer
		// enforces that). Pin the Host header too, so a web page can't reach
		// this via DNS rebinding and drive the user's subscription.
		const host = hostnameOf(c.req.header("host") ?? "").toLowerCase();
		if (!isLoopbackHost(host) && host !== publicHost) {
			return c.json({ error: `host ${host || "(none)"} not allowed` }, 403);
		}
		return next();
	});

	app.all("/mcp", async (c) => {
		const server = createMcpServer(ctx);
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});
		await server.connect(transport);
		const res = await transport.handleRequest(c.req.raw);
		// Stateless: nothing outlives this request except what's on ctx. The
		// transport finishes writing an SSE body before close resolves, so
		// close only once the client has the whole response.
		c.req.raw.signal.addEventListener("abort", () => {
			void server.close();
		});
		return res;
	});

	app.get("/files/:token", async (c) => {
		const token = c.req.param("token");
		const rec = FILE_TOKEN_RE.test(token) ? ctx.index.byToken(token) : undefined;
		if (!rec) return c.json({ error: "not found" }, 404);
		let body: Buffer;
		try {
			body = await fs.readFile(rec.path);
		} catch {
			// Indexed but deleted from disk since. Same answer as unknown.
			return c.json({ error: "not found" }, 404);
		}
		const filename = path.basename(rec.path).replace(/[^A-Za-z0-9._-]/g, "_");
		return c.body(new Uint8Array(body), 200, {
			"Content-Type": "image/png",
			"Content-Length": String(body.length),
			"Content-Disposition": `inline; filename="${filename}"`,
			"Cache-Control": "private, max-age=3600, immutable",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		});
	});

	app.notFound((c) => c.json({ error: "not found" }, 404));
	return app;
}

export interface ResolvedHttpOptions {
	host: string;
	port: number;
	publicBaseUrl: string;
	token?: string;
}

/**
 * Fill defaults and enforce the one hard rule: no token, no listening off
 * loopback. Throws with an actionable message instead of starting open.
 */
export function resolveHttpOptions(opts: McpServeOptions): ResolvedHttpOptions {
	const host = opts.host ?? "127.0.0.1";
	const port = opts.port ?? DEFAULT_MCP_HTTP_PORT;
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`invalid port: ${opts.port}`);
	}
	if (!opts.token && !isLoopbackHost(host)) {
		throw new Error(
			`refusing to listen on ${host} without a token. Set --token (or OAI_BRIDGE_MCP_TOKEN), or bind to 127.0.0.1 and put an authenticating proxy in front.`,
		);
	}
	let publicBaseUrl: string;
	if (opts.publicUrl) {
		const u = new URL(opts.publicUrl);
		if (u.protocol !== "http:" && u.protocol !== "https:") {
			throw new Error(`--public-url must be http(s): ${opts.publicUrl}`);
		}
		publicBaseUrl = opts.publicUrl.replace(/\/+$/, "");
	} else {
		// 0.0.0.0 / :: aren't addresses a client can use; point at loopback.
		const urlHost =
			host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
		publicBaseUrl = `http://${urlHost}:${port}`;
	}
	return { host, port, publicBaseUrl, ...(opts.token ? { token: opts.token } : {}) };
}

export async function startMcpHttpServer(cfg: Config, opts: McpServeOptions): Promise<void> {
	const resolved = resolveHttpOptions(opts);
	const ctx = createMcpContext(cfg, resolved.publicBaseUrl);
	const app = createMcpHttpApp(ctx, resolved.token ? { token: resolved.token } : {});
	const server = serve({ fetch: app.fetch, hostname: resolved.host, port: resolved.port });
	console.error(
		`oai-bridge MCP (Streamable HTTP) on http://${resolved.host}:${resolved.port}/mcp` +
			` -- files at ${resolved.publicBaseUrl}/files/` +
			(resolved.token ? " -- bearer auth on" : " -- no auth (loopback only)"),
	);
	const shutdown = () => {
		server.close();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}
