import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.ts";
import { createMcpHttpApp, isLoopbackHost, resolveHttpOptions } from "../src/mcp-http.ts";
import { type McpContext, createMcpContext } from "../src/mcp.ts";

const INIT_BODY = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "test", version: "0" },
	},
});
const MCP_HEADERS = {
	"content-type": "application/json",
	accept: "application/json, text/event-stream",
};

describe("resolveHttpOptions", () => {
	test("defaults to loopback on 10532", () => {
		const r = resolveHttpOptions({});
		expect(r.host).toBe("127.0.0.1");
		expect(r.port).toBe(10532);
		expect(r.publicBaseUrl).toBe("http://127.0.0.1:10532");
		expect(r.token).toBeUndefined();
	});

	test("refuses a non-loopback host without a token", () => {
		expect(() => resolveHttpOptions({ host: "0.0.0.0" })).toThrow(/without a token/);
		expect(() => resolveHttpOptions({ host: "192.168.1.5" })).toThrow(/without a token/);
	});

	test("allows a non-loopback host with a token and maps 0.0.0.0 to loopback", () => {
		const r = resolveHttpOptions({ host: "0.0.0.0", port: 9000, token: "s3cret" });
		expect(r.publicBaseUrl).toBe("http://127.0.0.1:9000");
		expect(r.token).toBe("s3cret");
	});

	test("public url wins and loses its trailing slash", () => {
		const r = resolveHttpOptions({ publicUrl: "https://bridge.example.com/" });
		expect(r.publicBaseUrl).toBe("https://bridge.example.com");
	});

	test("rejects non-http public urls and bad ports", () => {
		expect(() => resolveHttpOptions({ publicUrl: "ftp://x" })).toThrow(/http\(s\)/);
		expect(() => resolveHttpOptions({ port: 70000 })).toThrow(/invalid port/);
	});

	test("isLoopbackHost", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("127.1.2.3")).toBe(true);
		expect(isLoopbackHost("LOCALHOST")).toBe(true);
		expect(isLoopbackHost("[::1]")).toBe(true);
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(isLoopbackHost("evil.example.com")).toBe(false);
	});
});

describe("createMcpHttpApp", () => {
	let dataHome: string;
	let ctx: McpContext;

	beforeEach(async () => {
		dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "oai-bridge-mcp-http-test-"));
		ctx = createMcpContext(loadConfig({ dataHome }), "http://127.0.0.1:10532");
		await fs.mkdir(ctx.index.dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dataHome, { recursive: true, force: true });
	});

	async function indexFile(name: string, bytes: Buffer): Promise<string> {
		const p = path.join(ctx.index.dir, name);
		await fs.writeFile(p, bytes);
		return ctx.index.add({
			path: p,
			prompt: "a fox",
			size: "1024x1024",
			quality: "high",
			bytes: bytes.length,
			createdAtMs: Date.now(),
		}).token;
	}

	test("GET /files/<token> serves the exact PNG bytes", async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		const token = await indexFile("gen.png", bytes);
		const res = await createMcpHttpApp(ctx).request(`/files/${token}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
	});

	test("GET /files is unauthenticated even when /mcp has a token", async () => {
		const token = await indexFile("gen.png", Buffer.from([1]));
		const res = await createMcpHttpApp(ctx, { token: "s3cret" }).request(`/files/${token}`);
		expect(res.status).toBe(200);
	});

	test("unknown and malformed tokens are 404", async () => {
		const app = createMcpHttpApp(ctx);
		expect((await app.request(`/files/${"A".repeat(22)}`)).status).toBe(404);
		expect((await app.request("/files/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
		expect((await app.request("/files/short")).status).toBe(404);
	});

	test("a file deleted after indexing is 404", async () => {
		const token = await indexFile("gone.png", Buffer.from([1]));
		await fs.rm(path.join(ctx.index.dir, "gone.png"));
		const res = await createMcpHttpApp(ctx).request(`/files/${token}`);
		expect(res.status).toBe(404);
	});

	test("GET /health", async () => {
		const res = await createMcpHttpApp(ctx).request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; transport: string };
		expect(body.ok).toBe(true);
		expect(body.transport).toBe("http");
	});

	test("/mcp without a bearer is 401 when a token is set", async () => {
		const app = createMcpHttpApp(ctx, { token: "s3cret" });
		const res = await app.request("/mcp", {
			method: "POST",
			headers: MCP_HEADERS,
			body: INIT_BODY,
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
		const wrong = await app.request("/mcp", {
			method: "POST",
			headers: { ...MCP_HEADERS, authorization: "Bearer nope" },
			body: INIT_BODY,
		});
		expect(wrong.status).toBe(401);
	});

	test("/mcp with the right bearer initializes", async () => {
		const app = createMcpHttpApp(ctx, { token: "s3cret" });
		const res = await app.request("/mcp", {
			method: "POST",
			headers: { ...MCP_HEADERS, authorization: "Bearer s3cret", host: "anything.example" },
			body: INIT_BODY,
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("oai-bridge");
	});

	test("/mcp without a token rejects a foreign Host (DNS rebinding)", async () => {
		const app = createMcpHttpApp(ctx);
		const res = await app.request("/mcp", {
			method: "POST",
			headers: { ...MCP_HEADERS, host: "evil.example.com:10532" },
			body: INIT_BODY,
		});
		expect(res.status).toBe(403);
		const ok = await app.request("/mcp", {
			method: "POST",
			headers: { ...MCP_HEADERS, host: "127.0.0.1:10532" },
			body: INIT_BODY,
		});
		expect(ok.status).toBe(200);
	});
});

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(url)).ok) return;
		} catch {
			// not listening yet
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`server at ${url} did not come up`);
}

describe("live round trip (oai-bridge mcp --transport http)", () => {
	let child: ChildProcess;
	let home: string;
	let port: number;
	const TOKEN = "live-test-token";

	beforeAll(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "oai-bridge-mcp-live-"));
		port = await freePort();
		child = spawn(
			process.execPath,
			["src/cli.ts", "mcp", "--transport", "http", "--port", String(port), "--token", TOKEN],
			{
				env: {
					...process.env,
					HOME: home,
					USERPROFILE: home,
					OAI_BRIDGE_AUTH_FILE: path.join(home, "missing-auth.json"),
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		await waitForHealth(`http://127.0.0.1:${port}/health`, 10_000);
	});

	afterAll(async () => {
		child?.kill("SIGTERM");
		await fs.rm(home, { recursive: true, force: true });
	});

	test("tools/list and health via the SDK client", async () => {
		const client = new Client({ name: "live-test", version: "0" });
		const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
		});
		await client.connect(transport);
		try {
			const tools = await client.listTools();
			const names = tools.tools.map((t) => t.name);
			expect(names).toContain("generate_image");
			expect(names).toContain("export_image");

			const health = await client.callTool({ name: "health", arguments: {} });
			const content = health.content as Array<{ type: string; text: string }>;
			const parsed = JSON.parse(content[0]?.text ?? "{}");
			expect(parsed.storage.files_base_url).toBe(`http://127.0.0.1:${port}/files/`);
		} finally {
			await client.close();
		}
	});
});
