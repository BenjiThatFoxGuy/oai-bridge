import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GenerationIndex, handleExportImage, handleListGenerations } from "../src/mcp.ts";

describe("GenerationIndex", () => {
	let dataHome: string;
	let index: GenerationIndex;

	beforeEach(async () => {
		dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "oai-bridge-mcp-test-"));
		index = new GenerationIndex(dataHome);
		await fs.mkdir(index.dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dataHome, { recursive: true, force: true });
	});

	test("dir is a fixed subdirectory of dataHome", () => {
		expect(index.dir).toBe(path.join(dataHome, "generations"));
	});

	test("has() is false until a record is added", () => {
		const p = path.join(index.dir, "a.png");
		expect(index.has(p)).toBe(false);
		index.add({
			path: p,
			prompt: "a fox",
			size: "1024x1024",
			quality: "high",
			bytes: 10,
			createdAtMs: Date.now(),
		});
		expect(index.has(p)).toBe(true);
	});

	test("recent() returns most-recent-first, capped to limit", () => {
		for (let i = 0; i < 5; i++) {
			index.add({
				path: path.join(index.dir, `${i}.png`),
				prompt: `p${i}`,
				size: "1024x1024",
				quality: "high",
				bytes: 1,
				createdAtMs: i,
			});
		}
		const top2 = index.recent(2);
		expect(top2.map((r) => r.prompt)).toEqual(["p4", "p3"]);
	});

	test("evicts oldest entries beyond the max cap", () => {
		// Cap is 200; add 205 and confirm the earliest 5 are gone.
		for (let i = 0; i < 205; i++) {
			index.add({
				path: path.join(index.dir, `${i}.png`),
				prompt: `p${i}`,
				size: "1024x1024",
				quality: "high",
				bytes: 1,
				createdAtMs: i,
			});
		}
		const all = index.recent(1000);
		expect(all.length).toBe(200);
		expect(all[all.length - 1]?.prompt).toBe("p5");
	});
});

describe("handleExportImage", () => {
	let dataHome: string;
	let index: GenerationIndex;

	beforeEach(async () => {
		dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "oai-bridge-mcp-test-"));
		index = new GenerationIndex(dataHome);
		await fs.mkdir(index.dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dataHome, { recursive: true, force: true });
	});

	test("reads back and base64-encodes a file the bridge wrote", async () => {
		const filePath = path.join(index.dir, "gen.png");
		const bytes = Buffer.from([1, 2, 3, 4]);
		await fs.writeFile(filePath, bytes);
		index.add({
			path: filePath,
			prompt: "a fox",
			size: "1024x1024",
			quality: "high",
			bytes: bytes.length,
			createdAtMs: Date.now(),
		});

		const result = await handleExportImage(index, { path: filePath });
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(parsed.ok).toBe(true);
		expect(parsed.mime).toBe("image/png");
		expect(Buffer.from(parsed.b64_data, "base64")).toEqual(bytes);
	});

	test("refuses a path outside the generations directory", async () => {
		const outside = path.join(dataHome, "outside.png");
		await fs.writeFile(outside, Buffer.from([1]));

		const result = await handleExportImage(index, { path: outside });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/Refusing to export/);
	});

	test("refuses a path traversal attempt out of the generations directory", async () => {
		const traversal = path.join(index.dir, "..", "outside.png");
		const result = await handleExportImage(index, { path: traversal });
		expect(result.isError).toBe(true);
	});

	test("refuses a file inside the directory that the bridge did not itself write", async () => {
		// e.g. dropped there by something else, or from a prior process run
		// whose index has since reset -- containment alone isn't enough.
		const untracked = path.join(index.dir, "untracked.png");
		await fs.writeFile(untracked, Buffer.from([9]));

		const result = await handleExportImage(index, { path: untracked });
		expect(result.isError).toBe(true);
	});
});

describe("handleListGenerations", () => {
	let dataHome: string;
	let index: GenerationIndex;

	beforeEach(async () => {
		dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "oai-bridge-mcp-test-"));
		index = new GenerationIndex(dataHome);
		await fs.mkdir(index.dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dataHome, { recursive: true, force: true });
	});

	test("lists indexed generations still present on disk, most recent first", async () => {
		const p1 = path.join(index.dir, "1.png");
		const p2 = path.join(index.dir, "2.png");
		await fs.writeFile(p1, Buffer.from([1]));
		await fs.writeFile(p2, Buffer.from([2]));
		index.add({
			path: p1,
			prompt: "first",
			size: "1024x1024",
			quality: "high",
			bytes: 1,
			createdAtMs: 1,
		});
		index.add({
			path: p2,
			prompt: "second",
			size: "1024x1024",
			quality: "high",
			bytes: 1,
			createdAtMs: 2,
		});

		const result = await handleListGenerations(index, {});
		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(parsed.count).toBe(2);
		expect(parsed.generations.map((g: { prompt: string }) => g.prompt)).toEqual([
			"second",
			"first",
		]);
	});

	test("skips indexed entries whose file no longer exists on disk", async () => {
		const gone = path.join(index.dir, "gone.png");
		index.add({
			path: gone,
			prompt: "deleted",
			size: "1024x1024",
			quality: "high",
			bytes: 1,
			createdAtMs: 1,
		});

		const result = await handleListGenerations(index, {});
		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(parsed.count).toBe(0);
	});
});

describe("GenerationIndex tokens", () => {
	let dataHome: string;
	let index: GenerationIndex;

	beforeEach(async () => {
		dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "oai-bridge-mcp-test-"));
		index = new GenerationIndex(dataHome);
	});

	afterEach(async () => {
		await fs.rm(dataHome, { recursive: true, force: true });
	});

	test("add() mints a unique 22-char base64url token per record", () => {
		const tokens = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const rec = index.add({
				path: path.join(index.dir, `${i}.png`),
				prompt: `p${i}`,
				size: "1024x1024",
				quality: "high",
				bytes: 1,
				createdAtMs: i,
			});
			expect(rec.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
			tokens.add(rec.token);
		}
		expect(tokens.size).toBe(50);
	});

	test("byToken() resolves live tokens and forgets evicted ones", () => {
		const first = index.add({
			path: path.join(index.dir, "first.png"),
			prompt: "first",
			size: "1024x1024",
			quality: "high",
			bytes: 1,
			createdAtMs: 0,
		});
		expect(index.byToken(first.token)?.path).toBe(first.path);
		expect(index.byToken("A".repeat(22))).toBeUndefined();
		for (let i = 0; i < 200; i++) {
			index.add({
				path: path.join(index.dir, `${i}.png`),
				prompt: `p${i}`,
				size: "1024x1024",
				quality: "high",
				bytes: 1,
				createdAtMs: i + 1,
			});
		}
		expect(index.byToken(first.token)).toBeUndefined();
	});
});

describe("export_image / list_generations URL format", () => {
	const BASE = "https://bridge.example.com";
	let dataHome: string;
	let index: GenerationIndex;
	let filePath: string;
	let token: string;

	beforeEach(async () => {
		dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "oai-bridge-mcp-test-"));
		index = new GenerationIndex(dataHome);
		await fs.mkdir(index.dir, { recursive: true });
		filePath = path.join(index.dir, "gen.png");
		await fs.writeFile(filePath, Buffer.from([1, 2, 3, 4]));
		token = index.add({
			path: filePath,
			prompt: "a fox",
			size: "1024x1024",
			quality: "high",
			bytes: 4,
			createdAtMs: Date.now(),
		}).token;
	});

	afterEach(async () => {
		await fs.rm(dataHome, { recursive: true, force: true });
	});

	test("defaults to url when the bridge hosts files", async () => {
		const result = await handleExportImage(index, { path: filePath }, BASE);
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(parsed.url).toBe(`${BASE}/files/${token}`);
		expect(parsed.bytes).toBe(4);
		expect(parsed.b64_data).toBeUndefined();
	});

	test("explicit base64 still works when hosting files", async () => {
		const result = await handleExportImage(index, { path: filePath, format: "base64" }, BASE);
		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(Buffer.from(parsed.b64_data, "base64")).toEqual(Buffer.from([1, 2, 3, 4]));
	});

	test("defaults to base64 without a files base", async () => {
		const result = await handleExportImage(index, { path: filePath });
		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(parsed.b64_data).toBeDefined();
		expect(parsed.url).toBeUndefined();
	});

	test("explicit url over stdio is an error", async () => {
		const result = await handleExportImage(index, { path: filePath, format: "url" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/--transport http/);
	});

	test("url format still refuses paths the bridge did not write", async () => {
		const untracked = path.join(index.dir, "untracked.png");
		await fs.writeFile(untracked, Buffer.from([9]));
		const result = await handleExportImage(index, { path: untracked, format: "url" }, BASE);
		expect(result.isError).toBe(true);
	});

	test("list_generations includes url only when hosting files", async () => {
		const withUrl = JSON.parse(
			(await handleListGenerations(index, {}, BASE)).content[0]?.text ?? "{}",
		);
		expect(withUrl.generations[0].url).toBe(`${BASE}/files/${token}`);
		const noUrl = JSON.parse((await handleListGenerations(index, {})).content[0]?.text ?? "{}");
		expect(noUrl.generations[0].url).toBeUndefined();
	});
});
