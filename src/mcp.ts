/**
 * MCP server: exposes the bridge as a Model Context Protocol server over stdio.
 *
 * Plug into Claude Desktop / Cursor / Zed / Cline / any MCP client with:
 *
 *   {
 *     "mcpServers": {
 *       "chatgpt-bridge": {
 *         "command": "npx",
 *         "args": ["-y", "chatgpt-bridge", "mcp"]
 *       }
 *     }
 *   }
 *
 * `chatgpt-bridge install --for <ide>` writes that block automatically.
 *
 * Tools exposed (mirror the CLI surface):
 *   - generate_image(prompt, out?, size?, quality?, references?)
 *       → writes PNG to disk under this process's generations directory,
 *         returns its absolute path. `references` are optional reference
 *         images that drive style/composition.
 *   - export_image(path)
 *       → reads back a PNG this same bridge process wrote and returns its
 *         bytes as base64, for callers (e.g. an MCP client in a different
 *         container) that cannot read the bridge's filesystem directly.
 *   - list_generations(limit?)
 *       → generations still on disk from this bridge process's current run.
 *   - chat(prompt, system?, model?, attachments?)
 *       → assistant reply as plain text. `attachments` accept paths or URLs;
 *         images become vision input, text files become contextual file_data.
 *   - health()
 *       → bridge state snapshot (auth, version, upstream, storage).
 *
 * Storage caveat: the bridge keeps generated images and the in-memory index
 * behind list_generations/export_image only for the lifetime of this process.
 * Neither survives a restart. See the generate_image/export_image tool
 * descriptions below, which repeat this in-band for the calling agent.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolveAttachments } from "./attachments.ts";
import { Auth, tokenExpiryMs } from "./auth.ts";
import { type Config, DEFAULT_CHAT_MODEL } from "./config.ts";
import { generateImage } from "./images.ts";
import { VERSION } from "./server.ts";
import { Upstream } from "./upstream.ts";

/** Generations index caps how many past writes we remember in memory. */
const MAX_INDEX_ENTRIES = 200;

export interface GenerationRecord {
	path: string;
	prompt: string;
	revisedPrompt?: string;
	size: string;
	quality: string;
	bytes: number;
	createdAtMs: number;
}

/**
 * Tracks PNGs this bridge process has written to `dir` (and only this
 * process — nothing here is persisted). export_image and list_generations
 * both read from this instead of touching the filesystem outside `dir`,
 * so a caller can never use export_image to read a file this process
 * didn't itself write.
 */
export class GenerationIndex {
	readonly dir: string;
	private entries: GenerationRecord[] = [];

	constructor(dataHome: string) {
		this.dir = path.join(dataHome, "generations");
	}

	add(record: GenerationRecord): void {
		this.entries.push(record);
		if (this.entries.length > MAX_INDEX_ENTRIES) this.entries.shift();
	}

	/** True only if `absPath` is exactly a path this process wrote. */
	has(absPath: string): boolean {
		return this.entries.some((e) => e.path === absPath);
	}

	/** Most recent first. */
	recent(limit: number): GenerationRecord[] {
		return this.entries.slice(-limit).reverse();
	}
}

const TOOL_DEFINITIONS = [
	{
		name: "generate_image",
		description:
			"Generate an image using the user's ChatGPT subscription via OAuth (no API key, no per-image cost). Optional `references` array shapes style/composition. Writes a PNG into this bridge process's generations directory and returns its absolute path. " +
			"IMPORTANT: this storage is NOT durable -- it lives only as long as the current bridge process, and a restart discards it permanently along with the list_generations index. If you (the calling agent) cannot read the bridge's filesystem directly, that returned path is not itself useful to you: call export_image on it before the turn ends, promptly, not as a deferred or batched step. Before calling this tool at all, call health() and check `storage.writable` rather than assuming the environment is reachable just because a call reports success.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "What to draw. Be visually specific.",
				},
				out: {
					type: "string",
					description:
						"Optional filename (basename only -- any directory component is stripped). The file always lands inside this bridge process's generations directory, not the caller's working directory, so export_image can read it back safely. Defaults to chatgpt-bridge-<timestamp>.png.",
				},
				size: {
					type: "string",
					enum: ["1024x1024", "1024x1536", "1536x1024", "auto"],
					description: "Image dimensions. Default 1024x1024.",
				},
				quality: {
					type: "string",
					enum: ["low", "medium", "high", "auto"],
					description: "Generation quality. Higher = slower + more detailed. Default high.",
				},
				references: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional reference images (paths, URLs, or data-URLs). Up to 8. Drives the style/composition of the generated image.",
				},
			},
			required: ["prompt"],
		},
	},
	{
		name: "export_image",
		description:
			"Read back a PNG that THIS bridge process's generate_image previously wrote, and return its bytes as base64. Pure read + re-encode: no regeneration, no upstream call. " +
			"Use this whenever you (the calling agent) cannot read the bridge's filesystem directly -- which is the common case, since the bridge and the calling MCP client often run in different containers/filesystems. `path` must be exactly a path this bridge process itself returned from generate_image or list_generations; it is refused otherwise (no arbitrary filesystem reads, no path traversal). " +
			"Because the underlying storage is not durable across bridge restarts, export promptly -- in the same turn a fresh image is generated -- rather than deferring or batching exports for later.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Absolute path previously returned by generate_image or list_generations.",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "list_generations",
		description:
			"List images generate_image has written that are still on disk from this bridge process's current run, most recent first. Backed by an in-memory index that resets on every bridge restart -- it will not show anything generated in a previous run, even if the PNG file happens to still exist. Use this to recall an earlier generation's path (e.g. to pass to export_image) without needing the agent to have kept it around.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: `Maximum entries to return, most recent first. Default 20, capped at ${MAX_INDEX_ENTRIES}.`,
				},
			},
		},
	},
	{
		name: "chat",
		description:
			"Send a chat message through the user's ChatGPT subscription and get the assistant reply as plain text. Supports text plus optional attachments (images for vision, .md/.txt/.json for context).",
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "User message.",
				},
				system: {
					type: "string",
					description: "Optional system / developer prompt.",
				},
				model: {
					type: "string",
					description: "Upstream model id (e.g. gpt-5.2). Defaults to gpt-5.2.",
				},
				attachments: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional attachment paths or URLs. Auto-detects image vs. text. Images become vision input; text files become contextual file_data. Max 25 MiB each, 100 MiB aggregate.",
				},
			},
			required: ["prompt"],
		},
	},
	{
		name: "health",
		description:
			"Return a snapshot of the bridge's auth, upstream, and local storage state -- including whether the generations directory is currently writable. Call this before generate_image to confirm the environment is actually reachable, rather than trusting a later reported success. Also useful for confirming the user is authenticated.",
		inputSchema: { type: "object", properties: {} },
	},
];

interface GenerateImageArgs {
	prompt: string;
	out?: string;
	size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
	quality?: "low" | "medium" | "high" | "auto";
	references?: string[];
}

interface ChatArgs {
	prompt: string;
	system?: string;
	model?: string;
	attachments?: string[];
}

interface ExportImageArgs {
	path: string;
}

interface ListGenerationsArgs {
	limit?: number;
}

async function handleGenerateImage(
	cfg: Config,
	upstream: Upstream,
	index: GenerationIndex,
	args: GenerateImageArgs,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	const t0 = Date.now();
	const size = args.size ?? "1024x1024";
	const quality = args.quality ?? "high";
	const img = await generateImage(cfg, upstream, {
		prompt: args.prompt,
		size,
		quality,
		n: 1,
		response_format: "b64_json",
		moderation: "low",
		...(args.references && args.references.length > 0 ? { reference_images: args.references } : {}),
	});
	// Every generation lands inside index.dir, never wherever the caller's
	// `out` might otherwise point -- that's what lets export_image validate
	// a path by directory containment instead of trusting caller input.
	const filename = args.out ? path.basename(args.out) : `chatgpt-bridge-${Date.now()}.png`;
	const outPath = path.join(index.dir, filename);
	await fs.mkdir(index.dir, { recursive: true });
	await fs.writeFile(outPath, Buffer.from(img.b64, "base64"));
	const bytes = Buffer.byteLength(img.b64, "base64");
	index.add({
		path: outPath,
		prompt: args.prompt,
		revisedPrompt: img.revisedPrompt,
		size,
		quality,
		bytes,
		createdAtMs: Date.now(),
	});
	const summary = {
		ok: true,
		file: outPath,
		latency_ms: Date.now() - t0,
		bytes,
		revised_prompt: img.revisedPrompt ?? null,
	};
	return {
		content: [
			{
				type: "text",
				text:
					`Image saved to ${outPath}. This is NOT durable across bridge restarts -- ` +
					`export it now (export_image) or hand it to the user in this same turn rather than deferring.\n\n${JSON.stringify(summary, null, 2)}`,
			},
		],
	};
}

export async function handleExportImage(
	index: GenerationIndex,
	args: ExportImageArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
	const resolved = path.resolve(args.path);
	const withinDir = resolved === index.dir || resolved.startsWith(index.dir + path.sep);
	if (!withinDir || !index.has(resolved)) {
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `Refusing to export ${args.path}: not a path this bridge process's generate_image wrote and still has indexed. Storage resets on every bridge restart, so this can also mean the image was generated in an earlier run. Call list_generations to see what is currently available.`,
				},
			],
		};
	}
	const bytes = await fs.readFile(resolved);
	const result = {
		ok: true,
		path: resolved,
		b64_data: bytes.toString("base64"),
		bytes: bytes.length,
		mime: "image/png",
	};
	return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export async function handleListGenerations(
	index: GenerationIndex,
	args: ListGenerationsArgs,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	const limit = Math.max(1, Math.min(args.limit ?? 20, MAX_INDEX_ENTRIES));
	const generations: Array<Record<string, unknown>> = [];
	for (const rec of index.recent(limit)) {
		try {
			await fs.stat(rec.path);
		} catch {
			// Vanished from disk since it was indexed (e.g. the user deleted it).
			// Skip it rather than list something export_image can't read back.
			continue;
		}
		generations.push({
			path: rec.path,
			prompt: rec.prompt,
			revised_prompt: rec.revisedPrompt ?? null,
			size: rec.size,
			quality: rec.quality,
			bytes: rec.bytes,
			created_at: new Date(rec.createdAtMs).toISOString(),
		});
	}
	const result = { ok: true, count: generations.length, generations };
	return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function handleChat(
	cfg: Config,
	upstream: Upstream,
	args: ChatArgs,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	const input: Array<Record<string, unknown>> = [];
	if (args.system) input.push({ role: "developer", content: args.system });

	const userContent: Array<Record<string, unknown>> = [{ type: "input_text", text: args.prompt }];
	if (args.attachments && args.attachments.length > 0) {
		const { parts } = await resolveAttachments(args.attachments, {}, cfg);
		for (const p of parts) userContent.push(p);
	}
	input.push({ role: "user", content: userContent });

	const res = await upstream.call({
		path: "/responses",
		method: "POST",
		body: {
			model: args.model ?? DEFAULT_CHAT_MODEL,
			input,
			stream: true,
			store: false,
			instructions: "",
		},
		stream: true,
	});
	if (!res.ok) await upstream.raiseForStatus(res);

	let text = "";
	const { parseSSE } = await import("./upstream.ts");
	for await (const ev of parseSSE(res)) {
		if (ev.type === "response.output_text.delta") {
			const delta = (ev.data as any).delta;
			if (typeof delta === "string") text += delta;
		}
	}
	return { content: [{ type: "text", text: text || "(empty response)" }] };
}

async function probeStorageWritable(index: GenerationIndex): Promise<boolean> {
	const probePath = path.join(index.dir, `.write-test-${process.pid}`);
	try {
		await fs.mkdir(index.dir, { recursive: true });
		await fs.writeFile(probePath, "");
		await fs.unlink(probePath);
		return true;
	} catch {
		return false;
	}
}

async function handleHealth(
	cfg: Config,
	auth: Auth,
	index: GenerationIndex,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	const storage = {
		generations_dir: index.dir,
		writable: await probeStorageWritable(index),
		durable: false,
		generations_in_memory: index.recent(MAX_INDEX_ENTRIES).length,
	};
	let status: Record<string, unknown>;
	try {
		const t = await auth.ensure();
		const exp = tokenExpiryMs(t.accessToken);
		status = {
			ok: true,
			version: VERSION,
			auth: {
				source_path: t.sourcePath,
				expires_in_seconds:
					typeof exp === "number" ? Math.max(0, Math.floor((exp - Date.now()) / 1000)) : null,
			},
			upstream: cfg.upstreamBase,
			storage,
		};
	} catch (e) {
		status = {
			ok: false,
			version: VERSION,
			error: (e as Error).message,
			storage,
			remedy: {
				cmd: "npx @openai/codex login",
				interactive: true,
				why: "OAuth flow opens browser; user signs in to ChatGPT once",
			},
		};
	}
	return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
}

export async function startMcpServer(cfg: Config): Promise<void> {
	const auth = new Auth(cfg);
	const upstream = new Upstream(cfg, auth);
	const index = new GenerationIndex(cfg.dataHome);

	const server = new Server(
		{ name: "chatgpt-bridge", version: VERSION },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOL_DEFINITIONS,
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const name = req.params.name;
		const args = (req.params.arguments ?? {}) as Record<string, unknown>;
		try {
			if (name === "generate_image") {
				return await handleGenerateImage(
					cfg,
					upstream,
					index,
					args as unknown as GenerateImageArgs,
				);
			}
			if (name === "export_image") {
				return await handleExportImage(index, args as unknown as ExportImageArgs);
			}
			if (name === "list_generations") {
				return await handleListGenerations(index, args as unknown as ListGenerationsArgs);
			}
			if (name === "chat") {
				return await handleChat(cfg, upstream, args as unknown as ChatArgs);
			}
			if (name === "health") {
				return await handleHealth(cfg, auth, index);
			}
			return {
				isError: true,
				content: [{ type: "text", text: `Unknown tool: ${name}` }],
			};
		} catch (e) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `${(e as Error).message}\n\nRun \`chatgpt-bridge doctor\` to diagnose.`,
					},
				],
			};
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Process stays alive on stdio. No console.log here — stdout is the protocol channel.
	void os; // silence unused if stripped
}
