/**
 * Config: types + defaults inline. KISS.
 *
 * No TOML file, no nested structures. ENV vars override defaults.
 * Want to tweak? Set the env var. Done.
 */

import os from "node:os";
import path from "node:path";

/**
 * Resolve the user's home directory.
 *
 * Honours `$OAI_BRIDGE_HOME` as an override (useful for tests, CI
 * sandboxes, and non-standard system layouts), falling back to the legacy
 * `$CHATGPT_BRIDGE_HOME` name for existing installs. Falls back to
 * `os.homedir()`, which on POSIX consults `getpwuid_r` and ignores `$HOME`
 * — so the env-var override is the portable way for callers to redirect.
 */
export function homeDir(): string {
	return process.env.OAI_BRIDGE_HOME ?? process.env.CHATGPT_BRIDGE_HOME ?? os.homedir();
}

/**
 * Default chat model. Single source of truth — used by /v1/chat/completions,
 * the CLI `chat` verb, the MCP `chat` tool, and the capability catalog.
 * Bump in one place, not nine.
 */
export const DEFAULT_CHAT_MODEL = "gpt-5.2";

export const DEFAULTS = {
	host: "127.0.0.1",
	port: 10531,
	upstreamBase: "https://chatgpt.com/backend-api/codex",
	oauthIssuer: "https://auth.openai.com",
	// Codex-CLI's published client_id (RFC 6749 §2.2 — public clients).
	// We piggyback it because the user's auth.json was minted under it.
	oauthClientId: "app_EMoamEEZ73f0CkXaXp7hrann",
	clientVersion: "0.111.0",
	timeoutMs: 400_000,
	rateHourlyHard: 200,
	imageModel: "gpt-5.5",
	chatModel: DEFAULT_CHAT_MODEL,
} as const;

export interface Config {
	host: string;
	port: number;
	upstreamBase: string;
	oauthIssuer: string;
	oauthClientId: string;
	clientVersion: string;
	timeoutMs: number;
	rateHourlyHard: number;
	imageModel: string;
	authFilePath: string | undefined;
	dataHome: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
	const env = process.env;
	// OAI_BRIDGE_* is the current name; CHATGPT_BRIDGE_* is kept as a
	// deprecated fallback for existing installs/scripts, never removed
	// without a major-version notice.
	const rawPort = env.OAI_BRIDGE_PORT ?? env.CHATGPT_BRIDGE_PORT;
	const cfg: Config = {
		host: overrides.host ?? env.OAI_BRIDGE_HOST ?? env.CHATGPT_BRIDGE_HOST ?? DEFAULTS.host,
		port: overrides.port ?? (rawPort ? Number.parseInt(rawPort, 10) : DEFAULTS.port),
		upstreamBase: overrides.upstreamBase ?? DEFAULTS.upstreamBase,
		oauthIssuer: overrides.oauthIssuer ?? DEFAULTS.oauthIssuer,
		oauthClientId:
			overrides.oauthClientId ??
			env.OAI_BRIDGE_CLIENT_ID ??
			env.CHATGPT_BRIDGE_CLIENT_ID ??
			DEFAULTS.oauthClientId,
		clientVersion: overrides.clientVersion ?? DEFAULTS.clientVersion,
		timeoutMs: overrides.timeoutMs ?? DEFAULTS.timeoutMs,
		rateHourlyHard: overrides.rateHourlyHard ?? DEFAULTS.rateHourlyHard,
		imageModel:
			overrides.imageModel ??
			env.OAI_BRIDGE_IMAGE_MODEL ??
			env.CHATGPT_BRIDGE_IMAGE_MODEL ??
			DEFAULTS.imageModel,
		authFilePath:
			overrides.authFilePath ?? env.OAI_BRIDGE_AUTH_FILE ?? env.CHATGPT_BRIDGE_AUTH_FILE,
		dataHome: overrides.dataHome ?? path.join(homeDir(), ".oai-bridge"),
	};
	return cfg;
}

/** Resolve auth file lookup order. First match wins. */
export function authFileCandidates(cfg: Config): string[] {
	const home = homeDir();
	const list = [
		cfg.authFilePath,
		process.env.CHATGPT_LOCAL_HOME
			? path.join(process.env.CHATGPT_LOCAL_HOME, "auth.json")
			: undefined,
		process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "auth.json") : undefined,
		path.join(home, ".chatgpt-local", "auth.json"),
		path.join(home, ".codex", "auth.json"),
		path.join(cfg.dataHome, "auth.json"),
		// Legacy data dir from the chatgpt-bridge name -- keeps existing
		// installs' saved tokens reachable after the oai-bridge rename.
		path.join(home, ".chatgpt-bridge", "auth.json"),
	];
	return list.filter((v): v is string => typeof v === "string" && v.length > 0);
}
